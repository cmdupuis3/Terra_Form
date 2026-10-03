#!/usr/bin/env python3
"""
build_coast_tiles.py  --  OSM land polygons  ->  data/coast_tiles/  (compact, tiled, two LODs)

Input : the osmdata.openstreetmap.de "land-polygons-split-4326" shapefile (WGS84, land = polygon,
        ocean = nothing; pieces pre-split on a 1 deg grid, so no feature is wider than ~1.1 deg).
Output: data/coast_tiles/index.json  plus  data/coast_tiles/<lod>/<col>_<row>.bin

    lod "c"  coarse  10 deg cells   (36 x 18)   tolerance ~300 m  -> windows 30..8 deg wide
    lod "f"  fine    2.5 deg cells  (144 x 72)  tolerance ~22 m   -> windows below 8 deg
                                                (same grid as data/hgt_tiles)

Per tile:
  1. collect the pieces that touch the cell (+ a small overlap so neighbouring tiles' fills overlap
     instead of abutting -- an abutting pair leaves an anti-aliased seam at ~75% coverage),
  2. clip to the overlapped box and union (removes the 1 deg split edges),
  3. simplify each polygon with Douglas-Peucker, tolerance scaled by its complexity:
       smooth outlines (perimeter close to the convex hull's) get up to --adapt x the base
       tolerance, convoluted ones (fjords, archipelago fragments) keep the base. Nothing in a
       low-complexity outline is lost at that scale, and the bytes go where the shape is,
  4. drop islets smaller than (--min-area x tol)^2 -- below what a Civ tile at that LOD can resolve,
  5. quantize to a per-LOD grid (q deg; error <= q/2 << tol), delta + zigzag varint encode, gzip.
  Tiles whose union covers the whole cell are listed in index.json "land" and get no file;
  cells with no land at all are simply absent (water).

Binary layout (all little-endian; "varint" = LEB128 unsigned, coordinates zigzag-signed):
  "CST1"  u8 lodIndex  u8 flags(0)  u16 pad   f64 lon0  f64 lat0  f64 q
  varint nPolys  { varint nRings { varint nVerts  nVerts x (varint dLon, varint dLat) } }
  ring[0] = exterior, ring[1..] = holes; first vertex is relative to (lon0,lat0), the rest to the
  previous vertex, all in units of q; the closing vertex is implicit. The whole file is gzipped
  (the app sniffs the 1f 8b magic and runs DecompressionStream).

Licence: the output is a derivative database of OpenStreetMap -> ODbL 1.0. The script writes
LICENSE.txt and README.txt next to the tiles and records source + date in index.json. Rendered
maps / WBS exports are "produced works" and only need the credit line.

Usage:
  python scripts/build_coast_tiles.py path/to/land_polygons.shp [--out data/coast_tiles]
         [--lods c,f] [--only 141_35,35_8] [--workers N]
"""
import argparse, gzip, io, json, math, os, struct, sys, time
from concurrent.futures import ProcessPoolExecutor
from datetime import date

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import Polygon, MultiPolygon, box

LODS = {
    #        cells/deg    tol (deg)   quant (deg)  overlap (deg)
    "c": dict(deg=10.0,  tol=0.003,  q=1e-3,      ov=0.02),    # ~330 m, ~110 m grid
    "f": dict(deg=2.5,   tol=0.0002, q=1e-4,      ov=0.004),   # ~22 m,  ~11 m grid
}
ADAPT_MAX = 3.0      # tolerance multiplier for the smoothest outlines (ratio -> 1)
MIN_AREA_TOL = 3.0   # drop polygons with area < (MIN_AREA_TOL * tol)^2

_PIECES = None       # per-process: (geoms ndarray, STRtree)


