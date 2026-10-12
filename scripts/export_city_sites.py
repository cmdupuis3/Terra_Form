#!/usr/bin/env python3
"""
export_city_sites.py -- per-site terrain packs for Culture Wars city maps.

The plan is the game's docs/CITY-TERRAIN-PLAN.md. For each seat asked for, a square window in a local
metre frame (transverse Mercator centred on the seat, x east, y north) is filled from the finest source
there is for each layer and written to <out>/<seat id>/:

  height_inner.png   m16 metres: (R * 256 + G) * stepMetres + minMeters (R high byte, G low byte; B 0),
                     whole metres by default (--height-step), INNER samples at INNER_M spacing,
                     pixel-is-point, row 0 north, from Copernicus GLO-30 (a DSM). The game takes the
                     terracing a coarse step leaves out again (smoothing held within half a step).
                     Whole metres halve the height PNGs against the old rg16 (0.1 m) and lose nothing
                     the sources carry: GLO-30's own vertical error is a few metres.
  height_outer.png   the same for the OUTER samples at OUTER_M spacing, from Copernicus GLO-90
  koppen.png         index8 Beck 2023 class on the outer lattice, from data/koppen_tiles (1 km polygons);
                     unclassified land takes the nearest class
  water.png          index8 on a 30 m lattice over the outer span: 0 land, 1 sea, 2 lake, 3 river channel,
                     4 salt pan; OSM land polygons (harbour works taken out, rings rounded: clean_coast),
                     Overture base/water lakes (HydroLAKES where Overture has nothing), river areas and
                     perennial river lines, Natural Earth playas
  shore.png          signed distance to the coast (water positive), 128 + d / 2 m, within ~360 m of it
  river.png          the same for the mapped river and canal banks (Overture river areas)
  vectors.bin        "CWCS" v1 (little-endian): polylines in local metres (coast rings, lake rings with
                     their level, playa rings, Overture waterways with class and the discharge of the
                     HydroRIVERS reach along them, HydroRIVERS reaches with discharge)
  site.json          frame, grids, sources, stats

and <out>/index.json lists the sites written. The two height lattices nest exactly: the inner span is a
whole number of outer cells and its corner vertices are outer vertices, so the game can stitch the two
meshes without cracks (INNER = 271 at 30 m is 8,100 m, half 4,050 = 45 outer cells; OUTER = 267 at 90 m
is 23,940 m, half 11,970 = 133 outer cells).

Copernicus tiles are read as Cloud-Optimised GeoTIFFs over HTTPS (/vsicurl/) from the public AWS buckets:
only the blocks under the window cross the wire. The result of each read is cached under --cache as .npy.
Attribution for the credits: produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus
Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.

  python scripts/export_city_sites.py --pack <Unity>/Assets/StreamingAssets/WorldPacks/earth16k \
      --out <Unity>/Assets/StreamingAssets/CitySites/earth --seats 171,71,62,633,1509,5
"""
import argparse, json, math, os, struct, sys, time
import numpy as np
from PIL import Image
import rasterio
from rasterio import features
from rasterio.crs import CRS
from rasterio.transform import from_origin, Affine
from rasterio.warp import reproject, Resampling, transform, transform_geom

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))
sys.path.insert(0, HERE)
from elev16 import SEA                                   # the world pack's height floor, -500 m
from export_world_pack import decode_coast_tile, rings_to_polygon

WGS84 = CRS.from_epsg(4326)
INNER, INNER_M = 271, 30.0
OUTER_M = 90.0
OUTER = 267                 # the 24 km default; export_site derives the count from --outer-km
WATER_M = 30.0
HEIGHT_STEP = 1.0           # metres a height unit (m16); --height-step
GLO = {"inner": ("copernicus-dem-30m", "10"), "outer": ("copernicus-dem-90m", "30")}
WATER_CLASSES = ["land", "sea", "lake", "river", "saltpan"]
ATTRIBUTION = ("Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, "
               "provided under COPERNICUS by the European Union and ESA; all rights reserved. Koppen-Geiger: Beck "
               "et al. 2023. Coastline (c) OpenStreetMap contributors (ODbL). Lakes: HydroLAKES (Messager et al. "
               "2016, CC BY 4.0). Rivers and lakes: OpenStreetMap contributors (ODbL) via Overture Maps; HydroRIVERS. "
               "Playas: Natural Earth.")


class Frame:
    """A square window of n pixel-is-point samples at `res` metres, centred on the site, in a local
    transverse Mercator frame (x east, y north, metres). Row 0 is the north edge.

    `warp` (2x2, row-major) maps the window's map metres to true local metres about the centre, for a
    window that is not the ground at true scale (CITY-SITE-SCORE-PLAN 4a: an atoll strip broadened
    across its minor axis, a small island expanded to fill the map). Everything burned or measured in
    the window is in map metres (`transform`, `to_local`); only the DEM reads go through the true
    ground (`geo_transform`)."""
    def __init__(self, lat, lon, n, res, warp=None, centre=(0.0, 0.0)):
        self.lat, self.lon, self.n, self.res = lat, lon, n, res
        self.half = (n - 1) * res / 2.0
        self.cx, self.cy = float(centre[0]), float(centre[1])           # the window's own centre in the frame, metres
        self.crs = CRS.from_proj4(f"+proj=tmerc +lat_0={lat} +lon_0={lon} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs")
        self.transform = from_origin(self.cx - self.half - res / 2.0, self.cy + self.half + res / 2.0, res, res)
        w = None if warp is None else np.reshape(np.asarray(warp, float), (2, 2))
        self.warp = None if w is None or np.allclose(w, np.eye(2)) else w
        if self.warp is None:
            self.geo_transform = self.transform
        else:
            a, b, c, d = self.warp.ravel()
            self.geo_transform = Affine(a, b, 0.0, c, d, 0.0) * self.transform
            self.unwarp = np.linalg.inv(self.warp)

    def lonlat_bounds(self, pad_m=0.0):
        h = self.half + pad_m
        xs = self.cx + np.array([-h, h, h, -h, 0, 0, -h, h], float); ys = self.cy + np.array([-h, -h, h, h, -h, h, 0, 0], float)
        if self.warp is not None:
            xs, ys = self.warp @ np.vstack([xs, ys])
        lons, lats = transform(self.crs, WGS84, list(xs), list(ys))
        return min(lons), min(lats), max(lons), max(lats)

    def to_local(self, geom):
        g = transform_geom(WGS84, self.crs, geom)
        if self.warp is None:
            return g
        m = self.unwarp

        def walk(c):
            if isinstance(c[0], (int, float)):
                return (m[0, 0] * c[0] + m[0, 1] * c[1], m[1, 0] * c[0] + m[1, 1] * c[1])
            return [walk(q) for q in c]
        return {"type": g["type"], "coordinates": walk(g["coordinates"])}

    def tag(self):
        """A cache tag for the warp, empty for the true ground."""
        t = "" if self.warp is None else "_w" + "_".join(f"{v:.4f}" for v in self.warp.ravel())
        return t + (f"_c{self.cx:.0f}_{self.cy:.0f}" if self.cx or self.cy else "")


