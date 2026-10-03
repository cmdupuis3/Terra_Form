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

# The same pipeline tiles the lake layer (HydroLAKES: lakes are punched out of the land fill, so a cell
# the layer covers completely is "full" = all lake). Lakes also get an absolute size floor per LOD: a
# pond that can't move a Civ tile's land fraction at that LOD is just bytes.
KINDS = {
    # union: OSM pieces abut along the 1 deg split grid and must be merged; HydroLAKES polygons are disjoint,
    # and a cascaded union over a Canadian 10 deg cell's 100k+ ponds is what made the first lake run crawl.
    "land":  dict(out="coast_tiles", min_km2={"c": 0.0, "f": 0.0}, union=True,
                  source="osmdata.openstreetmap.de land-polygons-split-4326",
                  attribution="© OpenStreetMap contributors (ODbL 1.0)"),
    # tol: HydroLAKES outlines are ~30 m-spaced fractal shorelines; at the coast tolerances they barely
    # simplify (37 MB). A lake edge 55 m off is invisible at any Civ tile size, so lakes get 2.5x the tolerance.
    "lakes": dict(out="lake_tiles", min_km2={"c": 10.0, "f": 1.0}, union=False, tol={"c": 0.0075, "f": 0.0005},
                  source="HydroLAKES v1.0 polygons (Messager et al. 2016, hydrosheds.org)",
                  attribution="HydroLAKES © Messager et al. 2016 (CC BY 4.0)"),
}
KM2_PER_DEG2 = 111.32 ** 2   # at the equator; scaled by cos(lat) per polygon


def area_km2(geoms):
    """Approximate area in km2 of each polygon (plate carree area x cos of the bbox centre latitude)."""
    b = shapely.bounds(geoms)
    lat = np.deg2rad((b[:, 1] + b[:, 3]) / 2)
    return shapely.area(geoms) * KM2_PER_DEG2 * np.cos(lat)

_PIECES = None       # per-process: (geoms ndarray, STRtree)

# Lagoon supplement for the lake layer (--diff-land/--diff-ne): places OSM maps as inland water (so its
# land polygons cover them) that Natural Earth maps as sea and HydroLAKES doesn't carry -- Lagoa dos
# Patos, for one. Per cell: OSM land minus NE land, keeping parts that are big and thick enough not to be
# a coastline-generalisation sliver, and dropping any part that is (nearly) a whole OSM component: that
# is an island NE left out, not a lagoon, and must stay land. The outline is NE's, so ~1 km precision.
LAGOON_MIN_KM2, LAGOON_MIN_THICK_KM, LAGOON_ISLAND_FRAC = 10.0, 1.0, 0.8
LAGOON_LAT_MIN = -60.0   # no diff in Antarctica: OSM's coastline follows the ice-shelf edge, NE's the grounding line,
                         # so the difference there is a million km2 of Ross/Ronne/Amery shelf, not lagoons
_DIFF = None         # per-process: (osm geoms, osm tree, ne geoms, ne tree)


def _init_diff(osm_cache, ne_json):
    global _DIFF
    osm_g, osm_t = load_pieces(None, 0, osm_cache)
    rings = []
    for p in json.load(open(ne_json, encoding="utf-8"))["polys"]:
        if p["r"] and len(p["r"][0]) >= 4:
            rings.append(shapely.make_valid(Polygon(p["r"][0], [h for h in p["r"][1:] if len(h) >= 4])))
    ne_g = np.array(rings, dtype=object)
    _DIFF = (osm_g, osm_t, ne_g, STRtree(ne_g))
    print(f"[{os.getpid()}] lagoon diff: {len(osm_g)} OSM pieces, {len(ne_g)} NE polygons", flush=True)


def lagoon_parts(ob):
    """Polygons of (OSM land - NE land) inside the box `ob` that look like lagoons (see above)."""
    osm_g, osm_t, ne_g, ne_t = _DIFF
    if ob.bounds[3] <= LAGOON_LAT_MIN:
        return []
    i = osm_t.query(ob, predicate="intersects")
    if len(i) == 0:
        return []
    osm = shapely.unary_union(shapely.clip_by_rect(osm_g[i], *ob.bounds))
    j = ne_t.query(ob, predicate="intersects")
    diff = osm.difference(shapely.unary_union(shapely.clip_by_rect(ne_g[j], *ob.bounds))) if len(j) else osm
    comps = polygons_of(osm)
    ctree = STRtree(comps) if comps else None
    out = []
    for p in polygons_of(diff):
        if p.centroid.y < LAGOON_LAT_MIN:
            continue
        c = math.cos(math.radians(p.centroid.y))
        a = p.area * KM2_PER_DEG2 * c
        if a < LAGOON_MIN_KM2 or a / (p.length * 111.32) < LAGOON_MIN_THICK_KM:
            continue
        if ctree is not None:
            k = ctree.query(p.representative_point(), predicate="within")
            if len(k) and p.area / comps[k[0]].area > LAGOON_ISLAND_FRAC:
                continue   # a whole OSM component: an island NE dropped, not a lagoon
        out.append(p)
    return out