def load_pieces(shp, presimplify, cache):
    """Read the shapefile, run one global DP pass at half the fine tolerance (79M -> 22M vertices; cheap,
    and it makes every later clip/union faster), and cache the result as ragged arrays so worker
    processes can load it in seconds instead of redoing the 2-minute read+simplify each."""
    t = time.time()
    if cache and os.path.exists(cache):
        z = np.load(cache)
        offs = tuple(z[f"off{i}"] for i in range(int(z["noff"])))   # 2 arrays for Polygon, 3 for MultiPolygon
        g = shapely.from_ragged_array(shapely.GeometryType(int(z["gtype"])), z["coords"], offs)
        print(f"[{os.getpid()}] loaded {len(g)} cached pieces in {time.time()-t:.1f}s", flush=True)
        return g, STRtree(g)
    import pyogrio
    df = pyogrio.read_dataframe(shp, columns=[], use_arrow=True)
    g = df.geometry.values
    n0 = int(shapely.get_num_coordinates(g).sum())
    if presimplify > 0:
        g = shapely.simplify(g, presimplify, preserve_topology=True)
        g = g[~shapely.is_empty(g)]
    n1 = int(shapely.get_num_coordinates(g).sum())
    print(f"loaded {len(g)} pieces, {n0:,} -> {n1:,} vertices in {time.time()-t:.1f}s", flush=True)
    if cache:
        gtype, coords, offs = shapely.to_ragged_array(g)
        np.savez(cache, gtype=np.int64(gtype.value), coords=coords, noff=np.int64(len(offs)), **{f"off{i}": o for i, o in enumerate(offs)})
    return g, STRtree(g)


def _init(shp, presimplify, cache):
    global _PIECES
    _PIECES = load_pieces(shp, presimplify, cache)


# ---------- geometry ----------
def polygons_of(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, "geoms"):   # GeometryCollection: keep the polygonal parts
        out = []
        for g in geom.geoms:
            out += polygons_of(g)
        return out
    return []


def adaptive_tol(poly, tol):
    """DP tolerance for one polygon: base tol x [1 .. ADAPT_MAX], larger for smoother outlines.
    complexity = perimeter / convex-hull perimeter (1 = convex blob, >>1 = fjords)."""
    hp = poly.convex_hull.length
    if hp <= 0:
        return tol
    ratio = poly.length / hp
    # ratio 1 -> ADAPT_MAX, ratio >= 2 -> 1, linear between
    m = 1.0 + (ADAPT_MAX - 1.0) * max(0.0, min(1.0, 2.0 - ratio))
    return tol * m


def build_cell(lod, col, row, adapt=True):
    """Returns ('water'|'land'|'tile', bytes|None, stats)."""
    P = LODS[lod]
    geoms, tree = _PIECES
    D, tol, q, ov = P["deg"], P["tol"], P["q"], P["ov"]
    lon0, lat1 = -180.0 + col * D, 90.0 - row * D
    lon1, lat0 = lon0 + D, lat1 - D
    cell = box(lon0, lat0, lon1, lat1)
    ob = box(lon0 - ov, lat0 - ov, lon1 + ov, lat1 + ov)
    idx = tree.query(ob, predicate="intersects")
    if len(idx) == 0:
        return "water", None, {}
    clipped = shapely.clip_by_rect(geoms[idx], lon0 - ov, lat0 - ov, lon1 + ov, lat1 + ov)
    clipped = clipped[~shapely.is_empty(clipped)]
    if len(clipped) == 0:
        return "water", None, {}
    land = shapely.unary_union(clipped)
    if land.is_empty:
        return "water", None, {}
    # whole cell is land (interior of a continent): no file, flag in the index
    if land.area >= cell.area * (1 - 1e-9) and land.covers(cell):
        return "land", None, {}

    min_area = (MIN_AREA_TOL * tol) ** 2
    polys, nv = [], 0
    for poly in polygons_of(land):
        if poly.area < min_area:
            continue
        t = adaptive_tol(poly, tol) if adapt else tol
        s = shapely.simplify(poly, t, preserve_topology=True)
        for sp in polygons_of(s):
            if sp.area < min_area:
                continue
            rings = [np.asarray(sp.exterior.coords)] + [np.asarray(h.coords) for h in sp.interiors if Polygon(h).area >= min_area]
            polys.append(rings)
            nv += sum(len(r) for r in rings)
    if not polys:
        return "water", None, {}
    data = encode(lod, lon0 - ov, lat0 - ov, q, polys)
    return "tile", data, {"polys": len(polys), "verts": nv, "bytes": len(data)}


