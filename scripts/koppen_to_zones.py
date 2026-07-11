#!/usr/bin/env python3
"""
koppen_to_zones.py  —  rasterize a Köppen-Geiger vector (a GeoJSON of climate-zone
polygons with a CODE property, WGS84 lon/lat) into an equirectangular class-index
PNG the app decodes (grayscale value = class index, 0 = none/ocean).

Bundled data: Rubel-Kottek 1976-2000 zones (via the circleofconfusion/climate-map
GitHub mirror). For higher fidelity, the Beck et al. 2018/2023 1-km GeoTIFFs are
CC BY 4.0 on gloh2o.org / figshare — reproject one to this grid the same way
(swap the loader for rasterio.open + a value remap onto the ORDER below).

    pip install rasterio numpy pillow
    python koppen_to_zones.py koppen.geojson --width 2048 --height 1024 --out koppen_2048.png
"""
import argparse, json
import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from PIL import Image

# canonical class order; index = position+1, 0 = none. Must match KOPPEN_KEYS in index.html.
ORDER = ['Af','Am','As','Aw','BWh','BWk','BSh','BSk','Csa','Csb','Csc','Cwa','Cwb','Cwc','Cfa','Cfb','Cfc',
         'Dsa','Dsb','Dsc','Dsd','Dwa','Dwb','Dwc','Dwd','Dfa','Dfb','Dfc','Dfd','ET','EF']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("geojson", help="Köppen zone polygons with a CODE property (WGS84 lon/lat)")
    ap.add_argument("--code-field", default="CODE")
    ap.add_argument("--width", type=int, default=2048)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--out", default="koppen.png")
    args = ap.parse_args()
    assert args.width == 2 * args.height, "equirectangular grid must be 2:1"

    idx = {c: i + 1 for i, c in enumerate(ORDER)}
    gj = json.load(open(args.geojson))
    transform = from_bounds(-180, -90, 180, 90, args.width, args.height)
    shapes = []
    for f in gj["features"]:
        c = f["properties"].get(args.code_field)
        if c in idx:
            shapes.append((f["geometry"], idx[c]))
    km = rasterize(shapes, out_shape=(args.height, args.width), transform=transform, fill=0, dtype="uint8")
    Image.fromarray(km, mode="L").save(args.out, optimize=True)
    print(f"grid {args.width}x{args.height} | classes {len(set(v for _, v in shapes))} | classified {float((km>0).mean())*100:.1f}%")
    print(f"wrote {args.out}  (embed as a data: URL in index.html's KOPPEN_SRC)")


if __name__ == "__main__":
    main()
