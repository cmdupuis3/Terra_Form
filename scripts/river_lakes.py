#!/usr/bin/env python3
"""
river_lakes.py  --  HydroLAKES polygons that are really river, dropped from the lake layer

HydroLAKES is a lake database, but it carries water that is river: widenings of a big river's channel,
side channels and floodplain arms threaded on the main stem, whole braided reaches digitised as
polygons. Punched out of the land mask they sit on the river as blobs of lake that are not there.

The rule, per polygon (only polygons with Dis_avg >= MIN_Q and Lake_area >= 1 km2 are looked at):
  1. a HydroRIVERS channel of MIN_Q m3/s or more runs THROUGH it, end to end: the reaches' length
     inside the polygon is at least THROUGH x the polygon's long axis (its minimum rotated rectangle);
  2. it is THIN for that river: mean width = area / channel length inside is under a ceiling that
     grows with the discharge, ceiling(Q) = max(WIDTH_FLOOR_KM, WIDTH_K x sqrt(Q)): 1.5 km for a
     100 m3/s river, 2.5 at 1,000, 8 at 10,000 -- so the Yangtze's channel polygons go and
     Lac Saint-Pierre (11 km across on a 10,000 m3/s river) stays a lake;
  3. the water does not stay: HydroLAKES' residence time (Res_time, volume over discharge) is under
     RES_MAX_DAYS. A channel polygon holds its water a few hours to a couple of days; a lake the
     river happens to run through holds it for a month or more, however narrow it is -- the Arrow
     Lakes (116 days), Kamloops Lake (53), Winokapau (45), Lillooet (256) all pass the first two
     tests and fail this one, which is what it is for. The bar is set high on purpose (the user,
     2026-10-07: a river rendered as water is wrong everywhere but the St Lawrence), so a widening
     the model gives two or three weeks goes with the channel bits;
  4. it is not in RIVER_LAKE_KEEP, the list reviewed by name.
A fjord lake with a river through it (Kootenay, Maggiore) is long and narrow too, but it is wide for
its river: a 3 km lake on an 800 m3/s river is over its 2.3 km ceiling. The shoreline development
(Shore_dev) is printed beside every candidate as a check, not a criterion.

As a module: load_reaches() and river_reaches() for build_coast_tiles.py (--rivers). As a script it
prints the candidates and the near misses for review and writes the dropped rows as CSV:

  python scripts/river_lakes.py HydroLAKES_polys_v10_shp/HydroLAKES_polys_v10.shp --rivers data/river_tiles \\
      --report data/lake_tiles/river_reaches.csv
"""
import argparse, glob, json, math, os, sys

import numpy as np
import shapely
from shapely import STRtree

MIN_Q = 100.0           # m3/s: a medium river by the world pack's classes (rivers.png 2 and 3)
THROUGH = 0.7           # the channel inside is at least this much of the polygon's long axis
WIDTH_FLOOR_KM = 1.5    # the ceiling a 100 m3/s river gets
WIDTH_K = 0.08          # km per sqrt(m3/s): 2.5 km at 1,000, 8 km at 10,000
RES_MAX_DAYS = 30.0     # a river bit turns its water over in hours or days; a lake on a river keeps it for a month or more
KM_PER_DEG = 111.32

# HydroLAKES Hylak_id of polygons the rule would drop that are lakes all the same, reviewed by name.
# The St Lawrence's three lakes are shallow widenings the river runs through in a day, which is what
# a channel polygon is by the numbers; but they are named lakes on every map, and the river between
# Cornwall and Trois-Rivieres is known by them.
RIVER_LAKE_KEEP = {
    744: "Lac Saint-Pierre", 754: "Lac Saint-Francois", 752: "Lac Saint-Louis",
}