# ---------- encoding ----------
def varint(buf, v):
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            buf.append(b | 0x80)
        else:
            buf.append(b)
            return


def zig(v):
    return (v << 1) ^ (v >> 63) if v < 0 else v << 1


def encode(lod, olon, olat, q, polys):
    out = bytearray()
    out += b"CST1" + struct.pack("<BBH", list(LODS).index(lod), 0, 0) + struct.pack("<ddd", olon, olat, q)
    body = bytearray()
    enc_polys = []
    for rings in polys:
        enc_rings = []
        for r in rings:
            u = np.rint((r - (olon, olat)) / q).astype(np.int64)
            if len(u) > 1 and (u[0] == u[-1]).all():
                u = u[:-1]                                   # implicit closure
            keep = np.ones(len(u), bool)
            keep[1:] = (u[1:] != u[:-1]).any(axis=1)         # drop consecutive duplicates after quantization
            u = u[keep]
            if len(u) >= 3:
                enc_rings.append(u)
        if enc_rings and len(enc_rings[0]) >= 3:
            enc_polys.append(enc_rings)
    varint(body, len(enc_polys))
    for enc_rings in enc_polys:
        varint(body, len(enc_rings))
        for u in enc_rings:
            varint(body, len(u))
            d = np.diff(u, axis=0, prepend=np.zeros((1, 2), np.int64))
            for dx, dy in d.tolist():
                varint(body, zig(dx)); varint(body, zig(dy))
    out += body
    return gzip.compress(bytes(out), compresslevel=9)


# ---------- driver ----------
def cell_ids(lod):
    D = LODS[lod]["deg"]
    cols, rows = int(round(360 / D)), int(round(180 / D))
    return [(c, r) for r in range(rows) for c in range(cols)]


