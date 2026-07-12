#!/usr/bin/env python3
"""
reduce_rivers.py -- HydroRIVERS_v10.gdb -> terminal-tiled, channel-decomposed river tiles
for Terra-WBS, with a Koppen-weighted keep threshold that preserves small rivers in dry regions.

Pipeline:
  1. read reaches ORD_FLOW <= --read-ord (default 6, i.e. >= ~1 m3/s) from the .gdb
  2. simplify geometry (Douglas-Peucker). INVARIANT: reach ENDPOINTS are never moved -- see the
     warning at the simplify call. The app distinguishes a real river MOUTH from a mere CONFLUENCE
     by exact coordinate equality between channel terminals and other channels' vertices; nudging
     an endpoint breaks that and sends tributaries hunting for estuaries far inland.
  3. decompose the network into CHANNELS (main-stem / tributary): at each confluence the
     highest-discharge upstream branch continues the channel, the others start new channels.
     Each channel's TERMINAL is where THAT channel ends -- a tributary's confluence with its
     parent, a main stem's mouth, or an inland/endorheic sink -- NOT the whole-basin mouth.
  4. KEEP each channel if its peak discharge >= a climate-dependent floor. Climate is judged by
     sampling the Koppen class at BOTH the channel's source and its terminal: a channel counts
     as arid only if BOTH ends are in arid (BW), semi-arid if both ends are in arid-or-steppe
     (BW/BS), else it uses the base floor. (Both-ends test avoids counting a wet-fed river that
     merely nicks a desert.) Floors: arid ~1 m3/s, semi-arid ~10, base ~100.
  5. TILE kept channels by TERMINAL location on a --grid-deg lon/lat grid (whole channels per
     tile) and write <out-dir>/<tx>_<ty>.json + manifest.json (per-tile bbox).

Koppen raster (--koppen): either the app's equirectangular class-index PNG
(data/koppen_2048.png) OR the original high-res GeoTIFF (read via rasterio, using its own
georeferencing). Both use the standard Beck 30-class legend -- there is NO 'As' class -- so the
indices are the same either way: arid BWh,BWk = 4,5; semi-arid BSh,BSk = 6,7; tundra ET = 29.
Those are the defaults, so no --*-classes overrides are needed for the Beck tif. (Add Csa=8 to
--semiarid-classes if you want Mediterranean drainages treated as semi-arid.) The printed climate
counts let you sanity-check.

  pip install pyogrio geopandas shapely numpy pillow rasterio

Example (app PNG):
  python3 scripts/reduce_rivers.py HydroRIVERS_v10.gdb --koppen data/koppen_2048.png --out-dir data/river_tiles
Example (high-res tif -- same indices as the PNG, so no class overrides needed):
  python3 scripts/reduce_rivers.py HydroRIVERS_v10.gdb --koppen koppen_geiger_0p00833333.tif \
      --semiarid-classes 6 7 8 --out-dir data/river_tiles     # (6 7 8 adds Csa to semi-arid)
"""
import argparse, gc, json, math, os
from collections import deque, defaultdict
import pyogrio
import numpy as np
from PIL import Image

COLS = ["HYRIV_ID", "NEXT_DOWN", "DIS_AV_CMS", "ORD_FLOW", "UPLAND_SKM", "LENGTH_KM"]


class Reach:
    """One HydroRIVERS reach. __slots__, not a dict: 80 B instead of 272 B, which is ~1.2 GB saved
    over 6.3M reaches. Indexable like the dict it replaced, so the rest of the pipeline is unchanged."""
    __slots__ = ("id", "nd", "d", "u", "km", "l")

    def __init__(self, id, nd, d, u, km, l):
        self.id, self.nd, self.d, self.u, self.km, self.l = id, nd, d, u, km, l

    def __getitem__(self, k):
        return getattr(self, k)

    def __setitem__(self, k, v):
        setattr(self, k, v)