def touches(b, bounds):
    return not (b[2] < bounds[0] or b[0] > bounds[2] or b[3] < bounds[1] or b[1] > bounds[3])


# ---------------------------------------------------------------- heights

def glo_tile_name(res_code, lat, lon):
    la, lo = int(math.floor(lat)), int(math.floor(lon))
    ns = "N" if la >= 0 else "S"; ew = "E" if lo >= 0 else "W"
    return f"Copernicus_DSM_COG_{res_code}_{ns}{abs(la):02d}_00_{ew}{abs(lo):03d}_00_DEM"


def read_copernicus(frame, ring, cache, log):
    """The frame filled from the GLO tiles under it, bilinear, metres; sea and missing tiles are 0."""
    tag = f"{ring}_{frame.n}_{int(frame.res)}{frame.tag()}"
    cpath = os.path.join(cache, f"{frame.lat:.4f}_{frame.lon:.4f}_{tag}.npy")
    if os.path.exists(cpath):
        log(f"  {ring}: cached {os.path.basename(cpath)}")
        return np.load(cpath)
    bucket, code = GLO[ring]
    w, s, e, n = frame.lonlat_bounds(pad_m=2 * frame.res)
    dst = np.full((frame.n, frame.n), np.nan, np.float32)
    used, missing = [], []
    t0 = time.time()
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
               GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="TRUE",
               VSI_CACHE_SIZE="268435456", GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2")
    with rasterio.Env(**env):
        for la in range(int(math.floor(s)), int(math.floor(n)) + 1):
            for lo in range(int(math.floor(w)), int(math.floor(e)) + 1):
                name = glo_tile_name(code, la, lo)
                url = f"/vsicurl/https://{bucket}.s3.amazonaws.com/{name}/{name}.tif"
                try:
                    src = rasterio.open(url)
                except rasterio.errors.RasterioIOError:
                    missing.append(name)          # an all-sea tile is not published
                    continue
                with src:
                    reproject(source=rasterio.band(src, 1), destination=dst, dst_transform=frame.geo_transform,
                              dst_crs=frame.crs, resampling=Resampling.bilinear, src_nodata=src.nodata,
                              dst_nodata=np.nan, init_dest_nodata=False)
                used.append(name)
    filled = np.where(np.isfinite(dst), dst, 0.0).astype(np.float32)
    os.makedirs(cache, exist_ok=True)
    np.save(cpath, filled)
    log(f"  {ring}: {len(used)} tile(s) {', '.join(used)}" + (f"; sea tiles {missing}" if missing else "")
        + f"  {time.time() - t0:.1f} s")
    return filled


# ---------------------------------------------------------------- vectors from the data folder