def work(args):
    lod, col, row, adapt = args
    try:
        kind, data, st = build_cell(lod, col, row, adapt)
    except Exception as e:   # one bad cell shouldn't kill a 40-minute run
        return lod, col, row, "error", None, {"error": repr(e)}
    return lod, col, row, kind, data, st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shp")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "coast_tiles"))
    ap.add_argument("--lods", default="c,f")
    ap.add_argument("--only", default="", help="comma list of col_row ids to build (debug)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--no-adapt", action="store_true", help="plain DP (for measuring what the adaptive term saves)")
    ap.add_argument("--presimplify", type=float, default=LODS["f"]["tol"] / 2)
    ap.add_argument("--cache", default="", help="npz cache of the pre-simplified pieces (created on first run; speeds up --workers)")
    args = ap.parse_args()
    lods = [l for l in args.lods.split(",") if l]
    only = set(args.only.split(",")) if args.only else None
    os.makedirs(args.out, exist_ok=True)
    for lod in lods:
        os.makedirs(os.path.join(args.out, lod), exist_ok=True)

    jobs = []
    for lod in lods:
        for c, r in cell_ids(lod):
            if only is None or f"{c}_{r}" in only:
                jobs.append((lod, c, r, not args.no_adapt))
    # heavy cells first so the pool doesn't idle at the end: sort by number of touching pieces
    print(f"{len(jobs)} cells to build", flush=True)

    index = {"version": 1, "source": "osmdata.openstreetmap.de land-polygons-split-4326",
             "built": date.today().isoformat(),
             "attribution": "© OpenStreetMap contributors (ODbL 1.0)", "lods": {}}
    for lod in lods:
        P = LODS[lod]
        index["lods"][lod] = {"deg": P["deg"], "cols": int(round(360 / P["deg"])), "rows": int(round(180 / P["deg"])),
                              "tol": P["tol"], "q": P["q"], "ext": "bin", "tiles": [], "land": []}
    t0 = time.time()
    totals = {lod: {"tiles": 0, "land": 0, "water": 0, "bytes": 0, "verts": 0} for lod in lods}

    def handle(res):
        lod, col, row, kind, data, st = res
        key = f"{col}_{row}"
        T = totals[lod]
        if kind == "tile":
            with open(os.path.join(args.out, lod, key + ".bin"), "wb") as f:
                f.write(data)
            index["lods"][lod]["tiles"].append(key)
            T["tiles"] += 1; T["bytes"] += st["bytes"]; T["verts"] += st["verts"]
        elif kind == "land":
            index["lods"][lod]["land"].append(key); T["land"] += 1
        elif kind == "water":
            T["water"] += 1
        else:
            print(f"  !! {lod} {key}: {st.get('error')}", flush=True)

    if args.workers > 1:
        if args.cache and not os.path.exists(args.cache):
            load_pieces(args.shp, args.presimplify, args.cache)   # build the cache once, in the parent
        with ProcessPoolExecutor(args.workers, initializer=_init, initargs=(args.shp, args.presimplify, args.cache)) as ex:
            for i, res in enumerate(ex.map(work, jobs, chunksize=4)):
                handle(res)
                if i % 200 == 0:
                    print(f"  {i}/{len(jobs)}  {time.time()-t0:.0f}s", flush=True)
    else:
        _init(args.shp, args.presimplify, args.cache)
        for i, job in enumerate(jobs):
            handle(work(job))
            if i % 200 == 0:
                print(f"  {i}/{len(jobs)}  {time.time()-t0:.0f}s", flush=True)

    for lod in lods:
        L = index["lods"][lod]
        L["tiles"].sort(key=lambda k: tuple(map(int, k.split("_"))))
        L["land"].sort(key=lambda k: tuple(map(int, k.split("_"))))
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))
    write_licence(args.out, index)
    for lod in lods:
        T = totals[lod]
        print(f"lod {lod}: {T['tiles']} tiles, {T['land']} all-land, {T['water']} water, "
              f"{T['verts']:,} verts, {T['bytes']/1e6:.1f} MB gz", flush=True)
    print(f"done in {time.time()-t0:.0f}s -> {args.out}")


def write_licence(out, index):
    with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as f:
        f.write(f"""Coastline tiles derived from OpenStreetMap land polygons
=========================================================

Source : {index['source']}  (https://osmdata.openstreetmap.de/data/land-polygons.html)
Built  : {index['built']}  with scripts/build_coast_tiles.py (clip, union, simplify, quantize, gzip)

These tiles are a Derivative Database of OpenStreetMap data and are licensed under the
Open Database License (ODbL) 1.0 -- see LICENSE.txt / https://opendatacommons.org/licenses/odbl/1-0/
Attribution: (c) OpenStreetMap contributors.

This licence applies to the files in this directory only. The Terra-WBS application code and the
other datasets under data/ carry their own licences. Maps, images and world files produced by the
app from these tiles are "Produced Works" under the ODbL: they need the attribution line, nothing
more. The process to recreate the tiles is this directory's build script; the upstream source is
publicly available at the URL above.
""")
    with open(os.path.join(out, "LICENSE.txt"), "w", encoding="utf-8") as f:
        f.write("Open Database License (ODbL) v1.0\n\nFull text: https://opendatacommons.org/licenses/odbl/1-0/\n\n"
                "Summary (not a substitute for the licence): you are free to share, create from and adapt this\n"
                "database as long as you attribute OpenStreetMap contributors, share any adapted database under\n"
                "the ODbL, and keep it open (no technical measures that restrict the work).\n")


if __name__ == "__main__":
    main()