def build_sampler(path):
    """Return sample(points)->[class,...] for a Koppen raster (equirectangular PNG or GeoTIFF)."""
    if path.lower().endswith((".tif", ".tiff")):
        import rasterio
        src = rasterio.open(path)                       # uses the raster's own CRS/transform
        def sample(points):
            return [int(v[0]) for v in src.sample(points)]   # points: [(lon,lat),...]
        return sample
    arr = np.asarray(Image.open(path))
    if arr.ndim == 3:
        arr = arr[..., 0]
    H, W = arr.shape
    def sample(points):
        out = []
        for lon, lat in points:
            px = int((lon + 180) / 360 * W) % W
            py = min(H - 1, max(0, int((90 - lat) / 180 * H)))
            out.append(int(arr[py, px]))
        return out
    return sample


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gdb", help="path to HydroRIVERS_v10.gdb")
    ap.add_argument("--koppen", default="data/koppen_2048.png", help="Koppen class raster (PNG or GeoTIFF)")
    ap.add_argument("--out-dir", default="data/river_tiles")
    ap.add_argument("--arid-classes", type=int, nargs="+", default=[4, 5], help="arid (BW) class indices")
    ap.add_argument("--semiarid-classes", type=int, nargs="+", default=[6, 7], help="semi-arid (BS) class indices")
    ap.add_argument("--tundra-classes", type=int, nargs="+", default=[29], help="tundra (ET) class index (29 in the Beck legend)")
    ap.add_argument("--read-ord", type=int, default=6,
                    help="read reaches ORD_FLOW <= this (6 ~ >=1 m3/s; floor arid can keep). Lower if RAM-tight.")
    ap.add_argument("--keep-base", type=float, default=100.0)
    ap.add_argument("--keep-semiarid", type=float, default=10.0)
    ap.add_argument("--keep-arid", type=float, default=1.0)
    ap.add_argument("--keep-tundra", type=float, default=130.0, help="floor in tundra (ET) -- DEBUFF above base to thin permafrost streams")
    ap.add_argument("--min-reaches", type=int, default=3, help="drop channels with fewer reaches (named exceptions exempt)")
    # --- spurious-channel filters (all judged at the channel OUTLET; named exceptions exempt) ---
    ap.add_argument("--min-upland-skm", type=float, default=10.0,
                    help="drop channels whose OUTLET drains less than this catchment area (km2). "
                         "HydroRIVERS traces every DEM valley, so a channel that drains ~nothing is a "
                         "landform artifact, not a river. 0 disables.")
    ap.add_argument("--keep-zero-discharge", dest="drop_zero_discharge", action="store_false",
                    help="keep channels whose outlet has modelled discharge 0 (default: drop them)")
    ap.set_defaults(drop_zero_discharge=True)
    ap.add_argument("--min-yield-mm", type=float, default=0.0,
                    help="THE EMPTY-QUARTER FILTER. Drop channels whose outlet sheds less than this specific "
                         "runoff (mm/yr) = Q/area. A sand-sea valley yields ~0.5 mm/yr; the Rhine and Potomac "
                         "yield ~300-400. CAUTION: a real desert wadi also yields little, so put the ones you "
                         "want in ALWAYS_INCLUDE first. See the [diag] table for what each threshold costs. "
                         "0 = off (default).")
    ap.add_argument("--min-length-km", type=float, default=0.0,
                    help="drop channels shorter than this. A channel shorter than ~3 export tiles cannot be "
                         "drawn as a river at all. At a 20-deg-wide view with W=104 a tile is ~21 km, so ~60 km "
                         "is the resolvability floor there. 0 = off (default).")
    ap.add_argument("--max-hack-ratio", type=float, default=0.0,
                    help="drop channels longer than this multiple of Hack's law (L ~ 1.4*A^0.6). Catches a channel "
                         "traced along a scarp or ridge. Does NOT catch Empty-Quarter channels -- those have huge "
                         "DEM basins; use --min-yield-mm for those. Try 3.0. 0 = off (default).")
    ap.add_argument("--prefilter-dis", type=float, default=0.0,
                    help="MEMORY. Push a discharge floor into the SQL so rows never enter RAM. Discharge rises "
                         "downstream, so this only trims headwater tips off channels you keep -- set it just under "
                         "your lowest keep floor (e.g. 0.9 if --keep-arid=1.0). 0 = off (default).")
    ap.add_argument("--chunk", type=int, default=500_000,
                    help="MEMORY. Read the .gdb in chunks of this many features (a GeoDataFrame of 6M shapely "
                         "geometries is what blows the heap).")
    ap.add_argument("--simplify-deg", type=float, default=0.008)
    ap.add_argument("--grid-deg", type=float, default=20.0)
    ap.add_argument("--lod-thresholds", type=float, nargs="+", default=[30.0, 300.0, 3000.0],
                    help="magnitude (peak discharge * length_deg) cuts for LOD bins: >=t2->lod0(biggest) .. <t0->lod3")
    ap.add_argument("--layer", default=None)
    args = ap.parse_args()
    ARID, SEMI = set(args.arid_classes), set(args.semiarid_classes)
    B = ARID | SEMI
    TUNDRA = set(args.tundra_classes)

    where = f"ORD_FLOW <= {args.read_ord}"
    if args.prefilter_dis > 0:
        # Push a discharge floor into the SQL, so the rows never enter RAM at all. Discharge rises
        # monotonically downstream, so this can only trim HEADWATER TIPS off channels you were going
        # to keep -- it cannot change which channels clear the keep floor, as long as it stays below
        # your lowest floor (keep_arid). Caveat: force-kept boxes lose their sub-threshold reaches.
        where += f" AND DIS_AV_CMS >= {args.prefilter_dis}"

    # Chunk by HYRIV_ID RANGE, not by feature offset. skip_features is applied to the layer
    # independently of the `where` clause, so offset-chunking a filtered read silently returns
    # OVERLAPPING pages (it read 6.5M rows out of a 6.27M-row layer, and the duplicate reaches then
    # blew up the channel graph). ID ranges are disjoint by construction, so this cannot recur.
    print(f"[read] {args.gdb}  where={where}")
    idf = pyogrio.read_dataframe(args.gdb, layer=args.layer, columns=["HYRIV_ID"],
                                 where=where, read_geometry=False)
    total = len(idf)
    id_lo, id_hi = int(idf["HYRIV_ID"].min()), int(idf["HYRIV_ID"].max())
    del idf; gc.collect()
    npages = max(1, math.ceil(total / max(1, args.chunk)))
    stride = max(1, math.ceil((id_hi - id_lo + 1) / npages))
    print(f"[read] {total:,} reaches match; {npages} page(s) of ~{args.chunk:,} by HYRIV_ID")

    feats, dropped = [], 0
    for lo in range(id_lo, id_hi + 1, stride):
        gdf = pyogrio.read_dataframe(
            args.gdb, layer=args.layer, columns=COLS,
            where=f"({where}) AND HYRIV_ID >= {lo} AND HYRIV_ID < {lo + stride}")
        for r in gdf.itertuples(index=False):
            g = r.geometry
            if g is None or g.is_empty:
                dropped += 1; continue
            if args.simplify_deg > 0:
                # Douglas-Peucker keeps each LineString's FIRST and LAST vertex, and HydroRIVERS splits
                # reaches AT confluences -- so the shared confluence node survives as an endpoint of both
                # the tributary's exit reach and the main stem's reaches. That is load-bearing.
                #
                # !!! NEVER smooth, snap, re-sample, or otherwise NUDGE reach endpoints. !!!
                # The app decides whether a channel terminal is a real river MOUTH (worth an expensive
                # estuary search) or merely a CONFLUENCE with another channel by testing exact coordinate
                # equality against the vertices of other channels. Move an endpoint by even one rounding
                # step and that test fails: tributaries get mistaken for basin mouths and go hunting for
                # estuaries hundreds of km inland. Interior vertices may be simplified freely.
                # (The round(x, 3) below is safe only because it is applied uniformly to every vertex,
                # so two coincident points stay coincident.)
                g = g.simplify(args.simplify_deg, preserve_topology=False)
            parts = g.geoms if g.geom_type == "MultiLineString" else [g]
            # tuple points, not [x, y] lists: 56 B vs 72 B each, over ~14M points
            lines = [[(round(x, 3), round(y, 3)) for x, y in p.coords] for p in parts if len(p.coords) >= 2]
            if not lines:
                dropped += 1; continue
            feats.append(Reach(int(r.HYRIV_ID), int(r.NEXT_DOWN), round(float(r.DIS_AV_CMS), 3),
                               float(getattr(r, "UPLAND_SKM", 0.0) or 0.0),   # upstream catchment, km2
                               float(getattr(r, "LENGTH_KM", 0.0) or 0.0), lines))
        del gdf; gc.collect()
        print(f"[read] {len(feats):,} / {total:,} reaches loaded ...", end="\r")
    print(f"[read] {len(feats):,} reaches loaded" + " " * 24)

    byid = {f["id"]: f for f in feats}
    present = set(byid)

    # --- channel decomposition ---
    upstream = defaultdict(list)
    for f in feats:
        if f["nd"] in present:
            upstream[f["nd"]].append(f["id"])
    main_up = {D: max(ups, key=lambda u: byid[u]["d"]) for D, ups in upstream.items()}
    chid, nxt, q = {}, 0, deque()
    for f in feats:
        if f["nd"] not in present:
            chid[f["id"]] = nxt; q.append(f["id"]); nxt += 1
    while q:
        D = q.popleft(); c = chid[D]
        for u in upstream.get(D, []):
            chid[u] = c if u == main_up[D] else nxt
            if u != main_up[D]:
                nxt += 1
            q.append(u)
    print(f"[channels] {nxt:,} channels")

    ch_reaches = defaultdict(list)
    for f in feats:
        ch_reaches[chid[f["id"]]].append(f)

    def terminal(rs, c):                          # downstream end of the channel's exit reach (confluence for a tributary)
        ex = [f for f in rs if chid.get(f["nd"], -1) != c]
        return (ex[0] if ex else rs[0])["l"][-1][-1]
    def source(rs):                               # upstream end of the channel's head reach
        lasts = set(tuple(f["l"][-1][-1]) for f in rs)
        head = next((f for f in rs if tuple(f["l"][0][0]) not in lasts), rs[0])
        return head["l"][0][0]

    cids = list(ch_reaches)
    ends = {c: (source(ch_reaches[c]), terminal(ch_reaches[c], c)) for c in cids}

    # --- climate at BOTH endpoints (batch-sample the Koppen raster) ---
    sample = build_sampler(args.koppen)
    pts = []
    for c in cids:
        s, t = ends[c]; pts.append(tuple(s)); pts.append(tuple(t))
    vals = sample(pts)
    kmap = {c: (vals[2 * i], vals[2 * i + 1]) for i, c in enumerate(cids)}   # channel -> (source class, terminal class)

    def keep_floor(c):
        ks, kt = kmap[c]
        if ks in ARID and kt in ARID:
            return args.keep_arid, "arid"
        if ks in B and kt in B:
            return args.keep_semiarid, "semiarid"
        if ks in TUNDRA and kt in TUNDRA:
            return args.keep_tundra, "tundra"          # debuff: higher floor thins permafrost streams
        return args.keep_base, "other"

    # channels intersecting a named-exception box are ALWAYS kept, whatever their discharge.
    # bbox = [W, S, E, N]. These are approximate -- check the [exceptions] catch counts printed
    # below and tighten any box that catches the wrong river (or catches 0 = not in the read set).
    ALWAYS_INCLUDE = [
        ("Vermilion (LA)",       [-92.15, 29.55, -91.95, 30.35]),
        ("Bayou Lafourche (LA)", [-90.75, 29.05, -90.20, 30.05]),   # tightened off the Atchafalaya
        ("Bayou Teche (LA)",     [-91.85, 29.65, -91.30, 30.55]),   # tightened off the Atchafalaya
        ("Salt River (AZ)",      [-112.50, 33.30, -109.80, 34.00]),
        ("Blackstone (RI)",      [-71.85, 41.80, -71.35, 42.30]),
        ("Wadi Ziz (MA)",        [-4.60, 30.80, -3.90, 32.10]),
        ("Gediz (TR)",           [26.70, 38.40, 29.60, 39.20]),
        ("Litani (LB)",          [35.15, 33.20, 36.15, 34.05]),
        ("Wadi Hadramaut (YE)",  [47.00, 14.80, 50.60, 16.40]),
        ("Wadi Tuban (YE)",      [44.70, 12.85, 45.10, 13.70]),
        ("Wadi Dhar (YE)",       [44.05, 15.40, 44.30, 15.75]),
        ("Wadi Dhana (YE)",      [44.90, 14.80, 45.70, 15.70]),
        ("Wadi Ibrahim (SA)",    [39.70, 21.30, 40.00, 21.60]),
        ("Yarkon (IL)",          [34.75, 32.05, 35.05, 32.17]),
        ("Eilat-DeadSea (IL)",   [34.90, 29.50, 35.50, 31.05]),
        ("Surkhandarya (UZ/TJ)", [66.90, 37.10, 68.20, 38.70]),
    ]
    def in_box(rs, box):
        w, s, e, n = box
        return any(w <= p[0] <= e and s <= p[1] <= n for f in rs for part in f["l"] for p in part)
    force = {}
    ex_counts = defaultdict(int)
    for c in cids:
        for name, box in ALWAYS_INCLUDE:
            if in_box(ch_reaches[c], box):
                force[c] = True; ex_counts[name] += 1
    if ALWAYS_INCLUDE:
        print("[exceptions] channels force-kept per box: " +
              ", ".join(f"{n}={ex_counts[n]}" for n, _ in ALWAYS_INCLUDE))

    kept, clim_counts = {}, defaultdict(int)
    for c in cids:
        rs = ch_reaches[c]
        floor, tag = keep_floor(c)
        clim_counts[tag] += 1
        if c in force or max(f["d"] for f in rs) >= floor:
            kept[c] = (rs, ends[c][1])
    print(f"[keep] {len(kept):,}/{nxt:,} channels  (by climate: {dict(clim_counts)}, +{len(force)} forced)")

    # min-reach filter: drop stubby channels (named exceptions exempt)
    if args.min_reaches > 1:
        before = len(kept)
        kept = {c: v for c, v in kept.items() if c in force or len(v[0]) >= args.min_reaches}
        print(f"[min-reach] dropped {before - len(kept):,} channels with < {args.min_reaches} reaches")

    # --- spurious-channel filter (named exceptions exempt) ---------------------------------------
    # HydroRIVERS is traced by flow-routing a DEM (HydroSHEDS), so it emits a "river" down EVERY
    # topographic valley, whether or not water has ever run there. Its discharge is MODELLED
    # (WaterGAP), not observed.
    #
    # NOTE ON WHAT DOESN'T WORK, learned the hard way:
    #   * min-upland / zero-discharge are SUBSUMED by the climate keep-floor above. By the time we
    #     get here every channel already carries >= keep_arid m3/s, so they can never fire. They are
    #     kept only as guards for anyone who sets the keep floors to ~0.
    #   * Hack's law (length vs basin) does NOT catch Rub' al-Khali / Empty Quarter channels. Those
    #     are not "too long for their basin" -- HydroSHEDS hands them a genuinely ENORMOUS catchment
    #     (vast flat sand-sea sinks). Their L/Hack is ~0.3, well under any sane threshold. It still
    #     catches a channel traced along a scarp or ridge, so it stays, but it is not the desert tool.
    #
    # What DOES separate a sand-sea artifact from a river is SPECIFIC RUNOFF (yield): how much water
    # the basin actually sheds per unit area.
    #     Rub' al-Khali valley  ~100,000 km2, ~1.5 m3/s  ->   ~0.5 mm/yr
    #     Potomac                 30,000 km2,   306 m3/s ->    323 mm/yr
    #     Rhine                  185,000 km2,  2330 m3/s ->    397 mm/yr
    # Two to three orders of magnitude apart. --min-yield-mm is the Empty Quarter filter.
    def outlet(rs, c):
        ex = [f for f in rs if chid.get(f["nd"], -1) != c]
        return ex[0] if ex else max(rs, key=lambda f: f["u"])

    SEC_PER_YR = 31_556_952.0
    def yield_mm(q, a):                       # specific runoff, mm/yr
        return (q * SEC_PER_YR) / (a * 1e6) * 1000.0 if a > 0 else 0.0
    def hack_len(a):                          # Hack's law: main-stem length ~ 1.4 * A^0.6 (km, km2)
        return 1.4 * (a ** 0.6) if a > 0 else 0.0

    stats = {}
    for c, v in kept.items():
        rs = v[0]; o = outlet(rs, c)
        stats[c] = (o["u"], o["d"], sum(f["km"] for f in rs), keep_floor(c)[1])   # area, Q, length_km, climate

    # Diagnostic FIRST, so thresholds are chosen from the data rather than guessed.
    def pcts(vals):
        vals = sorted(vals)
        if not vals: return "n/a"
        g = lambda p: vals[min(len(vals) - 1, int(p / 100 * len(vals)))]
        return f"p10={g(10):<9.2f} p50={g(50):<9.2f} p90={g(90):<9.2f}"
    print("[diag] specific runoff (mm/yr) of kept channels, by climate:")
    for tag in ("other", "semiarid", "arid", "tundra"):
        ys = [yield_mm(a, 0) if False else yield_mm(q, a) for (a, q, L, t) in stats.values() if t == tag]
        if ys:
            print(f"         {tag:<9} n={len(ys):<7,} {pcts(ys)}")
    print("[diag] channel length (km) of kept channels: " + pcts([L for (_, _, L, _) in stats.values()]))
    print("[diag] --min-yield-mm would drop:  " + "  ".join(
        f"{th}mm={sum(1 for c,(a,q,L,t) in stats.items() if c not in force and yield_mm(q,a) < th):,}"
        for th in (1, 2, 5, 10, 20)))
    print("[diag] --min-length-km would drop: " + "  ".join(
        f"{th}km={sum(1 for c,(a,q,L,t) in stats.items() if c not in force and L < th):,}"
        for th in (10, 25, 50, 100, 200)))

    spur = defaultdict(int)
    before = len(kept)
    survivors = {}
    for c, v in kept.items():
        if c in force:
            survivors[c] = v; continue
        area, q, L, _tag = stats[c]
        if area < args.min_upland_skm:
            spur["no catchment"] += 1; continue
        if args.drop_zero_discharge and q <= 0.0:
            spur["zero discharge"] += 1; continue
        if args.min_yield_mm > 0 and yield_mm(q, area) < args.min_yield_mm:
            spur["dry basin (low yield)"] += 1; continue
        if args.min_length_km > 0 and L < args.min_length_km:
            spur["too short to resolve"] += 1; continue
        if args.max_hack_ratio > 0 and area > 0 and L > args.max_hack_ratio * hack_len(area):
            spur["too long for its basin"] += 1; continue
        survivors[c] = v
    kept = survivors
    print(f"[spurious] dropped {before - len(kept):,} channels: {dict(spur) if spur else '{}'}"
          f"  -> {len(kept):,} channels remain")

    # --- LOD bins by magnitude (peak discharge * total length in degrees) ---
    def seglen(rs):
        L = 0.0
        for f in rs:
            for part in f["l"]:
                for i in range(1, len(part)):
                    L += math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1])
        return L
    t0, t1, t2 = args.lod_thresholds
    def lod_of(rs):
        m = max(f["d"] for f in rs) * seglen(rs)
        return 0 if m >= t2 else 1 if m >= t1 else 2 if m >= t0 else 3

    # --- terminal tiling, split by region AND LOD bin (so small rivers load only when zoomed in) ---
    GS = args.grid_deg
    tiles = defaultdict(list)
    lod_counts = defaultdict(int)
    for c, (rs, term) in kept.items():
        lod = lod_of(rs); lod_counts[lod] += 1
        tx, ty = math.floor((term[0] + 180) / GS), math.floor((term[1] + 90) / GS)
        tiles[(tx, ty, lod)].append((c, rs))
    print(f"[lod] channels per bin (0=biggest): {dict(sorted(lod_counts.items()))}")

    os.makedirs(args.out_dir, exist_ok=True)
    for old in os.listdir(args.out_dir):
        if old.endswith(".json"):
            os.remove(os.path.join(args.out_dir, old))
    manifest, total = [], 0
    for (tx, ty, lod), chs in tiles.items():
        tid = f"{tx}_{ty}_{lod}"
        recs, mnx, mny, mxx, mxy = [], 1e9, 1e9, -1e9, -1e9
        for c, rs in chs:
            for f in rs:
                recs.append({"d": f["d"], "c": c, "l": f["l"]})
                for part in f["l"]:
                    for p in part:
                        mnx, mxx = min(mnx, p[0]), max(mxx, p[0])
                        mny, mxy = min(mny, p[1]), max(mxy, p[1])
        path = os.path.join(args.out_dir, tid + ".json")
        json.dump({"features": recs}, open(path, "w"), separators=(",", ":"))
        total += os.path.getsize(path)
        manifest.append({"id": tid, "lod": lod, "b": [round(mnx, 3), round(mny, 3), round(mxx, 3), round(mxy, 3)],
                         "n": len(recs)})
    json.dump({"schema": "terra-rivers-tiles/2", "gs": GS, "lods": 4, "channels": len(kept), "tiles": manifest},
              open(os.path.join(args.out_dir, "manifest.json"), "w"), separators=(",", ":"))
    print(f"[write] {len(manifest)} tiles + manifest to {args.out_dir}  ({total/1e6:.1f} MB, "
          f"{dropped:,} empty/degenerate dropped)")


if __name__ == "__main__":
    main()
