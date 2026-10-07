#!/usr/bin/env python3
"""Export a Culture Wars *world pack* from Terra_Form's data layers.

A world pack is a folder with a manifest.json and a few rasters that the Unity project
(Culture Wars) loads at runtime from StreamingAssets/WorldPacks/<name>/:

  elevation.png  RG16-encoded elevation (R = high byte, G = low byte), 0..65535 spans
                 [minMeters, maxMeters]
  landmask.png   8-bit L, 255 = land, 0 = water. Rasterised from the coastline polygons with
                 lakes punched out (same rule as the app's buildLandMask()).
  koppen.png     8-bit L class-index raster (0 = none, 1..30 = Beck et al. 2023 classes)
  rivers.png     8-bit L, 0 = none, 1 = minor (< 100 m3/s), 2 = medium (100..1000), 3 = major
                 (>= 1000 m3/s) river passing through the cell. Rasterised from data/river_tiles
                 (HydroRIVERS channels, all LOD bands), one cell wide.

--island-expand E (0..1, default 0) is the app's small-island expander: an island under --island-min-deg
(default 0.15 deg) on its longer side is scaled about its centre E of the way toward that size and burned
all-touched, so atolls and islets that the pixel grid would lose still mark cells as land (the game can
then put a city site on Funafuti or Male). Pieces of larger land clipped at a coast tile edge are never
scaled. Two rules keep it off continental coasts, where every skerry would otherwise claim a cell and
weld onto the shore: an expansion that would touch bigger land (anything of --island-min-deg or more)
under a 3x3 stencil is dropped (--island-merge allows it; islets may still union with each other, an
atoll is many polygons), and --island-isolation KM expands only islets at least that far from bigger
land. --island-regions names lon/lat boxes where the isolation gate is waived (atoll country, where one
long rim strip would gate out the rest of its ring): the composite is the plain coast everywhere, the
expander in those regions and on isolated islets. data/island_regions.json holds the Pacific atoll
groups and the Maldives; the earth packs use --island-isolation 25 with it.

A pack is a FRAME of the Earth: a lon/lat box (--bounds W S E N; W > E crosses the antimeridian)
at a pixel density (--ppd pixels per degree, or --width to fix the pixel width). The default is the
whole globe on the app's 4096x2048 working grid.

The pixel grid is anchored at (-180, 90) and every edge snaps OUTWARD to a multiple of --snap
pixels, so the requested box is always inside the pack, a frame at the working density lines up
pixel for pixel with the global export (rasters exactly; a rasterised line can differ where it
grazes a pixel corner), and the game's downsample factors still divide both sides. The manifest carries the snapped bounds.

Each layer is drawn from the finest source the density calls for (--elev-source, --koppen-source,
--coast-source: auto | base | fine; auto = fine only above the working density):

  elevation  base: data/elev_4096.png          fine: data/hgt_tiles (120 px/deg, land only; the
                                                     dropped ocean cells are filled from the base)
  koppen     base: data/koppen_2048.png        fine: data/koppen_tiles polygons, rasterised
             (written at its own resolution when the frame is a whole multiple of it)
  land       base: data/coast_10m + lakes_10m  fine: data/coast_tiles (OSM land polygons, ODbL; the
                                                     fine LOD) + lakes_hires; coast_hires when the
                                                     tile set is absent
  rivers     data/river_tiles, rasterised at any density

    # the Earth without the poles, on the working grid
    python scripts/export_world_pack.py --out "<UnityProject>/Assets/StreamingAssets/WorldPacks/earth" --bounds -180 -60 180 85
    # the Aegean with as many cells across as the world map
    python scripts/export_world_pack.py --out "<UnityProject>/Assets/StreamingAssets/WorldPacks/aegean" --bounds 19 34 30 42 --width 4096

Rotation is a future option (see docs/PLAN.md in Culture Wars).
"""
import argparse, json, math, os, time
import numpy as np
from PIL import Image
from rasterio import features
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

# Must match index.html KOPPEN_KEYS and scripts/elev16.py SEA/PEAK.
KOPPEN_KEYS = [None, 'Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk', 'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb',
               'Cwc', 'Cfa', 'Cfb', 'Cfc', 'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd',
               'Dfa', 'Dfb', 'Dfc', 'Dfd', 'ET', 'EF']
SEA, PEAK = -500.0, 6000.0
BASE_PPD = 4096 / 360.0          # the working grid (elev_4096.png)
MAX_WINDOW_PX = 48_000_000       # fine elevation held in memory for one band of the frame
EPS = 1e-9
CRS = "EPSG:4326"


