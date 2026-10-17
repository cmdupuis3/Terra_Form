#!/usr/bin/env python3
"""
score_city_sites.py -- choose each city site's window before it is exported.

The plan is the game's docs/CITY-SITE-SCORE-PLAN.md. For each seat a survey of the ground around it (GLO-90
heights, OSM land, HydroLAKES, HydroRIVERS, Koppen, at 90 m over SURVEY_KM) is classified (mainland, island,
rim atoll, lagoon group) and searched for the window that scores best:

  * a gate: buildable ground (land, gentle slope) at least FLOOR of the city core (the 3.07 km capture of
    CITY-SITE-VIEW), credit rising to FULL;
  * interest: relief, coast, rivers, lakes, climate mix, room around the core;
  * layout: mountains toward the edges, no range through the city, the sea off-centre with a little on the
    rim, a cost for moving the window from the seat;
  * atolls: the land-rich bend framed with the arms running off the map, broadened across the strip;
    lagoon groups: the high islands framed with the barrier reef out of view; islands: expanded to fill.

The best mainland candidates are refined at 30 m (GLO-30, heights opened to strip roofs and canopy, a
parcel-width test, connected ground). Writes <report>/<id>.json, <id>.png and <report>/frames.json, which
export_city_sites.py --frames reads.

  python games/culture_wars/score_city_sites.py --pack <Unity>/Assets/StreamingAssets/WorldPacks/earth16k \\
      --report <Unity>/Artifacts/CitySiteScores --seats 171,62,650,1907
"""
import argparse, json, math, os, sys, time
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import export_city_sites as ex                                  # noqa: E402

SURVEY_KM = 52.0
ATOLL_SURVEY_KM = 72.0        # an atoll's corner can be 25 km from its seat (Tarawa)
RES = 90.0                    # survey lattice, metres
FINE = 3                      # land is burned at RES / FINE (30 m) and averaged, so atoll strips are not lost
WINDOW_KM = 36.0              # the mainland window (the testbeds' span)
CORE_HALF_M = 4608.0          # the city capture: 256 cells of 36 m (CityScreen.MetresPerUnit since 2026-10-11; was 12 m)
INNER_HALF_M = 4050.0         # the inner ring (the 30 m mesh)

DEFAULT_WEIGHTS = {
    "floor": 0.10, "full": 0.30,                       # buildable share of the core: gate, full credit
    "slopeFull": 8.0, "slopeHalf": 15.0,               # degrees: counts whole below, half below, none above
    # Interest: what makes the site worth looking at. It ranks sites and is measured once, on the window
    # centred on the seat, so the nudge is not dragged toward whatever is interesting (LA toward its sea).
    "relief": 0.25, "coast": 0.20, "rivers": 0.20, "lakes": 0.05, "climate": 0.10,
    # Layout: where things sit in the window; these steer the nudge.
    "room": 0.20, "environs": 0.30, "buildable": 0.20,
    "mountainsEdge": 0.30, "edgeMountains": 0.30, "edgeMountainsFull": 0.20, "framing": 0.10, "seaPlace": 0.10, "seaRim": 0.05, "seaRimFull": 0.01,
    "sliced": 0.5, "ridge": 0.6, "seaCore": 0.5,       # penalties
    "nudgeFree": 2.0, "nudgeScale": 2.0, "nudgeCost": 0.15, "nudgeCap": 4.05,   # km; the seat stays in the inner ring
    "atollTargetWidthM": 900.0, "atollGrowCap": 8.0, "islandScaleCap": 6.0, "islandRim": 0.12,
    "atollSpans": [12, 16, 20, 24, 28, 32, 36], "atollNudgeCap": 16.0,
    "highIslandM": 30.0,          # a lagoon's island this tall is a high island (palm canopy on a reef islet reaches ~20 m)
    "islandGroupGapKm": 6.0,      # high islands this close chain into one group (Chuuk's; not Bora Bora with Taha'a)
    # Where high islands stand (a lagoon), the low ones are thickened much less: the high island is the site's land,
    # and a full atoll width made Bora Bora's motus look off (the user, 2026-10-11).
    "highSiteLowWidthM": 350.0, "highSiteGrowCap": 3.0,
    "lagoonMarginKm": 2.0, "lagoonSpanCap": 44.0,   # a lagoon's window grows to fit all its inner islands (Chuuk's span 38 km)
}


# ---------------------------------------------------------------- the survey

class Survey:
    """The ground around a seat on a RES lattice in the seat's local frame (true metres). Arrays are row 0 north."""

    def __init__(self, seat, cache, log, km=SURVEY_KM):
        self.seat = seat
        lat, lon = seat["lat"], seat["lon"]
        n = ex.outer_samples(km)
        self.n = n
        self.frame = ex.Frame(lat, lon, n, RES)
        fine = ex.Frame(lat, lon, (n - 1) * FINE + 1, RES / FINE)
        bounds = self.frame.lonlat_bounds(pad_m=500)
        t0 = time.time()
        self.h = ex.read_copernicus(self.frame, "outer", cache, log).astype(np.float64)
        land_polys = [fine.to_local(g) for g in ex.tileset_polys("coast_tiles", bounds)]
        land_f = ex.burn(fine, [(g, 1) for g in land_polys])
        small = [g for g in land_polys if ex.local_area_km2(g) < ex.SMALL_LAND_KM2]
        if small:
            land_f |= ex.burn(fine, [(g, 1) for g in small], all_touched=True)
        self.land_fine = land_f.astype(bool)
        self.land = nd.uniform_filter(land_f.astype(np.float64), FINE)[::FINE, ::FINE]
        lakes = [self.frame.to_local(g) for g in ex.tileset_polys("lake_tiles", bounds)]
        self.lake = (ex.burn(self.frame, [(g, 1) for g in lakes]) == 1) & (self.land > 0.5)
        playas = [self.frame.to_local(g) for g in ex.playa_polys(bounds)]
        self.salt = ex.burn(self.frame, [(g, 1) for g in playas]) == 1
        self.koppen = ex.fill_nearest(ex.burn(self.frame, [(self.frame.to_local(g), v) for g, v in ex.koppen_polys(bounds)]))
        reaches = ex.hydro_reaches(bounds)
        shapes = []
        for g, d in reaches:
            w = 3 if d >= 100 else (2 if d >= 10 else 1)
            shapes.append((self.frame.to_local(g), w))
        self.river = np.zeros((n, n))
        if shapes:
            # Strongest class wins a cell: burn the weak ones first.
            for w in (1, 2, 3):
                cells = ex.burn(self.frame, [(g, 1) for g, ww in shapes if ww == w], all_touched=True) == 1
                self.river[cells] = {1: 0.3, 2: 0.6, 3: 1.0}[w]
        self.river *= self.land > 0.3
        self.sea = 1.0 - self.land
        self.derive()
        log(f"  survey {n}x{n} at {RES:.0f} m ({km:.0f} km) {time.time() - t0:.1f} s; land {100 * self.land.mean():.0f}%")

    def derive(self, weights=DEFAULT_WEIGHTS):
        h = np.where(self.land > 0.5, self.h, np.minimum(self.h, 0.0))
        gy, gx = np.gradient(h, RES, RES)
        self.slope = np.degrees(np.arctan(np.hypot(gx, gy)))
        self.rugged = ruggedness(h, RES)
        # Height over the lowland within 5 km: a mountain stands over its surroundings, wherever the city's floor is.
        base = nd.minimum_filter(np.where(self.land > 0.5, h, 0.0), size=int(10000 / RES) | 1)
        self.above = h - base
        self.mountain = (self.land > 0.5) & (((self.above > 300) & (self.slope > 12)) | (self.rugged >= 0.5))
        sw = np.where(self.slope <= weights["slopeFull"], 1.0, np.where(self.slope <= weights["slopeHalf"], 0.5, 0.0))
        self.build = self.land * sw * (~self.lake) * (~self.salt)