def koppen_polys(bounds):
    tdir = os.path.join(DATA, "koppen_tiles")
    idx = json.load(open(os.path.join(tdir, "index.json"), encoding="utf-8"))
    have, deg = set(idx["tiles"]), float(idx["deg"])
    out = []
    for c in range(int((bounds[0] + 180) // deg), int((bounds[2] + 180) // deg) + 1):
        for r in range(int((90 - bounds[3]) // deg), int((90 - bounds[1]) // deg) + 1):
            tid = f"{c}_{r}"
            if tid not in have:
                continue
            for p in json.load(open(os.path.join(tdir, tid + ".json"), encoding="utf-8"))["polys"]:
                if touches(p["b"], bounds):
                    g = rings_to_polygon(p["r"])
                    if g:
                        out.append((g, int(p["v"])))
    return out


def tileset_polys(tileset, bounds, lod="f"):
    """Polygons of data/<tileset>/ (coast_tiles: OSM land; lake_tiles: HydroLAKES) under the bounds."""
    root = os.path.join(DATA, tileset)
    idx = json.load(open(os.path.join(root, "index.json"), encoding="utf-8"))
    L = idx["lods"][lod]
    have, full, D = set(L["tiles"]), set(L.get("full") or []), float(L["deg"])
    out = []
    for c in range(int((bounds[0] + 180) // D), int((bounds[2] + 180) // D) + 1):
        for r in range(int((90 - bounds[3]) // D), int((90 - bounds[1]) // D) + 1):
            key = f"{c}_{r}"
            if key in have:
                out += decode_coast_tile(os.path.join(root, lod, key + "." + L.get("ext", "bin")))
            elif key in full:
                x0, y1 = -180.0 + c * D, 90.0 - r * D
                out.append({"type": "Polygon", "coordinates": [[[x0, y1 - D], [x0 + D, y1 - D], [x0 + D, y1], [x0, y1], [x0, y1 - D]]]})
    return [g for g in out if touches(poly_bounds(g), bounds)]


def poly_bounds(g):
    xs = [x for ring in g["coordinates"] for x, _ in ring]; ys = [y for ring in g["coordinates"] for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def playa_polys(bounds):
    path = os.path.join(DATA, "playas.json")
    if not os.path.exists(path):
        return []
    out = []
    for p in json.load(open(path, encoding="utf-8"))["polys"]:
        if touches(p["b"], bounds):
            g = rings_to_polygon(p["r"])
            if g:
                out.append(g)
    return out


# Overture "base/water" (OSM waterways and water areas, full detail) for the site's box: the city-scale
# rivers, canals, river banks, lakes and lagoons. The box's rows are cached as parquet beside the Copernicus
# cache, so a re-export is offline. Line classes kept: every river, named streams, canals (not ditches or
# drains); polygons: rivers and canals (their mapped banks), lakes, lagoons, reservoirs and plain water
# over OVERTURE_MIN_HA (pools, ponds, basins and sewage works are not city-map water).
OVERTURE_BUCKET = "overturemaps-us-west-2/release/{release}/theme=base/type=water"
OVERTURE_MIN_HA = 2.0
LINE_RIVER, LINE_STREAM, LINE_CANAL, LINE_INTERMITTENT = 0, 1, 2, 8


def overture_water(bounds, cache, release, log):
    """(lines, river_polys, lake_polys, release) in lon/lat: lines are (geojson, name, cls) with cls one of
    LINE_RIVER/STREAM/CANAL plus LINE_INTERMITTENT; polygons are geojson."""
    import pyarrow as pa, pyarrow.parquet as pq
    import shapely
    from shapely.geometry import mapping
    os.makedirs(cache, exist_ok=True)
    key = "_".join(f"{b:.3f}" for b in bounds)
    hits = [f for f in os.listdir(cache) if f.startswith(key + "_") and f.endswith(".parquet")]
    if hits:
        release = hits[0][len(key) + 1:-len(".parquet")]
        tb = pq.read_table(os.path.join(cache, hits[0]))
    else:
        import pyarrow.compute as pc, pyarrow.dataset as ds, pyarrow.fs as pfs
        if not release:
            from fetch_osm_waterways import latest_release
            release = latest_release()
        t0 = time.time()
        fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
        dset = ds.dataset(OVERTURE_BUCKET.format(release=release), filesystem=fs, format="parquet")
        w, s, e, n = bounds
        flt = ((pc.field("bbox", "xmax") >= w) & (pc.field("bbox", "xmin") <= e) &
               (pc.field("bbox", "ymax") >= s) & (pc.field("bbox", "ymin") <= n))
        tb = dset.to_table(columns=["subtype", "class", "names", "is_intermittent", "geometry"], filter=flt)
        tb = pa.table({"subtype": tb["subtype"], "class": tb["class"], "is_intermittent": tb["is_intermittent"],
                       "name": pa.array([nm["primary"] if nm else None for nm in tb["names"].to_pylist()], pa.string()),
                       "geometry": tb["geometry"]})
        pq.write_table(tb, os.path.join(cache, f"{key}_{release}.parquet"))
        log(f"  overture {tb.num_rows} water features {time.time() - t0:.0f} s ({release})")
    geoms = shapely.from_wkb(tb["geometry"].to_numpy(zero_copy_only=False))
    lines, rivers, lakes = [], [], []
    lat = 0.5 * (bounds[1] + bounds[3])
    m2_per_deg2 = 111320.0 ** 2 * math.cos(math.radians(lat))
    for g, st, cl, it, nm in zip(geoms, tb["subtype"].to_pylist(), tb["class"].to_pylist(),
                                 tb["is_intermittent"].to_pylist(), tb["name"].to_pylist()):
        if g is None or g.is_empty:
            continue
        if g.geom_type in ("LineString", "MultiLineString"):
            if st == "river":
                cls = LINE_RIVER
            elif st == "stream" and nm:
                cls = LINE_STREAM
            elif st == "canal" and cl == "canal":
                cls = LINE_CANAL
            else:
                continue
            cls |= LINE_INTERMITTENT if it else 0
            for p in getattr(g, "geoms", [g]):
                if len(p.coords) >= 2:
                    lines.append((mapping(p), nm or "", cls))
        elif g.geom_type in ("Polygon", "MultiPolygon"):
            for p in getattr(g, "geoms", [g]):
                if p.area * m2_per_deg2 < OVERTURE_MIN_HA * 1e4:
                    continue
                if st == "river" or (st == "canal" and cl == "canal"):
                    rivers.append(mapping(p))
                elif (st == "lake" and cl in ("lake", "lagoon", "oxbow")) or (st == "reservoir" and cl == "reservoir") \
                        or (st == "water" and cl == "water"):
                    lakes.append(mapping(p))
    return lines, rivers, lakes, release


WATERWAY_SIMPLIFY_M = 3.0


def _simplified(g):
    """A local-metre geojson line or polygon simplified at WATERWAY_SIMPLIFY_M (topology kept)."""
    import shapely
    from shapely.geometry import shape, mapping
    return mapping(shapely.simplify(shape(g), WATERWAY_SIMPLIFY_M, preserve_topology=True))


def line_discharge(lines, reaches, near_m=1000.0, step_m=200.0):
    """Each local-metre line's discharge (m3/s): the median of the nearest HydroRIVERS reach's over points
    every step_m along it, within near_m; 0 where under a third of its points find one (a river HydroRIVERS
    does not carry). The median keeps a tributary from taking the main river's flow at the confluence."""
    import shapely
    if not reaches:
        return [0.0] * len(lines)
    rl = [shapely.linestrings(np.asarray(g["coordinates"])) for g, _ in reaches]
    rq = np.array([d for _, d in reaches])
    tree = shapely.STRtree(rl)
    out = []
    for g in lines:
        ls = shapely.linestrings(np.asarray(g["coordinates"]))
        k = max(2, int(ls.length / step_m) + 1)
        pts = shapely.line_interpolate_point(ls, np.linspace(0.0, ls.length, k))
        hit, dist = tree.query_nearest(pts, max_distance=near_m, return_distance=True, all_matches=False)
        out.append(float(np.median(rq[hit[1]])) if len(hit[1]) * 3 >= k else 0.0)
    return out


def hydro_reaches(bounds):
    man = json.load(open(os.path.join(DATA, "river_tiles", "manifest.json"), encoding="utf-8"))
    out = []
    for t in man["tiles"]:
        path = os.path.join(DATA, "river_tiles", t["id"] + ".json")
        if not os.path.exists(path) or not touches(t["b"], bounds):
            continue
        for f in json.load(open(path, encoding="utf-8"))["features"]:
            d = float(f.get("d", 0))
            for line in f["l"]:
                if len(line) < 2:
                    continue
                xs = [p[0] for p in line]; ys = [p[1] for p in line]
                if touches((min(xs), min(ys), max(xs), max(ys)), bounds):
                    out.append(({"type": "LineString", "coordinates": [[float(x), float(y)] for x, y in line]}, d))
    return out


def shore_signed_distance(frame, land_polys, lake_polys, water, reach_cells=12):
    """Signed distance (metres, water positive) from each cell centre to the shoreline of the land polygons
    with the lakes cut out, for the cells within reach_cells of the shore by the raster; the rest saturate.
    The raster's shore is a 30 m staircase; this is the polygons' own line, so the game can draw a smooth
    waterline, bed ramp and beach. Encoded as 128 + d / 2 m, clipped to 0..255."""
    import shapely
    from shapely.geometry import shape
    from shapely.ops import unary_union
    from scipy.ndimage import distance_transform_edt
    n = frame.n
    wet = (water == 1) | (water == 2)
    enc = np.where(wet, 255, 0).astype(np.uint8)
    if not land_polys or wet.all() or not wet.any():
        return enc
    def polygons(geoms):
        """The polygonal parts of the valid forms of the polygons (make_valid can return a collection with lines in it, whose union has no boundary)."""
        out = []
        for g in geoms:
            v = shapely.make_valid(shape(g))
            parts = v.geoms if hasattr(v, "geoms") else [v]
            out += [q for q in parts if q.geom_type in ("Polygon", "MultiPolygon") and not q.is_empty]
        return out
    land = unary_union(polygons(land_polys))
    if lake_polys:
        land = land.difference(unary_union(polygons(lake_polys)))
    if land.is_empty:
        return enc
    shapely.prepare(land)
    near = (distance_transform_edt(~wet) <= reach_cells) | (distance_transform_edt(wet) <= reach_cells)
    jj, ii = np.nonzero(near)
    xs = -frame.half + ii * frame.res
    ys = frame.half - jj * frame.res          # row 0 is the north edge
    pts = shapely.points(xs, ys)
    # The shore cut into short pieces in a tree, so each point measures to its nearest pieces only (the rounded
    # rings carry a vertex every few metres; one distance to the whole boundary was minutes a site).
    pieces = []
    for line in (land.boundary.geoms if hasattr(land.boundary, "geoms") else [land.boundary]):
        c = np.asarray(line.coords)
        for a in range(0, len(c) - 1, 32):
            pieces.append(shapely.linestrings(c[a:a + 33]))
    tree = shapely.STRtree(pieces)
    hit, dist = tree.query_nearest(pts, return_distance=True, all_matches=False)
    d = np.empty(len(pts)); d[hit[0]] = dist
    inland = shapely.contains_xy(land, xs, ys)
    signed = np.where(inland, -d, d)
    enc[jj, ii] = np.clip(np.rint(128.0 + signed / 2.0), 0, 255).astype(np.uint8)
    return enc


def polygon_signed_distance(frame, polys, reach_cells=12):
    """Signed distance (metres, inside positive) from each cell centre to the outline of the local-metre
    polygons (the rivers' and canals' mapped banks), encoded as shore_signed_distance's is; cells further
    than reach_cells from the outline saturate (255 inside, 0 outside)."""
    import shapely
    from shapely.geometry import shape
    from shapely.ops import unary_union
    from scipy.ndimage import distance_transform_edt
    if not polys:
        return np.zeros((frame.n, frame.n), np.uint8)
    parts = []
    for g in polys:
        v = shapely.make_valid(shape(g))
        parts += [q for q in (v.geoms if hasattr(v, "geoms") else [v]) if q.geom_type in ("Polygon", "MultiPolygon") and not q.is_empty]
    area = unary_union(parts)
    if area.is_empty:
        return np.zeros((frame.n, frame.n), np.uint8)
    inside = burn(frame, [(area, 1)]) == 1
    enc = np.where(inside, 255, 0).astype(np.uint8)
    near = (distance_transform_edt(~inside) <= reach_cells) | (distance_transform_edt(inside) <= reach_cells)
    jj, ii = np.nonzero(near)
    xs = -frame.half + ii * frame.res
    ys = frame.half - jj * frame.res
    pieces = []
    for line in (area.boundary.geoms if hasattr(area.boundary, "geoms") else [area.boundary]):
        c = np.asarray(line.coords)
        for a in range(0, len(c) - 1, 32):
            pieces.append(shapely.linestrings(c[a:a + 33]))
    tree = shapely.STRtree(pieces)
    hit, dist = tree.query_nearest(shapely.points(xs, ys), return_distance=True, all_matches=False)
    d = np.empty(len(xs)); d[hit[0]] = dist
    shapely.prepare(area)
    signed = np.where(shapely.contains_xy(area, xs, ys), d, -d)
    enc[jj, ii] = np.clip(np.rint(128.0 + signed / 2.0), 0, 255).astype(np.uint8)
    return enc


# ---------------------------------------------------------------- the coastline, cleaned and rounded

# The OSM land polygons come simplified (lod f: 0.0002 deg, ~22 m, on a 0.0001 deg grid), so the shore is a
# polyline whose vertices, 100-500 m apart, are its corners; and they carry the harbour works: piers, jetties,
# breakwaters and the slips and dock basins between them. Neither reads well on a city map. The coast is
# cleaned in the local metre frame before anything is burned from it, so the water raster, the shore distance
# and the vectors agree:
#   1. thin land the morphological opening (radius ART_R) takes away is dropped where it meets the land that
#      stays at exactly one place (a pier, a jetty, a groyne, a sharp point) and is small or straight-edged
#      (on islets: straight-edged or jetty-narrow, so an atoll strip's tip stays);
#      thin necks joining two thick parts (an atoll island's narrow waist) meet it at two and stay, as do
#      thin islands, except long straight thin ones (detached breakwaters);
#   2. thin water the closing (radius ART_R) fills is filled where it is straight-edged (a slip, a dock basin)
#      or small (a sharp notch); natural inlets and channels stay;
#   3. every ring is resampled every ROUND_STEP metres and smoothed along its length by a Gaussian of
#      ROUND_SIGMA metres (ROUND_SIGMA_ISLET on islets, so atoll strips keep their size): corners become curves of about
#      that radius, while shapes larger than a few hundred metres barely move. An interpolating spline would
#      pass through the vertices, and here the vertices are the corners, so the shore is filtered instead.
ART_R = 45.0            # metres: land or water narrower than twice this is a candidate
RECT_MIN = 0.65         # area over the minimum rotated rectangle's: at least this is straight-edged
SMALL_PIECE = 0.03e6    # m2: a one-contact thin piece under this goes whatever its shape (on islets, if narrow)
PIER_WIDTH = 25.0       # metres: on islets, a one-contact thin piece narrower than this on average is a jetty
BREAKWATER_ASPECT = 5.0 # a detached piece this elongated and straight-edged is a breakwater
ROUND_STEP = 10.0       # metres between resampled vertices
ROUND_SIGMA = 70.0      # metres: the smoothing Gaussian along the shore
ROUND_SIGMA_ISLET = 25.0  # metres, on islands under SMALL_LAND_KM2 (atoll islets are strips a few cells wide)


def _parts(g):
    if g.is_empty:
        return []
    return [p for p in (g.geoms if hasattr(g, "geoms") else [g]) if p.geom_type == "Polygon" and not p.is_empty]


def _rectangularity(p):
    r = p.minimum_rotated_rectangle
    return p.area / r.area if r.area > 0 else 0.0, r


def _aspect(rect):
    xs, ys = rect.exterior.coords.xy
    a = math.hypot(xs[1] - xs[0], ys[1] - ys[0]); b = math.hypot(xs[2] - xs[1], ys[2] - ys[1])
    return max(a, b) / max(min(a, b), 1e-6)


def _smooth_ring(coords, step=ROUND_STEP, sigma=ROUND_SIGMA):
    """The closed ring resampled every step metres along its length and smoothed by a circular Gaussian of
    sigma metres (capped at a twentieth of the perimeter, so small islands are not shrunk away)."""
    from scipy.ndimage import gaussian_filter1d
    c = np.asarray(coords, float)
    if len(c) < 4:
        return [tuple(p) for p in c]
    if not np.allclose(c[0], c[-1]):
        c = np.vstack([c, c[:1]])
    seg = np.hypot(*np.diff(c, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    perim = s[-1]
    if perim <= 0:
        return [tuple(p) for p in c]
    m = max(8, int(round(perim / step)))
    t = np.linspace(0.0, perim, m, endpoint=False)
    x = np.interp(t, s, c[:, 0]); y = np.interp(t, s, c[:, 1])
    sg = min(sigma, perim / 20.0) / (perim / m)
    if sg > 0.3:
        x = gaussian_filter1d(x, sg, mode="wrap"); y = gaussian_filter1d(y, sg, mode="wrap")
    out = list(zip(x.tolist(), y.tolist()))
    out.append(out[0])
    return out


def clean_coast(land, half, log=print):
    """The land geometry (local metres) with the harbour works taken out and every ring rounded; see above.
    Returns (geometry, counts)."""
    import shapely
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union
    land = land.intersection(box(-half - 1000, -half - 1000, half + 1000, half + 1000))
    counts = {"piers": 0, "breakwaters": 0, "slips": 0, "fillets": 0}
    corner_area = math.pi * ART_R * ART_R * 0.5
    # 1. Thin land.
    opened = land.buffer(-ART_R).buffer(ART_R)
    shapely.prepare(opened)
    islands = _parts(land)
    tree = shapely.STRtree(islands)
    drop = []
    for p in _parts(land.difference(opened)):
        if p.area < 1.0:
            drop.append(p); continue
        contacts = len(_parts(p.buffer(2.0).intersection(opened)))
        rect, r = _rectangularity(p)
        # On islets (an atoll's strips) a thin end is land, not a pier, unless it is straight-edged or a
        # jetty's width (mean width 2 area / perimeter under PIER_WIDTH; an islet's tip is wider).
        owner = tree.query(p.representative_point(), predicate="intersects")
        islet = len(owner) > 0 and islands[owner[0]].area < SMALL_LAND_KM2 * 1e6
        narrow = 2.0 * p.area / max(p.length, 1e-6) < PIER_WIDTH
        if contacts == 1 and ((p.area < SMALL_PIECE and (not islet or narrow)) or rect >= RECT_MIN):
            drop.append(p); counts["piers"] += 1
        elif contacts == 0 and rect >= RECT_MIN and _aspect(r) >= BREAKWATER_ASPECT and p.area < 0.05e6:
            drop.append(p); counts["breakwaters"] += 1
    if drop:
        land = land.difference(unary_union(drop).buffer(0.5))
    # 2. Thin water.
    closed = land.buffer(ART_R).buffer(-ART_R)
    fill = []
    for p in _parts(closed.difference(land)):
        if p.area < 1.0:
            fill.append(p); continue
        rect, _ = _rectangularity(p)
        if p.area < corner_area:
            fill.append(p); counts["fillets"] += 1
        elif rect >= RECT_MIN:
            fill.append(p); counts["slips"] += 1
    if fill:
        land = unary_union([land, unary_union(fill).buffer(0.5)])
    # 3. Round every ring.
    rounded = []
    for p in _parts(land):
        sigma = ROUND_SIGMA_ISLET if p.area < SMALL_LAND_KM2 * 1e6 else ROUND_SIGMA
        ext = _smooth_ring(list(p.exterior.coords), sigma=sigma)
        holes = [_smooth_ring(list(h.coords), sigma=sigma) for h in p.interiors if len(h.coords) >= 4]
        rounded += _parts(shapely.make_valid(Polygon(ext, [h for h in holes if len(h) >= 4])))
    out = unary_union(rounded) if rounded else land
    log(f"  coast: {counts['piers']} piers and points, {counts['breakwaters']} breakwaters, {counts['slips']} slips taken out, "
        f"{counts['fillets']} notches filled")
    return out, counts


BROADEN_RES = 15.0      # metres: the raster an atoll's land is broadened on


def broaden_land(land_polys, half, target_half_m, max_factor, log=print):
    """An atoll's land widened about its centre line (CITY-SITE-SCORE-PLAN 4a, the user 2026-10-11: build a
    centreline along the ring and expand the atoll perpendicular to it). Each piece of land's local half-width h
    is the depth of its centre line (the distance-to-coast ridge within target_half_m); the shore is pushed out
    along its normal by target_half_m - h, at most (max_factor - 1) h, so a 200 m strip becomes a
    2 x target_half_m one and land already that wide is left alone. The ring keeps its true shape and place;
    the lagoon narrows by the growth. Returns the new land as local-metre geojson polygons, rounded."""
    import shapely
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union
    from scipy.ndimage import distance_transform_edt, maximum_filter
    r = BROADEN_RES
    ext = half + 1000.0
    n = int(2 * ext / r) + 1
    tr = from_origin(-ext, ext, r, r)
    land = features.rasterize([(g, 1) for g in land_polys], out_shape=(n, n), transform=tr, fill=0, dtype="uint8",
                              all_touched=True).astype(bool)
    if not land.any():
        return land_polys
    depth = distance_transform_edt(land) * r
    h = maximum_filter(depth, size=int(2 * target_half_m / r) | 1)
    grow = np.where(land, np.clip(target_half_m - h, 0.0, (max_factor - 1.0) * h), 0.0)
    dist, (iy, ix) = distance_transform_edt(~land, return_indices=True)
    new = land | (dist * r <= grow[iy, ix])
    parts = [shape(g) for g, v in features.shapes(new.astype(np.uint8), mask=new, transform=tr)]
    merged = unary_union([shapely.make_valid(p) for p in parts]).buffer(0)
    out = []
    from shapely.geometry import Polygon
    for p in _parts(merged):
        ext_ring = _smooth_ring(list(p.exterior.coords), sigma=2 * r)
        holes = [_smooth_ring(list(q.coords), sigma=2 * r) for q in p.interiors if len(q.coords) >= 4]
        out += [mapping(q) for q in _parts(shapely.make_valid(Polygon(ext_ring, [q for q in holes if len(q) >= 4])))]
    grown = float(new.sum() - land.sum()) * r * r / 1e6
    log(f"  atoll broadened to {2 * target_half_m:.0f} m: +{grown:.2f} km2 of land (was {land.sum() * r * r / 1e6:.2f} km2)")
    return out


def fill_new_land(h, frame, before, after, floor_m=2.0):
    """Heights for land the broadening added: the nearest original land sample's, at least floor_m (Copernicus
    gives the reef and lagoon 0 m)."""
    from scipy.ndimage import distance_transform_edt
    old = burn(frame, [(g, 1) for g in before], all_touched=True) == 1
    now = burn(frame, [(g, 1) for g in after]) == 1
    add = now & ~old
    if not add.any():
        return h
    if old.any():
        _, (iy, ix) = distance_transform_edt(~old, return_indices=True)
        src = h[iy, ix]
    else:
        src = np.zeros_like(h)
    h = h.copy()
    h[add] = np.maximum(src[add], floor_m)
    return h


def clip_local(geom, half):
    """Drop a local-metre geometry that lies wholly outside the window (rasterize handles the rest)."""
    coords = geom["coordinates"]
    pts = [p for ring in coords for p in ring] if geom["type"] == "Polygon" else coords
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return not (max(xs) < -half or min(xs) > half or max(ys) < -half or min(ys) > half)


SMALL_LAND_KM2 = 4.0


def local_area_km2(geom):
    """Shoelace area of a local-metre polygon's exterior ring, km2."""
    ring = geom["coordinates"][0]
    a = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        a += x0 * y1 - x1 * y0
    return abs(a) * 0.5 / 1e6


def burn(frame, shapes, fill=0, all_touched=False):
    if not shapes:
        return np.full((frame.n, frame.n), fill, np.uint8)
    return features.rasterize(shapes, out_shape=(frame.n, frame.n), transform=frame.transform, fill=fill,
                              dtype="uint8", all_touched=all_touched)


def fill_nearest(k):
    """Zero cells take the nearest non-zero class (scipy)."""
    if not (k == 0).any() or (k != 0).sum() == 0:
        return k
    from scipy.ndimage import distance_transform_edt
    _, (iy, ix) = distance_transform_edt(k == 0, return_indices=True)
    return k[iy, ix]


# ---------------------------------------------------------------- vectors.bin

def write_vectors(path, lines):
    """lines: (kind, cls, name, level, discharge, [(x, y), ...]). Kinds: 1 coast ring (cls 0 exterior,
    1 hole), 2 lake ring (level = surface metres), 3 playa ring, 4 waterway (cls 0 river, 1 stream,
    2 canal, + 8 intermittent; discharge m3/s of the HydroRIVERS reach along it, 0 unknown), 5 HydroRIVERS reach
    (discharge m3/s, cls 1 minor / 2 medium / 3 major)."""
    with open(path, "wb") as f:
        f.write(b"CWCS"); f.write(struct.pack("<II", 1, len(lines)))
        for kind, cls, name, level, discharge, pts in lines:
            nb = name.encode("utf-8")[:255]
            f.write(struct.pack("<BBH", kind, cls, len(nb))); f.write(nb)
            f.write(struct.pack("<ffI", float("nan") if level is None else level, discharge, len(pts)))
            f.write(np.asarray(pts, np.float32).tobytes())


def ring_lines(kind, geom, level=None):
    out = []
    for i, ring in enumerate(geom["coordinates"]):
        out.append((kind, 0 if i == 0 else 1, "", level, 0.0, [(float(x), float(y)) for x, y in ring]))
    return out


# ---------------------------------------------------------------- one site

def outer_samples(outer_km):
    """Outer sample count for a span: odd, so the inner corners land on outer vertices."""
    n = int(round(outer_km * 1000.0 / OUTER_M)) + 1
    return n if n % 2 == 1 else n + 1


def m16_encode(a, step):
    """metres -> m16 RGB pixels: round((a - SEA) / step) as R high byte, G low byte, B 0."""
    g = np.clip(np.rint((a - SEA) / step), 0, 65535).astype(np.uint16)
    return np.stack([(g >> 8).astype(np.uint8), (g & 255).astype(np.uint8), np.zeros(g.shape, np.uint8)], -1)


def export_site(seat, out_dir, cache, log, outer_km=24.0, offset_km=(0.0, 0.0), height_step=HEIGHT_STEP,
                overture_cache=None, overture_release=None, frame=None):
    """`frame`, when given, is the window score_city_sites.py chose: its offsetKmEast/North and spanKm
    override offset_km and outer_km, `warp` maps map metres to true metres, and `verticalScale` multiplies
    the heights above sea level (an expanded island's)."""
    lat0, lon0 = seat["lat"], seat["lon"]
    warp, vscale, city, broaden = None, 1.0, (0.0, 0.0), None
    if frame:
        offset_km = (frame["offsetKmEast"], frame["offsetKmNorth"])
        outer_km = frame["spanKm"]
        warp = frame.get("warp")
        vscale = float(frame.get("verticalScale", 1.0))
        # The city off the window's centre, on whole outer cells so the inner ring's corners stay outer vertices.
        city = (round(frame.get("cityKmEast", 0.0) * 1000.0 / OUTER_M) * OUTER_M,
                round(frame.get("cityKmNorth", 0.0) * 1000.0 / OUTER_M) * OUTER_M)
        frame = dict(frame, cityKmEast=city[0] / 1000.0, cityKmNorth=city[1] / 1000.0)
        broaden = frame.get("broaden")
    # The window centre may be moved from the seat (east, north km) to take in more land or relief.
    lat = lat0 + offset_km[1] / 111.32
    lon = lon0 + offset_km[0] / (111.32 * math.cos(math.radians(lat0)))
    OUTER = outer_samples(outer_km)
    inner, outer = Frame(lat, lon, INNER, INNER_M, warp, city), Frame(lat, lon, OUTER, OUTER_M, warp)
    nwater = int(round((OUTER - 1) * OUTER_M / WATER_M)) + 1
    water_f = Frame(lat, lon, nwater, WATER_M, warp)
    assert abs(water_f.half - outer.half) < 1e-6 and abs(((outer.half - inner.half) / OUTER_M) % 1.0) < 1e-6
    assert max(abs(city[0]), abs(city[1])) + inner.half <= outer.half + 1e-6, "the city's inner ring must lie inside the window"
    bounds = outer.lonlat_bounds(pad_m=500)
    log(f"site {seat['id']} {seat['name']} ({lat:.4f}, {lon:.4f}) bounds {tuple(round(b, 3) for b in bounds)}")

    h_in = read_copernicus(inner, "inner", cache, log)
    h_out = read_copernicus(outer, "outer", cache, log)
    if vscale != 1.0:
        h_in = np.where(h_in > 0, h_in * vscale, h_in).astype(np.float32)
        h_out = np.where(h_out > 0, h_out * vscale, h_out).astype(np.float32)

    # Koppen on the outer lattice, nearest-filled.
    kshapes = [(outer.to_local(g), v) for g, v in koppen_polys(bounds)]
    kop = fill_nearest(burn(outer, kshapes))

    # Water at 30 m: sea everywhere, land polygons, lakes, playas back to land, rivers on land.
    land_polys = [water_f.to_local(g) for g in tileset_polys("coast_tiles", bounds)]
    land_polys = [g for g in land_polys if clip_local(g, water_f.half)]
    # The coast cleaned of harbour works and rounded (clean_coast), before anything is burned from it.
    coast_counts = {}
    if land_polys:
        import shapely
        from shapely.geometry import shape, mapping
        from shapely.ops import unary_union
        parts = []
        for g in land_polys:
            v = shapely.make_valid(shape(g))
            parts += [q for q in (v.geoms if hasattr(v, "geoms") else [v]) if q.geom_type in ("Polygon", "MultiPolygon") and not q.is_empty]
        t_coast = time.time()
        cleaned, coast_counts = clean_coast(unary_union(parts), water_f.half, log)
        land_polys = [mapping(q) for q in _parts(cleaned)]
        land_polys = [g for g in land_polys if clip_local(g, water_f.half)]
        log(f"  coast cleaned {time.time() - t_coast:.1f} s")
    land_before = land_polys
    if broaden and land_polys:
        grow, keep = land_polys, []
        if broaden.get("lowOnlyM"):
            # A lagoon's mixed islands: only the low ones (motus, reef islets) are broadened; the high ones stay.
            grow = []
            for g in land_polys:
                cells = burn(outer, [(g, 1)], all_touched=True) == 1
                top = float(h_out[cells].max()) if cells.any() else 0.0
                (grow if top < float(broaden["lowOnlyM"]) else keep).append(g)
            log(f"  {len(grow)} low island(s) to broaden, {len(keep)} high kept")
        if grow:
            grow = broaden_land(grow, water_f.half, float(broaden["targetHalfWidthM"]), float(broaden["maxFactor"]), log)
        land_polys = [g for g in grow + keep if clip_local(g, water_f.half)]
        h_in = fill_new_land(h_in, inner, land_before, land_polys)
        h_out = fill_new_land(h_out, outer, land_before, land_polys)
    playas = [water_f.to_local(g) for g in playa_polys(bounds)]
    playas = [g for g in playas if clip_local(g, water_f.half)]
    reaches = [(water_f.to_local(g), d) for g, d in hydro_reaches(bounds)]
    reaches = [(g, d) for g, d in reaches if clip_local(g, water_f.half)]
    # Rivers, canals, their banks, lakes and lagoons from Overture (OSM at full detail); HydroLAKES only where
    # Overture has nothing for the box. Each line takes the discharge of the HydroRIVERS reach along it.
    ov_lines, ov_rivers, ov_lakes, ov_release = overture_water(bounds, overture_cache, overture_release, log)
    rivers = [(water_f.to_local(g), name, cls) for g, name, cls in ov_lines]
    rivers = [(g, n, c) for g, n, c in rivers if clip_local(g, water_f.half)]
    river_polys = [water_f.to_local(g) for g in ov_rivers]
    river_polys = [g for g in river_polys if clip_local(g, water_f.half)]
    lake_polys = [water_f.to_local(g) for g in ov_lakes] if (ov_lines or ov_rivers or ov_lakes) else         [water_f.to_local(g) for g in tileset_polys("lake_tiles", bounds)]
    lake_polys = [g for g in lake_polys if clip_local(g, water_f.half)]
    # OSM's full detail is a vertex every few metres; WATERWAY_SIMPLIFY_M keeps the shapes at a fraction of the bytes.
    rivers = [(_simplified(g), n, c) for g, n, c in rivers]
    lake_polys = [_simplified(g) for g in lake_polys]
    discharge = line_discharge([g for g, _, _ in rivers], reaches)

    land = burn(water_f, [(g, 1) for g in land_polys])
    # Small land (islets, atoll rims under a lattice cell wide) is burned all-touched too, so it is not
    # lost between samples; the world exporter's island rule, at city scale.
    small = [g for g in land_polys if local_area_km2(g) < SMALL_LAND_KM2]
    if small:
        land |= burn(water_f, [(g, 1) for g in small], all_touched=True)
    water = np.where(land == 1, 0, 1).astype(np.uint8)
    if lake_polys:
        # On the land only: OSM maps harbour basins and such as water too, and the coastline already has the sea.
        lakes = burn(water_f, [(g, i + 1) for i, g in enumerate(lake_polys)]).astype(np.int32)
        water[(lakes > 0) & (water == 0)] = 2
    if playas:
        water[burn(water_f, [(g, 1) for g in playas]) == 1] = 4
    # The river channel class: the mapped banks, and the perennial lines (dry wadis are not water).
    wet_lines = [g for g, _, c in rivers if not c & LINE_INTERMITTENT]
    if wet_lines or river_polys:
        riv = burn(water_f, [(g, 1) for g in wet_lines], all_touched=True) | burn(water_f, [(g, 1) for g in river_polys])
        water[(riv == 1) & (water == 0)] = 3
    t_river = time.time()
    river_sd = polygon_signed_distance(water_f, river_polys)
    log(f"  river banks {len(river_polys)} polygons {time.time() - t_river:.1f} s")

    t_shore = time.time()
    shore = shore_signed_distance(water_f, land_polys, lake_polys, water)
    log(f"  shore distance {time.time() - t_shore:.1f} s")

    # Lake levels: the median outer DEM under each lake.
    lines = []
    for g in land_polys:
        lines += ring_lines(1, g)
    if lake_polys:
        lake_out = burn(outer, [(g, i + 1) for i, g in enumerate(lake_polys)]).astype(np.int32)
        for i, g in enumerate(lake_polys):
            cells = h_out[lake_out == i + 1]
            if cells.size:
                level = float(np.median(cells))
            else:   # under one outer cell: the nearest outer sample to its first vertex
                x, y = g["coordinates"][0][0]
                level = float(h_out[int(np.clip(round((outer.half - y) / OUTER_M), 0, OUTER - 1)),
                                    int(np.clip(round((x + outer.half) / OUTER_M), 0, OUTER - 1))])
            lines += ring_lines(2, g, level)
    for g in playas:
        lines += ring_lines(3, g)
    for (g, name, cls), q in zip(rivers, discharge):
        lines.append((4, cls, name, None, q, [(float(x), float(y)) for x, y in g["coordinates"]]))
    for g, d in reaches:
        cls = 3 if d >= 1000 else (2 if d >= 100 else 1)
        lines.append((5, cls, "", None, float(d), [(float(x), float(y)) for x, y in g["coordinates"]]))

    # Stats.
    gy, gx = np.gradient(h_in, INNER_M, INNER_M)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    kvals, kcounts = np.unique(kop, return_counts=True)
    wvals, wcounts = np.unique(water, return_counts=True)
    wshare = {int(v): float(c) / water.size for v, c in zip(wvals, wcounts)}
    stats = {
        "innerMin": float(h_in.min()), "innerMax": float(h_in.max()),
        "outerMin": float(h_out.min()), "outerMax": float(h_out.max()),
        "landShare": wshare.get(0, 0.0), "seaShare": wshare.get(1, 0.0), "lakeShare": wshare.get(2, 0.0),
        "riverShare": wshare.get(3, 0.0), "saltShare": wshare.get(4, 0.0),
        "slopeP50": float(np.percentile(slope, 50)), "slopeP90": float(np.percentile(slope, 90)), "slopeMax": float(slope.max()),
        "koppenClasses": [int(v) for v in kvals], "koppenShares": [float(c) / kop.size for c in kcounts],
        "coastCleanup": coast_counts,
        "lakes": len(lake_polys), "rivers": len(rivers), "riverAreas": len(river_polys), "reaches": len(reaches), "coastRings": sum(1 for l in lines if l[0] == 1),
    }

    # Write.
    os.makedirs(out_dir, exist_ok=True)
    Image.fromarray(m16_encode(h_in, height_step), "RGB").save(os.path.join(out_dir, "height_inner.png"), optimize=True)
    Image.fromarray(m16_encode(h_out, height_step), "RGB").save(os.path.join(out_dir, "height_outer.png"), optimize=True)
    Image.fromarray(kop, "L").save(os.path.join(out_dir, "koppen.png"), optimize=True)
    Image.fromarray(water, "L").save(os.path.join(out_dir, "water.png"), optimize=True)
    Image.fromarray(shore, "L").save(os.path.join(out_dir, "shore.png"), optimize=True)
    Image.fromarray(river_sd, "L").save(os.path.join(out_dir, "river.png"), optimize=True)
    write_vectors(os.path.join(out_dir, "vectors.bin"), lines)
    site = {
        "format": "culturewars-citysite", "version": 1, "id": int(seat["id"]), "name": seat["name"] or "",
        "lat": lat0, "lon": lon0, "centreLat": lat, "centreLon": lon, "offsetKmEast": offset_km[0], "offsetKmNorth": offset_km[1], "proj4": inner.crs.to_proj4(), "rows": "north-first",
        "inner": {"file": "height_inner.png", "encoding": "m16", "size": INNER, "metres": INNER_M, "minMeters": SEA, "maxMeters": SEA + 65535 * height_step, "stepMetres": height_step},
        "outer": {"file": "height_outer.png", "encoding": "m16", "size": OUTER, "metres": OUTER_M, "minMeters": SEA, "maxMeters": SEA + 65535 * height_step, "stepMetres": height_step},
        "koppen": {"file": "koppen.png", "encoding": "index8", "size": OUTER, "metres": OUTER_M},
        "water": {"file": "water.png", "encoding": "index8", "size": nwater, "metres": WATER_M, "classes": WATER_CLASSES},
        "shore": {"file": "shore.png", "encoding": "sdist8", "size": nwater, "metres": WATER_M, "stepMetres": 2.0, "zero": 128},
        "river": {"file": "river.png", "encoding": "sdist8", "size": nwater, "metres": WATER_M, "stepMetres": 2.0, "zero": 128},
        "vectors": "vectors.bin",
        "sources": {"height": "Copernicus GLO-30 (inner) and GLO-90 (outer) DSM, COG on AWS, bilinear",
                    "koppen": "Beck et al. 2023, 1 km, Terra_Form koppen_tiles polygons",
                    "coast": "OSM land polygons (Terra_Form coast_tiles lod f)",
                    "lakes": f"Overture base/water {ov_release} (OSM)" if ov_release else "HydroLAKES (lake_tiles lod f)",
                    "rivers": f"Overture base/water {ov_release} (OSM waterways and river areas); HydroRIVERS reaches (discharge)", "playas": "Natural Earth playas"},
        "attribution": ATTRIBUTION, "exported": time.strftime("%Y-%m-%d"), "stats": stats,
    }
    if frame:
        site["frame"] = frame
    json.dump(site, open(os.path.join(out_dir, "site.json"), "w", encoding="utf-8"), indent=1)
    log(f"  inner {stats['innerMin']:.0f}..{stats['innerMax']:.0f} m, outer {stats['outerMin']:.0f}..{stats['outerMax']:.0f} m, "
        f"land {100 * stats['landShare']:.0f}%, slope p90 {stats['slopeP90']:.1f} max {stats['slopeMax']:.1f} deg, koppen "
        + ", ".join(f"{v}:{100 * s:.0f}%" for v, s in zip(stats['koppenClasses'], stats['koppenShares']))
        + f", lakes {len(lake_polys)}, rivers {len(rivers)} ({len(river_polys)} areas), reaches {len(reaches)}")
    return site


def read_seats(pack):
    """seats.yaml (the flat subset select_city_seats.py writes) -> list of dicts."""
    seats, cur = [], None
    for line in open(os.path.join(pack, "seats.yaml"), encoding="utf-8"):
        s = line.strip()
        if s.startswith("- id:"):
            cur = {"id": int(s[5:].strip()), "name": None}; seats.append(cur)
        elif cur is not None and ":" in s and not s.startswith("#"):
            k, v = s.split(":", 1); k, v = k.strip(), v.strip()
            if k in ("lat", "lon"):
                cur[k] = float(v)
            elif k == "name":
                cur[k] = v.strip('"') if v != "null" else None
    return seats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", required=True, help="world pack folder holding seats.yaml")
    ap.add_argument("--out", required=True, help="output folder; one subfolder per seat id, plus index.json")
    ap.add_argument("--seats", required=True, help="comma-separated seat ids")
    ap.add_argument("--cache", default=os.path.normpath(os.path.join(HERE, "..", "cache", "copernicus")))
    ap.add_argument("--outer-km", type=float, default=24.0, help="outer ring span in km (24 is the plan's default)")
    ap.add_argument("--offset", default="", help="per-seat centre offsets, 'id:eastKm,northKm;id:...'")
    ap.add_argument("--overture-cache", default=os.path.normpath(os.path.join(HERE, "..", "cache", "overture")))
    ap.add_argument("--overture-release", default=None, help="Overture release for new fetches (default: latest)")
    ap.add_argument("--height-step", type=float, default=HEIGHT_STEP, help="metres a height unit in the m16 PNGs (1 = whole metres)")
    ap.add_argument("--frames", default=None, help="frames.json from score_city_sites.py: each seat's chosen window")
    ap.add_argument("--extra-seat", action="append", default=[],
                    help="'id:name:lat:lon', a site not in seats.yaml (a preview; give it an id no seat uses)")
    args = ap.parse_args()
    frames = json.load(open(args.frames, encoding="utf-8")) if args.frames else {}
    offsets = {}
    for part in filter(None, args.offset.split(";")):
        sid, xy = part.split(":"); dx, dy = xy.split(",")
        offsets[int(sid)] = (float(dx), float(dy))

    seats = {s["id"]: s for s in read_seats(args.pack)}
    for spec in args.extra_seat:
        sid, name, la, lo = spec.split(":")
        seats[int(sid)] = {"id": int(sid), "name": name, "lat": float(la), "lon": float(lo)}
    wanted = [int(x) for x in args.seats.split(",") if x.strip()]
    os.makedirs(args.out, exist_ok=True)
    ipath = os.path.join(args.out, "index.json")
    index = json.load(open(ipath, encoding="utf-8")) if os.path.exists(ipath) else \
        {"format": "culturewars-citysites", "version": 1, "pack": os.path.basename(os.path.normpath(args.pack)), "sites": []}
    byid = {s["id"]: s for s in index["sites"]}
    t0 = time.time()
    for sid in wanted:
        if sid not in seats:
            print(f"seat {sid}: not in {args.pack}", file=sys.stderr); continue
        fr = frames.get(str(sid))
        site = export_site(seats[sid], os.path.join(args.out, str(sid)), args.cache, print, args.outer_km, offsets.get(sid, (0.0, 0.0)), args.height_step,
                           args.overture_cache, args.overture_release, fr)
        byid[sid] = {"id": sid, "name": site["name"], "lat": site["lat"], "lon": site["lon"], "dir": str(sid), "version": 1,
                     "outerKm": fr["spanKm"] if fr else args.outer_km}
    index["sites"] = [byid[k] for k in sorted(byid)]
    json.dump(index, open(ipath, "w", encoding="utf-8"), indent=1)
    print(f"{len(wanted)} site(s) in {time.time() - t0:.0f} s -> {args.out}")


if __name__ == "__main__":
    main()
