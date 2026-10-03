#!/usr/bin/env python3
"""
fetch_osm_waterways.py -- pull OSM river lines over the world's dry regions, for the observed-river
gate in reduce_rivers.py.

HydroRIVERS is DEM-traced, so in sand seas (Rub' al-Khali, Simpson, the Ergs) it invents rivers down
interdune corridors. OSM is mapped by people: a wadi or creek that has a name, or that someone bothered
to draw as a river, is very unlikely to be a dune corridor. reduce_rivers.py scores desert channels by
how much of them lies along these lines.

Source: the Overture Maps "base/water" layer (OSM waterways, re-published as GeoParquet on a public
S3 bucket). It is read with bbox + column pushdown, so a 25x20 deg box takes seconds -- the public
Overpass API needed ~1 min per 5 deg tile once its rate limit kicked in.

Coverage: every --tile-deg lon/lat tile whose land is >= --min-dry of Koppen BW/BS (from the app's
koppen PNG), read in --block-deg blocks. Per block it keeps LINE features with
    class=river                   (named or not)
    class=stream + a name         (unnamed streams are too dense and too noisy to be worth it)
and caches the block as <out-dir>/<lon>_<lat>.json, so a rerun only fetches what is missing.

Output records: {"k": class, "n": name or null, "i": 1 if intermittent, "g": [[lon,lat],...]}

  python scripts/fetch_osm_waterways.py --out-dir osm_waterways
(OSM data (c) OpenStreetMap contributors, ODbL, via Overture Maps.)
"""
import argparse, json, os, sys, time
import numpy as np
from PIL import Image
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pfs
import shapely

BUCKET = "overturemaps-us-west-2/release/{release}/theme=base/type=water"


def dry_tiles(koppen, deg, min_dry, dry_classes):
    a = np.asarray(Image.open(koppen))
    if a.ndim == 3:
        a = a[..., 0]
    H, W = a.shape
    nx, ny = int(round(360 / deg)), int(round(180 / deg))
    out = []
    for j in range(ny):                       # j=0 is the northernmost row
        for i in range(nx):
            blk = a[int(j * H / ny):int((j + 1) * H / ny), int(i * W / nx):int((i + 1) * W / nx)]
            land = int((blk > 0).sum())
            if land and np.isin(blk, dry_classes).sum() / land >= min_dry:
                w, n = -180 + i * deg, 90 - j * deg
                out.append((w, n - deg, w + deg, n))
    return out


def latest_release():
    import requests
    cat = requests.get("https://stac.overturemaps.org/catalog.json", timeout=60).json()
    rel = [l["href"].split("/")[-2] for l in cat["links"] if l["rel"] == "child"]
    return sorted(rel)[-1]


def read_block(dset, bbox, dry, simplify_deg):
    """dry: prepared union of the dry tiles -- lines that never touch one are not kept."""
    w, s, e, n = bbox
    flt = ((pc.field("bbox", "xmax") >= w) & (pc.field("bbox", "xmin") <= e) &
           (pc.field("bbox", "ymax") >= s) & (pc.field("bbox", "ymin") <= n) &
           pc.field("class").isin(["river", "stream"]))
    tb = dset.to_table(columns=["class", "names", "is_intermittent", "geometry"], filter=flt)
    geoms = shapely.from_wkb(tb["geometry"].to_numpy(zero_copy_only=False))
    cls = tb["class"].to_pylist()
    names = [nm["primary"] if nm else None for nm in tb["names"].to_pylist()]
    inter = tb["is_intermittent"].to_pylist()
    recs = []
    for g, k, nm, it in zip(geoms, cls, names, inter):
        if g is None or g.geom_type not in ("LineString", "MultiLineString"):
            continue                           # river AREAS are polygons; the centreline is a separate way
        if k == "stream" and not nm:
            continue
        if not dry.intersects(g):
            continue
        # the gate matches within kilometres, so ~300 m of shape and 3 decimals are plenty; this
        # shrinks the cache ~10x (the US block is ~300 MB at full OSM detail)
        g = shapely.simplify(g, simplify_deg)
        for p in getattr(g, "geoms", [g]):
            c = shapely.get_coordinates(p)
            if len(c) >= 2:
                recs.append({"k": k, "n": nm, "i": 1 if it else 0, "g": np.round(c, 3).tolist()})
    return recs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--koppen", default="data/koppen_2048.png")
    ap.add_argument("--out-dir", default="osm_waterways")
    ap.add_argument("--release", default=None, help="Overture release, e.g. 2026-09-23.0 (default: latest)")
    ap.add_argument("--tile-deg", type=float, default=5.0)
    ap.add_argument("--block-deg", type=float, default=20.0, help="read granularity (multiple of --tile-deg)")
    ap.add_argument("--min-dry", type=float, default=0.02, help="min BW/BS share of a tile's land")
    ap.add_argument("--dry-classes", type=int, nargs="+", default=[4, 5, 6, 7])
    ap.add_argument("--simplify-deg", type=float, default=0.003)
    args = ap.parse_args()

    release = args.release or latest_release()
    fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
    dset = ds.dataset(BUCKET.format(release=release), filesystem=fs, format="parquet")
    os.makedirs(args.out_dir, exist_ok=True)

    tiles = dry_tiles(args.koppen, args.tile_deg, args.min_dry, args.dry_classes)
    dry = shapely.union_all([shapely.box(*t) for t in tiles])
    shapely.prepare(dry)
    B = args.block_deg
    blocks = sorted({(np.floor(t[0] / B) * B, np.floor(t[1] / B) * B) for t in tiles})
    todo = [b for b in blocks if not os.path.exists(os.path.join(args.out_dir, f"{b[0]:g}_{b[1]:g}.json"))]
    print(f"[tiles] {len(tiles)} dry {args.tile_deg:g}-deg tiles in {len(blocks)} {B:g}-deg blocks, "
          f"{len(todo)} to fetch (Overture {release})", flush=True)
    for k, (w, s) in enumerate(todo):
        t0 = time.time()
        bbox = (float(w), float(s), float(w + B), float(s + B))
        recs = read_block(dset, bbox, dry, args.simplify_deg)
        path = os.path.join(args.out_dir, f"{w:g}_{s:g}.json")
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump({"bbox": bbox, "release": release, "features": recs}, f, separators=(",", ":"),
                      ensure_ascii=False)
        os.replace(path + ".tmp", path)
        named = sum(1 for r in recs if r["n"])
        print(f"[{k + 1}/{len(todo)}] {bbox}: {len(recs):,} lines ({named:,} named)  {time.time() - t0:.0f}s",
              flush=True)
    print("[done]", flush=True)


if __name__ == "__main__":
    sys.exit(main())