def broaden_mask(land_fine, r, target_half_m, max_factor):
    """export_city_sites.broaden_land on a raster: the land widened about its centre line to 2 target_half_m,
    each shore pushed out by target_half_m - h (h: the local centre line's depth), at most (max_factor - 1) h."""
    depth = nd.distance_transform_edt(land_fine) * r
    h = nd.maximum_filter(depth, size=int(2 * target_half_m / r) | 1)
    grow = np.where(land_fine, np.clip(target_half_m - h, 0.0, (max_factor - 1.0) * h), 0.0)
    dist, (iy, ix) = nd.distance_transform_edt(~land_fine, return_indices=True)
    return land_fine | (dist * r <= grow[iy, ix])


def with_land(survey, land_fine):
    """A copy of the survey with other land (an atoll's broadened), heights on the new land the nearest old land's."""
    import copy
    s = copy.copy(survey)
    s.land_fine = land_fine
    s.land = nd.uniform_filter(land_fine.astype(np.float64), FINE)[::FINE, ::FINE]
    s.sea = 1.0 - s.land
    old = survey.land > 0.5
    if old.any():
        _, (iy, ix) = nd.distance_transform_edt(~old, return_indices=True)
        add = (s.land > 0.5) & ~old
        h = survey.h.copy()
        h[add] = np.maximum(survey.h[iy, ix][add], 2.0)
        s.h = h
    s.derive()
    return s


def ruggedness(h, res, full=0.35):
    """CitySiteFields.Ruggedness: mean |dh| to the 8 neighbours per metre, averaged 5x5, 1 at `full`."""
    p = np.pad(h, 1, mode="edge")
    n0, n1 = h.shape
    tri = np.zeros_like(h)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            if di or dj:
                tri += np.abs(p[1 + dj:1 + dj + n0, 1 + di:1 + di + n1] - h)
    tri /= 8 * res
    return np.clip(nd.uniform_filter(tri, 5, mode="nearest") / full, 0, 1)


# ---------------------------------------------------------------- warping a survey (atolls, islands)

def warped(survey, M, vscale=1.0):
    """A copy of the survey resampled into map space, where true = M @ map about the seat."""
    s = Survey.__new__(Survey)
    s.seat, s.n, s.frame = survey.seat, survey.n, survey.frame
    n = survey.n
    c = (n - 1) / 2.0
    jj, ii = np.mgrid[0:n, 0:n]
    x = (ii - c) * RES; y = (c - jj) * RES                    # map metres
    tx = M[0, 0] * x + M[0, 1] * y; ty = M[1, 0] * x + M[1, 1] * y
    ti = tx / RES + c; tj = c - ty / RES                       # true lattice coordinates
    def samp(a, order=1, cval=0.0):
        return nd.map_coordinates(a.astype(np.float64), [tj, ti], order=order, mode="constant", cval=cval)
    # Fine land in map space (FINE samples a map cell), then averaged to the lattice like the survey's own.
    nf = survey.land_fine.shape[0]; cf = (nf - 1) / 2.0
    jf, i_f = np.mgrid[0:nf, 0:nf]
    xf = (i_f - cf) * RES / FINE; yf = (cf - jf) * RES / FINE
    txf = M[0, 0] * xf + M[0, 1] * yf; tyf = M[1, 0] * xf + M[1, 1] * yf
    s.land_fine = nd.map_coordinates(survey.land_fine.astype(np.float64), [cf - tyf / (RES / FINE), txf / (RES / FINE) + cf], order=0, mode="constant") > 0.5
    s.land = nd.uniform_filter(s.land_fine.astype(np.float64), FINE)[::FINE, ::FINE]
    h = samp(survey.h)
    s.h = np.where(h > 0, h * vscale, h)
    s.lake = samp(survey.lake, 0) > 0.5
    s.salt = samp(survey.salt, 0) > 0.5
    s.koppen = samp(survey.koppen, 0).astype(np.uint8)
    s.river = samp(survey.river, 0)
    s.sea = 1.0 - s.land
    s.derive()
    return s


# ---------------------------------------------------------------- one window's terms

def radial(nw):
    """Chebyshev distance from the window centre over the half-width, 0..1, for an nw x nw window."""
    c = (nw - 1) / 2.0
    j, i = np.mgrid[0:nw, 0:nw]
    return np.maximum(np.abs(i - c), np.abs(j - c)) / c


def ramp_weight(r, lo=0.25, hi=0.6):
    """-1 inside lo, +1 outside hi, linear between: where mass is welcome (edges) and not (centre)."""
    return np.clip((r - lo) / (hi - lo), 0, 1) * 2 - 1


def band(x, lo0, lo1, hi1, hi0):
    """1 between lo1 and hi1, tapering to 0 at lo0 and hi0."""
    if x <= lo0 or x >= hi0:
        return 0.0
    if x < lo1:
        return (x - lo0) / (lo1 - lo0)
    if x > hi1:
        return (hi0 - x) / (hi0 - hi1)
    return 1.0