class Frame:
    """A plate carree pixel window on the global grid at `ppd` px/deg. Column c spans
    lon_min + c/ppd .. +1/ppd; row r spans lat_max - r/ppd (row 0 = north, PNG order).
    lon_max may exceed 180 when the frame crosses the antimeridian."""

    def __init__(self, bounds, ppd, snap):
        w, s, e, n = bounds
        assert -90.0 <= s < n <= 90.0, "bounds must be W S E N with S < N"
        # The grid is a whole number of pixels around the globe and the pixel size is 360 / that, so
        # a wrapping frame closes exactly and the working grid's pixel (45/512 deg) stays exact.
        full_w = int(round(360.0 * ppd))
        ppd = full_w / 360.0
        self.res = 360.0 / full_w
        if e - w >= 360.0:
            c0, c1 = 0, full_w
        else:
            w = (w + 180.0) % 360.0 - 180.0
            e = (e + 180.0) % 360.0 - 180.0
            if e <= w:
                e += 360.0
            c0 = math.floor((w + 180.0) * ppd / snap + EPS) * snap
            c1 = math.ceil((e + 180.0) * ppd / snap - EPS) * snap
            if c1 - c0 >= full_w:
                c0, c1 = 0, full_w
        full_h = int(round(180.0 * ppd))
        r0 = max(0, math.floor((90.0 - n) * ppd / snap + EPS) * snap)
        r1 = min(full_h, math.ceil((90.0 - s) * ppd / snap - EPS) * snap)
        self.ppd, self.c0, self.c1, self.r0, self.r1 = ppd, c0, c1, r0, r1
        self.w, self.h = c1 - c0, r1 - r0
        self.wrap = self.w == full_w
        self.lon_min, self.lon_max = c0 * self.res - 180.0, c1 * self.res - 180.0
        self.lat_max, self.lat_min = 90.0 - r0 * self.res, 90.0 - r1 * self.res

    def transform(self, lon_shift=0.0):
        return Affine(self.res, 0.0, self.lon_min + lon_shift, 0.0, -self.res, self.lat_max)

    def shifts(self):
        """Origins to burn vector data at: a frame past 180 also sees the globe's western copy."""
        return (0.0, -360.0) if self.lon_max > 180.0 + EPS else (0.0,)

    def touches(self, b):
        """Does a lon/lat bbox [minLon, minLat, maxLon, maxLat] fall in the frame (either copy)?"""
        pad = 1.0 / self.ppd
        if b[3] < self.lat_min - pad or b[1] > self.lat_max + pad:
            return False
        return any(b[2] + k >= self.lon_min - pad and b[0] + k <= self.lon_max + pad for k in (0.0, 360.0))

    def tile_ids(self, deg):
        """"col_row" ids of a `deg`-degree global tile grid (col 0 at 180W, row 0 at 90N) under the frame."""
        cols = int(round(360.0 / deg))
        ct0, ct1 = math.floor((self.lon_min + 180.0) / deg), math.ceil((self.lon_max + 180.0) / deg - EPS)
        rt0, rt1 = math.floor((90.0 - self.lat_max) / deg), math.ceil((90.0 - self.lat_min) / deg - EPS)
        return ct0, ct1, rt0, rt1, [(c, r, f"{c % cols}_{r}") for r in range(rt0, rt1) for c in range(ct0, ct1)]


# ---------------------------------------------------------------- rasters

def resample_global(src, dst_shape, dst_transform, resampling):
    """Resample a whole-globe plate carree array (row 0 at 90N, col 0 at 180W) onto a grid whose
    columns may run past 180E (the source is tiled once eastward for that)."""
    H, W = src.shape
    ext = np.concatenate([src, src], axis=1).astype(np.float32)
    out = np.zeros(dst_shape, np.float32)
    reproject(ext, out, src_transform=Affine(360.0 / W, 0.0, -180.0, 0.0, -180.0 / H, 90.0), src_crs=CRS,
              dst_transform=dst_transform, dst_crs=CRS, resampling=resampling)
    return out


def global_to_frame(src, frame, resampling):
    """A global raster on the frame's grid: a straight slice when the densities agree."""
    H, W = src.shape
    if abs(W / 360.0 - frame.ppd) < EPS:
        cols = np.arange(frame.c0, frame.c1) % W
        return src[frame.r0:frame.r1][:, cols]
    return resample_global(src, (frame.h, frame.w), frame.transform(), resampling)


