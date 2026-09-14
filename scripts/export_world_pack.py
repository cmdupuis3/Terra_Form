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
  land       base: data/coast_10m + lakes_10m  fine: data/coast_hires + lakes_hires
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
MAX_MOSAIC_PX = 400_000_000      # fine elevation read into memory for one frame
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
    mh, mw = (rt1 - rt0) * th, (ct1 - ct0) * tw
    if mh * mw > MAX_MOSAIC_PX:
        raise SystemExit(f"fine elevation for this frame is {mw}x{mh} px; lower --ppd or use --elev-source base")
    mosaic_tf = Affine(deg / tw, 0.0, ct0 * deg - 180.0, 0.0, -deg / th, 90.0 - rt0 * deg)
    # The tiles are land only: the ocean between them comes from the base.
    mosaic = resample_global(base, (mh, mw), mosaic_tf, Resampling.bilinear)
    n = 0
    for c, r, tid in ids:
        if tid in have:
            y, x = (r - rt0) * th, (c - ct0) * tw
            mosaic[y:y + th, x:x + tw] = rg16_decode(os.path.join(tdir, f"{tid}.{idx.get('ext', 'png')}"))
            n += 1
    code = np.zeros((frame.h, frame.w), np.float32)
    fine_down = frame.ppd < tw / deg
    reproject(mosaic, code, src_transform=mosaic_tf, src_crs=CRS, dst_transform=frame.transform(), dst_crs=CRS,
              resampling=Resampling.average if fine_down else Resampling.bilinear)
    return code, f"fine hgt_tiles ({n} tiles)"


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


def build_landmask(frame, fine):
    stem = "hires" if fine else "10m"
    land = polys_in_frame(os.path.join(DATA, f"coast_{stem}.json"), frame)
    lakes = polys_in_frame(os.path.join(DATA, f"lakes_{stem}.json"), frame)
    mask = burn(frame, [(g, 1) for g in land])
    if lakes:
        mask[burn(frame, [(g, 1) for g in lakes]) == 1] = 0
    return (mask * 255).astype(np.uint8), f"coast_{stem} + lakes_{stem} ({len(land)} + {len(lakes)} polygons)"


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

    mask, land_src = build_landmask(frame, fine["coast"])
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
                  "sources": {"elevation": elev_src, "koppen": kop_src, "landMask": land_src, "rivers": "river_tiles"}},
        "attribution": [
            "Elevation: ETOPO 2022 (NOAA NCEI), " + ("30 arc-second" if fine["elev"] else "decimated to the working grid"),
            "Coastline and lakes: " + ("Terra_Form high-resolution land polygons" if fine["coast"] else "Natural Earth 10 m (public domain)"),
            "Climate: Koppen-Geiger, Beck et al. 2023 (CC BY 4.0)",
            "Rivers: HydroRIVERS v1.0 (CC BY 4.0), channel-reduced by Terra_Form",
        ],
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {os.path.join(args.out, 'manifest.json')} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
