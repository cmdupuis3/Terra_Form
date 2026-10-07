#!/usr/bin/env python3
"""
audit_lake_rivers.py  --  how much of a world pack's inland water looks like river

Reads a Culture Wars world pack's landmask.png and rivers.png, labels the inland water (water not
connected to the frame's edge), and counts the components that are thin and threaded on a medium or
major river: at least --min-cells cells, mean width (cells over the long side of the bounding box) at
most --max-width, river cells of class 2 or 3 along at least --min-river of that long side. It is a
screen, not a judge -- a fjord lake with a river through it has the same silhouette -- so it is run
before and after a lake-layer change (scripts/river_lakes.py) to see the thin set shrink while the
big lakes stay put.

  python scripts/audit_lake_rivers.py "<Unity>/Assets/StreamingAssets/WorldPacks/earth16k" [--list 40]
"""
import argparse, json, os

import numpy as np
from PIL import Image
import scipy.ndimage as ndi

Image.MAX_IMAGE_PIXELS = None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack", help="world pack folder (manifest.json, landmask.png, rivers.png)")
    ap.add_argument("--min-cells", type=int, default=10)
    ap.add_argument("--max-width", type=float, default=3.0)
    ap.add_argument("--min-river", type=float, default=0.7)
    ap.add_argument("--list", type=int, default=30, help="print this many of the flagged components, largest first")
    args = ap.parse_args()

    man = json.load(open(os.path.join(args.pack, "manifest.json"), encoding="utf-8"))
    W, H = man["width"], man["height"]
    b = man["bounds"]
    land = np.array(Image.open(os.path.join(args.pack, man["layers"]["landMask"]["file"]))) > 0
    riv = np.array(Image.open(os.path.join(args.pack, man["layers"]["rivers"]["file"])))
    lab, _ = ndi.label(~land)
    edge = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    inland = lab.copy()
    inland[np.isin(lab, edge[edge > 0])] = 0
    ids = np.unique(inland)
    ids = ids[ids > 0]
    sizes = ndi.sum(np.ones_like(inland, dtype=np.uint8), inland, ids)
    rmed = ndi.sum((riv >= 2).astype(np.uint8), inland, ids)
    objs = ndi.find_objects(inland)
    print(f"{man['name']} {W}x{H}: {len(ids)} inland water components, {int(sizes.sum())} cells; "
          f"{int(((riv >= 2) & ~land).sum())} medium/major river cells lie under water")

    flagged = []
    for k, i in enumerate(ids):
        sl = objs[i - 1]
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        L = max(w, h)
        if sizes[k] >= args.min_cells and sizes[k] / L <= args.max_width and rmed[k] / L >= args.min_river:
            y = (sl[0].start + sl[0].stop) / 2
            x = (sl[1].start + sl[1].stop) / 2
            lon = b["lonMin"] + x / W * (b["lonMax"] - b["lonMin"])
            lat = b["latMax"] - y / H * (b["latMax"] - b["latMin"])   # PNG row 0 is north
            flagged.append((sizes[k], w, h, sizes[k] / L, rmed[k] / L, lon, lat))
    flagged.sort(key=lambda r: -r[0])
    print(f"thin river-threaded components (>= {args.min_cells} cells, width <= {args.max_width}, river >= {args.min_river}): "
          f"{len(flagged)}, {sum(r[0] for r in flagged):.0f} cells")
    for r in flagged[:args.list]:
        print(f"  cells {r[0]:6.0f} bbox {r[1]:3d}x{r[2]:3d} width {r[3]:.1f} river {r[4]:.2f} at {r[5]:8.2f} {r[6]:7.2f}")
    big = sorted(zip(sizes, ids), reverse=True)[:10]
    print("largest lakes (cells): " + ", ".join(f"{int(s)}" for s, _ in big))


if __name__ == "__main__":
    main()
