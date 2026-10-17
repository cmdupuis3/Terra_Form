"""A learned, labelled landform codebook for Terra Form's tile grids, one codebook per scale band.

A tile grid (land, relief, Koppen group, river) is cut into S x S windows (S = 7 by default) around every
tile; each window is one-hot encoded and assigned to the nearest of K centroids learned from Earth at that
tile size (scripts/landform_windows.py samples the globe at 8 log-spaced tile sizes from 0.01 to 3 degrees
per tile; this module fits a codebook per band). Each code carries a caption from Natural Earth's
physical-geography labels (the labels over-represented in the windows it absorbed: "delta", "isthmus",
"range/mtn", "strait" ...) and a geomorphon form (a hand-designed local landform from the height field), so a
describe pass can call a window what Earth's windows that look like it, at that scale, are called.

Codes are rotation and mirror invariant within a band: k-means runs over the orbit of each window under
the 8 dihedral symmetries (a window is assigned to the centroid nearest ANY of its 8 orientations, and
contributes to that centroid in that orientation). They are deliberately NOT scale invariant: what a 7x7
window means changes with the tile size, so inference picks the band from the tile size (degrees per tile)
and the report compares how many codes recur across adjacent bands.

    python -P scripts/landform_windows.py                 # data/landform/windows.npz (+ ne_physical.json cache)
    python -P terraform/landform_codebook.py              # data/landform/codebook.json, docs/landform-codes.txt, report section

Inference (what a JavaScript port does too; see docs/landform-codebook.md):
    from terraform.landform_codebook import load_codebook, windows_from_grid, assign
    cb = load_codebook()
    win = windows_from_grid(land, relief, koppen, river, cb["window"])     # (H*W, S, S, 4) uint8
    codes, orient, band = assign(win, deg_per_tile=span_x / W, codebook=cb)
"""
import argparse, json, math, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DATA = os.path.join(ROOT, "data")
LANDFORM_DIR = os.path.join(DATA, "landform")
WINDOWS_NPZ = os.path.join(LANDFORM_DIR, "windows.npz")
CODEBOOK_JSON = os.path.join(LANDFORM_DIR, "codebook.json")
DOCS_DIR = os.path.join(ROOT, "docs")
CODES_TXT = os.path.join(DOCS_DIR, "landform-codes.txt")
REPORT_MD = os.path.join(DOCS_DIR, "landform-codebook.md")
REPORT_MARKS = ("<!-- generated:start (python -P terraform/landform_codebook.py rewrites this section) -->",
                "<!-- generated:end -->")

# The raw per-tile channels a window carries (uint8 each): land 0/1; relief 0 flat 1 hills 2 peak (0 on
# water); Koppen group 0..5 as core/app.js classGroup (0 EF, 1 ET, 2 arid, 3 tropical, 4 temperate,
# 5 continental; meaningless on water); river 0/1 (0 on water).
RAW_CHANNELS = ("land", "relief", "koppen", "river")
RELIEF_NAMES = ("flat", "hills", "peak")
KOPPEN_GROUPS = ("ice", "tundra", "arid", "tropical", "temperate", "continental")
# The one-hot feature channels per cell, in order. water/flat/hills/peak are mutually exclusive (one is 1);
# the six climate channels are one-hot on land and all 0 on water; river is 0/1 on land.
ONEHOT_CHANNELS = ("water", "flat", "hills", "peak") + tuple("k_" + g for g in KOPPEN_GROUPS) + ("river",)
N_ONEHOT = len(ONEHOT_CHANNELS)   # 11

# Geomorphon forms (Jasiewicz & Stepinski 2013), indexed by (number of lower directions, number of higher
# directions) over the 8 lines of sight. Index 10 = unknown / off-grid (never produced here).
GEOMORPHON_NAMES = ("flat", "peak", "ridge", "shoulder", "spur", "slope", "hollow", "footslope", "valley", "pit")
_FL, _PK, _RI, _SH, _SP, _SL, _HL, _FS, _VL, _PT = range(10)
_X = 255
GEOMORPHON_TABLE = np.array([
    # higher ->  0    1    2    3    4    5    6    7    8      lower (rows)
    [_FL, _FL, _FL, _FS, _FS, _VL, _VL, _VL, _PT],   # 0
    [_FL, _FL, _FS, _FS, _FS, _VL, _VL, _VL, _X],    # 1
    [_FL, _SH, _SL, _SL, _HL, _HL, _VL, _X, _X],     # 2
    [_SH, _SH, _SL, _SL, _SL, _HL, _X, _X, _X],      # 3
    [_SH, _SH, _SP, _SL, _SL, _X, _X, _X, _X],       # 4
    [_RI, _RI, _SP, _SP, _X, _X, _X, _X, _X],        # 5
    [_RI, _RI, _RI, _X, _X, _X, _X, _X, _X],         # 6
    [_RI, _RI, _X, _X, _X, _X, _X, _X, _X],          # 7
    [_PK, _X, _X, _X, _X, _X, _X, _X, _X],           # 8
], np.uint8)

# ASCII glyphs for the centroid renderings.
RELIEF_GLYPH = "~.n^"                 # water, flat, hills, peak
KOPPEN_GLYPH = "*tDAcK"               # ice, tundra, arid, tropical, temperate, continental
RIVER_GLYPH = " ="                    # no river / river (probability >= 0.5)


# ---------------------------------------------------------------- dihedral group

def d8(a, t, axes=None):
    """The t-th (0..7) dihedral symmetry of windows `a`: rotations by t*90 degrees for t < 4, the
    horizontal mirror followed by (t-4)*90 degrees for t >= 4. `axes` are the (y, x) axes: by default the
    last two, or axes 1 and 2 of a (N, S, S, C) window stack."""
    if axes is None:
        axes = (1, 2) if a.ndim == 4 else (-2, -1)
    if t >= 4:
        a = np.flip(a, axis=axes[1])
    return np.rot90(a, t % 4, axes=axes)


