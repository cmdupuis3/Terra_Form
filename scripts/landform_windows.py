#!/usr/bin/env python
"""Training data for the landform codebook: the Earth as game-map tile grids at several scales, cut into
S x S windows, with scale as a first-class variable.

Scale bands. --bands gives log-spaced tile sizes in degrees per tile (default 8 bands over 0.01..3.0: a
1 km tile up to a 300 km one; a regional map is ~0.2, Europe at 80x52 ~0.75, a 128-wide world map ~2.8).
What a 7x7 window holds changes with scale (a cordillera and a whole peninsula at 3 deg/tile, one range or
one valley at 0.2, a cove or a headland at 0.02), so every window is tagged with its band and the codebook
is fitted per band.

  coarse bands (>= --global-min-deg, default 0.2 deg/tile): the whole globe is one grid, built from the
      base rasters (elev_4096, koppen_2048, coast_10m) at --sub layer pixels per tile side and reduced per
      tile the way core/app.js samples a frame; every land or coast tile between --lat is a candidate.
  fine bands (< --global-min-deg): the globe cannot be enumerated (0.02 deg/tile is 18000x9000 tiles), so
      --frames random map-sized frames (--frame-size, default 80x52 tiles) per band are built with the fine
      sources (hgt_tiles 120 px/deg, OSM coast_tiles + lakes_hires, koppen_tiles). Frame centres are drawn
      from the finest coarse grid, stratified over delta, archipelago, strait/fjord, mountain, desert,
      coast, hills and plain tiles so every landform kind is represented; each frame's bounds are recorded
      (reproducible from --seed).

Per tile: land (land fraction >= 0.5), height (mean elevation of the land pixels, m), relief 0/1/2 from
the app's blend of the FRAME's land percentiles of height and roughness (relief is relative: a world map
and a regional map each get their own hills and peaks), Koppen classGroup 0..5, river (a HydroRIVERS
channel of --river-class or larger crosses a land tile), the geomorphon form (lookback --geo-lookback
tiles, flatness --geo-flat m per tile), and the Natural Earth physical labels. A label polygon counts at a
band only when it is at least two tiles across and its scalerank is within the band's edition (<= 3 at
2 deg/tile and up, the 110m-like set; <= 6 from 0.5, the 50m-like set; all of 10m below), and it is
burned all-touched. Each window records the labels at its centre tile (bitmask) and, per label, how many
of its S x S tiles the label covers (coverage).

The candidates of a band are subsampled to --per-band source windows, stratified by (land / coast centre,
rarest label at the centre) with a floor per stratum so rare landforms survive; each kept window is
stored with its 8 dihedral symmetries (rows 8i..8i+7 = source window i, transforms 0..7 of
terraform.landform_codebook.d8) in data/landform/windows.npz, with the coarse bands' whole grids.

Natural Earth: download ne_10m_geography_regions_polys.zip and ne_10m_geography_marine_polys.zip from
naturalearthdata.com (https://naciscdn.org/naturalearth/10m/physical/<name>.zip) into a fresh, empty
directory, unzip each into its own folder, and pass the directory as --ne-dir. The first run writes the
polygons it needs (with scalerank and min_label) to data/landform/ne_physical.json (public domain), which
later runs read instead, so the download is only needed to rebuild that cache.

    python -P scripts/landform_windows.py --ne-dir "C:/Users/me/Downloads/ne_10m_physical_labels"
    python -P scripts/landform_windows.py                 # from the cached labels
"""
import argparse, json, math, os, sys, time
import numpy as np

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, ROOT)
from terraform import frame as tf                                   # noqa: E402
from terraform import landform_codebook as lc                       # noqa: E402

NE_SETS = ("ne_10m_geography_regions_polys", "ne_10m_geography_marine_polys")
# Labels that name an area too large to be a landform at tile scale, or nothing at all.
NE_SKIP = {"continent", "geoarea", "dragons-be-here", "ocean", "sea", "generic", "river", "lake"}
NE_JSON = os.path.join(lc.LANDFORM_DIR, "ne_physical.json")
NE_CACHE_SCHEMA = "terra-ne-physical/2"