def load_pieces(shp, presimplify, cache, min_km2=0.0):
    """Read the shapefile, drop polygons under min_km2 (the smallest floor any LOD applies -- for
    HydroLAKES that is most of the 1.4M ponds), run one global DP pass at half the fine tolerance
    (79M -> 22M vertices for OSM; cheap, and it makes every later clip/union faster), and cache the
    result as ragged arrays so worker processes load it in seconds instead of redoing the 2-minute
    read+simplify each."""
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
    if min_km2 > 0:
        n = len(g)
        g = g[area_km2(g) >= min_km2]
        print(f"size floor {min_km2} km2: {n} -> {len(g)} polygons", flush=True)
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


def _init(shp, presimplify, cache, min_km2=0.0, diff=None):
    global _PIECES
    _PIECES = load_pieces(shp, presimplify, cache, min_km2)
    if diff:
        _init_diff(*diff)


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


def build_cell(lod, col, row, adapt=True, min_km2=0.0, union=True, tol=None):
    """Returns ('water'|'full'|'tile', bytes|None, stats). 'water' = nothing of this layer in the cell,
    'full' = the layer covers the whole cell (continent interior for land, mid-Superior for lakes)."""
    P = LODS[lod]
    geoms, tree = _PIECES
    D, q, ov = P["deg"], P["q"], P["ov"]
    tol = tol or P["tol"]
    lon0, lat1 = -180.0 + col * D, 90.0 - row * D
    lon1, lat0 = lon0 + D, lat1 - D
    cell = box(lon0, lat0, lon1, lat1)
    ob = box(lon0 - ov, lat0 - ov, lon1 + ov, lat1 + ov)
    idx = tree.query(ob, predicate="intersects")
    if len(idx) == 0 and _DIFF is None:
        return "water", None, {}
    clipped = shapely.clip_by_rect(geoms[idx], lon0 - ov, lat0 - ov, lon1 + ov, lat1 + ov)
    clipped = clipped[~shapely.is_empty(clipped)]
    if len(clipped) == 0 and _DIFF is None:
        return "water", None, {}
    if union:
        land = shapely.unary_union(clipped) if len(clipped) else shapely.Polygon()
        if land.is_empty and _DIFF is None:
            return "water", None, {}
        parts = polygons_of(land)
    else:   # disjoint input: the pieces are the polygons
        parts = [p for g in clipped for p in polygons_of(g)]
        land = None
    if _DIFF is not None:
        try:
            have = shapely.unary_union(parts) if parts else None   # skip lagoons HydroLAKES already carries (Pontchartrain)
            parts += [p for p in lagoon_parts(ob) if have is None or have.intersection(p).area < 0.5 * p.area]
        except shapely.errors.GEOSException as e:   # a bad NE ring in an Arctic cell shouldn't cost the cell its lakes
            print(f"  lagoon diff skipped for {lod} {col}_{row}: {e}", flush=True)
    if not parts:
        return "water", None, {}
    # whole cell is covered (interior of a continent / middle of a great lake): no file, flag in the index
    if sum(p.area for p in parts) >= cell.area * (1 - 1e-9) and (land or shapely.unary_union(parts)).covers(cell):
        return "full", None, {}

    min_area = (MIN_AREA_TOL * tol) ** 2
    polys, nv = [], 0
    for poly in parts:
        if poly.area < min_area:
            continue
        if min_km2 > 0 and poly.area * KM2_PER_DEG2 * math.cos(math.radians(poly.centroid.y)) < min_km2:
            continue   # below the LOD's size floor (lakes)
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
    lod, col, row, adapt, min_km2, union, tol = args
    try:
        kind, data, st = build_cell(lod, col, row, adapt, min_km2, union, tol)
    except Exception as e:   # one bad cell shouldn't kill a 40-minute run
        return lod, col, row, "error", None, {"error": repr(e)}
    return lod, col, row, kind, data, st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shp")
    ap.add_argument("--kind", choices=list(KINDS), default="land", help="land (OSM land polygons) or lakes (HydroLAKES)")
    ap.add_argument("--out", default="", help="default data/<coast_tiles|lake_tiles> by --kind")
    ap.add_argument("--lods", default="c,f")
    ap.add_argument("--only", default="", help="comma list of col_row ids to build (debug)")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--no-adapt", action="store_true", help="plain DP (for measuring what the adaptive term saves)")
    ap.add_argument("--presimplify", type=float, default=-1, help="global DP pass before tiling (default: half the kind's fine tolerance)")
    ap.add_argument("--cache", default="", help="npz cache of the pre-simplified pieces (created on first run; speeds up --workers)")
    ap.add_argument("--diff-land", default="", help="lakes only: npz cache of the OSM land build, for the lagoon supplement")
    ap.add_argument("--diff-ne", default="", help="lakes only: Natural Earth land polygons json (data/coast_hires.json)")
    args = ap.parse_args()
    diff = (args.diff_land, args.diff_ne) if (args.diff_land and args.diff_ne) else None
    K = KINDS[args.kind]
    if args.presimplify < 0:
        args.presimplify = K.get("tol", {}).get("f", LODS["f"]["tol"]) / 2
    if not args.out:
        args.out = os.path.join(os.path.dirname(__file__), "..", "data", K["out"])
    lods = [l for l in args.lods.split(",") if l]
    only = set(args.only.split(",")) if args.only else None
    os.makedirs(args.out, exist_ok=True)
    for lod in lods:
        os.makedirs(os.path.join(args.out, lod), exist_ok=True)

    jobs = []
    for lod in lods:
        for c, r in cell_ids(lod):
            if only is None or f"{c}_{r}" in only:
                jobs.append((lod, c, r, not args.no_adapt, K["min_km2"][lod], K["union"], K.get("tol", {}).get(lod)))
    print(f"{len(jobs)} cells to build ({args.kind})", flush=True)

    index = {"version": 1, "kind": args.kind, "source": K["source"], "built": date.today().isoformat(),
             "attribution": K["attribution"], "lods": {}}
    if diff:
        index["supplement"] = "lagoons = OSM land minus Natural Earth land (NE outline), >= %g km2, mean width >= %g km" % (LAGOON_MIN_KM2, LAGOON_MIN_THICK_KM)
    ipath = os.path.join(args.out, "index.json")
    if only and os.path.exists(ipath):   # partial rebuild: keep every other cell's entry
        index = json.load(open(ipath, encoding="utf-8"))
        for lod in lods:
            L = index["lods"].get(lod)
            if L:
                L["tiles"] = [k for k in L["tiles"] if k not in only]
                L["full"] = [k for k in L["full"] if k not in only]
    for lod in lods:
        P = LODS[lod]
        index["lods"].setdefault(lod, {"deg": P["deg"], "cols": int(round(360 / P["deg"])), "rows": int(round(180 / P["deg"])),
                                       "tol": K.get("tol", {}).get(lod, P["tol"]), "q": P["q"], "minKm2": K["min_km2"][lod],
                                       "ext": "bin", "tiles": [], "full": []})
    t0 = time.time()
    totals = {lod: {"tiles": 0, "full": 0, "water": 0, "bytes": 0, "verts": 0} for lod in lods}

    def handle(res):
        lod, col, row, kind, data, st = res
        key = f"{col}_{row}"
        T = totals[lod]
        if kind == "tile":
            with open(os.path.join(args.out, lod, key + ".bin"), "wb") as f:
                f.write(data)
            index["lods"][lod]["tiles"].append(key)
            T["tiles"] += 1; T["bytes"] += st["bytes"]; T["verts"] += st["verts"]
        elif kind == "full":
            index["lods"][lod]["full"].append(key); T["full"] += 1
        elif kind == "water":
            T["water"] += 1
        else:
            print(f"  !! {lod} {key}: {st.get('error')}", flush=True)

    floor = min(K["min_km2"].values())
    if args.workers > 1:
        if args.cache and not os.path.exists(args.cache):
            load_pieces(args.shp, args.presimplify, args.cache, floor)   # build the cache once, in the parent
        with ProcessPoolExecutor(args.workers, initializer=_init, initargs=(args.shp, args.presimplify, args.cache, floor, diff)) as ex:
            for i, res in enumerate(ex.map(work, jobs, chunksize=4)):
                handle(res)
                if i % 200 == 0:
                    print(f"  {i}/{len(jobs)}  {time.time()-t0:.0f}s", flush=True)
    else:
        _init(args.shp, args.presimplify, args.cache, floor, diff)
        for i, job in enumerate(jobs):
            handle(work(job))
            if i % 200 == 0:
                print(f"  {i}/{len(jobs)}  {time.time()-t0:.0f}s", flush=True)

    for lod in lods:
        L = index["lods"][lod]
        L["tiles"].sort(key=lambda k: tuple(map(int, k.split("_"))))
        L["full"].sort(key=lambda k: tuple(map(int, k.split("_"))))
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))
    (write_licence if args.kind == "land" else write_licence_lakes)(args.out, index)
    for lod in lods:
        T = totals[lod]
        print(f"lod {lod}: {T['tiles']} tiles, {T['full']} full, {T['water']} empty, "
              f"{T['verts']:,} verts, {T['bytes']/1e6:.1f} MB gz", flush=True)
    print(f"done in {time.time()-t0:.0f}s -> {args.out}")


def write_licence_lakes(out, index):
    with open(os.path.join(out, "README.txt"), "w", encoding="utf-8") as f:
        f.write(f"""Lake tiles derived from HydroLAKES
==================================

Source : {index['source']}  (https://www.hydrosheds.org/products/hydrolakes)
Built  : {index['built']}  with scripts/build_coast_tiles.py --kind lakes (clip, union, simplify, size floor,
         quantize, gzip). Lakes under {index['lods'].get('f', {}).get('minKm2', '?')} km2 (fine LOD) /
         {index['lods'].get('c', {}).get('minKm2', '?')} km2 (coarse LOD) are dropped.

Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
Attribution: Messager, M.L., Lehner, B., Grill, G., Nedeva, I., Schmitt, O. (2016). Estimating the
volume and age of water stored in global lakes using a geo-statistical approach. Nature
Communications 7: 13603. doi:10.1038/ncomms13603
""")


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