def d8_inverse(t):
    """The index of the symmetry that undoes d8(., t)."""
    return (4 - t) % 4 if t < 4 else t      # a mirror composed with a rotation is an involution


def d8_feature_perms(S):
    """For each symmetry t: the permutation p with onehot(d8(w, t)) = onehot(w)[p] over the flattened
    (S*S*C) feature layout, as an int array (8, S*S*N_ONEHOT)."""
    idx = np.arange(S * S * N_ONEHOT).reshape(S, S, N_ONEHOT)
    return np.stack([d8(idx, t, axes=(0, 1)).reshape(-1) for t in range(8)])


# ---------------------------------------------------------------- windows and features

def onehot(win):
    """Raw windows (N, S, S, 4) uint8 -> one-hot features (N, S*S*N_ONEHOT) uint8 in the layout
    feature = (y*S + x)*N_ONEHOT + channel (cell-major, channel-minor)."""
    win = np.asarray(win)
    n, S = win.shape[0], win.shape[1]
    land = win[..., 0] > 0
    out = np.zeros((n, S, S, N_ONEHOT), np.uint8)
    out[..., 0] = ~land
    rel = np.clip(win[..., 1], 0, 2)
    for r in range(3):
        out[..., 1 + r] = land & (rel == r)
    kop = np.clip(win[..., 2], 0, 5)
    for g in range(6):
        out[..., 4 + g] = land & (kop == g)
    out[..., 10] = land & (win[..., 3] > 0)
    return out.reshape(n, -1)


def feature_weights(S, climate=0.5, river=0.75):
    """Per-feature weights (S*S*N_ONEHOT,) float32: 1 on the water/relief channels, `climate` on the six
    Koppen channels, `river` on the river channel. Distances are taken in the weighted space, so the
    codebook is about form first and climate second."""
    w = np.ones(N_ONEHOT, np.float32)
    w[4:10] = climate
    w[10] = river
    return np.tile(w, S * S)


def windows_from_grid(land, relief, koppen, river, S=7, wrap_x=False, fill=None):
    """Every tile's S x S window from a tile grid (each array (H, W)); (H*W, S, S, 4) uint8 in row-major
    tile order. Off-grid cells are `fill` (default: water) unless wrap_x wraps the columns (a whole-globe
    grid)."""
    R = S // 2
    H, W = land.shape
    raw = np.stack([np.asarray(land, np.uint8) > 0, relief, koppen, river], -1).astype(np.uint8)
    if fill is None:
        fill = np.zeros(4, np.uint8)
    padded = np.empty((H + 2 * R, W + 2 * R, 4), np.uint8)
    padded[:] = fill
    padded[R:R + H, R:R + W] = raw
    if wrap_x:
        padded[R:R + H, :R] = raw[:, W - R:]
        padded[R:R + H, R + W:] = raw[:, :R]
    v = np.lib.stride_tricks.sliding_window_view(padded, (S, S), axis=(0, 1))   # (H, W, 4, S, S)
    return np.ascontiguousarray(v.transpose(0, 1, 3, 4, 2).reshape(H * W, S, S, 4))


# ---------------------------------------------------------------- geomorphons

def geomorphons(height, lookback=5, flat=100.0, wrap_x=False):
    """Geomorphon form (0..9, GEOMORPHON_NAMES) of every cell of a height grid (metres) from the 8 lines
    of sight out to `lookback` cells. A direction counts as higher when the steepest rise along it exceeds
    the steepest drop by more than `flat` metres per cell of distance (the zenith/nadir angle test in
    slope units, for a grid whose cell is 50-200 km), lower in the mirror case, level otherwise; the
    (lower, higher) counts index GEOMORPHON_TABLE. Off-grid cells are ignored (wrap_x wraps columns)."""
    h = np.asarray(height, np.float32)
    H, W = h.shape
    L = lookback
    pad = np.full((H + 2 * L, W + 2 * L), np.nan, np.float32)
    pad[L:L + H, L:L + W] = h
    if wrap_x:
        pad[L:L + H, :L] = h[:, W - L:]
        pad[L:L + H, L + W:] = h[:, :L]
    lower = np.zeros((H, W), np.int16)
    higher = np.zeros((H, W), np.int16)
    for dy, dx in ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)):
        up = np.full((H, W), -np.inf, np.float32)
        down = np.full((H, W), np.inf, np.float32)
        for r in range(1, L + 1):
            s = (pad[L + dy * r:L + dy * r + H, L + dx * r:L + dx * r + W] - h) / r
            ok = ~np.isnan(s)
            up = np.where(ok, np.maximum(up, s), up)
            down = np.where(ok, np.minimum(down, s), down)
        seen = np.isfinite(up)
        with np.errstate(invalid="ignore"):
            delta = np.where(seen, up + down, 0.0)      # steepest rise minus steepest drop (slope units)
        higher += (delta > flat) & seen
        lower += (delta < -flat) & seen
    form = GEOMORPHON_TABLE[np.clip(lower, 0, 8), np.clip(higher, 0, 8)]
    form[form == _X] = _SL       # over-counted corners (can only happen with NaN asymmetry): call them slope
    return form


# ---------------------------------------------------------------- k-means

def _kmeanspp(X, K, rng, chunk=65536):
    """k-means++ seeds over float32 rows of X (n, d)."""
    n = X.shape[0]
    c = np.empty((K, X.shape[1]), np.float32)
    c[0] = X[rng.integers(n)]
    d2 = ((X - c[0]) ** 2).sum(1)
    for k in range(1, K):
        p = d2 / d2.sum()
        c[k] = X[rng.choice(n, p=p)]
        d2 = np.minimum(d2, ((X - c[k]) ** 2).sum(1))
    return c