def window_terms(sv, ci, cj, nw, R, W, refine=None):
    """All the mainland terms for the nw x nw window centred on survey cell (cj, ci)."""
    k = (nw - 1) // 2
    sl = np.s_[cj - k:cj + k + 1, ci - k:ci + k + 1]
    land, sea, build, mtn, h = sv.land[sl], sv.sea[sl], sv.build[sl], sv.mountain[sl], sv.h[sl]
    kc = int(round(CORE_HALF_M / RES)); ki = int(round(INNER_HALF_M / RES))
    core = np.s_[k - kc:k + kc + 1, k - kc:k + kc + 1]
    inner = np.s_[k - ki:k + ki + 1, k - ki:k + ki + 1]
    t = {}
    B = float(build[core].mean()) if refine is None else refine
    t["B"] = B
    t["gate"] = B >= W["floor"]
    t["buildable"] = float(np.clip((B - W["floor"]) / (W["full"] - W["floor"]), 0, 1))
    lm = land > 0.5
    if lm.sum() > 10:
        hl = h[lm]
        rng = float(np.percentile(hl, 95) - np.percentile(hl, 5))
        rg = float(np.percentile(sv.rugged[sl][lm], 75))
    else:
        rng, rg = 0.0, 0.0
    t["relief"] = 0.5 * min(1.0, rng / 1500.0) + 0.5 * min(1.0, rg / 0.5)
    seaShare = float(sea.mean())
    edges = (np.count_nonzero(lm[1:, :] != lm[:-1, :]) + np.count_nonzero(lm[:, 1:] != lm[:, :-1])) * RES / 1000.0
    t["seaShare"] = seaShare
    t["coastKm"] = edges
    t["coast"] = min(1.0, edges / 40.0) * band(seaShare, 0.0, 0.03, 0.25, 0.5)
    riv = sv.river[sl]
    rkm = float(riv[inner].sum()) * RES / 1000.0
    near = int(round(1500 / RES))
    t["riversKm"] = rkm
    t["rivers"] = min(1.0, rkm / 15.0 + (0.3 if riv[k - near:k + near + 1, k - near:k + near + 1].any() else 0.0))
    lakeShare = float(sv.lake[sl].mean())
    t["lakes"] = band(lakeShare, 0.0, 0.01, 0.15, 0.3)
    kv = sv.koppen[sl][lm]
    if kv.size:
        _, cnt = np.unique(kv[kv > 0], return_counts=True)
        p = cnt / cnt.sum() if cnt.size else np.array([1.0])
        t["climate"] = float(min(1.0, -(p * np.log(p)).sum() / math.log(3)))
    else:
        t["climate"] = 0.0
    ring = np.ones((2 * ki + 1, 2 * ki + 1), bool)
    ring[ki - kc:ki + kc + 1, ki - kc:ki + kc + 1] = False
    t["room"] = min(1.0, float(build[inner][ring].mean()) / 0.4)
    # Environs: buildable ground over the whole window (the city's surroundings, fields, the camp), credit to 80%.
    t["environs"] = min(1.0, float(build.mean()) / 0.8)
    # Layout.
    m = mtn.astype(np.float64)
    wm = ramp_weight(R)
    t["mountainsEdge"] = 1.0 if m.sum() < 1 else 0.5 * (1 + float((m * wm).sum() / m.sum()))   # none: nothing misplaced
    # Ranges on the edges (the user: mountain ranges favoured on the map's edges): mountain share of the outer
    # band, full at edgeMountainsFull. mountainsEdge only judges where the mountains in view sit; this one
    # brings a range just outside the window (LA's San Gabriels) in to the edge.
    outer = R >= 0.7
    t["edgeMountains"] = min(1.0, float(mtn[outer].mean()) / W["edgeMountainsFull"])
    perim = R >= 0.85
    t["framing"] = float((mtn[perim] | (sea[perim] > 0.5)).mean())
    t["seaPlace"] = 1.0 if sea.sum() < 1 else 0.5 * (1 + float((sea * ramp_weight(R, 0.2, 0.7)).sum() / sea.sum()))
    rim = float(sea[R >= 0.7].sum() / sea.size)
    # A little sea on the rim, for character (the user, 2026-10-11): full at seaRimFull of the window, gone past 10% sea.
    t["seaRim"] = min(rim, W["seaRimFull"]) / W["seaRimFull"] * (1.0 if seaShare <= 0.10 else max(0.0, 1 - (seaShare - 0.10) / 0.15))
    # Penalties: the city sliced, a range through it, the sea in the core.
    bi = build[inner] >= 0.5
    lab, nlab = nd.label(bi)
    share = 1.0 if nlab == 0 else float(np.bincount(lab.ravel())[1:].max() / bi.sum())
    t["largestPiece"] = share
    t["sliced"] = float(np.clip((0.85 - share) / 0.35, 0, 1) ** 2)
    mi = nd.binary_dilation(mtn[inner], iterations=2)
    lab, nlab = nd.label(mi)
    ridge = 0.0
    if nlab:
        cen = np.zeros_like(mi); r2 = int(round(2000 / RES))
        cen[ki - r2:ki + r2 + 1, ki - r2:ki + r2 + 1] = True
        for q in range(1, nlab + 1):
            comp = lab == q
            if not (comp & cen).any():
                continue
            if (comp[0, :].any() and comp[-1, :].any()) or (comp[:, 0].any() and comp[:, -1].any()):
                ridge = 1.0
                break
    t["ridge"] = ridge
    sc = float(sea[core].mean())
    t["seaCore"] = float(np.clip((sc - 0.3) / 0.3, 0, 1))
    t["perimSea"] = float((sea[perim] > 0.5).mean())
    return t


INTEREST = ("relief", "coast", "rivers", "lakes", "climate")
LAYOUT = ("room", "environs", "buildable", "mountainsEdge", "edgeMountains", "framing", "seaPlace", "seaRim")
PENALTIES = ("sliced", "ridge", "seaCore")


def combine(t, W, dist_km):
    t["interest"] = sum(W[k] * t[k] for k in INTEREST) / sum(W[k] for k in INTEREST)
    t["layout"] = sum(W[k] * t[k] for k in LAYOUT) - sum(W[k] * t[k] for k in PENALTIES)
    s = t["layout"]
    if W.get("_island"):                       # an island's map has the sea all round it (CITY-SITE-SCORE-PLAN 4a)
        s -= 2.0 * max(0.0, 0.8 - t["perimSea"])
    nudge = 0.0 if dist_km <= W["nudgeFree"] else W["nudgeCost"] * ((dist_km - W["nudgeFree"]) / W["nudgeScale"]) ** 2
    t["nudge"] = nudge
    t["score"] = s - nudge
    return t["score"] if t["gate"] else t["score"] - 10.0


# ---------------------------------------------------------------- classification

def land_axis(sv, radius_m):
    """PCA of the fine land within radius_m of the seat: (major unit vector, minor unit vector, mean width m,
    length m, area m2) in true metres, x east, y north; None if no land."""
    nf = sv.land_fine.shape[0]; cf = (nf - 1) // 2; f = RES / FINE
    r = int(radius_m / f)
    sub = sv.land_fine[cf - r:cf + r + 1, cf - r:cf + r + 1]
    jj, ii = np.nonzero(sub)
    if len(ii) < 10:
        return None
    x = (ii - r) * f; y = (r - jj) * f
    keep = x * x + y * y <= radius_m * radius_m
    x, y = x[keep], y[keep]
    if len(x) < 10:
        return None
    P = np.vstack([x, y])
    ev, evec = np.linalg.eigh(np.cov(P))
    major, minor = evec[:, 1], evec[:, 0]
    L = float(np.ptp(major @ P)) + f
    A = len(x) * f * f
    return major, minor, A / L, L, A


