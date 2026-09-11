#!/usr/bin/env python3
"""Export a Culture Wars *world pack* from Terra_Form's data layers.

A world pack is a folder with a manifest.json and a few rasters that the Unity project
(Culture Wars) loads at runtime from StreamingAssets/WorldPacks/<name>/:

  elevation.png  RG16-encoded elevation (R = high byte, G = low byte), 0..65535 spans
                 [minMeters, maxMeters]  -- a straight copy of data/elev_4096.png
  landmask.png   8-bit L, 255 = land, 0 = water. Rasterised from the Natural Earth 10 m
                 coastline polygons with lakes punched out (same rule as the app's
                 buildLandMask()).
  koppen.png     8-bit L class-index raster (0 = none, 1..30 = Beck et al. 2023 classes)
                 -- a straight copy of data/koppen_2048.png
  rivers.png     8-bit L, 0 = none, 1 = minor (< 100 m3/s), 2 = medium (100..1000), 3 = major
                 (>= 1000 m3/s) river passing through the cell. Rasterised from data/river_tiles
                 (HydroRIVERS channels, all LOD bands), one cell wide.

For now this exports the full globe on the app's 4096x2048 working grid. Region framing,
rotation and the fine hgt_tiles path are future options (see docs/PLAN.md in Culture Wars).

    python scripts/export_world_pack.py --out "<UnityProject>/Assets/StreamingAssets/WorldPacks/earth"
"""
import argparse, json, os, shutil, time
import numpy as np
from PIL import Image
import rasterio
from rasterio import features
from rasterio.transform import from_bounds

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

# Must match index.html KOPPEN_KEYS and scripts/elev16.py SEA/PEAK.
KOPPEN_KEYS = [None, 'Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk', 'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb',
               'Cwc', 'Cfa', 'Cfb', 'Cfc', 'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd',
               'Dfa', 'Dfb', 'Dfc', 'Dfd', 'ET', 'EF']
SEA, PEAK = -500.0, 6000.0


def polys_to_geoms(path):
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    geoms = []
    for p in j["polys"]:
        rings = p["r"]
        if not rings or len(rings[0]) < 3:
            continue
        coords = []
        for ring in rings:
            if len(ring) < 3:
                continue
            r = [[float(x), float(y)] for x, y in ring]
            if r[0] != r[-1]:
                r.append(r[0])
            coords.append(r)
        if coords:
            geoms.append({"type": "Polygon", "coordinates": coords})
    return geoms


def build_landmask(w, h):
    transform = from_bounds(-180, -90, 180, 90, w, h)
    land = polys_to_geoms(os.path.join(DATA, "coast_10m.json"))
    lakes = polys_to_geoms(os.path.join(DATA, "lakes_10m.json"))
    mask = features.rasterize(((g, 1) for g in land), out_shape=(h, w), transform=transform,
                              fill=0, dtype="uint8", all_touched=False)
    if lakes:
        lake = features.rasterize(((g, 1) for g in lakes), out_shape=(h, w), transform=transform,
                                  fill=0, dtype="uint8", all_touched=False)
        mask[lake == 1] = 0
    return (mask * 255).astype(np.uint8)


def river_geoms():
    """Yield (LineString geometry, class) for every channel. The LOD files are discharge
    bands (lod 0 = largest rivers ... lod 3 = smallest), so all of them are read."""
    man = json.load(open(os.path.join(DATA, "river_tiles", "manifest.json"), encoding="utf-8"))
    for t in man["tiles"]:
        path = os.path.join(DATA, "river_tiles", t["id"] + ".json")
        if not os.path.exists(path):
            continue
        for f in json.load(open(path, encoding="utf-8"))["features"]:
            d = float(f.get("d", 0))
            cls = 3 if d >= 1000 else (2 if d >= 100 else 1)
            for line in f["l"]:
                if len(line) >= 2:
                    yield {"type": "LineString", "coordinates": [[float(x), float(y)] for x, y in line]}, cls


def build_rivers(w, h):
    transform = from_bounds(-180, -90, 180, 90, w, h)
    shapes = sorted(river_geoms(), key=lambda gc: gc[1])   # draw major rivers last so they win
    return features.rasterize(shapes, out_shape=(h, w), transform=transform, fill=0,
                              dtype="uint8", all_touched=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output pack folder (created)")
    ap.add_argument("--name", default="earth")
    ap.add_argument("--elev", default=os.path.join(DATA, "elev_4096.png"))
    ap.add_argument("--koppen", default=os.path.join(DATA, "koppen_2048.png"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()

    elev = Image.open(args.elev)
    w, h = elev.size
    assert elev.mode == "RGB", "elevation PNG must be the RG16 RGB container"
    shutil.copyfile(args.elev, os.path.join(args.out, "elevation.png"))
    print(f"elevation {w}x{h} copied")

    kop = Image.open(args.koppen)
    assert kop.mode == "L", "koppen PNG must be 8-bit L (class index)"
    shutil.copyfile(args.koppen, os.path.join(args.out, "koppen.png"))
    print(f"koppen {kop.size[0]}x{kop.size[1]} copied")

    mask = build_landmask(w, h)
    Image.fromarray(mask, "L").save(os.path.join(args.out, "landmask.png"), optimize=True)
    print(f"landmask {w}x{h} rasterised: {100.0 * (mask > 0).mean():.1f}% land")

    rivers = build_rivers(w, h)
    Image.fromarray(rivers, "L").save(os.path.join(args.out, "rivers.png"), optimize=True)
    print(f"rivers {w}x{h} rasterised: minor {(rivers == 1).sum()} medium {(rivers == 2).sum()} major {(rivers == 3).sum()} cells")

    manifest = {
        "format": "culturewars-worldpack",
        "version": 1,
        "name": args.name,
        "width": w,
        "height": h,
        "bounds": {"lonMin": -180.0, "lonMax": 180.0, "latMin": -90.0, "latMax": 90.0},
        "wrapX": True,
        "rotationDeg": 0.0,
        "layers": {
            "elevation": {"file": "elevation.png", "encoding": "rg16", "width": w, "height": h,
                           "minMeters": SEA, "maxMeters": PEAK},
            "landMask": {"file": "landmask.png", "encoding": "l8", "width": w, "height": h},
            "rivers": {"file": "rivers.png", "encoding": "index8", "width": w, "height": h,
                       "classes": ["", "minor", "medium", "major"]},
            "koppen": {"file": "koppen.png", "encoding": "index8",
                        "width": kop.size[0], "height": kop.size[1],
                        "classes": ["" if k is None else k for k in KOPPEN_KEYS]},
        },
        "attribution": [
            "Elevation: ETOPO 2022 (NOAA NCEI), decimated to the working grid",
            "Coastline and lakes: Natural Earth 10 m (public domain)",
            "Climate: Koppen-Geiger, Beck et al. 2023 (CC BY 4.0)",
            "Rivers: HydroRIVERS v1.0 (CC BY 4.0), channel-reduced by Terra_Form",
        ],
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {os.path.join(args.out, 'manifest.json')} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