def _sq_dist(X, C, x2=None):
    """||x - c||^2 for rows of X (n, d) against rows of C (K, d), float32 (n, K)."""
    if x2 is None:
        x2 = (X.astype(np.float32) ** 2).sum(1)
    c2 = (C ** 2).sum(1)
    return x2[:, None] + c2[None, :] - 2.0 * (X.astype(np.float32) @ C.T)


def orbit_assign(X, C, perms, w=None, chunk=20000):
    """Orientation-free assignment: (codes, orient, dist2) where orient is the symmetry t with
    onehot(d8(window, t)) nearest centroid `code`. X (n, d) uint8 one-hot features, C (K, d) centroids in
    the weighted space, perms from d8_feature_perms, w the feature weights (None = all 1). Implemented as
    8K transformed centroids against the untransformed data: x[p_t] . c = x . c[inv p_t]."""
    K, d = C.shape
    inv = np.argsort(perms, axis=1)                 # inverse permutations
    CT = np.concatenate([C[:, inv[t]] for t in range(8)], 0)   # (8K, d): row t*K + k = centroid k seen in orientation t
    c2 = (CT ** 2).sum(1)
    n = X.shape[0]
    codes = np.empty(n, np.int32)
    orient = np.empty(n, np.int8)
    dist = np.empty(n, np.float32)
    for i in range(0, n, chunk):
        xb = X[i:i + chunk].astype(np.float32)
        if w is not None:
            xb *= w
        x2 = (xb ** 2).sum(1)
        D = x2[:, None] + c2[None, :] - 2.0 * (xb @ CT.T)
        j = D.argmin(1)
        codes[i:i + chunk] = j % K
        orient[i:i + chunk] = j // K
        dist[i:i + chunk] = np.maximum(D[np.arange(len(j)), j], 0.0)
    return codes, orient, dist


def orbit_kmeans(X, K, perms, w=None, iters=40, seed=0, tol=1e-4, log=print):
    """k-means over dihedral orbits: every window may sit in any of its 8 orientations, and takes the one
    nearest its centroid. X (n, d) uint8 one-hot features (the untransformed windows), w feature weights.
    Returns (centroids (K, d) float32 in the weighted space, codes, orient)."""
    from scipy import sparse
    rng = np.random.default_rng(seed)
    n, d = X.shape
    if w is None:
        w = np.ones(d, np.float32)
    # Seed on a random orientation of each window so the seeds are not biased toward the stored one.
    t0 = rng.integers(8, size=n)
    Xs = np.take_along_axis(X, perms[t0], axis=1)
    sub = rng.choice(n, size=min(n, 60000), replace=False)
    C = _kmeanspp(Xs[sub].astype(np.float32) * w, K, rng)
    del Xs
    prev = None
    for it in range(iters):
        t = time.time()
        codes, orient, dist = orbit_assign(X, C, perms, w)
        inertia = float(dist.sum())
        # Update: each window contributes in the orientation it was matched in.
        sums = np.zeros((K, d), np.float64)
        counts = np.bincount(codes, minlength=K).astype(np.float64)
        for o in range(8):
            sel = np.nonzero(orient == o)[0]
            if not len(sel):
                continue
            Xo = X[sel][:, perms[o]].astype(np.float32) * w
            M = sparse.csr_matrix((np.ones(len(sel), np.float32), (codes[sel], np.arange(len(sel)))), shape=(K, len(sel)))
            sums += M @ Xo
        empty = counts == 0
        if empty.any():
            # Re-seed an empty code on the windows farthest from their centroids.
            far = np.argsort(-dist)[:int(empty.sum())]
            for k, i in zip(np.nonzero(empty)[0], far):
                sums[k] = X[i] * w
                counts[k] = 1.0
        C = (sums / counts[:, None]).astype(np.float32)
        log(f"  iter {it + 1:2d}  inertia {inertia:.0f}  ({time.time() - t:.1f}s, {int(empty.sum())} re-seeded)")
        if prev is not None and prev - inertia < tol * prev:
            break
        prev = inertia
    codes, orient, _ = orbit_assign(X, C, perms, w)
    return C, codes, orient


def augmented_kmeans(X8, K, w=None, seed=0, iters=40, log=print):
    """Plain k-means on the 8x augmented one-hot windows, weighted by w (sklearn's KMeans when importable,
    else Lloyd's in numpy). Returns centroids (K, d) float32 in the weighted space. Holds the whole set as
    float32 (about 1 GB for 500k windows)."""
    X8 = X8.astype(np.float32)
    if w is not None:
        X8 *= w
    try:
        from sklearn.cluster import KMeans
        log(f"  sklearn KMeans on {X8.shape[0]} windows")
        km = KMeans(n_clusters=K, n_init=1, max_iter=iters, random_state=seed).fit(X8)
        return km.cluster_centers_.astype(np.float32)
    except ImportError:
        pass
    rng = np.random.default_rng(seed)
    sub = rng.choice(X8.shape[0], size=min(X8.shape[0], 60000), replace=False)
    C = _kmeanspp(X8[sub], K, rng)
    from scipy import sparse
    prev = None
    for it in range(iters):
        codes = np.concatenate([_sq_dist(X8[i:i + 20000], C).argmin(1) for i in range(0, X8.shape[0], 20000)])
        M = sparse.csr_matrix((np.ones(len(codes), np.float32), (codes, np.arange(len(codes)))), shape=(K, len(codes)))
        counts = np.bincount(codes, minlength=K)
        sums = M @ X8
        empty = counts == 0
        sums[empty] = X8[rng.choice(X8.shape[0], size=int(empty.sum()))]
        counts[empty] = 1
        Cn = (sums / counts[:, None]).astype(np.float32)
        shift = float(((Cn - C) ** 2).sum())
        C = Cn
        log(f"  iter {it + 1:2d}  centroid shift {shift:.3f}")
        if prev is not None and shift < 1e-3:
            break
        prev = shift
    return C


