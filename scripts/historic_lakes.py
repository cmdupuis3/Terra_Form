#!/usr/bin/env python3
"""
historic_lakes.py  --  the lake layers show lakes as they were before the modern era, not today's map

Two corrections, shared by every lake layer (the HydroLAKES tiles built by build_coast_tiles.py and the
Natural Earth sets data/lakes_10m.json / lakes_hires.json):

  1. Modern reservoirs are dropped. Two sources decide what is one, because each misses some:
     - HydroLAKES Lake_type 2 ("reservoir"). It comes from the GRanD dam database, and GRanD also lists
       a dam on the outlet of many natural lakes -- Flathead, Red Lake, the Finger Lakes -- so a blanket
       type-2 drop would delete real lakes. RESERVOIR_KEEP holds the type-2 lakes that existed before their
       dam (the named ones >= 20 km2 were reviewed by name, smaller/unnamed ones only where Natural Earth
       maps them as a lake); they keep the modern, sometimes raised, outline (Michikamau sits inside
       Smallwood Reservoir, the Arrow Lakes in Keenleyside's pool). RESERVOIR_DROP removes the few type-3
       ("lake control") water bodies that are really new.
     - Natural Earth ne_10m_lakes featurecla "Reservoir", less NE_NATURAL (regulated natural lakes NE files
       as reservoirs: Mjosa, Saint-Jean, Te Anau...). HydroLAKES maps some reservoirs at the low year-2000
       water level and labels part of others a natural lake (Lake Powell is split in two), so a HydroLAKES
       polygon mostly inside one of these NE outlines goes too.
  2. Lakes that have since shrunk or vanished come back at their historic extent from Natural Earth's
     ne_10m_lakes_historic (Aral Sea late 1950s, Lake Chad early 1960s, Lop Nur early 1970s, Lake Texcoco
     early 1500s). Each historic outline is unioned with the modern remnants it touches.

As a module: hydrolakes_where() (the pyogrio SQL filter), ne_reservoirs(), drop_inside() and
merge_historic() for build_coast_tiles.py. As a script it rewrites the Natural Earth JSON layers in place:

  python scripts/historic_lakes.py data/lakes_10m.json data/lakes_hires.json \\
      --hydrolakes HydroLAKES_polys_v10_shp/HydroLAKES_polys_v10.shp \\
      --ne-lakes ne_10m_lakes.shp --historic ne_10m_lakes_historic.shp

  A polygon goes when it lies mostly inside a dropped NE reservoir, or when more of the HydroLAKES water
  under it is dropped reservoir than kept lake; historic lakes the file lacks are added (Douglas-Peucker at
  --eps, rounded like the rest of the file). Idempotent.
"""
import argparse, json, unicodedata

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import Polygon, MultiPolygon

# HydroLAKES Hylak_id of type-2 lakes that are natural lakes with a dam (or weir) on the outlet, or a
# reservoir old enough to count as historic (Parakrama Samudra, 12th c.; Lake Homs, Roman or older).
RESERVOIR_KEEP = {
    49: "Michikamau (in Smallwood Reservoir)", 51: "Cedar Lake, MB", 61: "Red Lake, MN", 145: "Hongze",
    1036: "Kovdozero", 698: "Arrow Lakes", 730: "Flathead", 661: "Kempt", 738: "Leech", 766: "Sebago",
    1392: "Habbaniyah", 720: "Meelpaeg", 751: "Moosehead", 777: "Upper Klamath", 735: "Winnibigoshish",
    1102: "Kallsjon", 728: "Preissac", 706: "Red Indian", 1096: "Ondozero", 768: "Winnipesaukee",
    772: "Cayuga", 9106: "Keuka", 9094: "Skaneateles", 9096: "Owasco", 1081: "Storuman",
    717: "Victoria Lake, NL", 763: "Rossignol", 1699: "Great Lake, TAS", 1162: "Skagern", 12962: "Boren",
    727: "Chelan", 729: "Coeur d'Alene", 1137: "Pyhajarvi", 854: "Kissimmee", 767: "Lake George, NY",
    747: "Chesuncook", 1690: "Lake Victoria, NSW", 765: "Jackson", 719: "Pend Oreille", 788: "Utah Lake",
    1098: "Torrojen", 1038: "Altevatnet", 11734: "(Arjeplog lake)", 11905: "(Vilhelmina lake)", 11189: "Sundvatnet",
    1482: "Keenjhar (Kalri)", 8876: "Grand Lake, ME", 12001: "Thorisvatn", 9465: "Caddo",
    8923: "Mooselookmeguntic", 9612: "Tohopekaliga", 8349: "Kenogami", 9129: "Chautauqua",
    8718: "Chamberlain", 8662: "Eagle Lake, ME", 8822: "Chiputneticook", 8804: "Chiputneticook",
    8783: "Traverse", 11154: "Klistervatn", 10533: "Laguna del Maule", 9705: "Pueblo Viejo lagoon",
    8852: "Big Stone", 8743: "Indian Lake, MI", 12992: "Loch Shin", 13078: "Loch Lochy", 8395: "Nett Lake",
    8668: "Dead Lake, MN", 9118: "Hart Lake, OR", 8556: "Moses Lake", 15866: "Parakrama Samudra",
    916: "Junin", 14949: "Lake Homs (Qattinah)", 7874: "Duncan", 11887: "Storjuktan", 14549: "Karla (Voivis)",
    9086: "Mendota", 16671: "Lake Echo, TAS", 9478: "Bistineau", 9473: "Cross Lake, LA",
}
# Hylak_id of type-3 ("lake control") water bodies that are modern impoundments all the same.
RESERVOIR_DROP = {144: "Tharthar (filled 1956)", 1701: "Pedder (impounded 1972; the natural lake was ~9 km2)",
                  1032: "Serebryanskoye (1970)"}