# core/app.js P: how much each relief metric leans on roughness vs height, and the thresholds.
P_BLEND_HILL, P_BLEND_PEAK, P_HILL, P_PEAK = 0.9, 0.7, 0.55, 0.8
KOPPEN_GROUP = np.array([5] + [{"A": 3, "B": 2, "C": 4, "D": 5}.get(k[0], 0 if k == "EF" else 1) for k in tf.KOPPEN_KEYS[1:]], np.uint8)
ELEV_BASE = os.path.join(tf.DATA, "elev_4096.png")
KOPPEN_BASE = os.path.join(tf.DATA, "koppen_2048.png")
FRAME_STRATA = ("delta", "archipelago", "strait", "mountain", "desert", "coast", "hills", "plain")
GLOBE = [-180.0, -90.0, 180.0, 90.0]


def class_group(kop):
    """Koppen class index grid -> classGroup 0..5 (core/app.js)."""
    return KOPPEN_GROUP[np.clip(kop, 0, 30)]


def pctl_rank(values, mask):
    """Each value's percentile among the masked values (fraction of them <= it), as core/app.js pctl."""
    ref = np.sort(values[mask])
    return np.searchsorted(ref, values, side="right") / max(1, len(ref))


def block_reduce(a, k, fn):
    H, W = a.shape
    return fn(a.reshape(H // k, k, W // k, k), axis=(1, 3))


def sub_for(ppd):
    """Layer pixels per tile side: 8, or 4 for dense grids (over 2 tiles/deg the base rasters are already
    coarser than the tile), or what brings a fine frame to about the hgt tiles' 120 px/deg."""
    if ppd > 12:
        return int(max(2, min(8, round(120.0 / ppd))))
    return 8 if ppd < 2 else 4


def fine_frame_for(tile, sub):
    bounds = GLOBE if tile.wrap else [tile.lon_min, max(-90.0, tile.lat_min), tile.lon_max, min(90.0, tile.lat_max)]
    fine = tf.Frame(bounds, tile.ppd * sub, 1)
    assert fine.w == tile.w * sub and fine.h == tile.h * sub, (tile.w, tile.h, sub, fine.w, fine.h)
    return fine


def build_grid(tile, fine_src, rivers, river_class, geo_lookback, geo_flat, wrap, geo_flat_rel=1.5):
    """The layers of a tile Frame as per-tile arrays: land, height, relief, koppen, river, rough, geomorphon.
    fine_src: use the fine sources (hgt_tiles, coast_tiles, koppen_tiles). rivers: preloaded (geometry,
    class) list, or None to read the channels under the frame."""
    sub = sub_for(tile.ppd)
    fine = fine_frame_for(tile, sub)
    H, W = tile.h, tile.w
    code, _ = tf.build_elevation(fine, ELEV_BASE, fine_src)
    mask, _ = tf.build_landmask(fine, fine_src)
    landpx = mask > 0
    del mask
    kop, _ = tf.build_koppen(fine, KOPPEN_BASE, fine_src)
    kop = np.asarray(kop)
    if kop.shape != (fine.h, fine.w):
        kop = tf.global_to_frame(kop, fine, tf.Resampling.nearest).astype(np.uint8)
    if rivers is None:
        rivers = tf.river_shapes(fine)
    shapes = [(g, 1) for g, c in rivers if c >= river_class]
    riverpx = (tf.burn(fine, shapes, all_touched=True) > 0) if shapes else np.zeros((fine.h, fine.w), bool)

    hn = (code / 65535.0).astype(np.float32)
    metres = (tf.SEA + hn * (tf.PEAK - tf.SEA)).astype(np.float32)
    del code
    # roughness as the app's buildRoughLayer: central-difference gradient of the coded height, normalised
    # by its max over the frame and gamma 0.7; the app samples one workspace cell per tile, this averages.
    gx = np.roll(hn, -1, 1) - np.roll(hn, 1, 1)
    if not wrap:
        gx[:, 0] = hn[:, 1] - hn[:, 0]
        gx[:, -1] = hn[:, -1] - hn[:, -2]
    gy = np.empty_like(hn)
    gy[1:-1] = hn[2:] - hn[:-2]
    gy[0] = hn[1] - hn[0]
    gy[-1] = hn[-1] - hn[-2]
    grad = np.hypot(gx, gy)
    del gx, gy, hn

    land_frac = block_reduce(landpx.astype(np.float32), sub, np.mean)
    land = land_frac >= 0.5
    n_land_px = block_reduce(landpx.astype(np.float32), sub, np.sum)
    h_land = block_reduce(np.where(landpx, metres, 0.0).astype(np.float32), sub, np.sum) / np.maximum(1, n_land_px)
    height = np.where(n_land_px > 0, h_land, 0.0).astype(np.float32)
    rough = block_reduce(grad, sub, np.mean)
    rough = np.power(np.minimum(1.0, rough / max(1e-9, float(rough.max()))), 0.7).astype(np.float32)
    kb = kop.reshape(H, sub, W, sub)
    hist = np.zeros((H, W, 31), np.int32)
    for k in range(1, 31):
        hist[..., k] = (kb == k).sum(axis=(1, 3))
    hist[..., 0] = -1
    koppen = class_group(hist.argmax(-1).astype(np.uint8))
    del hist, kb, kop
    river = land & (block_reduce(riverpx.astype(np.uint8), sub, np.max) > 0)

    # relief is relative: percentiles over THIS frame's land tiles (the app's per-view normalisation)
    hp = pctl_rank(height, land)
    rp = pctl_rank(rough, land)
    m_hill = (1 - P_BLEND_HILL) * hp + P_BLEND_HILL * rp
    m_peak = (1 - P_BLEND_PEAK) * hp + P_BLEND_PEAK * rp
    relief = np.where(~land, 0, np.where(m_peak > P_PEAK, 2, np.where(m_hill > P_HILL, 1, 0))).astype(np.uint8)
    hh = np.where(land, height, 0.0).astype(np.float32)
    if geo_flat is None:                                    # relative: the grid's own median land-to-land height step
        steps = np.concatenate([np.abs(hh[:, 1:] - hh[:, :-1])[land[:, 1:] & land[:, :-1]], np.abs(hh[1:] - hh[:-1])[land[1:] & land[:-1]]])
        geo_flat = max(1.0, geo_flat_rel * float(np.median(steps))) if len(steps) else 1.0
    geo = lc.geomorphons(hh, geo_lookback, geo_flat, wrap_x=wrap)
    return {"frame": tile, "land": land, "height": height, "relief": relief, "koppen": koppen.astype(np.uint8),
            "river": river, "rough": rough, "geomorphon": geo.astype(np.uint8), "geo_flat": float(geo_flat)}


# ---------------------------------------------------------------- Natural Earth labels

def ne_load(ne_dir, cache=NE_JSON, log=print):
    """[{cla, name, src, sr, ml, b, r}] from the cache, or from the shapefiles under ne_dir (written to the
    cache): one entry per polygon part, with its scalerank (sr) and min_label (ml)."""
    if ne_dir:
        import pyogrio
        from shapely import get_parts
        polys = []
        for name in NE_SETS:
            shp = os.path.join(ne_dir, name, name + ".shp")
            df = pyogrio.read_dataframe(shp)
            cols = {c.lower(): c for c in df.columns}
            src = "marine" if "marine" in name else "regions"
            for cla, nm, sr, ml, geom in zip(df[cols["featurecla"]], df[cols["name"]], df[cols["scalerank"]], df[cols["min_label"]], df.geometry):
                cla = str(cla).strip().lower()
                if cla in NE_SKIP or geom is None or geom.is_empty:
                    continue
                for part in get_parts(geom):
                    part = part.simplify(0.005)
                    if part.is_empty:
                        continue
                    rings = [[[round(x, 3), round(y, 3)] for x, y in r.coords] for r in [part.exterior] + list(part.interiors)]
                    polys.append({"cla": cla, "name": str(nm) if nm is not None else "", "src": src, "sr": int(sr), "ml": float(ml),
                                  "b": [round(v, 3) for v in part.bounds], "r": rings})
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w", encoding="utf-8") as f:
            json.dump({"schema": NE_CACHE_SCHEMA, "source": "Natural Earth 10m physical (public domain): " + ", ".join(NE_SETS),
                       "skipped_featurecla": sorted(NE_SKIP), "polys": polys}, f, separators=(",", ":"))
        log(f"  Natural Earth: {len(polys)} polygon parts from {ne_dir} -> {os.path.relpath(cache, ROOT)}")
        return polys
    if not os.path.exists(cache):
        sys.exit(f"no Natural Earth labels: pass --ne-dir (see the docstring) to build {cache}")
    j = json.load(open(cache, encoding="utf-8"))
    if j.get("schema") != NE_CACHE_SCHEMA:
        sys.exit(f"{cache} is an older cache without scalerank; rebuild it with --ne-dir")
    log(f"  Natural Earth: {len(j['polys'])} polygon parts from {os.path.relpath(cache, ROOT)}")
    return j["polys"]


def rank_max(deg_per_tile):
    """The Natural Earth edition a band reads like: scalerank <= 3 (110m-like) from 2 deg/tile up, <= 6
    (50m-like) from 0.5, everything in 10m below."""
    return 3 if deg_per_tile >= 2.0 else (6 if deg_per_tile >= 0.5 else 99)


def ne_rasterise(tile, polys, names, deg_per_tile):
    """Label bitmask (H, W) uint64: bit j set where a polygon of label names[j] that counts at this band (at
    least two tiles across, scalerank within the band's edition) touches the tile."""
    bits = np.zeros((tile.h, tile.w), np.uint64)
    rmax = rank_max(deg_per_tile)
    for j, cla in enumerate(names):
        shapes = []
        for p in polys:
            if p["cla"] != cla or p["sr"] > rmax or not tile.touches(p["b"]):
                continue
            if max(p["b"][2] - p["b"][0], p["b"][3] - p["b"][1]) < 2.0 * deg_per_tile:
                continue
            g = tf.rings_to_polygon(p["r"])
            if g:
                shapes.append((g, 1))
        if shapes:
            bits |= (tf.burn(tile, shapes, all_touched=True) > 0).astype(np.uint64) << np.uint64(j)
    return bits


def box_sum(a, S, wrap_x):
    """Sum of a over the S x S box around each cell (off-grid = 0, or wrapped columns), int32."""
    R = S // 2
    H, W = a.shape
    p = np.zeros((H + 2 * R, W + 2 * R), np.int32)
    p[R:R + H, R:R + W] = a
    if wrap_x:
        p[R:R + H, :R] = a[:, W - R:]
        p[R:R + H, R + W:] = a[:, :R]
    c = np.zeros((H + 2 * R + 1, W + 2 * R + 1), np.int64)
    c[1:, 1:] = p.cumsum(0).cumsum(1)
    return (c[S:, S:] - c[:-S, S:] - c[S:, :-S] + c[:-S, :-S]).astype(np.int32)


def coverage(bits, n_labels, S, wrap_x):
    """(H, W, n_labels) uint8: how many of the S x S tiles around each cell carry each label."""
    out = np.zeros(bits.shape + (n_labels,), np.uint8)
    for j in range(n_labels):
        plane = ((bits >> np.uint64(j)) & np.uint64(1)).astype(np.int32)
        if plane.any():
            out[..., j] = box_sum(plane, S, wrap_x)
    return out


# ---------------------------------------------------------------- windows

def near_land(land, wrap_x):
    near = np.zeros_like(land)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            s = np.roll(np.roll(land, dy, 0), dx, 1)
            if not wrap_x:
                if dx == 1:
                    s[:, 0] = False
                elif dx == -1:
                    s[:, -1] = False
            near |= s
    return near


def candidates(grid, margin, lat_range, wrap_x):
    """Centre tiles: land, or water next to land, at least `margin` rows/cols in from the edge (columns
    exempt when wrapping) and inside lat_range."""
    land = grid["land"]
    H, W = land.shape
    centre = land | near_land(land, wrap_x)
    centre[:margin] = False
    centre[H - margin:] = False
    if not wrap_x:
        centre[:, :margin] = False
        centre[:, W - margin:] = False
    fr = grid["frame"]
    lat = fr.lat_max - (np.arange(H) + 0.5) * fr.res
    centre[(lat < lat_range[0]) | (lat > lat_range[1])] = False
    return centre


def stratified_pick(land_c, bits_c, cap, floor, rng):
    """Indices to keep out of candidate centres: strata = (land or coast centre, the rarest label at the
    centre or none); each stratum keeps min(n, max(floor, its share of cap))."""
    n = len(land_c)
    counts = np.array([int(((bits_c >> np.uint64(j)) & np.uint64(1)).sum()) for j in range(64)])
    rare = np.full(n, 63, np.int64)
    rare_count = np.full(n, np.iinfo(np.int64).max)
    for j in np.argsort(-counts):          # commonest first, so the rarest present label wins
        if counts[j] == 0:
            continue
        has = ((bits_c >> np.uint64(j)) & np.uint64(1)) > 0
        rare[has] = j
        rare_count[has] = counts[j]
    key = land_c.astype(np.int64) * 64 + rare
    keep = []
    for k in np.unique(key):
        idx = np.nonzero(key == k)[0]
        q = min(len(idx), max(min(len(idx), floor), int(round(cap * len(idx) / n))))
        keep.append(rng.choice(idx, size=q, replace=False) if q < len(idx) else idx)
    keep = np.sort(np.concatenate(keep))
    return keep


def cut(grid, ys, xs, S, wrap_x):
    R = S // 2
    land = grid["land"]
    H, W = land.shape
    raw = np.stack([land.astype(np.uint8), grid["relief"], grid["koppen"], grid["river"].astype(np.uint8)], -1)
    if wrap_x:
        padded = np.concatenate([raw[:, W - R:], raw, raw[:, :R]], axis=1)
    else:
        padded = np.zeros((H, W + 2 * R, 4), np.uint8)
        padded[:, R:R + W] = raw
    win = np.empty((len(ys), S, S, 4), np.uint8)
    for i, (y, x) in enumerate(zip(ys, xs)):
        win[i] = padded[y - R:y + R + 1, x:x + S]
    return win


def collect(grid, bits, cov, centre, S, cap, floor, rng, wrap_x, deg_per_tile, band_id, frame_id):
    """Pick and cut the windows of one grid; returns a dict of per-window arrays."""
    ys, xs = np.nonzero(centre)
    if len(ys) == 0:
        return None
    keep = stratified_pick(grid["land"][ys, xs], bits[ys, xs], cap, floor, rng) if cap else np.arange(len(ys))
    ys, xs = ys[keep], xs[keep]
    fr = grid["frame"]
    lon = fr.lon_min + (xs + 0.5) * fr.res
    lon = (lon + 180.0) % 360.0 - 180.0
    lat = fr.lat_max - (ys + 0.5) * fr.res
    return {"windows": cut(grid, ys, xs, S, wrap_x),
            "centre": np.stack([lon, lat, np.full(len(ys), deg_per_tile)], 1).astype(np.float32),
            "band": np.full(len(ys), band_id, np.uint8), "frame": np.full(len(ys), frame_id, np.int32),
            "geomorphon": grid["geomorphon"][ys, xs], "height": np.clip(grid["height"][ys, xs], -32000, 32000).astype(np.int16),
            "labels": bits[ys, xs], "cover": cov[ys, xs]}


# ---------------------------------------------------------------- fine-band frames

def frame_strata(ref, names):
    """Boolean masks over the reference (finest coarse) grid for the frame-centre strata."""
    land, relief, kop, bits = ref["land"], ref["relief"], ref["koppen"], ref["labels"]
    coast = near_land(land, True) & ~land | land & near_land(~land, True)

    def has(*labs):
        m = np.zeros(land.shape, bool)
        for l in labs:
            if l in names:
                m |= ((bits >> np.uint64(names.index(l))) & np.uint64(1)) > 0
        return m

    strata = {
        "delta": has("delta"),
        "archipelago": coast & has("island group", "island"),
        "strait": has("strait", "fjord", "channel", "sound"),
        "mountain": land & (relief == 2),
        "desert": land & (kop == 2) & (relief == 0),
        "coast": coast,
        "hills": land & (relief == 1),
        "plain": land & (relief == 0),
    }
    taken = np.zeros(land.shape, bool)
    for k in FRAME_STRATA:
        strata[k] &= ~taken
        taken |= strata[k]
    return strata


FRAME_SHARES = {"delta": 2, "archipelago": 1.5, "strait": 1.5, "mountain": 1.5, "desert": 1, "coast": 2, "hills": 1, "plain": 1.5}


def frame_centres(ref, names, n_frames, lat_range, rng, polys=()):
    """(stratum, lon, lat) for n_frames frame centres, spread over the strata by FRAME_SHARES. Delta frames
    go round-robin over the named Natural Earth deltas (a random point in each delta's largest part), so
    every delta is in the sample; the other strata draw random tiles of the reference grid."""
    strata = frame_strata(ref, names)
    fr = ref["frame"]
    lat = fr.lat_max - (np.arange(fr.h) + 0.5) * fr.res
    ok_lat = (lat >= lat_range[0]) & (lat <= lat_range[1])
    out = []
    tot = sum(FRAME_SHARES[k] for k in FRAME_STRATA)
    per = [int(n_frames * FRAME_SHARES[k] / tot) for k in FRAME_STRATA]
    for i in range(n_frames - sum(per)):
        per[FRAME_STRATA.index("coast") if i == 0 else i % len(FRAME_STRATA)] += 1
    deltas = {}
    for p in polys:
        if p["cla"] == "delta" and lat_range[0] <= (p["b"][1] + p["b"][3]) / 2 <= lat_range[1]:
            size = max(p["b"][2] - p["b"][0], p["b"][3] - p["b"][1])
            if p["name"] not in deltas or size > deltas[p["name"]][0]:
                deltas[p["name"]] = (size, p["b"])
    for name, q in zip(FRAME_STRATA, per):
        if name == "delta" and deltas:
            keys = sorted(deltas)
            for i in range(q):
                b = deltas[keys[i % len(keys)]][1]
                out.append((name, b[0] + rng.random() * (b[2] - b[0]), b[1] + rng.random() * (b[3] - b[1])))
            continue
        m = strata[name] & ok_lat[:, None]
        ys, xs = np.nonzero(m)
        if len(ys) == 0:
            continue
        pick = rng.choice(len(ys), size=min(q, len(ys)), replace=False)
        for i in pick:
            out.append((name, fr.lon_min + (xs[i] + rng.random()) * fr.res, fr.lat_max - (ys[i] + rng.random()) * fr.res))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bands", default="0.01,3.0,8", help="MIN,MAX,N log-spaced degrees per tile, or an explicit comma list of tile sizes")
    ap.add_argument("--global-min-deg", type=float, default=0.2, help="bands at or above this tile size enumerate the whole globe from the base rasters; finer bands sample frames with the fine sources")
    ap.add_argument("--frames", type=int, default=48, help="frames per fine band")
    ap.add_argument("--frame-size", type=int, nargs=2, default=[80, 52], metavar=("W", "H"), help="frame size in tiles (the window margin is added)")
    ap.add_argument("--per-band", type=int, default=20000, help="source windows kept per band (0 = all)")
    ap.add_argument("--floor", type=int, default=400, help="windows a (land/coast, rarest label) stratum keeps at least, when it has them")
    ap.add_argument("--window", type=int, default=7, help="window side S (odd)")
    ap.add_argument("--lat", type=float, nargs=2, default=[-60.0, 84.0], metavar=("S", "N"),
                    help="keep windows (and frame centres) in this latitude band (the default leaves Antarctica out)")
    ap.add_argument("--river-class", type=int, default=2, choices=(1, 2, 3), help="rivers of this class or larger mark a tile (1 minor, 2 >= 100 m3/s, 3 >= 1000 m3/s)")
    ap.add_argument("--geo-lookback", type=int, default=5, help="geomorphon lookback, tiles")
    ap.add_argument("--geo-flat", default="auto", help="geomorphon flatness threshold, metres per tile of distance, or auto = --geo-flat-rel times the grid's median land height step (relative, like the relief classes)")
    ap.add_argument("--geo-flat-rel", type=float, default=1.5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--ne-dir", default="", help="directory holding the unzipped Natural Earth sets (rebuilds the label cache)")
    ap.add_argument("--ne-json", default=NE_JSON, help="the Natural Earth label cache")
    ap.add_argument("--out", default=lc.WINDOWS_NPZ)
    args = ap.parse_args()
    S = args.window
    assert S % 2 == 1 and S >= 3
    margin = max(S // 2, args.geo_lookback)
    geo_flat = None if args.geo_flat == "auto" else float(args.geo_flat)
    rng = np.random.default_rng(args.seed)

    parts = [float(v) for v in args.bands.split(",")]
    if len(parts) == 3 and parts[2] >= 2 and float(parts[2]).is_integer() and parts[0] < parts[1]:
        degs = list(np.geomspace(parts[0], parts[1], int(parts[2])))
    else:
        degs = sorted(parts)
    degs = sorted(degs, reverse=True)                     # coarse first: the fine bands need a coarse grid
    # A band's density is snapped so the globe is an even number of tiles wide: then the tile grid and its
    # sub x finer layer grid both have a whole number of rows and the layer grid refines the tiles exactly.
    ppds = [max(2, 2 * int(round(180.0 / d))) / 360.0 for d in degs]
    bands = [{"id": i, "deg_per_tile": 1.0 / ppd, "ppd": ppd, "mode": "globe" if 1.0 / ppd >= args.global_min_deg else "frames"} for i, ppd in enumerate(ppds)]
    for i, b in enumerate(bands):                         # band ranges: geometric midpoints, open at the ends
        b["range"] = [math.sqrt(b["deg_per_tile"] * bands[i + 1]["deg_per_tile"]) if i + 1 < len(bands) else 0.0,
                      math.sqrt(b["deg_per_tile"] * bands[i - 1]["deg_per_tile"]) if i > 0 else float("inf")]

    t0 = time.time()
    polys = ne_load(args.ne_dir, args.ne_json)
    names = sorted({p["cla"] for p in polys})
    assert len(names) <= 63
    print(f"  labels ({len(names)}): {', '.join(names)}")
    rivers = tf.river_shapes(tf.Frame(GLOBE, 1.0, 1))
    print(f"  rivers: {len(rivers)} reaches")

    chunks, grids, frames, ref = [], {}, [], None
    for b in bands:
        tb = time.time()
        d, ppd = b["deg_per_tile"], b["ppd"]
        if b["mode"] == "globe":
            tile = tf.Frame(GLOBE, ppd, 1)
            g = build_grid(tile, False, rivers, args.river_class, args.geo_lookback, geo_flat, wrap=True, geo_flat_rel=args.geo_flat_rel)
            bits = ne_rasterise(tile, polys, names, d)
            cov = coverage(bits, len(names), S, True)
            centre = candidates(g, margin, args.lat, True)
            n_cand = int(centre.sum())
            c = collect(g, bits, cov, centre, S, args.per_band, args.floor, rng, True, d, b["id"], -1)
            chunks.append(c)
            g["labels"] = bits
            for name in ("land", "relief", "koppen", "river", "geomorphon", "labels"):
                grids[f"band{b['id']}_{name}"] = g[name]
            grids[f"band{b['id']}_height"] = np.clip(g["height"], -32000, 32000).astype(np.int16)
            ref = g                                        # the finest coarse grid seeds the fine bands' frames
            land_n = int(g["land"].sum())
            b.update({"tiles": [tile.w, tile.h], "land_tiles": land_n, "candidates": n_cand, "kept": len(c["windows"]), "geo_flat_m": round(g["geo_flat"], 1),
                      "relief_pct": [float((g["relief"][g["land"]] == r).mean()) for r in range(3)], "seconds": round(time.time() - tb, 1)})
            print(f"  band {b['id']} {d:.4g} deg/tile (globe {tile.w}x{tile.h}): {land_n} land tiles, {n_cand} candidates -> {len(c['windows'])} kept; "
                  f"relief {b['relief_pct'][0]:.0%}/{b['relief_pct'][1]:.0%}/{b['relief_pct'][2]:.0%}; {b['seconds']}s")
        else:
            assert ref is not None, "a frames band needs a coarser globe band before it"
            fw, fh = args.frame_size[0] + 2 * margin, args.frame_size[1] + 2 * margin
            cs = frame_centres(ref, names, args.frames, [args.lat[0] + fh * d / 2, args.lat[1] - fh * d / 2], rng, polys)
            band_chunks, n_cand, strata_n = [], 0, {}
            for stratum, lon, lat in cs:
                bounds = [lon - fw * d / 2, lat - fh * d / 2, lon + fw * d / 2, lat + fh * d / 2]
                tile = tf.Frame(bounds, ppd, 1)
                tfr = time.time()
                g = build_grid(tile, True, None, args.river_class, args.geo_lookback, geo_flat, wrap=False, geo_flat_rel=args.geo_flat_rel)
                if g["land"].mean() < 0.03:                # open sea with a rock in it: no relief to speak of
                    continue
                bits = ne_rasterise(tile, polys, names, d)
                cov = coverage(bits, len(names), S, False)
                centre = candidates(g, margin, [-90.0, 90.0], False)
                n_cand += int(centre.sum())
                fid = len(frames)
                frames.append([b["id"], tile.lon_min, tile.lat_min, tile.lon_max, tile.lat_max, FRAME_STRATA.index(stratum),
                               int(centre.sum()), round(time.time() - tfr, 2), round(g["geo_flat"], 1)])
                strata_n[stratum] = strata_n.get(stratum, 0) + 1
                c = collect(g, bits, cov, centre, S, 0, 0, rng, False, d, b["id"], fid)
                if c:
                    band_chunks.append(c)
            cat = {k: np.concatenate([c[k] for c in band_chunks]) for k in band_chunks[0]}
            if args.per_band and len(cat["windows"]) > args.per_band:
                keep = stratified_pick(cat["windows"][:, S // 2, S // 2, 0] > 0, cat["labels"], args.per_band, args.floor, rng)
                cat = {k: v[keep] for k, v in cat.items()}
            chunks.append(cat)
            lab = float((cat["labels"] != 0).mean())
            b.update({"frames": len(band_chunks), "frame_tiles": [fw, fh], "strata": strata_n, "candidates": n_cand, "kept": len(cat["windows"]),
                      "geo_flat_m": round(float(np.median([f[8] for f in frames if f[0] == b["id"]])), 1),
                      "labelled": lab, "seconds": round(time.time() - tb, 1)})
            print(f"  band {b['id']} {d:.4g} deg/tile ({len(band_chunks)} frames of {fw}x{fh}): {n_cand} candidates -> {len(cat['windows'])} kept; "
                  f"{lab:.0%} centres labelled; {b['seconds']}s")

    allc = {k: np.concatenate([c[k] for c in chunks]) for k in chunks[0]}
    win = allc.pop("windows")
    n0 = len(win)
    aug = np.stack([lc.d8(win, t) for t in range(8)], 1).reshape(n0 * 8, S, S, 4)   # rows 8i..8i+7
    meta = {
        "window": S, "bands": bands, "global_min_deg": args.global_min_deg, "frames_per_band": args.frames, "frame_size": args.frame_size,
        "per_band": args.per_band, "floor": args.floor, "seed": args.seed, "lat": args.lat, "river_class": args.river_class,
        "geo_lookback": args.geo_lookback, "geo_flat": args.geo_flat, "geo_flat_rel": args.geo_flat_rel,
        "relief": {"blend_hill": P_BLEND_HILL, "blend_peak": P_BLEND_PEAK, "hill": P_HILL, "peak": P_PEAK},
        "label_filter": "polygon part at least 2 tiles across and scalerank <= 3 (>= 2 deg/tile), 6 (>= 0.5), any (finer); burned all-touched",
        "raw_channels": list(lc.RAW_CHANNELS), "koppen_groups": list(lc.KOPPEN_GROUPS), "geomorphons": list(lc.GEOMORPHON_NAMES),
        "frame_strata": list(FRAME_STRATA), "frame_shares": FRAME_SHARES, "frame_columns": ["band", "W", "S", "E", "N", "stratum", "candidates", "seconds", "geo_flat_m"],
        "sources": "elev_4096 / hgt_tiles (ETOPO 2022), koppen_2048 / koppen_tiles (Beck 2023), coast_10m + lakes_10m + playas / coast_tiles (OSM, ODbL) + lakes_hires, river_tiles (HydroRIVERS), Natural Earth 10m physical labels",
        "built": time.strftime("%Y-%m-%d"), "seconds": round(time.time() - t0, 1),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    np.savez_compressed(
        args.out,
        windows=aug,
        transform=np.tile(np.arange(8, dtype=np.uint8), n0),
        src=np.repeat(np.arange(n0, dtype=np.int32), 8),
        label_names=np.array(names),
        frames=np.array(frames, np.float64).reshape(-1, 9),
        meta=np.array(json.dumps(meta)),
        **allc, **grids,
    )
    print(f"{n0} source windows x 8 = {len(aug)} rows, {len(frames)} fine frames -> {os.path.relpath(args.out, ROOT)} "
          f"({os.path.getsize(args.out) / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
    for b in bands:
        m = allc["band"] == b["id"]
        bits = allc["labels"][m]
        present = [(names[j], int(((bits >> np.uint64(j)) & np.uint64(1)).sum())) for j in range(len(names))]
        present = [f"{n} {c}" for n, c in present if c >= 20]
        print(f"  band {b['id']} {b['deg_per_tile']:.4g} deg/tile: {int(m.sum())} windows, {(bits != 0).mean():.0%} labelled; labels with >= 20 windows: {', '.join(present)}")


if __name__ == "__main__":
    main()