# ---------------------------------------------------------------- captions

def lift_table(member_mask, labels_bits, n_labels, base_rate, min_n=5):
    """For one code: [(label index, share, lift, n, score)] over its member windows; share = P(label | code),
    lift = share / base rate, score = share * log2(lift) (the label's share of the code's pointwise mutual
    information: a label most of the code carries beats a rare one with a huge lift), sorted by score."""
    bits = labels_bits[member_mask]
    n = len(bits)
    if n == 0:
        return []
    out = []
    for j in range(n_labels):
        cnt = int(((bits >> np.uint64(j)) & np.uint64(1)).sum())
        if cnt < min_n or base_rate[j] <= 0:
            continue
        share = cnt / n
        lift = share / base_rate[j]
        out.append((j, share, lift, cnt, share * math.log2(lift) if lift > 1 else 0.0))
    out.sort(key=lambda r: -r[4])
    return out


def caption_for(rows, names, min_lift=1.5, min_share=0.05, max_terms=3):
    """A short caption from a lift table: the strongest over-represented labels, 'unlabelled' if none."""
    terms = [names[j] for j, share, lift, n, score, *_ in rows if lift >= min_lift and share >= min_share][:max_terms]
    return " / ".join(terms) if terms else "unlabelled"


def render_ascii(centroid, S):
    """Three S x S glyph grids (relief, climate, river) of a centroid, as text rows 'rrrrrrr  ccccccc  vvvvvvv'."""
    c = np.asarray(centroid, np.float32).reshape(S, S, N_ONEHOT)
    rows = []
    for y in range(S):
        rel = "".join(RELIEF_GLYPH[int(c[y, x, :4].argmax())] for x in range(S))
        kop = "".join(("~" if c[y, x, 0] >= 0.5 else KOPPEN_GLYPH[int(c[y, x, 4:10].argmax())]) for x in range(S))
        riv = "".join(("~" if c[y, x, 0] >= 0.5 else RIVER_GLYPH[int(c[y, x, 10] >= 0.5)]) for x in range(S))
        rows.append(f"{rel}  {kop}  {riv}")
    return rows


# ---------------------------------------------------------------- the codebook

SCHEMA = "terra-landform-codebook/2"
KINDS = ("open water / islands", "coast", "inland peaks", "inland hills", "inland flat")


def code_kind(centroid, S):
    """A coarse kind for a centroid from its mean water / relief content: open water or islands (water
    >= 60 % of cells), coast (20..60 %), inland peaks (peak >= 40 %), inland hills (hills + peak >= 40 %),
    inland flat."""
    c = np.asarray(centroid, np.float32).reshape(S * S, N_ONEHOT).mean(0)
    if c[0] >= 0.6:
        return KINDS[0]
    if c[0] >= 0.2:
        return KINDS[1]
    if c[3] >= 0.4:
        return KINDS[2]
    if c[2] + c[3] >= 0.4:
        return KINDS[3]
    return KINDS[4]


def band_for(cb, deg_per_tile):
    """Index of the band whose range holds a tile size (degrees per tile)."""
    for i, b in enumerate(cb["bands"]):
        lo, hi = b["range"]
        if lo <= deg_per_tile < (hi if hi is not None else float("inf")):
            return i
    return min(range(len(cb["bands"])), key=lambda i: abs(math.log(cb["bands"][i]["deg_per_tile"] / deg_per_tile)))


def load_codebook(path=CODEBOOK_JSON):
    cb = json.load(open(path, encoding="utf-8"))
    S = cb["window"]
    cb["_w"] = np.tile(np.array(cb["channel_weights"], np.float32), S * S)
    cb["_perms"] = d8_feature_perms(S)
    for b in cb["bands"]:
        b["_C"] = np.array([c["centroid"] for c in b["codes"]], np.float32) * cb["_w"]
    return cb


def assign(windows, deg_per_tile=None, codebook=None, band=None):
    """Raw windows (N, S, S, 4) uint8 -> (codes (N,) int32, orient (N,) int8, band index): the code of the
    band for `deg_per_tile` (a snapshot's frame gives it as its longitude span / W; or pass `band`) whose
    centroid is nearest to the window in orientation `orient` (d8(window, orient))."""
    cb = codebook or load_codebook()
    if band is None:
        if deg_per_tile is None:
            raise ValueError("assign needs deg_per_tile (the tile size in degrees) or a band index")
        band = band_for(cb, deg_per_tile)
    X = onehot(windows)
    codes, orient, _ = orbit_assign(X, cb["bands"][band]["_C"], cb["_perms"], cb["_w"])
    return codes, orient, band


def centroid_orbit_dist(Ca, Cb, perms):
    """(Ka, Kb) squared distances between centroids (weighted space) minimised over the 8 orientations of
    the second set."""
    inv = np.argsort(perms, axis=1)
    D = np.full((len(Ca), len(Cb)), np.inf, np.float32)
    for t in range(8):
        D = np.minimum(D, _sq_dist(Ca, Cb[:, inv[t]]))
    return D