# ne_10m_lakes "Reservoir" features that are natural lakes (accents stripped, see _plain).
NE_NATURAL = {
    "Akkajaure", "Cedar Lake", "Kemijarvi", "Koitere", "Lac Saint-Jean", "Lac Seul", "Lake Abitibi",
    "Lake Chelan", "Lake Coleridge", "Lake Hawea", "Lake Il'Men'", "Lake Imandra", "Lake Kovdozero",
    "Lake Manapouri", "Lake Monowai", "Lake Pukaki", "Lake Te Anau", "Lake Waikaremoana", "Lake Zaysan",
    "Lower Arrow Lake", "Upper Arrow Lake", "Mjosa", "Ondozero", "Oulujarvi", "Ozero Kubenskoye",
    "Paduskoye More", "Rikkavesi", "Sipiwesk Lac", "Southern Indian Lake", "Stora Lulevatten",
    "Umbozero Lake", "Umfreville Lake", "Lake Habbaniyah", "Reservoir Manicouagan", "Smallwood Reservoir",
}
INSIDE_FRAC = 0.5   # a polygon this much inside a dropped NE reservoir is part of it


def _plain(s):
    s = str(s).translate(str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss"}))   # no NFKD decomposition
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def hydrolakes_where():
    """pyogrio/OGR SQL WHERE keeping natural lakes and dropping HydroLAKES' modern reservoirs."""
    keep = ",".join(str(i) for i in sorted(RESERVOIR_KEEP))
    drop = ",".join(str(i) for i in sorted(RESERVOIR_DROP))
    return f"(Lake_type <> 2 OR Hylak_id IN ({keep})) AND Hylak_id NOT IN ({drop})"


def ne_reservoirs(path):
    """Outlines of the ne_10m_lakes reservoirs that go (featurecla Reservoir, not in NE_NATURAL)."""
    import pyogrio
    df = pyogrio.read_dataframe(path, columns=["name", "featurecla"])
    sel = (df["featurecla"] == "Reservoir").values & ~np.array([_plain(n) in NE_NATURAL for n in df["name"]])
    return shapely.make_valid(df.geometry.values[sel])


def inside(g, res, res_tree):
    """Per polygon of g: True when >= INSIDE_FRAC of its area lies inside the res outlines."""
    out = np.zeros(len(g), bool)
    pi, ri = res_tree.query(g, predicate="intersects")
    for k in np.unique(pi):
        a = shapely.area(g[k])
        if a > 0 and sum(g[k].intersection(res[j]).area for j in ri[pi == k]) >= INSIDE_FRAC * a:
            out[k] = True
    return out


def drop_inside(g, ne_lakes):
    """g minus the polygons lying mostly inside a dropped Natural Earth reservoir."""
    res = ne_reservoirs(ne_lakes)
    gone = inside(g, res, STRtree(res))
    print(f"NE reservoirs: {len(res)} outlines drop {int(gone.sum())} more pieces", flush=True)
    return g[~gone]


def load_historic(path):
    import pyogrio
    df = pyogrio.read_dataframe(path, columns=["name", "date"])
    return shapely.make_valid(df.geometry.values), list(df["name"]), list(df["date"])


def polygons_of(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in polygons_of(g)]
    return []


def merge_historic(g, path):
    """g = array of modern lake polygons. Each historic outline absorbs the pieces it touches (the shrunken
    remnant, its satellite ponds) so the layer stays disjoint; returns the new array."""
    hist, names, dates = load_historic(path)
    tree = STRtree(g)
    drop, add = set(), []
    for h, name, when in zip(hist, names, dates):
        idx = [i for i in tree.query(h, predicate="intersects").tolist() if i not in drop]
        merged = shapely.unary_union(np.concatenate([[h], g[idx]])) if idx else h
        drop.update(idx)
        add += polygons_of(merged)
        print(f"historic {name} ({when}): absorbed {len(idx)} modern pieces", flush=True)
    keep = np.ones(len(g), bool)
    keep[list(drop)] = False
    return np.concatenate([g[keep], np.array(add, dtype=object)])


# ---------- Natural Earth JSON layers ----------
def json_poly(p):
    rings = [r for r in p["r"] if len(r) >= 4]
    return shapely.make_valid(Polygon(rings[0], rings[1:])) if rings else Polygon()


def dp_ring(ring, eps, nd):
    s = shapely.simplify(shapely.LineString(ring), eps)
    return [[round(x, nd), round(y, nd)] for x, y in s.coords]


def covered(geom, tree, gs):
    i = tree.query(geom, predicate="intersects")
    return sum(geom.intersection(gs[k]).area for k in i) if len(i) else 0.0


def filter_json(path, hl, ne_res, hist, names, eps, nd):
    (res_tree, res_g), (nat_tree, nat_g) = hl
    j = json.load(open(path, encoding="utf-8"))
    geoms = np.array([json_poly(p) for p in j["polys"]], dtype=object)
    in_ne = inside(geoms, ne_res, STRtree(ne_res))
    out, dropped = [], []
    for p, g, ne_hit in zip(j["polys"], geoms, in_ne):
        if not g.is_empty:
            r = covered(g, res_tree, res_g)
            if ne_hit or (r > 0.1 * g.area and r > covered(g, nat_tree, nat_g)):
                dropped.append((round(g.area, 3), p["b"]))
                continue
        out.append(p)
    have = [json_poly(p) for p in out]
    have_tree = STRtree(np.array(have, dtype=object))
    added = []
    for h, name in zip(hist, names):
        i = have_tree.query(h, predicate="intersects")
        if any(have[k].intersection(h).area > 0.8 * h.area and have[k].area < 1.25 * h.area for k in i):
            continue   # already carries this historic outline
        for poly in polygons_of(h):
            rings = [dp_ring(poly.exterior.coords, eps, nd)] + [dp_ring(r.coords, eps, nd) for r in poly.interiors]
            rings = [r for r in rings if len(r) >= 4]
            if rings:
                xs = [x for x, _ in rings[0]]; ys = [y for _, y in rings[0]]
                out.append({"b": [round(min(xs), nd), round(min(ys), nd), round(max(xs), nd), round(max(ys), nd)], "r": rings})
        added.append(name)
    j["polys"] = out
    with open(path, "w", encoding="utf-8") as f:
        json.dump(j, f, separators=(",", ":"))
    print(f"{path}: dropped {len(dropped)} reservoir polygons, added historic {added or 'none'} -> {len(out)} polygons")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json", nargs="+", help="Natural Earth lake layers to rewrite in place (data/lakes_10m.json ...)")
    ap.add_argument("--hydrolakes", required=True, help="HydroLAKES_polys_v10.shp (for Lake_type)")
    ap.add_argument("--ne-lakes", required=True, help="ne_10m_lakes.shp (for featurecla Reservoir)")
    ap.add_argument("--historic", required=True, help="ne_10m_lakes_historic.shp")
    ap.add_argument("--min-km2", type=float, default=1.0, help="ignore HydroLAKES polygons below this (NE doesn't map them)")
    ap.add_argument("--eps", type=float, default=0.01, help="DP tolerance (deg) for added historic outlines")
    ap.add_argument("--round", type=int, default=3)
    args = ap.parse_args()
    import pyogrio
    df = pyogrio.read_dataframe(args.hydrolakes, columns=["Hylak_id", "Lake_type", "Lake_area"],
                                where=f"Lake_area >= {args.min_km2}")   # OGR matches nothing if the WHERE column isn't read
    ids = df["Hylak_id"].values
    sel = ((df["Lake_type"].values == 2) & ~np.isin(ids, list(RESERVOIR_KEEP))) | np.isin(ids, list(RESERVOIR_DROP))
    g = shapely.make_valid(df.geometry.values)
    res_g, nat_g = g[sel], g[~sel]
    print(f"HydroLAKES >= {args.min_km2} km2: {len(res_g)} dropped reservoirs, {len(nat_g)} kept lakes", flush=True)
    ne_res = ne_reservoirs(args.ne_lakes)
    hist, names, _ = load_historic(args.historic)
    for path in args.json:
        filter_json(path, ((STRtree(res_g), res_g), (STRtree(nat_g), nat_g)), ne_res, hist, names, args.eps, args.round)


if __name__ == "__main__":
    main()