def rg16_decode(path):
    a = np.asarray(Image.open(path).convert("RGB"))
    return a[..., 0].astype(np.uint16) * 256 + a[..., 1]


def rg16_encode(code):
    g = np.rint(np.clip(code, 0, 65535)).astype(np.uint16)
    return np.stack([(g >> 8).astype(np.uint8), (g & 255).astype(np.uint8), np.zeros(g.shape, np.uint8)], -1)


def build_elevation(frame, base_path, fine):
    base = rg16_decode(base_path)
    down = frame.ppd < base.shape[1] / 360.0
    if not fine:
        code = global_to_frame(base, frame, Resampling.average if down else Resampling.bilinear)
        return code, "base elev_4096"

    tdir = os.path.join(DATA, "hgt_tiles")
    idx = json.load(open(os.path.join(tdir, "index.json"), encoding="utf-8"))
    deg, tw, th = idx["deg"], idx["tileW"], idx["tileH"]
    have = set(idx["tiles"])
    ct0, ct1, rt0, rt1, ids = frame.tile_ids(deg)
    fppd = tw / deg                      # the tiles' own density, 120 px/deg
    mw = (ct1 - ct0) * tw                # the mosaic's width: the whole run of tile columns
    rows_of = {}
    for c, r, tid in ids:
        if tid in have:
            rows_of.setdefault(r, []).append((c, tid))

    # The whole mosaic is 43200x18000 px for a global frame — 3 GB of float32, which is why this
    # goes band by band down the output instead. A band is as many output rows as keep its source
    # window under the budget, padded by the few source rows a resampling kernel reaches over.
    src_per_dst = fppd / frame.ppd
    band = max(1, int(MAX_WINDOW_PX / max(1, mw) / max(1.0, src_per_dst)))
    pad = int(math.ceil(src_per_dst)) + 2
    fine_rows = int(round(180.0 * fppd))
    fine_down = frame.ppd < fppd
    resampling = Resampling.average if fine_down else Resampling.bilinear
    code = np.zeros((frame.h, frame.w), np.float32)
    used = set()
    for y0 in range(0, frame.h, band):
        y1 = min(frame.h, y0 + band)
        lat_top = frame.lat_max - y0 * frame.res
        lat_bot = frame.lat_max - y1 * frame.res
        s0 = max(0, int(math.floor((90.0 - lat_top) * fppd)) - pad)
        s1 = min(fine_rows, int(math.ceil((90.0 - lat_bot) * fppd)) + pad)
        win_tf = Affine(1.0 / fppd, 0.0, ct0 * deg - 180.0, 0.0, -1.0 / fppd, 90.0 - s0 / fppd)
        # The tiles are land only: the ocean between them comes from the base.
        win = resample_global(base, (s1 - s0, mw), win_tf, Resampling.bilinear)
        for r in range(rt0, rt1):
            ty0 = int(round(r * deg * fppd))
            a0, a1 = max(s0, ty0), min(s1, ty0 + th)
            if a1 <= a0:
                continue
            for c, tid in rows_of.get(r, ()):
                t = rg16_decode(os.path.join(tdir, f"{tid}.{idx.get('ext', 'png')}"))
                win[a0 - s0:a1 - s0, (c - ct0) * tw:(c - ct0) * tw + tw] = t[a0 - ty0:a1 - ty0]
                used.add(tid)
        out = np.zeros((y1 - y0, frame.w), np.float32)
        reproject(win, out, src_transform=win_tf, src_crs=CRS,
                  dst_transform=Affine(frame.res, 0.0, frame.lon_min, 0.0, -frame.res, lat_top), dst_crs=CRS,
                  resampling=resampling)
        code[y0:y1] = out
    return code, f"fine hgt_tiles ({len(used)} tiles)"