def load_reaches(river_dir, min_q=MIN_Q):
    """Every reach of min_q m3/s or more in the river tiles, as LineStrings with their discharge."""
    lines, q = [], []
    for path in sorted(glob.glob(os.path.join(river_dir, "*.json"))):
        if os.path.basename(path) == "manifest.json":
            continue
        for f in json.load(open(path, encoding="utf-8"))["features"]:
            d = float(f.get("d", 0))
            if d < min_q:
                continue
            for part in f["l"]:
                if len(part) >= 2:
                    lines.append(shapely.linestrings(part))
                    q.append(d)
    g = np.array(lines, dtype=object)
    return g, np.array(q), STRtree(g)


def _km(geom, coslat):
    """The geometry with degrees turned into kilometres about its own latitude."""
    return shapely.transform(geom, lambda c: c * np.array([KM_PER_DEG * coslat, KM_PER_DEG]))


def long_axis_km(poly, coslat):
    rect = _km(poly, coslat).minimum_rotated_rectangle
    c = np.asarray(rect.exterior.coords)
    if len(c) < 3:
        return 0.0
    return max(float(np.hypot(*(c[1] - c[0]))), float(np.hypot(*(c[2] - c[1]))))


def ceiling_km(q):
    return max(WIDTH_FLOOR_KM, WIDTH_K * math.sqrt(max(q, 0.0)))


def river_reaches(geoms, attrs, reaches, keep=RIVER_LAKE_KEEP):
    """
    geoms: HydroLAKES polygons; attrs: dict of equal-length arrays Hylak_id, Lake_name, Lake_area,
    Dis_avg, Res_time, Shore_dev; reaches: load_reaches() result.
    Returns (drop mask, rows) where rows describe every polygon the channel runs through (dropped or
    not), for the report.
    """
    lines, q, tree = reaches
    n = len(geoms)
    drop = np.zeros(n, bool)
    rows = []
    looked = np.where((attrs["Dis_avg"] >= MIN_Q) & (attrs["Lake_area"] >= 1.0))[0]
    for i in looked:
        poly = geoms[i]
        if poly is None or poly.is_empty:
            continue
        idx = tree.query(poly, predicate="intersects")
        if len(idx) == 0:
            continue
        cy = poly.centroid.y
        coslat = max(math.cos(math.radians(cy)), 0.05)
        inside = shapely.intersection(lines[idx], poly)
        length_km = float(sum(_km(s, coslat).length for s in inside if s is not None and not s.is_empty))
        if length_km <= 0:
            continue
        axis_km = long_axis_km(poly, coslat)
        area = float(attrs["Lake_area"][i])
        width_km = area / length_km
        qq = float(attrs["Dis_avg"][i])
        ceil = ceiling_km(qq)
        through = length_km >= THROUGH * axis_km
        thin = width_km < ceil
        res = float(attrs["Res_time"][i])
        fast = res < RES_MAX_DAYS
        hid = int(attrs["Hylak_id"][i])
        kept = hid in keep
        is_river = through and thin and fast and not kept
        drop[i] = is_river
        rows.append(dict(Hylak_id=hid, Lake_name=attrs["Lake_name"][i] if attrs["Lake_name"][i] is not None else "",
                         Lake_type=int(attrs["Lake_type"][i]) if "Lake_type" in attrs else 0,
                         Lake_area=area, Dis_avg=qq, Q_reach=float(q[idx].max()), length_km=length_km, axis_km=axis_km,
                         width_km=width_km, ceiling_km=ceil, Res_time=res,
                         Shore_dev=float(attrs["Shore_dev"][i]), lon=float(poly.centroid.x), lat=float(cy),
                         through=through, thin=thin, fast=fast, kept=kept, dropped=is_river))
    return drop, rows


ATTR_COLS = ["Hylak_id", "Lake_name", "Lake_type", "Lake_area", "Dis_avg", "Res_time", "Shore_dev"]


def attrs_of(df):
    """The attribute arrays river_reaches() reads, from a HydroLAKES dataframe with ATTR_COLS."""
    attrs = {c: df[c].values for c in ATTR_COLS}
    attrs["Lake_name"] = np.array([None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v)
                                   for v in attrs["Lake_name"]], dtype=object)
    return attrs