def build_band(W0, labels_bits, cover, geo, frame, label_names, K, perms, w, S, method, iters, seed, min_lift, log):
    """Fit one band's codes. Returns (codes list for the JSON, per-window codes, centroids in weighted space,
    band stats). A label's lift for a code is its mean coverage over the code's windows divided by the mean
    coverage of the label over the windows of the SAME FRAMES (frame-conditional base rate; the globe is one
    frame), so a label that blankets a sampled frame (the "pen/cape" of a cove inside India) has lift 1 and
    never captions, while a delta inside a coast frame keeps its lift. lift_band is the plain band-wide lift."""
    X = onehot(W0)
    n0 = len(W0)
    if method == "orbit":
        Cw, codes, orient = orbit_kmeans(X, K, perms, w, iters=iters, seed=seed, log=log)
    else:
        X8 = onehot(np.concatenate([d8(W0, t) for t in range(8)]))
        Cw = augmented_kmeans(X8, K, w, seed=seed, iters=iters, log=log)
        codes, orient, _ = orbit_assign(X, Cw, perms, w)
    counts = np.bincount(codes, minlength=K)
    order = np.argsort(-counts)
    remap = np.empty(K, np.int64)
    remap[order] = np.arange(K)
    Cw, counts = Cw[order], counts[order]
    codes = remap[codes].astype(np.int32)
    C = Cw / w

    nl = len(label_names)
    cells = S * S
    cov = cover.astype(np.float32) / cells                       # (n0, nl) fraction of the window under each label
    base_cov = cov.mean(0)
    expect = np.empty_like(cov)                                   # each window's frame-wide mean coverage per label
    for f in np.unique(frame):
        mf = frame == f
        expect[mf] = cov[mf].mean(0)
    base_centre = np.array([float(((labels_bits >> np.uint64(j)) & np.uint64(1)).mean()) for j in range(nl)])
    geo_base = np.bincount(geo, minlength=10)[:10] / n0
    centre_land = W0[:, S // 2, S // 2, 0] > 0
    out = []
    for k in range(K):
        m = codes == k
        n = int(m.sum())
        share_cov = cov[m].mean(0) if n else np.zeros(nl)
        exp_cov = expect[m].mean(0) if n else np.ones(nl)
        rows = []
        for j in range(nl):
            if base_cov[j] <= 0 or share_cov[j] <= 0 or exp_cov[j] <= 0:
                continue
            n_centre = int(((labels_bits[m] >> np.uint64(j)) & np.uint64(1)).sum())
            if n_centre < 5 and share_cov[j] * n < 5:
                continue
            lift = float(share_cov[j] / exp_cov[j])
            rows.append((j, float(share_cov[j]), lift, n_centre, share_cov[j] * math.log2(lift) if lift > 1 else 0.0, float(share_cov[j] / base_cov[j])))
        rows.sort(key=lambda r: -r[4])
        cap = caption_for(rows, label_names, min_lift=min_lift)
        g = np.bincount(geo[m], minlength=10)[:10] / max(1, n)
        gi = int(g.argmax())
        out.append({
            "id": k, "count": n, "freq": float(n / n0),
            "centre_land": float(centre_land[m].mean()) if n else 0.0,
            "kind": code_kind(C[k], S),
            "caption": cap,
            "labels": [{"label": label_names[j], "cover": round(s, 4), "lift": round(l, 2), "lift_band": round(lb, 2), "n_centre": c,
                        "centre_share": round(c / n, 4) if n else 0.0} for j, s, l, c, _, lb in rows[:6]],
            "geomorphon": {"form": GEOMORPHON_NAMES[gi], "share": round(float(g[gi]), 4),
                           "lift": round(float(g[gi] / geo_base[gi]) if geo_base[gi] > 0 else 0.0, 2),
                           "dist": [round(float(v), 4) for v in g]},
            "ascii": render_ascii(C[k], S),
            "norm2": round(float((Cw[k] ** 2).sum()), 4),
            "centroid": [round(float(v), 3) for v in C[k]],
        })
    stats = {"label_base_cover": [round(float(v), 5) for v in base_cov],
             "label_centre_rate": [round(float(v), 5) for v in base_centre],
             "geomorphon_base_rate": [round(float(v), 5) for v in geo_base],
             "labelled": float((labels_bits != 0).mean())}
    return out, codes, Cw, stats


def label_summary(cb, by_band):
    """Per label and band: windows at the centre, best coverage lift any code gives it, and for the frame
    bands how much of the label is 'mixed' (sits in frames where it marks 10..90 % of the windows: a label
    that covers a whole frame tells the band which frame, not which shape)."""
    rows = []
    for j, name in enumerate(cb["labels"]):
        r = {"label": name, "bands": []}
        for b, (codes, bits, frame) in zip(cb["bands"], by_band):
            has = ((bits >> np.uint64(j)) & np.uint64(1)) > 0
            n = int(has.sum())
            best = max((l["lift"] for c in b["codes"] for l in c["labels"] if l["label"] == name), default=0.0)
            top = sorted(((l["lift"], c["id"]) for c in b["codes"] for l in c["labels"] if l["label"] == name), reverse=True)[:3]
            mixed = None
            if b["mode"] == "frames" and n:
                share = {f: float(has[frame == f].mean()) for f in np.unique(frame)}
                mixed = float(sum(1 for f in frame[has] if 0.1 <= share[f] <= 0.9) / n)
            r["bands"].append({"n": n, "best_lift": round(float(best), 2), "top_codes": [k for _, k in top],
                               "mixed": None if mixed is None else round(mixed, 3)})
        r["total"] = sum(x["n"] for x in r["bands"])
        rows.append(r)
    rows.sort(key=lambda r: -r["total"])
    return rows


def stability(cb, Cws, perms):
    """Adjacent-band code stability: a code pair is stable when the two centroids are mutual nearest
    neighbours across the bands and closer than tau, the median nearest-other-centroid distance within
    the bands (so 'stable' means 'as close as two codes of one band ever are')."""
    out = []
    for i in range(len(Cws) - 1):
        Ca, Cb = Cws[i], Cws[i + 1]
        Daa, Dbb, Dab = centroid_orbit_dist(Ca, Ca, perms), centroid_orbit_dist(Cb, Cb, perms), centroid_orbit_dist(Ca, Cb, perms)
        np.fill_diagonal(Daa, np.inf)
        np.fill_diagonal(Dbb, np.inf)
        tau = float((np.median(Daa.min(1)) + np.median(Dbb.min(1))) / 2)
        nn_ab, nn_ba = Dab.argmin(1), Dab.argmin(0)
        pairs = [(int(k), int(nn_ab[k]), float(Dab[k, nn_ab[k]])) for k in range(len(Ca)) if nn_ba[nn_ab[k]] == k and Dab[k, nn_ab[k]] < tau]
        pairs.sort(key=lambda p: p[2])
        lead = lambda cap: cap.split(" / ")[0]
        agree = sum(1 for a, b, _ in pairs if lead(cb["bands"][i]["codes"][a]["caption"]) == lead(cb["bands"][i + 1]["codes"][b]["caption"]))
        out.append({"bands": [i, i + 1], "tau": round(tau, 3), "stable": len(pairs), "caption_agree": agree, "k": [len(Ca), len(Cb)],
                    "pairs": [{"a": a, "b": b, "d2": round(d, 3), "caption_a": cb["bands"][i]["codes"][a]["caption"],
                               "caption_b": cb["bands"][i + 1]["codes"][b]["caption"]} for a, b, d in pairs]})
    return out


def pooled_fit(W0_all, band_all, n_bands, K, perms, w, iters, seed, log):
    """One codebook over every band, no scale channel: how many codes end up shared across bands (two or
    more bands each hold >= 15 % of the code) versus band-specific (one band holds >= 85 %)."""
    X = onehot(W0_all)
    Cw, codes, _ = orbit_kmeans(X, K, perms, w, iters=iters, seed=seed, log=log)
    use = np.zeros((K, n_bands), np.float64)
    for k in range(K):
        m = codes == k
        if m.any():
            use[k] = np.bincount(band_all[m], minlength=n_bands) / m.sum()
    shared = int(((use >= 0.15).sum(1) >= 2).sum())
    specific = int((use.max(1) >= 0.85).sum())
    return {"k": K, "shared": shared, "band_specific": specific, "other": K - shared - specific,
            "band_use": [[round(float(v), 3) for v in row] for row in use],
            "codes_per_band_majority": [int((use.argmax(1) == i).sum()) for i in range(n_bands)]}


def build(npz_path=WINDOWS_NPZ, K=128, method="orbit", iters=40, seed=0, min_lift=1.5, climate_weight=0.5,
          river_weight=0.75, pooled_k=192, log=print):
    """Fit one codebook per scale band from windows.npz; returns (codebook dict, per-band (codes, centre
    label bits))."""
    z = np.load(npz_path, allow_pickle=False)
    meta = json.loads(str(z["meta"]))
    S = int(meta["window"])
    win8 = z["windows"]
    tr = z["transform"]
    base = np.nonzero(tr == 0)[0]
    assert np.array_equal(z["src"][base], np.arange(len(base))), "windows.npz rows must be ordered by source window"
    W0 = win8[base]
    del win8
    band_all = z["band"]
    label_names = [str(s) for s in z["label_names"]]
    bands_meta = meta["bands"]
    log(f"windows: {len(W0)} source windows x 8 symmetries, {S}x{S}, {len(bands_meta)} bands")
    perms = d8_feature_perms(S)
    w = feature_weights(S, climate_weight, river_weight)

    bands, by_band, Cws = [], [], []
    t_all = time.time()
    for bm in bands_meta:
        i = bm["id"]
        m = np.nonzero(band_all == i)[0]
        Kb = min(K, max(8, len(m) // 40))
        t = time.time()
        log(f"band {i}: {bm['deg_per_tile']:.4g} deg/tile, {len(m)} windows, K={Kb}")
        codes_json, codes, Cw, stats = build_band(W0[m], z["labels"][m].astype(np.uint64), z["cover"][m], z["geomorphon"][m], z["frame"][m],
                                                   label_names, Kb, perms, w, S, method, iters, seed, min_lift, log)
        b = {"id": i, "deg_per_tile": bm["deg_per_tile"], "range": [bm["range"][0], None if bm["range"][1] == float("inf") else bm["range"][1]],
             "mode": bm["mode"], "k": Kb, "source_windows": int(len(m)), "fit_seconds": round(time.time() - t, 1),
             "sample": {k: bm.get(k) for k in ("tiles", "land_tiles", "frames", "frame_tiles", "strata", "candidates", "kept", "relief_pct", "seconds", "geo_flat_m") if k in bm},
             **stats,
             "kinds": {kind: {"codes": sum(1 for c in codes_json if c["kind"] == kind),
                              "windows": round(float(sum(c["freq"] for c in codes_json if c["kind"] == kind)), 4)} for kind in KINDS},
             "captioned": sum(1 for c in codes_json if c["caption"] != "unlabelled"),
             "codes": codes_json}
        bands.append(b)
        by_band.append((codes, z["labels"][m].astype(np.uint64), z["frame"][m]))
        Cws.append(Cw)
        log(f"  {b['captioned']}/{Kb} captioned, {stats['labelled']:.0%} of windows labelled at the centre, {b['fit_seconds']}s")

    cb = {
        "schema": SCHEMA, "window": S, "method": method, "seed": seed, "k": K,
        "raw_channels": list(RAW_CHANNELS), "relief": list(RELIEF_NAMES), "koppen_groups": list(KOPPEN_GROUPS),
        "onehot_channels": list(ONEHOT_CHANNELS),
        "channel_weights": [1.0, 1.0, 1.0, 1.0] + [climate_weight] * 6 + [river_weight],
        "feature_layout": "feature = (y*S + x)*11 + channel; water/flat/hills/peak one-hot per cell, k_* one-hot on land (0 on water), river 0/1 on land",
        "distance": "d2(x, k) = norm2_k - 2 * sum_i w_i^2 * x_i * centroid_k[i] (+ |w x|^2, the same for every k); w_i = channel_weights[i % 11]; norm2_k = sum_i (w_i centroid_k[i])^2",
        "dihedral": "orientation t: rot90^t for t<4, mirror columns then rot90^(t-4) for t>=4 (numpy rot90 on the (y, x) axes); assign = argmin over t and k of d2(onehot(d8(w,t)), k)",
        "band_choice": "deg_per_tile = a frame's longitude span / its width in tiles; the band whose [range[0], range[1]) holds it (range[1] null = open)",
        "labels": label_names, "geomorphons": list(GEOMORPHON_NAMES), "kinds": list(KINDS),
        "ascii_legend": {"relief": "~ water . flat n hills ^ peak", "climate": "* ice t tundra D arid A tropical c temperate K continental",
                         "river": "= river (p >= 0.5)"},
        "train": {k: v for k, v in meta.items() if k != "bands"},
        "bands": bands,
    }
    cb["label_summary"] = label_summary(cb, by_band)
    cb["stability"] = stability(cb, Cws, perms)
    if pooled_k:
        t = time.time()
        log(f"pooled codebook over all bands, K={pooled_k}")
        cb["pooled"] = pooled_fit(W0, band_all, len(bands), pooled_k, perms, w, iters, seed, log)
        cb["pooled"]["fit_seconds"] = round(time.time() - t, 1)
        log(f"  shared {cb['pooled']['shared']}, band-specific {cb['pooled']['band_specific']}, other {cb['pooled']['other']}")
    cb["fit_seconds"] = round(time.time() - t_all, 1)
    return cb, by_band


def write_codes_txt(cb, path=CODES_TXT):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"# Terra Form landform codebook: {len(cb['bands'])} scale bands, {cb['window']}x{cb['window']} windows, method {cb['method']}\n")
        f.write(f"# columns: relief ({cb['ascii_legend']['relief']}) | climate ({cb['ascii_legend']['climate']}) | river ({cb['ascii_legend']['river']})\n")
        f.write("# labels: cover = mean fraction of the window under the label, lift = cover / the label's mean cover over the same frames\n\n")
        for b in cb["bands"]:
            f.write(f"## band {b['id']}: {b['deg_per_tile']:.4g} deg/tile, K={b['k']}, {b['source_windows']} windows\n\n")
            for c in b["codes"]:
                labs = ", ".join(f"{l['label']} x{l['lift']:.1f} ({l['cover']:.0%})" for l in c["labels"][:4])
                f.write(f"code {b['id']}:{c['id']:<3d} n={c['count']:5d} ({c['freq']:.2%})  {c['kind']}  caption: {c['caption']}  |  geomorphon: "
                        f"{c['geomorphon']['form']} ({c['geomorphon']['share']:.0%}, x{c['geomorphon']['lift']:.1f})\n")
                f.write(f"          labels: {labs or '-'}\n")
                for row in c["ascii"]:
                    f.write(f"          {row}\n")
                f.write("\n")


def write_report_section(cb, path=REPORT_MD, top=6):
    """Rewrite the generated section of docs/landform-codebook.md (between REPORT_MARKS; appended when the
    file has no marks yet)."""
    tr = cb["train"]
    B = cb["bands"]
    L = [f"Built {tr.get('built', '?')}: {len(B)} scale bands, {cb['window']}x{cb['window']} windows, method `{cb['method']}` (seed {cb['seed']}), "
         f"{sum(b['source_windows'] for b in B)} source windows x 8 symmetries, channel weights {cb['channel_weights'][0]:g} form / "
         f"{cb['channel_weights'][4]:g} climate / {cb['channel_weights'][10]:g} river, geomorphon lookback {tr['geo_lookback']} tiles at "
         f"{tr['geo_flat']} m per tile (auto = {tr.get('geo_flat_rel', '?')} x each grid's median land height step); sampling {tr.get('seconds', 0):.0f} s, fitting {cb.get('fit_seconds', 0):.0f} s.", ""]
    L += ["### Bands", "", "| band | deg/tile | km/tile | range (deg/tile) | source | windows | K | captioned | labelled centres | geomorphon flat m/tile | sampling s | fit s |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for b in B:
        sm = b["sample"]
        src = f"globe {sm['tiles'][0]}x{sm['tiles'][1]}" if b["mode"] == "globe" else f"{sm.get('frames')} frames of {sm['frame_tiles'][0]}x{sm['frame_tiles'][1]}"
        hi = "open" if b["range"][1] is None else f"{b['range'][1]:.3g}"
        sm = {**sm, "geo": sm.get("geo_flat_m", "?")}
        L.append(f"| {b['id']} | {b['deg_per_tile']:.3g} | {b['deg_per_tile'] * 111:.3g} | {b['range'][0]:.3g} - {hi} | {src} | {b['source_windows']} | {b['k']} | "
                 f"{b['captioned']} | {b['labelled']:.0%} | {sm['geo']} | {sm.get('seconds', 0):.0f} | {b['fit_seconds']:.0f} |")
    L += ["", "### Vocabulary across the scales", "",
          "Codes per kind (and the share of the band's windows they hold), kind from the centroid's water and relief content:", "",
          "| band | deg/tile | " + " | ".join(KINDS) + " |", "|---|---|" + "---|" * len(KINDS)]
    for b in B:
        L.append(f"| {b['id']} | {b['deg_per_tile']:.3g} | " + " | ".join(f"{b['kinds'][k]['codes']} ({b['kinds'][k]['windows']:.0%})" for k in KINDS) + " |")
    L += ["", "Label reliability per band: windows with the label at the centre / best coverage lift any code gives it / for the frame bands, "
          "the share of those windows in frames where the label is mixed (marks 10..90 % of the frame; a label that blankets its frames is a "
          "frame constant, not a shape) (blank = under 20 windows):", "",
          "| label | " + " | ".join(f"b{b['id']} {b['deg_per_tile']:.2g}" for b in B) + " |", "|---|" + "---|" * len(B)]
    for r in cb["label_summary"]:
        if r["total"] < 20:
            continue
        L.append(f"| {r['label']} | " + " | ".join((f"{x['n']} / x{x['best_lift']:.1f}" + (f" / {x['mixed']:.0%}" if x["mixed"] is not None else "")) if x["n"] >= 20 else "" for x in r["bands"]) + " |")
    L += ["", "### Stability between adjacent bands", "",
          "Mutual nearest-neighbour centroid pairs closer than tau (the median distance between a code and its nearest other code "
          "within a band), with three examples each:", "",
          "| bands | K | tau | stable pairs | same leading caption | examples |", "|---|---|---|---|---|---|"]
    for s in cb["stability"]:
        ex = "; ".join(f"{p['a']}:{p['caption_a']} ~ {p['b']}:{p['caption_b']}" for p in s["pairs"][:3])
        L.append(f"| {s['bands'][0]} - {s['bands'][1]} | {s['k'][0]} / {s['k'][1]} | {s['tau']:.2f} | {s['stable']} | {s['caption_agree']} | {ex} |")
    if "pooled" in cb:
        p = cb["pooled"]
        L += ["", f"Pooled check: one codebook of K = {p['k']} over every band (no scale channel) ends with {p['shared']} codes shared by two or more "
              f"bands (each holding >= 15 % of the code), {p['band_specific']} band-specific (one band >= 85 %) and {p['other']} in between; "
              f"codes by majority band: {', '.join(f'b{i} {n}' for i, n in enumerate(p['codes_per_band_majority']))} ({p['fit_seconds']:.0f} s)."]
    L += ["", f"### Top {top} codes per band", "",
          f"Relief `{cb['ascii_legend']['relief']}`; climate `{cb['ascii_legend']['climate']}`; river `{cb['ascii_legend']['river']}`. "
          "Cover = mean fraction of the code's windows under the label, lift = cover / the label's mean cover over the same frames "
          "(the globe for the coarse bands); "
          "every code of every band is in docs/landform-codes.txt.", ""]
    for b in B:
        L += [f"#### Band {b['id']}: {b['deg_per_tile']:.3g} deg/tile ({b['deg_per_tile'] * 111:.3g} km)", ""]
        for c in b["codes"][:top]:
            labs = ", ".join(f"{l['label']} x{l['lift']:.1f} ({l['cover']:.0%})" for l in c["labels"][:4]) or "-"
            g = c["geomorphon"]
            L += [f"**Code {b['id']}:{c['id']}** - {c['freq']:.2%} of windows, {c['kind']} - caption **{c['caption']}** - "
                  f"geomorphon {g['form']} ({g['share']:.0%}, x{g['lift']:.1f})  ", f"labels: {labs}", "", "```"]
            L += ["    " + r for r in c["ascii"]]
            L += ["```", ""]
    body = "\n".join(L)
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else "# Landform codebook\n\n"
    a, bmark = REPORT_MARKS
    if a in text and bmark in text:
        head, rest = text.split(a, 1)
        _, tail = rest.split(bmark, 1)
        text = head + a + "\n" + body + "\n" + bmark + tail
    else:
        text = text.rstrip() + "\n\n" + a + "\n" + body + "\n" + bmark + "\n"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w", encoding="utf-8").write(text)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--windows", default=WINDOWS_NPZ)
    ap.add_argument("--out", default=CODEBOOK_JSON)
    ap.add_argument("--codes-txt", default=CODES_TXT, help="per-code ASCII renderings; '' to skip")
    ap.add_argument("--report", default=REPORT_MD, help="rewrite the generated section of this markdown report; '' to skip")
    ap.add_argument("-k", type=int, default=128, help="codes per band (a band with few windows gets fewer: one code per 40 windows at least)")
    ap.add_argument("--pooled-k", type=int, default=192, help="K of the pooled all-bands comparison codebook (0 skips it)")
    ap.add_argument("--method", choices=("orbit", "augmented"), default="orbit")
    ap.add_argument("--iters", type=int, default=40)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--min-lift", type=float, default=1.5, help="a label captions a code only above this lift over its base rate")
    ap.add_argument("--climate-weight", type=float, default=0.5, help="weight of the six Koppen channels in the distance (1 = as much as form)")
    ap.add_argument("--river-weight", type=float, default=0.75, help="weight of the river channel in the distance")
    args = ap.parse_args(argv)

    cb, _ = build(args.windows, K=args.k, method=args.method, iters=args.iters, seed=args.seed, min_lift=args.min_lift,
                  climate_weight=args.climate_weight, river_weight=args.river_weight, pooled_k=args.pooled_k)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(cb, f, separators=(",", ":"))
    print(f"codebook: {args.out} ({os.path.getsize(args.out) // 1024} KB), {len(cb['bands'])} bands, {sum(b['k'] for b in cb['bands'])} codes")
    if args.codes_txt:
        write_codes_txt(cb, args.codes_txt)
        print(f"ascii codes: {args.codes_txt}")
    if args.report:
        write_report_section(cb, args.report)
        print(f"report section: {args.report}")
    for b in cb["bands"]:
        print(f"band {b['id']} {b['deg_per_tile']:.4g} deg/tile: {b['captioned']}/{b['k']} captioned; kinds " +
              ", ".join(f"{k.split(' ')[-1]} {b['kinds'][k]['codes']}" for k in KINDS))
        for c in b["codes"][:4]:
            print(f"    {c['id']:3d} {c['freq']:6.2%}  {c['caption']:<40} {c['geomorphon']['form']} ({c['geomorphon']['share']:.0%})")
    for s in cb["stability"]:
        print(f"stability bands {s['bands']}: {s['stable']} stable pairs of {s['k']} (tau {s['tau']:.2f})")


if __name__ == "__main__":
    main()