def build_koppen(frame, base_path, fine):
    """Returns (class array, description). The base raster is kept at its own resolution when the
    frame is a whole multiple of it (the game upsamples it to the grid on load)."""
    if fine:
        tdir = os.path.join(DATA, "koppen_tiles")
        idx = json.load(open(os.path.join(tdir, "index.json"), encoding="utf-8"))
        have = set(idx["tiles"])
        shapes = []
        for _, _, tid in frame.tile_ids(idx["deg"])[4]:
            if tid not in have:
                continue
            for p in json.load(open(os.path.join(tdir, tid + ".json"), encoding="utf-8"))["polys"]:
                if frame.touches(p["b"]):
                    g = rings_to_polygon(p["r"])
                    if g:
                        shapes.append((g, int(p["v"])))
        return burn(frame, shapes), f"fine koppen_tiles ({len(shapes)} polygons)"

    kop = np.asarray(Image.open(base_path).convert("L"))
    kppd = kop.shape[1] / 360.0
    k = frame.ppd / kppd
    ki = int(round(k))
    if ki >= 1 and abs(k - ki) < EPS and all(v % ki == 0 for v in (frame.c0, frame.c1, frame.r0, frame.r1)):
        cols = np.arange(frame.c0 // ki, frame.c1 // ki) % kop.shape[1]
        return kop[frame.r0 // ki:frame.r1 // ki][:, cols], "base koppen_2048"
    return global_to_frame(kop, frame, Resampling.nearest).astype(np.uint8), "base koppen_2048 (resampled)"


# ---------------------------------------------------------------- vectors

def rings_to_polygon(rings):
    coords = []
    for ring in rings:
        if len(ring) < 3:
            continue
        r = [[float(x), float(y)] for x, y in ring]
        if r[0] != r[-1]:
            r.append(r[0])
        coords.append(r)
    return {"type": "Polygon", "coordinates": coords} if coords else None


def polys_in_frame(path, frame):
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    geoms = []
    for p in j["polys"]:
        if p["r"] and len(p["r"][0]) >= 3 and frame.touches(p["b"]):
            g = rings_to_polygon(p["r"])
            if g:
                geoms.append(g)
    return geoms


def burn(frame, shapes, all_touched=False):
    """Rasterise (geometry, value) pairs onto the frame; later shapes win, as in rasterio."""
    out = np.zeros((frame.h, frame.w), np.uint8)
    if not shapes:
        return out
    for shift in frame.shifts():
        part = features.rasterize(shapes, out_shape=out.shape, transform=frame.transform(shift), fill=0,
                                  dtype="uint8", all_touched=all_touched)
        np.copyto(out, part, where=part != 0)
    return out


def decode_coast_tile(path):
    """One data/coast_tiles/<lod>/<col>_<row>.bin -> list of GeoJSON polygons. Format: see the header of
    scripts/build_coast_tiles.py (gzip, "CST1", f64 lon0/lat0/q, then varint counts and zigzag-varint
    deltas in units of q; ring 0 is the exterior, the closing vertex is implicit)."""
    import gzip, struct
    with open(path, "rb") as f:
        buf = f.read()
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    assert buf[:4] == b"CST1", path
    lon0, lat0, q = struct.unpack_from("<ddd", buf, 8)
    pos = 32

    def varint():
        nonlocal pos
        r, s = 0, 0
        while True:
            b = buf[pos]; pos += 1
            r |= (b & 0x7F) << s; s += 7
            if not b & 0x80:
                return r

    def zz(u):
        return (u >> 1) ^ -(u & 1)

    polys = []
    for _ in range(varint()):
        rings = []
        for _ in range(varint()):
            n, x, y, ring = varint(), 0, 0, []
            for _ in range(n):
                x += zz(varint()); y += zz(varint())
                ring.append([lon0 + x * q, lat0 + y * q])
            ring.append(ring[0])
            rings.append(ring)
        if rings and len(rings[0]) >= 4:
            polys.append({"type": "Polygon", "coordinates": rings})
    return polys


def vector_tile_polys(frame, tileset, lod="f"):
    """Polygons under the frame from data/<tileset>/ (coast_tiles = OSM land, lake_tiles = HydroLAKES;
    both built by scripts/build_coast_tiles.py), or None when the tile set isn't there. Cells the index
    marks "full" come back as their cell rectangle; cells absent from the index hold none of the layer."""
    root = os.path.join(DATA, tileset)
    ipath = os.path.join(root, "index.json")
    if not os.path.exists(ipath):
        return None
    idx = json.load(open(ipath, encoding="utf-8"))
    L = idx["lods"].get(lod) or next(iter(idx["lods"].values()))
    have, full, D = set(L["tiles"]), set(L.get("full") or L.get("land") or []), float(L["deg"])
    geoms = []
    for _, r, key in frame.tile_ids(D)[4]:
        if key in have:
            geoms += decode_coast_tile(os.path.join(root, lod, key + "." + L.get("ext", "bin")))
        elif key in full:
            c = int(key.split("_")[0])
            x0, y1 = -180.0 + c * D, 90.0 - r * D
            geoms.append({"type": "Polygon", "coordinates": [[[x0, y1 - D], [x0 + D, y1 - D], [x0 + D, y1], [x0, y1], [x0, y1 - D]]]})
    return geoms


def parse_regions(spec):
    """--island-regions: 'W,S,E,N;W,S,E,N' boxes, or a path to a JSON file holding a list of
    {"name":..., "bounds":[W,S,E,N]} (or bare [W,S,E,N] lists). W > E crosses the antimeridian."""
    if not spec:
        return []
    if os.path.exists(spec):
        j = json.load(open(spec, encoding="utf-8"))
        items = j["regions"] if isinstance(j, dict) else j
        return [tuple(float(v) for v in (it["bounds"] if isinstance(it, dict) else it)) for it in items]
    return [tuple(float(v) for v in part.split(",")) for part in spec.split(";") if part.strip()]


def in_regions(lon, lat, regions):
    for w, s, e, n in regions:
        if not s <= lat <= n:
            continue
        if (lon - w) % 360.0 <= (e - w) % 360.0 or w == e:
            return True
    return False


def expand_islands(land, expand, min_deg, tile_deg, min_area_km2=0.3, isolation_km=0.0, regions=None):
    """The app's small-island expander for the export: an island whose bounding box is under min_deg on
    its longer side is scaled about its centre toward min_deg, by `expand` of the way (1 = all the way;
    nothing shrinks, nothing larger is touched), and comes back in a list to be burned with all_touched
    so an atoll's thin strips still mark the cells they cross. A polygon clipped at a coast tile's edge
    is a piece of something larger and is left alone, whatever its size.

    isolation_km > 0 keeps the expander off continental coasts, where it would weld skerries onto the
    shore: only islets at least that far from bigger land (continents and every island of min_deg or
    more) are expanded. `regions` (lon/lat boxes) waive that gate: inside them every islet expands,
    which is what atoll country wants, where one long rim strip of min_deg would otherwise count as
    bigger land and gate out the rest of its own ring. isolation 0 = every islet everywhere, as before.

    Returns (big, rest, small, stats): big are the untouched polygons of min_deg or more (what an islet
    must never join), rest the islets left as they are (rocks under the area floor, islets the gates
    turned away), small a list of (original, expanded, area_km2) for the islets to expand, largest first."""
    stats = {"rocks": 0, "near_land": 0, "in_regions": 0}
    if expand <= 0:
        return land, [], [], stats
    from shapely.geometry import shape, mapping
    from shapely import affinity, STRtree, clip_by_rect
    big, big_geoms, rest, cand = [], [], [], []
    for g in land:
        geom = shape(g) if isinstance(g, dict) else g
        x0, y0, x1, y1 = geom.bounds
        L = max(x1 - x0, y1 - y0, 1e-9)
        clipped = tile_deg and any(abs(v / tile_deg - round(v / tile_deg)) < 1e-6 for v in (x0, y0, x1, y1))
        if L >= min_deg or clipped:
            big.append(g); big_geoms.append(geom)
            continue
        # A rock or skerry under the area floor is left as it is (and so, mostly, lost to the grid):
        # the expander is for islets people live on.
        cy = (y0 + y1) / 2
        area_km2 = geom.area * 111.2 * 111.2 * max(0.05, math.cos(math.radians(cy)))
        if area_km2 < min_area_km2:
            rest.append(g); stats["rocks"] += 1
            continue
        cand.append((g, geom, L, area_km2))

    if isolation_km > 0 and cand:
        # Distance to the nearest bigger land in km on the ground: the STRtree finds the big polygons
        # within the islet's lon-degree radius, each is clipped to that window (a continent is not
        # rescaled whole) and measured with x squeezed by cos(lat).
        tree = STRtree(big_geoms)
        far = []
        for g, geom, L, area in cand:
            x0, y0, x1, y1 = geom.bounds
            cy = (y0 + y1) / 2
            if regions and in_regions((x0 + x1) / 2, cy, regions):
                far.append((g, geom, L, area)); stats["in_regions"] += 1
                continue
            k = max(0.05, math.cos(math.radians(cy)))
            r = isolation_km / (111.2 * k)
            box = (x0 - r, y0 - r, x1 + r, y1 + r)
            me = affinity.scale(geom, k, 1.0, origin=(0, 0))
            near = False
            for i in tree.query(shape({"type": "Polygon", "coordinates": [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]]]})):
                try:
                    piece = clip_by_rect(big_geoms[i], *box)
                except Exception:   # a degenerate ring in the source polygon: measure the whole thing
                    piece = big_geoms[i]
                if piece.is_empty:
                    continue
                if me.distance(affinity.scale(piece, k, 1.0, origin=(0, 0))) * 111.2 < isolation_km:
                    near = True
                    break
            if near:
                rest.append(g); stats["near_land"] += 1
            else:
                far.append((g, geom, L, area))
        cand = far

    small = []
    for g, geom, L, area in sorted(cand, key=lambda t: -t[3]):
        x0, y0, x1, y1 = geom.bounds
        f = 1.0 + expand * (min_deg / L - 1.0)
        small.append((g, mapping(affinity.scale(geom, f, f, origin=((x0 + x1) / 2, (y0 + y1) / 2))), area))
    return big, rest, small, stats