REPORT_COLS = ["Hylak_id", "Lake_name", "Lake_type", "Lake_area", "Dis_avg", "Q_reach", "length_km", "axis_km", "width_km",
               "ceiling_km", "Res_time", "Shore_dev", "lon", "lat"]


def write_report(rows, path):
    import csv
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(REPORT_COLS)
        for r in sorted(rows, key=lambda r: -r["Lake_area"]):
            if r["dropped"]:
                w.writerow([r[c] if not isinstance(r[c], float) else round(r[c], 3) for c in REPORT_COLS])


def _fmt(r):
    name = (r["Lake_name"] or "-")[:28]
    return (f"{r['Hylak_id']:8d} {name:28s} t{r['Lake_type']} area {r['Lake_area']:8.1f} Q {r['Dis_avg']:8.0f} "
            f"len {r['length_km']:6.1f} axis {r['axis_km']:6.1f} width {r['width_km']:5.2f} < {r['ceiling_km']:5.2f} "
            f"res {r['Res_time']:7.1f}d dev {r['Shore_dev']:5.1f}  at {r['lon']:8.3f} {r['lat']:7.3f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("shp", help="HydroLAKES_polys_v10.shp")
    ap.add_argument("--rivers", default=os.path.join(os.path.dirname(__file__), "..", "data", "river_tiles"))
    ap.add_argument("--report", default="", help="CSV of the dropped polygons")
    ap.add_argument("--near", type=float, default=2.0, help="also print lakes the channel runs through whose width is under this many ceilings")
    ap.add_argument("--keep-reservoirs", action="store_true", help="look at HydroLAKES' modern reservoirs too (the tile build drops them first)")
    args = ap.parse_args()
    import pyogrio
    sys.path.insert(0, os.path.dirname(__file__))
    import historic_lakes
    where = f"Dis_avg >= {MIN_Q} AND Lake_area >= 1"
    if not args.keep_reservoirs:
        where += " AND " + historic_lakes.hydrolakes_where()
    df = pyogrio.read_dataframe(args.shp, columns=ATTR_COLS, where=where, use_arrow=True)
    attrs = attrs_of(df)
    reaches = load_reaches(args.rivers)
    print(f"{len(df)} lake polygons with Dis_avg >= {MIN_Q:g}; {len(reaches[0])} reaches of {MIN_Q:g} m3/s or more", flush=True)
    drop, rows = river_reaches(df.geometry.values, attrs, reaches)
    dropped = [r for r in rows if r["dropped"]]
    kept = [r for r in rows if r["kept"]]
    slow = [r for r in rows if r["through"] and r["thin"] and not r["fast"] and not r["kept"]]
    near = [r for r in rows if r["through"] and not r["thin"] and r["width_km"] < args.near * r["ceiling_km"]]
    print(f"\n== dropped as river reaches: {len(dropped)} polygons, {sum(r['Lake_area'] for r in dropped):.0f} km2")
    for r in sorted(dropped, key=lambda r: -r["Lake_area"]):
        print("  " + _fmt(r))
    print(f"\n== kept by RIVER_LAKE_KEEP: {len(kept)}")
    for r in kept:
        print("  " + _fmt(r))
    print(f"\n== thin and run through, but the water stays {RES_MAX_DAYS:g} days or more (kept as lakes): {len(slow)}")
    for r in sorted(slow, key=lambda r: -r["Lake_area"]):
        print("  " + _fmt(r))
    print(f"\n== near misses (the channel runs through, width under {args.near:g} ceilings): {len(near)}")
    for r in sorted(near, key=lambda r: r["width_km"] / r["ceiling_km"]):
        print("  " + _fmt(r))
    if args.report:
        write_report(rows, args.report)
        print(f"\nreport -> {args.report}")


if __name__ == "__main__":
    main()