def in_atoll_region(lat, lon):
    path = os.path.join(ex.DATA, "island_regions.json")
    if not os.path.exists(path):
        return False
    for r in json.load(open(path, encoding="utf-8"))["regions"]:
        w, s, e, n = r["bounds"]
        if w <= lon <= e and s <= lat <= n:
            return True
    return False


def seat_component(sv):
    """The fine land component the seat stands on (or the nearest one), labelled; (labels, id)."""
    lab, _ = nd.label(sv.land_fine, structure=np.ones((3, 3)))
    nf = lab.shape[0]; cf = (nf - 1) // 2
    if lab[cf, cf]:
        return lab, lab[cf, cf]
    d, (iy, ix) = nd.distance_transform_edt(lab == 0, return_indices=True)
    return lab, lab[iy[cf, cf], ix[cf, cf]]


def classify(sv, W):
    lat, lon = sv.seat["lat"], sv.seat["lon"]
    ax = land_axis(sv, 2500)
    atoll_region = in_atoll_region(lat, lon)
    nf = sv.land_fine.shape[0]; cf = (nf - 1) // 2
    k36 = int(WINDOW_KM * 500 / (RES / FINE))
    share36 = float(sv.land_fine[cf - k36:cf + k36 + 1, cf - k36:cf + k36 + 1].mean())
    info = {"atollRegion": atoll_region, "landShare36": share36}
    if ax is not None:
        info["meanWidthM"] = ax[2]
    thin = ax is not None and ax[2] < 500
    if thin and (atoll_region or share36 < 0.10):
        return "atoll", info
    lab, cid = seat_component(sv)
    comp = lab == cid
    touches = comp[0, :].any() or comp[-1, :].any() or comp[:, 0].any() or comp[:, -1].any()
    # A lagoon group: the seat's island stands inside a ring of other land (a barrier reef's islets).
    others = (lab > 0) & ~comp
    if others.any() and not touches:
        jj, ii = np.nonzero(others[::4, ::4])
        pts = np.vstack([ii * 4 - cf, cf - jj * 4]).T.astype(float)
        if len(pts) >= 10:
            from scipy.spatial import ConvexHull, Delaunay
            try:
                hull = ConvexHull(pts)
                inside = Delaunay(pts[hull.vertices]).find_simplex([[0.0, 0.0]])[0] >= 0
                land_in_hull = (lab > 0).sum() / max(hull.volume, 1.0)
                npieces = len(np.unique(lab[others]))
                info.update({"hullLandShare": float(land_in_hull), "pieces": int(npieces)})
                if inside and land_in_hull < 0.2 and npieces >= 5:
                    return "lagoon", info
            except Exception:
                pass
    if not touches:
        jj, ii = np.nonzero(comp)
        f = RES / FINE
        ext = max(np.ptp(ii), np.ptp(jj)) * f
        info["islandExtentKm"] = ext / 1000.0
        return "island", info
    return "mainland", info


# ---------------------------------------------------------------- the searches

def nearest_land_cell(sv):
    """The survey cell (i, j) of the seat, or of the land nearest it: where the city stands."""
    c = (sv.n - 1) // 2
    land = sv.land > 0.5
    if land[c, c]:
        return c, c
    _, (iy, ix) = nd.distance_transform_edt(~land, return_indices=True)
    return int(ix[c, c]), int(iy[c, c])


def search_mainland(sv, W, nw, cap_km, centre=(0, 0), step=3, refine=None, log=print):
    """Every window centre within cap_km (Chebyshev) of `centre` (map metres from the seat) on a `step`-cell
    grid: [(score, ci, cj, terms)], best first."""
    c = (sv.n - 1) // 2
    k = (nw - 1) // 2
    R = radial(nw)
    cap = int(cap_km * 1000 / RES)
    c0i, c0j = c + int(round(centre[0] / RES)), c - int(round(centre[1] / RES))
    out = []
    site = window_terms(sv, c0i, c0j, nw, R, W)                  # the site's interest, measured once
    for dj in range(-cap, cap + 1, step):
        for di in range(-cap, cap + 1, step):
            ci, cj = c0i + di, c0j + dj
            if ci - k < 0 or cj - k < 0 or ci + k >= sv.n or cj + k >= sv.n:
                continue
            t = window_terms(sv, ci, cj, nw, R, W)
            for key in INTEREST + ("coastKm", "riversKm"):
                t[key] = site[key]
            dist = math.hypot((ci - c) * RES, (cj - c) * RES) / 1000.0
            out.append((combine(t, W, dist), ci, cj, t))
    out.sort(key=lambda q: -q[0])
    return out


def refine_core(seat, cache, off_e_km, off_n_km, W, log):
    """The core's buildable share at 30 m: GLO-30, opened over 150 m (roofs and canopy out), the slope rule,
    a 60 m parcel-width opening, and pieces of at least 4 ha. Land from the coast tiles at 30 m."""
    lat = seat["lat"] + off_n_km / 111.32
    lon = seat["lon"] + off_e_km / (111.32 * math.cos(math.radians(seat["lat"])))
    n = int(round(2 * CORE_HALF_M / 30.0)) | 1
    fr = ex.Frame(lat, lon, n, 30.0)
    h = ex.read_copernicus(fr, "inner", cache, lambda *_: None).astype(np.float64)
    bounds = fr.lonlat_bounds(pad_m=300)
    polys = [fr.to_local(g) for g in ex.tileset_polys("coast_tiles", bounds)]
    land = ex.burn(fr, [(g, 1) for g in polys]) == 1
    lakes = [fr.to_local(g) for g in ex.tileset_polys("lake_tiles", bounds)]
    if lakes:
        land &= ex.burn(fr, [(g, 1) for g in lakes]) == 0
    ho = nd.grey_opening(h, size=5)
    gy, gx = np.gradient(ho, 30.0, 30.0)
    sl = np.degrees(np.arctan(np.hypot(gx, gy)))
    full = land & (sl <= W["slopeFull"]); half = land & (sl > W["slopeFull"]) & (sl <= W["slopeHalf"])
    ok = nd.binary_opening(full | half, structure=np.ones((2, 2)))
    lab, nlab = nd.label(ok)
    if nlab:
        sizes = np.bincount(lab.ravel()); sizes[0] = 0
        ok &= sizes[lab] * 900 >= 4e4
    w = np.where(ok & full, 1.0, np.where(ok & half, 0.5, 0.0))
    return float(w.mean())