def _window(frame, bounds, shift, pad=1):
    """Pixel window (r0, r1, c0, c1) around a lon/lat bbox drawn at `shift`, padded, rows clipped to the
    frame; columns run past the edge for a wrapping frame (index them modulo frame.w) and are clipped otherwise."""
    x0, y0, x1, y1 = bounds
    c0 = math.floor((x0 + shift - frame.lon_min) / frame.res) - pad
    c1 = math.ceil((x1 + shift - frame.lon_min) / frame.res) + pad
    r0 = max(0, math.floor((frame.lat_max - y1) / frame.res) - pad)
    r1 = min(frame.h, math.ceil((frame.lat_max - y0) / frame.res) + pad)
    if not frame.wrap:
        c0, c1 = max(0, c0), min(frame.w, c1)
    return r0, r1, c0, c1


def _burn_window(frame, geom, win, shift, all_touched):
    r0, r1, c0, c1 = win
    tf = Affine(frame.res, 0.0, frame.lon_min + c0 * frame.res - shift, 0.0, -frame.res, frame.lat_max - r0 * frame.res)
    return features.rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=tf, fill=0, dtype="uint8",
                              all_touched=all_touched)


def burn_islands(frame, mask, big, small, allow_merge=False):
    """Burn the expanded islets (all_touched) into `mask`. Unless allow_merge, an islet is expanded only
    where its expanded cells stay clear of `big` (the plain burn of the bigger land) under a 3x3
    stencil; one that would join a bigger land mass keeps its plain burn, which for most is nothing.
    Islets may union with each other: an atoll is many polygons. Returns a stats dict."""
    from scipy.ndimage import binary_dilation
    stats = {"expanded": 0, "joins_land": 0, "cells": 0}
    S = np.ones((3, 3), bool)
    for orig, geom, _ in small:
        ring = geom["coordinates"][0]
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        bounds = (min(xs), min(ys), max(xs), max(ys))
        for shift in frame.shifts():
            win = _window(frame, bounds, shift)
            r0, r1, c0, c1 = win
            if r1 <= r0 or c1 <= c0:
                continue
            cols = np.arange(c0, c1) % frame.w
            E = _burn_window(frame, geom, win, shift, True).astype(bool)
            if not E.any():
                continue
            if not allow_merge and (binary_dilation(E, structure=S) & big[r0:r1][:, cols].astype(bool)).any():
                stats["joins_land"] += 1
                continue
            sub = mask[r0:r1][:, cols].astype(bool)
            stats["cells"] += int((E & ~sub).sum())
            mask[r0:r1, cols] = (sub | E).astype(np.uint8)
            stats["expanded"] += 1
    return stats


