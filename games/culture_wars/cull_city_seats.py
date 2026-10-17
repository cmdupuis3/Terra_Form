#!/usr/bin/env python3
"""Thin a seats.yaml (select_city_seats.py's output) to fewer seats, keeping its regional balance.

The selector writes seats in descending cultural score, so the file order is the priority. Thinning is
greedy in that order: a seat stays unless a kept seat lies within ALPHA x its local spacing, the local
spacing being the great-circle distance to its K-th nearest neighbour in the input. Because the floor is
relative to the local spacing, dense and sparse country lose about the same share and the density map
keeps its shape; ALPHA is found by bisection so the output holds --target seats. Ids are renumbered
1..N in the kept order, as the selector numbers them.

  python games/culture_wars/cull_city_seats.py --seats <pack>/seats.yaml --target 5000 --out <pack>/seats.yaml
"""
import argparse, math, re, sys
import numpy as np
from scipy.spatial import cKDTree

ap = argparse.ArgumentParser()
ap.add_argument("--seats", required=True)
ap.add_argument("--target", type=int, required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--k", type=int, default=3, help="neighbour whose distance is the local spacing")
ap.add_argument("--curated", default=None, help="folder with historic_*.csv: their significance >= --keep-sig sites go first")
ap.add_argument("--keep-sig", type=int, default=4)
args = ap.parse_args()

text = open(args.seats, encoding="utf-8").read()
header, _, body = text.partition("seats:\n")
blocks = re.split(r"(?m)^  - ", body)[1:]
seats = []
for b in blocks:
    lat = float(re.search(r"lat: (-?[\d.]+)", b).group(1))
    lon = float(re.search(r"lon: (-?[\d.]+)", b).group(1))
    seats.append((lat, lon, b))
n = len(seats)
# Priority: the curated gazetteer's great sites first (Babylon, Ur, Teotihuacan: a modern town with a
# higher score must not cull them), then the selector's order. A seat matches a curated row by name.
first = set()
if args.curated:
    import csv, glob, os
    import unicodedata
    def plain(t): return unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().lower()
    great = set()
    for f in glob.glob(os.path.join(args.curated, "historic_*.csv")):
        for r in csv.DictReader(open(f, encoding="utf-8")):
            if int(r["significance"] or 0) >= args.keep_sig: great.add(plain(r["name"]))
    for i, s in enumerate(seats):
        m = re.search(r'name: "(.*)"', s[2])
        if m and plain(m.group(1)) in great: first.add(i)
    print(f"{len(first)} seats of {len(great)} curated sites at significance >= {args.keep_sig} go first")
order = sorted(range(n), key=lambda i: (i not in first, i))
seats = [seats[i] for i in order]
if args.target >= n: sys.exit(f"{n} seats already, target {args.target}")

lat = np.radians([s[0] for s in seats]); lon = np.radians([s[1] for s in seats])
xyz = np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=1)
tree = cKDTree(xyz)
d, _ = tree.query(xyz, k=args.k + 1)
spacing = d[:, args.k]                       # chord on the unit sphere, close to the angle at these scales

def thin(alpha):
    kept = np.zeros(n, bool)
    near = tree.query_ball_point(xyz, alpha * spacing)
    for i in range(n):
        kept[i] = not any(kept[j] for j in near[i] if j < i)
    return kept

lo, hi = 0.0, 4.0
best = None
for _ in range(30):
    mid = (lo + hi) / 2
    kept = thin(mid)
    c = int(kept.sum())
    if best is None or abs(c - args.target) < abs(int(best.sum()) - args.target): best = kept
    if c == args.target: break
    if c > args.target: lo = mid
    else: hi = mid
kept = best
# Land exactly on the target: drop the lowest-priority extras, or add back the highest-priority culled.
idx = np.flatnonzero(kept)
if len(idx) > args.target: kept[idx[args.target:]] = False
elif len(idx) < args.target:
    for i in np.flatnonzero(~kept)[: args.target - len(idx)]: kept[i] = True
print(f"alpha {mid:.3f}: kept {int(kept.sum())} of {n}")

out_header = re.sub(r"\(\d+ seats,", f"({int(kept.sum())} seats, culled from {n} by cull_city_seats.py,", header)
with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(out_header + "seats:\n")
    for new_id, i in enumerate(np.flatnonzero(kept), start=1):
        fh.write("  - " + re.sub(r"^id: \d+", f"id: {new_id}", seats[i][2]))
named = sum(1 for i in np.flatnonzero(kept) if "name:" in seats[i][2])
print(f"named {named}, unnamed {int(kept.sum()) - named}")