def bend_point(sv, radius_km=30.0, falloff_m=60000.0, simplify_m=800.0):
    """The atoll's main corner near the seat, (strength, x, y, turn degrees) in true metres from the seat, or
    None. Candidates are the vertices of the rim's convex hull (simplified by simplify_m): the extreme points,
    so a point on an arm a few km short of the corner, or a lagoon islet, never qualifies. A vertex is a
    corner when the rim land 1-5 km from it lies in two directions (an arm's end, Betio, has one); its turn
    is 180 less the angle between them. The sharpest corner wins, weighted by distance from the seat."""
    import shapely
    from scipy.spatial import ConvexHull
    rim = seat_rim(sv)
    n = rim.shape[0]; c = (n - 1) // 2
    jj, ii = np.nonzero(rim & (sv.land > 0.05))
    if len(ii) < 10:
        return None
    x = (ii - c) * RES; y = (c - jj) * RES
    pts = np.vstack([x, y]).T
    hull = ConvexHull(pts)
    verts = np.asarray(shapely.Polygon(pts[hull.vertices]).simplify(simplify_m).exterior.coords)[:-1]
    best = None
    for v in verts:
        if math.hypot(*v) > radius_km * 1000:
            continue
        dx, dy = x - v[0], y - v[1]
        d2 = dx * dx + dy * dy
        sel = (d2 >= 1000 ** 2) & (d2 <= 8000 ** 2)
        if sel.sum() < 8:
            continue
        ang = np.degrees(np.arctan2(dy[sel], dx[sel])) % 360
        hist, _ = np.histogram(ang, bins=36, range=(0, 360))
        hist = nd.uniform_filter1d(hist.astype(float), 3, mode="wrap")
        a1 = int(np.argmax(hist))
        h2 = hist.copy()
        for k in range(-4, 5):
            h2[(a1 + k) % 36] = 0
        a2 = int(np.argmax(h2))
        if h2[a2] < 0.25 * hist[a1]:
            continue                                                     # one arm: an end, not a corner
        def mean_dir(a):
            dd = (ang - (a * 10 + 5) + 180) % 360 - 180
            m = np.abs(dd) <= 40
            return (a * 10 + 5) + float(np.degrees(np.arctan2(np.sin(np.radians(dd[m])).mean(), np.cos(np.radians(dd[m])).mean())))
        sep = abs(mean_dir(a1) - mean_dir(a2)) % 360
        sep = min(sep, 360 - sep)
        turn = 180.0 - sep
        if turn < 30:
            continue
        # Weighted by the shorter arm: an islet's hooked tip (Betio) has a second arm a km or two long.
        strength = turn * min(hist[a1], h2[a2]) * math.exp(-math.hypot(*v) / falloff_m)
        if best is None or strength > best[0]:
            best = (float(strength), float(v[0]), float(v[1]), float(turn))
    return best


def seat_rim(sv):
    """The atoll rim the seat stands on: the land closed across reef gaps of up to about 1.2 km, the component
    holding (or nearest) the seat. Computed on the true ground, before any stretch widens the gaps."""
    c = (sv.n - 1) // 2
    # Any land at all, grown a cell: a causeway or a strip a few tens of metres wide is a few percent of a
    # 90 m cell (Betio-Bairiki's join to the rest of South Tarawa).
    rim = nd.binary_closing(nd.binary_dilation(sv.land > 0.05), iterations=7)
    lab, _ = nd.label(rim)
    if lab[c, c]:
        return lab == lab[c, c]
    _, (iy, ix) = nd.distance_transform_edt(lab == 0, return_indices=True)
    return lab == lab[iy[c, c], ix[c, c]]


def rim_axis(sv, rim, radius_m=10000.0):
    """The strip's direction where the city stands: PCA of the rim's land within radius_m of the seat (true
    metres): (major, minor) unit vectors."""
    c = (sv.n - 1) // 2
    jj, ii = np.nonzero(rim & (sv.land > 0.05))
    x = (ii - c) * RES; y = (c - jj) * RES
    keep = x * x + y * y <= radius_m * radius_m
    P = np.vstack([x[keep], y[keep]])
    wts = sv.land[jj[keep], ii[keep]]
    m = (P * wts).sum(1) / wts.sum()
    Q = (P - m[:, None]) * np.sqrt(wts)
    ev, evec = np.linalg.eigh(Q @ Q.T)
    return evec[:, 1], evec[:, 0]


def warp_mask(mask, M):
    """A true-space survey mask resampled into map space (true = M @ map about the seat), nearest."""
    n = mask.shape[0]; c = (n - 1) / 2.0
    jj, ii = np.mgrid[0:n, 0:n]
    x = (ii - c) * RES; y = (c - jj) * RES
    tx = M[0, 0] * x + M[0, 1] * y; ty = M[1, 0] * x + M[1, 1] * y
    return nd.map_coordinates(mask.astype(np.float64), [c - ty / RES, tx / RES + c], order=0, mode="constant") > 0.5