def build_landmask(frame, fine, island_expand=0.0, island_min_deg=0.15, island_min_area=0.3,
                   island_isolation_km=0.0, island_regions=None, island_merge=False):
    stem = "hires" if fine else "10m"
    land = vector_tile_polys(frame, "coast_tiles") if fine else None
    coast_src = "coast_tiles/f (OpenStreetMap)"
    tile_deg = None
    if land is None:
        land = polys_in_frame(os.path.join(DATA, f"coast_{stem}.json"), frame)
        coast_src = f"coast_{stem}"
    else:
        idx = json.load(open(os.path.join(DATA, "coast_tiles", "index.json"), encoding="utf-8"))
        L = idx["lods"].get("f") or next(iter(idx["lods"].values()))
        tile_deg = float(L["deg"])
    lakes = vector_tile_polys(frame, "lake_tiles") if fine else None
    lake_src = "lake_tiles/f (HydroLAKES)"
    if lakes is None:
        lakes = polys_in_frame(os.path.join(DATA, f"lakes_{stem}.json"), frame)
        lake_src = f"lakes_{stem}"
    big, rest, small, gate = expand_islands(land, island_expand, island_min_deg, tile_deg, island_min_area,
                                            island_isolation_km, island_regions)
    # Every polygon burns plain first, the islets' originals included; the expansions go on top, and
    # the plain burn of the bigger land is what they must keep clear of.
    bigmask = burn(frame, [(g, 1) for g in big])
    mask = bigmask.copy() if small and not island_merge else bigmask
    n_polys = len(big)
    if rest or small:
        n_polys += len(rest) + len(small)
        mask |= burn(frame, [(g, 1) for g in rest] + [(o, 1) for o, _, _ in small])
    if small:
        stats = burn_islands(frame, mask, bigmask, small, island_merge)
        del bigmask
        coast_src += (f", {stats['expanded']} of {len(small)} small islands expanded x{island_expand:g} toward "
                      f"{island_min_deg:g} deg, {stats['cells']} cells ({stats['joins_land']} would join bigger land; "
                      f"{gate['near_land']} within {island_isolation_km:g} km of it, {gate['in_regions']} in the "
                      f"gate-free regions, {gate['rocks']} rocks)")
    if lakes:
        mask[burn(frame, [(g, 1) for g in lakes]) == 1] = 0
    return (mask * 255).astype(np.uint8), f"{coast_src} + {lake_src} ({n_polys} + {len(lakes)} polygons)"


