#!/usr/bin/env python3
"""
coastline_to_mask.py  —  step 1 of the Terra-WBS data pipeline.

Rasterize a land-polygon vector (Natural Earth / GSHHG / OSM land polygons,
all in WGS84 lon/lat) into an equirectangular land/water mask that drops
straight into the app's coordinate convention:

    * plate carree (EPSG:4326 as a regular pixel grid) — no cartographic
      reprojection, just a linear lon/lat -> pixel mapping.
    * row 0 = +90 (north) at the top, longitude -180..180 left..right,
      matching latOf()/lonOf() in the viewer. The Civ south-origin flip
      happens later, at serialize time, so the mask stays north-up here.

Polygon holes (e.g. inland lakes carried inside a land polygon) are handled
correctly by rasterio.features.rasterize, so lakes come out as water for free.
"""
import argparse, json
import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from PIL import Image


def load_land_geometries(path):
    """Yield (geojson-geometry, value) pairs. rasterize accepts geojson dicts
    directly, so we need neither geopandas nor shapely here."""
    with open(path) as fh:
        gj = json.load(fh)
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
    for feat in feats:
        geom = feat["geometry"] if "geometry" in feat else feat
        if geom and geom.get("type") in ("Polygon", "MultiPolygon"):
            yield (geom, 1)


def rasterize_land(path, width, height, all_touched=False):
    # NW corner at (-180, +90); rows increase southward -> north-up mask.
    transform = from_bounds(-180.0, -90.0, 180.0, 90.0, width, height)
    mask = rasterize(
        load_land_geometries(path),
        out_shape=(height, width),
        transform=transform,
        fill=0,                 # water
        default_value=1,        # land
        all_touched=all_touched,
        dtype="uint8",
    )
    return mask


def save_outputs(mask, stem):
    # 1) the mask itself, 0/255 grayscale (this is what the sampler consumes)
    Image.fromarray((mask * 255).astype(np.uint8), mode="L").save(stem + "_mask.png")
    # 2) a human-readable preview: land = green, water = deep blue
    h, w = mask.shape
    rgb = np.empty((h, w, 3), np.uint8)
    rgb[mask == 1] = (76, 122, 74)
    rgb[mask == 0] = (18, 46, 66)
    Image.fromarray(rgb, "RGB").save(stem + "_preview.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("geojson", help="land-polygon geojson (WGS84 lon/lat)")
    ap.add_argument("--width", type=int, default=3600)
    ap.add_argument("--height", type=int, default=1800)
    ap.add_argument("--stem", default="landmask")
    ap.add_argument("--all-touched", action="store_true",
                    help="mark a pixel land if any polygon touches it (fatter coasts)")
    args = ap.parse_args()

    assert args.width == 2 * args.height, "equirectangular grid must be 2:1"
    mask = rasterize_land(args.geojson, args.width, args.height, args.all_touched)
    save_outputs(mask, args.stem)

    land_frac = float(mask.mean())
    deg_per_px = 360.0 / args.width
    print(f"grid            {args.width} x {args.height}  (2:1 equirectangular)")
    print(f"resolution      {deg_per_px:.4f} deg/px  (~{deg_per_px*111.32:.1f} km at equator)")
    print(f"land fraction   {land_frac*100:.1f}%   (Earth reference ~29.2%)")
    print(f"wrote           {args.stem}_mask.png, {args.stem}_preview.png")


if __name__ == "__main__":
    main()