def boundary_exits(mask):
    """The runs of `mask` along the window's boundary (clockwise from the top-left): a list of each run's
    side (0 north, 1 east, 2 south, 3 west), by its middle cell."""
    n = mask.shape[0]
    b = np.concatenate([mask[0, :], mask[1:, -1], mask[-1, -2::-1], mask[-2:0:-1, 0]])
    side = np.concatenate([np.zeros(n), np.ones(n - 1), np.full(n - 1, 2), np.full(n - 2, 3)]).astype(int)
    if not b.any():
        return []
    if b.all():
        return [0]
    shift = int(np.argmin(b))                                    # start the walk on a gap
    bb = np.roll(b, -shift); ss = np.roll(side, -shift)
    out = []; start = None
    for i, v in enumerate(bb):
        if v and start is None:
            start = i
        if not v and start is not None:
            out.append(int(ss[(start + i - 1) // 2])); start = None
    if start is not None:
        out.append(int(ss[(start + len(bb) - 1) // 2]))
    return out


def search_atoll(sv, W, log, seat_rim_mask, bend, city):
    """Rim atolls (CITY-SITE-SCORE-PLAN 4a), on the broadened land at true scale. The city stays at `city`
    (survey cells); the window moves around it, keeping the city's inner ring inside: the atoll's main corner
    toward one side, the arms leaving through the other sides, as much of the atoll's land in view as the
    window can take, a little preference for zooming in, never the whole ring."""
    c = (sv.n - 1) // 2
    cic, cjc = city
    jj, ii = np.mgrid[0:sv.n, 0:sv.n]
    near = np.hypot(ii - c, jj - c) * RES <= 30000
    atoll_land = float((sv.land * near).sum()) or 1.0
    kc = int(round(CORE_HALF_M / RES)); ki = int(round(INNER_HALF_M / RES))
    B = float(sv.build[cjc - kc:cjc + kc + 1, cic - kc:cic + kc + 1].mean())
    # Placing the corner at an edge only means something when the corner is away from the city: Tarawa's is 24 km
    # off; Funafuti's is where the city stands, and chasing the edge with it pushed the window off the atoll's land.
    far_bend = bend is not None and max(abs(bend[1] / RES - (cic - c)), abs(-bend[2] / RES - (cjc - c))) * RES > INNER_HALF_M + 2000
    out = []
    step = 3
    for span in W["atollSpans"]:
        nw = ex.outer_samples(span)
        k = (nw - 1) // 2
        room = k - ki
        if room < 0:
            continue
        for dj in range(-room, room + 1, step):
            for di in range(-room, room + 1, step):
                ci, cj = cic + di, cjc + dj
                if ci - k < 0 or cj - k < 0 or ci + k >= sv.n or cj + k >= sv.n:
                    continue
                sl = np.s_[cj - k:cj + k + 1, ci - k:ci + k + 1]
                rm = seat_rim_mask[sl]
                exits = boundary_exits(rm)
                whole = 1.0 if (not exits and seat_rim_mask.sum() == rm.sum()) else 0.0
                captured = float((sv.land[sl] * near[sl]).sum()) / atoll_land
                corner, bend_side = 1.0, None                            # no corner to place: nothing misplaced
                if bend is not None and far_bend:
                    corner = 0.0
                    bx, by = bend[1] / RES - (ci - c), -bend[2] / RES - (cj - c)    # bend from the window centre, cells (x east, y down)
                    rb = max(abs(bx), abs(by)) / k
                    if rb <= 0.97:
                        corner = float(np.clip((rb - 0.4) / 0.25, 0, 1))
                        bend_side = (1 if bx > 0 else 3) if abs(bx) >= abs(by) else (2 if by > 0 else 0)
                other = [e for e in exits if e != bend_side]
                arms = min(len(other), 2) / 2.0
                q = {"span": span, "ci": ci, "cj": cj, "B": B, "exits": exits, "whole": whole, "captured": captured,
                     "corner": corner, "arms": arms, "gate": B >= W["floor"]}
                q["landTerm"] = captured
                q["buildable"] = float(np.clip((B - W["floor"]) / (W["full"] - W["floor"]), 0, 1))
                # Most of the atoll's land in view first (the user: crop to where the land is); arms through the edges
                # and a far corner at one side after; a little for zooming in, and against the whole ring alone.
                q["score"] = (0.6 * captured + 0.15 * arms + 0.15 * corner + 0.1 * q["buildable"]
                              - 0.1 * whole - 0.008 * span) - (0 if q["gate"] else 10)
                out.append(q)
    out.sort(key=lambda q: -q["score"])
    return out

def piece_heights(sv):
    """Fine land labelled into pieces and each piece's highest survey height: (labels, max height per label)."""
    lab, nlab = nd.label(sv.land_fine, structure=np.ones((3, 3)))
    nf = lab.shape[0]
    hf = np.repeat(np.repeat(sv.h, FINE, 0), FINE, 1)[:nf, :nf]
    hmax = np.zeros(nlab + 1)
    if nlab:
        hmax[1:] = nd.maximum(hf, lab, index=np.arange(1, nlab + 1))
    return lab, hmax


def frame_lagoon(sv, W, log, city, lab, hmax):
    """Lagoon groups (the user, 2026-10-11: fit all the inner islands; the centroid of the viable land masses,
    not the seat's island). The inner islands are the high ones (highIslandM) chained to the city's island
    by gaps under islandGroupGapKm; the window is centred on their extent and sized to hold it all with a sea
    margin, and the city's inner ring inside it. Reef islets and other groups fall where they fall."""
    c = (sv.n - 1) // 2
    f = RES / FINE
    nf = lab.shape[0]; cf = (nf - 1) // 2
    high_ids = np.nonzero(hmax >= W["highIslandM"])[0]
    high_ids = high_ids[high_ids > 0]
    high = np.isin(lab, high_ids)
    # Chain: grow each high island by half the gap; the pieces whose growth touches form a group.
    grow = int(W["islandGroupGapKm"] * 500 / (f * 3))
    coarse = high[::3, ::3]
    joined, _ = nd.label(nd.binary_dilation(coarse, iterations=max(1, grow)))
    ci_f, cj_f = city[0] * FINE, city[1] * FINE
    cl = lab[cj_f, ci_f]
    if cl == 0 or cl not in high_ids:
        d, (iy, ix) = nd.distance_transform_edt(~high, return_indices=True)
        cl = lab[iy[cj_f, ci_f], ix[cj_f, ci_f]]
    gid = joined[min(cj_f // 3, joined.shape[0] - 1), min(ci_f // 3, joined.shape[1] - 1)]
    group = high & np.repeat(np.repeat(joined == gid, 3, 0), 3, 1)[:nf, :nf]
    jj, ii = np.nonzero(group)
    x0, x1 = (ii.min() - cf) * f, (ii.max() - cf) * f
    y0, y1 = (cf - jj.max()) * f, (cf - jj.min()) * f
    ext = max(x1 - x0, y1 - y0)
    gx, gy = (x0 + x1) / 2, (y0 + y1) / 2
    city_m = np.array([(city[0] - c) * RES, (c - city[1]) * RES])
    margin = W["lagoonMarginKm"] * 1000
    span = max(ext + 2 * margin, ext / 0.88)
    # The city's inner ring must be inside too.
    span = max(span, 2 * (max(abs(city_m[0] - gx), abs(city_m[1] - gy)) + INNER_HALF_M + 500))
    span_km = float(min(W["lagoonSpanCap"], max(16.0, 2 * math.ceil(span / 2000.0))))
    half = span_km * 500
    # Over 36 km: keep the city's ring in and slide the window toward the group's centre as far as that allows.
    lim = half - INNER_HALF_M - 500
    cx = float(np.clip(gx, city_m[0] - lim, city_m[0] + lim)); cy = float(np.clip(gy, city_m[1] - lim, city_m[1] + lim))
    cx = round(cx / RES) * RES; cy = round(cy / RES) * RES
    inview = group[(np.abs((ii - cf) * f - cx) <= half) & (np.abs((cf - jj) * f - cy) <= half)].size if False else \
        float(((np.abs((ii - cf) * f - cx) <= half) & (np.abs((cf - jj) * f - cy) <= half)).mean())
    kc = int(round(CORE_HALF_M / RES))
    B = float(sv.build[city[1] - kc:city[1] + kc + 1, city[0] - kc:city[0] + kc + 1].mean())
    terms = {"span": span_km, "groupExtentKm": ext / 1000, "groupInView": inview, "groupIslands": int(len(np.unique(lab[group]))),
             "B": B, "gate": B >= W["floor"], "score": inview + 0.1 * float(np.clip((B - W["floor"]) / (W["full"] - W["floor"]), 0, 1))}
    return np.array([cx, cy]), span_km, terms, group, (gx, gy)

def score_seat(seat, cache, W, report, log):
    t0 = time.time()
    log(f"seat {seat['id']} {seat.get('name')} ({seat['lat']:.4f}, {seat['lon']:.4f})")
    sv = Survey(seat, cache, log)
    kind, info = classify(sv, W)
    log(f"  kind {kind} {json.dumps({k: (round(v, 3) if isinstance(v, float) else v) for k, v in info.items()})}")
    M = np.eye(2); vscale = 1.0; map_sv = sv
    result = {"id": seat["id"], "name": seat.get("name"), "kind": kind, "classify": info}
    extra = {}
    city_m = np.zeros(2)                                                # the city from the window centre's survey origin (the seat)
    if kind == "atoll":
        sv = Survey(seat, cache, log, ATOLL_SURVEY_KM)
        width = land_axis(sv, 2500)[2]
        broad = broaden_mask(sv.land_fine, RES / FINE, W["atollTargetWidthM"] / 2, W["atollGrowCap"])
        map_sv = with_land(sv, broad)
        rim = seat_rim(map_sv)
        bend = bend_point(map_sv)
        city = nearest_land_cell(map_sv)
        c = (sv.n - 1) // 2
        city_m = np.array([(city[0] - c) * RES, (c - city[1]) * RES])
        result.update({"meanWidthM": width, "broadenedTo": W["atollTargetWidthM"],
                       "landKm2": float(sv.land.sum() * RES * RES / 1e6), "broadenedKm2": float(map_sv.land.sum() * RES * RES / 1e6),
                       "bendKm": None if bend is None else [bend[1] / 1000, bend[2] / 1000]})
        cands = search_atoll(map_sv, W, log, rim, bend, city)
        best = cands[0]
        span = best["span"]
        cm = np.array([(best["ci"] - c) * RES, (c - best["cj"]) * RES])
        extra = {"bend": None if bend is None else {"strength": bend[0], "x": bend[1], "y": bend[2], "turnDeg": bend[3]}}
        terms = {k: v for k, v in best.items() if k not in ("ci", "cj")}
        top = [{k: v for k, v in q.items() if k not in ("ci", "cj")} | {"centreKm": [(q["ci"] - c) * RES / 1000, (c - q["cj"]) * RES / 1000]} for q in cands[:5]]
    elif kind == "lagoon":
        # A lagoon's island group can reach past the 52 km survey (Chuuk's Tol, 26 km west of Weno, was clipped).
        sv = Survey(seat, cache, log, ATOLL_SURVEY_KM)
        c = (sv.n - 1) // 2
        lab, hmax = piece_heights(sv)
        # Mixed high and low islands: the low ones (motus, reef islets) are broadened like an atoll's land; the high
        # ones are left as they are.
        low = np.isin(lab, np.nonzero((hmax < W["highIslandM"]) & (np.arange(len(hmax)) > 0))[0])
        grown = broaden_mask(low, RES / FINE, W["highSiteLowWidthM"] / 2, W["highSiteGrowCap"]) | sv.land_fine
        map_sv = with_land(sv, grown)
        city = nearest_land_cell(map_sv)
        city_m = np.array([(city[0] - c) * RES, (c - city[1]) * RES])
        cm, span, terms, group, centroid = frame_lagoon(map_sv, W, log, city, lab, hmax)
        top = []
        extra = {"centroidKm": [centroid[0] / 1000, centroid[1] / 1000]}
        result.update({"lowIslandsBroadened": True})
    else:
        span = WINDOW_KM
        if kind == "island":
            lab, cid = seat_component(sv)
            comp = lab == cid
            nf = comp.shape[0]; cf = (nf - 1) // 2; f = RES / FINE
            jj, ii = np.nonzero(comp)
            reach = max(abs(ii - cf).max(), abs(jj - cf).max()) * f        # from the seat to the island's far edge
            s = float(np.clip((0.5 - W["islandRim"]) * span * 1000 / max(reach, 1.0), 1.0, W["islandScaleCap"]))
            if s > 1.0:
                M = np.eye(2) / s
                vscale = s ** 0.5
                map_sv = warped(sv, M, vscale)
            result.update({"expand": s, "verticalScale": vscale})
            cap = 3.0
            W = dict(W, _island=True)
        else:
            cap = W["nudgeCap"]
        nw = ex.outer_samples(span)
        cands = search_mainland(map_sv, W, nw, cap)
        c = (sv.n - 1) // 2
        # Refine the best three at 30 m (true scale only; a warped core is judged on the survey).
        if kind == "mainland":
            refined = []
            for sc, ci, cj, t in cands[:3]:
                oe, on = (ci - c) * RES / 1000, (c - cj) * RES / 1000
                B30 = refine_core(seat, cache, oe, on, W, log)
                t2 = window_terms(map_sv, ci, cj, nw, radial(nw), W, refine=B30)
                for key in INTEREST + ("coastKm", "riversKm"):
                    t2[key] = t[key]
                t2["B90"] = t["B"]
                dist = math.hypot(oe, on)
                refined.append((combine(t2, W, dist), ci, cj, t2))
            refined.sort(key=lambda q: -q[0])
            cands = refined + cands[3:]
        sc, ci, cj, terms = cands[0]
        cm = np.array([(ci - c) * RES, (c - cj) * RES])
        top = [dict(q[3], score=q[0], centreMapKm=[(q[1] - c) * RES / 1000, (c - q[2]) * RES / 1000]) for q in cands[:5]]
        extra["heat"] = heat_of(cands, sv.n)
    true_off = M @ cm                                                    # window centre, true metres from the seat
    city_rel = city_m - cm if kind in ("atoll", "lagoon") else np.zeros(2)   # the city from the window centre, map metres
    frame = {"kind": kind, "offsetKmEast": round(float(true_off[0]) / 1000, 3), "offsetKmNorth": round(float(true_off[1]) / 1000, 3),
             "rotationDeg": 0.0, "spanKm": float(span), "warp": [round(float(v), 6) for v in M.ravel()],
             "cityKmEast": round(float(city_rel[0]) / 1000, 3), "cityKmNorth": round(float(city_rel[1]) / 1000, 3),
             "verticalScale": round(vscale, 4), "score": round(float(terms.get("score", 0.0)), 4), "scoreVersion": 2}
    if kind == "atoll":
        frame["broaden"] = {"targetHalfWidthM": W["atollTargetWidthM"] / 2, "maxFactor": W["atollGrowCap"]}
    elif kind == "lagoon":
        frame["broaden"] = {"targetHalfWidthM": W["highSiteLowWidthM"] / 2, "maxFactor": W["highSiteGrowCap"], "lowOnlyM": W["highIslandM"]}
    result.update({"frame": frame, "terms": jsonable(terms), "top": jsonable(top)})
    result.update(jsonable({k: v for k, v in extra.items() if k != "heat"}))
    draw_report(map_sv, cm, span, kind, extra, os.path.join(report, f"{seat['id']}.png"), seat, cm + city_rel)
    json.dump(result, open(os.path.join(report, f"{seat['id']}.json"), "w", encoding="utf-8"), indent=1)
    log(f"  -> {kind}: centre {frame['offsetKmEast']:+.1f} E {frame['offsetKmNorth']:+.1f} N km, city at {frame['cityKmEast']:+.1f} E "
        f"{frame['cityKmNorth']:+.1f} N of it, span {span:.0f} km, "
        f"warp {frame['warp']}, vscale {frame['verticalScale']}, score {frame['score']:.3f}, B {terms.get('B', 0):.2f}  "
        f"({time.time() - t0:.0f} s)")
    return frame


def heat_of(cands, n):
    pts = [(q[1], q[2], q[0]) for q in cands]
    return pts


def jsonable(o):
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


# ---------------------------------------------------------------- the report image

def draw_report(sv, cm, span, kind, extra, path, seat, city=None):
    """Hillshade of the (map-space) survey: sea blue, mountains red-tinted, rivers cyan, the chosen window
    white, its inner ring orange, its core yellow; for a mainland search a heat map of the score beside it."""
    h = sv.h
    gy, gx = np.gradient(h, RES, RES)
    az, alt = math.radians(315), math.radians(35)
    nx, ny, nz = -gx, gy, np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
    shade = np.clip((nx * lx + ny * ly + nz * lz) / norm, 0, 1)
    rgb = np.dstack([shade * 210 + 30] * 3)
    landf = np.clip(sv.land, 0, 1)[..., None]
    sea_rgb = np.array([40, 80, 130.0])
    rgb = rgb * landf + sea_rgb * (1 - landf)
    m = sv.mountain[..., None]
    rgb = np.where(m, rgb * 0.6 + np.array([170, 60, 40.0]) * 0.4, rgb)
    rv = (sv.river > 0)[..., None]
    rgb = np.where(rv, np.array([60, 210, 230.0]), rgb)
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    c = (sv.n - 1) / 2.0
    city = cm if city is None else city
    for half_m, col, at in ((span * 500, (255, 255, 255), cm), (INNER_HALF_M, (255, 160, 40), city), (CORE_HALF_M, (255, 240, 60), city)):
        ci, cj = c + at[0] / RES, c - at[1] / RES
        r = half_m / RES
        d.rectangle([ci - r, cj - r, ci + r, cj + r], outline=col, width=2)
    if extra.get("centroidKm"):
        gx, gy = c + extra["centroidKm"][0] * 1000 / RES, c - extra["centroidKm"][1] * 1000 / RES
        d.ellipse([gx - 5, gy - 5, gx + 5, gy + 5], outline=(0, 255, 120), width=2)
    d.ellipse([c - 4, c - 4, c + 4, c + 4], outline=(255, 0, 255), width=2)          # the seat
    if extra.get("bend"):
        b = extra["bend"]; bi, bj = c + b["x"] / RES, c - b["y"] / RES
        d.line([bi - 6, bj - 6, bi + 6, bj + 6], fill=(255, 0, 0), width=2); d.line([bi - 6, bj + 6, bi + 6, bj - 6], fill=(255, 0, 0), width=2)
    d.text((6, 6), f"{seat['id']} {seat.get('name')} [{kind}]", fill=(255, 255, 255))
    if "heat" in extra and extra["heat"]:
        pts = extra["heat"]
        hm = np.full((sv.n, sv.n), np.nan)
        for i, j, s in pts:
            hm[int(j), int(i)] = s
        vals = np.array([p[2] for p in pts])
        ok = vals > -5
        lo, hi = (vals[ok].min(), vals[ok].max()) if ok.any() else (vals.min(), vals.max())
        span_px = max(int(max(abs(p[0] - c) for p in pts)), int(max(abs(p[1] - c) for p in pts))) + 3
        sub = hm[int(c) - span_px:int(c) + span_px + 1, int(c) - span_px:int(c) + span_px + 1]
        t = np.clip((sub - lo) / max(hi - lo, 1e-6), 0, 1)
        t = nd.generic_filter(np.nan_to_num(t, nan=-1), lambda v: v[v >= 0].max() if (v >= 0).any() else -1, size=3)
        hr = np.where(t < 0, 30, 255 * t); hg = np.where(t < 0, 30, 255 * (1 - abs(t - 0.5) * 2) * 0.8); hb = np.where(t < 0, 30, 255 * (1 - t))
        heat = Image.fromarray(np.dstack([hr, hg, hb]).astype(np.uint8)).resize((sv.n, sv.n), Image.NEAREST)
        dh = ImageDraw.Draw(heat)
        dh.text((6, 6), f"score over centres (+-{span_px * RES / 1000:.1f} km); red best", fill=(255, 255, 255))
        both = Image.new("RGB", (sv.n * 2 + 8, sv.n), (0, 0, 0))
        both.paste(img, (0, 0)); both.paste(heat, (sv.n + 8, 0))
        img = both
    img.save(path)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", required=True)
    ap.add_argument("--seats", required=True, help="comma-separated seat ids")
    ap.add_argument("--report", required=True, help="folder for <id>.json, <id>.png and frames.json")
    ap.add_argument("--cache", default=os.path.normpath(os.path.join(HERE, "..", "..", "cache", "copernicus")))
    ap.add_argument("--weights", default=os.path.join(HERE, "city_site_score.json"))
    ap.add_argument("--extra-seat", action="append", default=[], help="'id:name:lat:lon' (as export_city_sites.py)")
    args = ap.parse_args()
    W = dict(DEFAULT_WEIGHTS)
    if os.path.exists(args.weights):
        W.update(json.load(open(args.weights, encoding="utf-8")))
    seats = {s["id"]: s for s in ex.read_seats(args.pack)}
    for spec in args.extra_seat:
        sid, name, la, lo = spec.split(":")
        seats[int(sid)] = {"id": int(sid), "name": name, "lat": float(la), "lon": float(lo)}
    os.makedirs(args.report, exist_ok=True)
    fpath = os.path.join(args.report, "frames.json")
    frames = json.load(open(fpath, encoding="utf-8")) if os.path.exists(fpath) else {}
    for sid in [int(x) for x in args.seats.split(",") if x.strip()]:
        if sid not in seats:
            print(f"seat {sid}: not in the pack", file=sys.stderr); continue
        frames[str(sid)] = score_seat(seats[sid], args.cache, W, args.report, print)
        json.dump(frames, open(fpath, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
