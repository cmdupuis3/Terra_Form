#!/usr/bin/env python3
"""
reduce_coastline.py  —  simplify a land-polygon GeoJSON into the compact form
embedded in the app (index.html).

Input : a land-polygon GeoJSON in WGS84 lon/lat (Natural Earth / GSHHG / OSM).
Output: coast_reduced.json  ->  {"polys":[{"b":[minLon,minLat,maxLon,maxLat],
                                           "r":[[[lon,lat],...], ...]}, ...]}
        "r" is a polygon's rings (ring 0 = outer, rest = holes); the app fills
        them with the even-odd rule so lakes stay water.

Douglas-Peucker simplification is what actually shrinks the file (vertex count
dominates size); coordinate rounding alone barely helps. The default ~4 km
tolerance keeps continental shape while fitting comfortably inline in the app.
For a higher-fidelity build (e.g. GSHHG full resolution), lower --eps.
"""
import argparse, json, math


def rings_of(geom):
    t = geom["type"]
    if t == "Polygon":
        return [geom["coordinates"]]
    if t == "MultiPolygon":
        return geom["coordinates"]
    return []


def bbox(ring):
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    return [min(xs), min(ys), max(xs), max(ys)]


def douglas_peucker(pts, eps):
    if len(pts) < 3:
        return pts

    def perp(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return math.hypot(x - x1, y - y1)
        t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
        t = max(0, min(1, t))
        return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, idx = 0.0, -1
        for k in range(i + 1, j):
            d = perp(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > eps:
            keep[idx] = True
            stack.append((i, idx)); stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("geojson", help="land-polygon GeoJSON (WGS84 lon/lat)")
    ap.add_argument("--eps", type=float, default=0.04, help="DP tolerance in degrees (~0.04 deg = ~4 km)")
    ap.add_argument("--min-area", type=float, default=0.02, help="drop polygons whose bbox area (deg^2) is below this")
    ap.add_argument("--round", type=int, default=3, help="coordinate decimal places")
    ap.add_argument("--out", default="coast_reduced.json")
    args = ap.parse_args()

    gj = json.load(open(args.geojson))
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]

    polys = []
    for feat in feats:
        geom = feat.get("geometry", feat)
        for poly in rings_of(geom):
            outer = poly[0]
            bx = bbox(outer)
            if (bx[2] - bx[0]) * (bx[3] - bx[1]) < args.min_area:
                continue
            rings = []
            for ring in poly:
                simplified = douglas_peucker([[round(x, args.round), round(y, args.round)] for x, y in ring], args.eps)
                if len(simplified) >= 4:
                    rings.append(simplified)
            if rings:
                polys.append({"b": [round(v, 2) for v in bbox(outer)], "r": rings})

    blob = json.dumps({"polys": polys}, separators=(",", ":"))
    open(args.out, "w").write(blob)
    nv = sum(len(r) for p in polys for r in p["r"])
    print(f"polygons: {len(polys)}   vertices: {nv}   size: {len(blob) / 1024:.0f} KB   -> {args.out}")


if __name__ == "__main__":
    main()