def river_shapes(frame):
    """(LineString, class) for every channel in a tile under the frame. The LOD files are discharge
    bands (lod 0 = largest rivers ... lod 3 = smallest), so all of them are read."""
    man = json.load(open(os.path.join(DATA, "river_tiles", "manifest.json"), encoding="utf-8"))
    shapes = []
    for t in man["tiles"]:
        path = os.path.join(DATA, "river_tiles", t["id"] + ".json")
        if not os.path.exists(path) or not frame.touches(t["b"]):
            continue
        for f in json.load(open(path, encoding="utf-8"))["features"]:
            d = float(f.get("d", 0))
            cls = 3 if d >= 1000 else (2 if d >= 100 else 1)
            for line in f["l"]:
                if len(line) >= 2:
                    shapes.append(({"type": "LineString", "coordinates": [[float(x), float(y)] for x, y in line]}, cls))
    return sorted(shapes, key=lambda gc: gc[1])   # draw major rivers last so they win


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output pack folder (created)")
    ap.add_argument("--name", help="pack name (default: the output folder's name)")
    ap.add_argument("--bounds", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=[-180.0, -90.0, 180.0, 90.0],
                    help="lon/lat box to export (default: the whole globe)")
    res = ap.add_mutually_exclusive_group()
    res.add_argument("--ppd", type=float, help=f"pixels per degree (default {BASE_PPD:.4f}, the working grid)")
    res.add_argument("--width", type=int, help="pixel width of the requested box; sets --ppd")
    ap.add_argument("--snap", type=int, default=4, help="edges snap outward to a multiple of this many pixels")
    for layer in ("elev", "koppen", "coast"):
        ap.add_argument(f"--{layer}-source", choices=("auto", "base", "fine"), default="auto")
    ap.add_argument("--elev", default=os.path.join(DATA, "elev_4096.png"), help="base elevation raster")
    ap.add_argument("--koppen", default=os.path.join(DATA, "koppen_2048.png"), help="base Koppen raster")
    ap.add_argument("--island-expand", type=float, default=0.0,
                    help="the app's small-island expander: islands under --island-min-deg across are scaled toward it by this much (0..1) and burned all-touched")
    ap.add_argument("--island-min-deg", type=float, default=0.15, help="the size (degrees, longer side) small islands are expanded toward")
    ap.add_argument("--island-min-area", type=float, default=0.3, help="km2; islets smaller than this are not expanded (rocks and skerries)")
    ap.add_argument("--island-isolation", type=float, default=0.0,
                    help="km; only islets at least this far from bigger land (anything of --island-min-deg or more) are expanded, so continental coasts keep their skerries as they are")
    ap.add_argument("--island-regions", default="",
                    help="lon/lat boxes where the isolation gate is waived and every islet expands (atoll country): 'W,S,E,N;W,S,E,N' or a JSON file of {name, bounds} items, e.g. data/island_regions.json; with a huge --island-isolation this is 'expand only here'")
    ap.add_argument("--island-merge", action="store_true",
                    help="let an expanded islet touch other land (by default an expansion that would join another land mass under a 3x3 stencil is dropped and the islet keeps its plain burn)")
    args = ap.parse_args()

    w, s, e, n = args.bounds
    span = 360.0 if e - w >= 360.0 else (e - w) % 360.0 or 360.0
    ppd = args.ppd or (args.width / span if args.width else BASE_PPD)
    frame = Frame(args.bounds, ppd, args.snap)
    fine = {k: (v == "fine" or (v == "auto" and frame.ppd > BASE_PPD + EPS))
            for k, v in (("elev", args.elev_source), ("koppen", args.koppen_source), ("coast", args.coast_source))}
    name = args.name or os.path.basename(os.path.normpath(args.out))

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    print(f"frame {frame.w}x{frame.h} at {frame.ppd:.4f} px/deg: lon {frame.lon_min:.6f}..{frame.lon_max:.6f}, "
          f"lat {frame.lat_min:.6f}..{frame.lat_max:.6f}, wrapX {frame.wrap}")

    code, elev_src = build_elevation(frame, args.elev, fine["elev"])
    Image.fromarray(rg16_encode(code), "RGB").save(os.path.join(args.out, "elevation.png"), optimize=True)
    print(f"elevation {frame.w}x{frame.h} from {elev_src}")

    kop, kop_src = build_koppen(frame, args.koppen, fine["koppen"])
    Image.fromarray(np.ascontiguousarray(kop), "L").save(os.path.join(args.out, "koppen.png"), optimize=True)
    print(f"koppen {kop.shape[1]}x{kop.shape[0]} from {kop_src}")

    regions = parse_regions(args.island_regions)
    mask, land_src = build_landmask(frame, fine["coast"], args.island_expand, args.island_min_deg, args.island_min_area,
                                    args.island_isolation, regions, args.island_merge)
    Image.fromarray(mask, "L").save(os.path.join(args.out, "landmask.png"), optimize=True)
    print(f"landmask from {land_src}: {100.0 * (mask > 0).mean():.1f}% land")

    shapes = river_shapes(frame)
    rivers = burn(frame, shapes, all_touched=True)
    Image.fromarray(rivers, "L").save(os.path.join(args.out, "rivers.png"), optimize=True)
    print(f"rivers from {len(shapes)} reaches: minor {(rivers == 1).sum()} medium {(rivers == 2).sum()} major {(rivers == 3).sum()} cells")

    manifest = {
        "format": "culturewars-worldpack",
        "version": 1,
        "name": name,
        "width": frame.w,
        "height": frame.h,
        "bounds": {"lonMin": frame.lon_min, "lonMax": frame.lon_max, "latMin": frame.lat_min, "latMax": frame.lat_max},
        "wrapX": frame.wrap,
        "rotationDeg": 0.0,
        "layers": {
            "elevation": {"file": "elevation.png", "encoding": "rg16", "width": frame.w, "height": frame.h,
                           "minMeters": SEA, "maxMeters": PEAK},
            "landMask": {"file": "landmask.png", "encoding": "l8", "width": frame.w, "height": frame.h},
            "rivers": {"file": "rivers.png", "encoding": "index8", "width": frame.w, "height": frame.h,
                       "classes": ["", "minor", "medium", "major"]},
            "koppen": {"file": "koppen.png", "encoding": "index8", "width": int(kop.shape[1]), "height": int(kop.shape[0]),
                        "classes": ["" if k is None else k for k in KOPPEN_KEYS]},
        },
        "frame": {"requestedBounds": [w, s, e, n], "ppd": frame.ppd, "snap": args.snap,
                  "islandExpand": args.island_expand, "islandMinDeg": args.island_min_deg, "islandMinAreaKm2": args.island_min_area,
                  "islandIsolationKm": args.island_isolation, "islandRegions": [list(r) for r in regions], "islandMerge": args.island_merge,
                  "sources": {"elevation": elev_src, "koppen": kop_src, "landMask": land_src, "rivers": "river_tiles"}},
        "attribution": [
            "Elevation: ETOPO 2022 (NOAA NCEI), " + ("30 arc-second" if fine["elev"] else "decimated to the working grid"),
            ("Coastline: OpenStreetMap land polygons (© OpenStreetMap contributors, ODbL 1.0)"
             if "OpenStreetMap" in land_src else "Coastline: Natural Earth 10 m (public domain)"),
            ("Lakes: HydroLAKES v1.0, Messager et al. 2016 (CC BY 4.0)"
             if "HydroLAKES" in land_src else "Lakes: Natural Earth 10 m (public domain)"),
            "Climate: Koppen-Geiger, Beck et al. 2023 (CC BY 4.0)",
            "Rivers: HydroRIVERS v1.0 (CC BY 4.0), channel-reduced by Terra_Form",
        ],
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {os.path.join(args.out, 'manifest.json')} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
