#!/usr/bin/env python3
"""Scatter potential province seats over the land of a Culture Wars world pack.

Reads the pack's rasters (elevation, landmask, koppen, rivers), scores every land cell on the
game's simulation grid (pack grid / --factor) by habitability -- the same Köppen / elevation /
river capacity rule the game uses -- plus a coast bonus, then places seats greedily from the best
cells outward with a spacing that widens as habitability drops (dense along rivers and coasts,
sparse in deserts and tundra, none on ice). Output is a small YAML file:

    schema: culturewars-seats/1
    pack: earth
    seats:
      - id: 1
        lat: 30.05
        lon: 31.23
        city_map: null      # reserved: id of the pass-2 city map for this seat

    python games/culture_wars/generate_seats.py --pack "<Unity>/Assets/StreamingAssets/WorldPacks/earth"
"""
import argparse, json, math, os, time
import numpy as np
from PIL import Image

SEA, PEAK = -500.0, 6000.0

# Beck 2023 class index -> base capacity (mirrors ConductivityBuilder.BaseCapacity in Unity).
CAP = {1: 0.85, 2: 0.85, 3: 0.9, 4: 0.05, 5: 0.05, 6: 0.35, 7: 0.35, 8: 0.8, 9: 0.8, 10: 0.8,
       11: 0.9, 12: 0.9, 13: 0.9, 14: 1.0, 15: 1.0, 16: 1.0,
       17: 0.7, 18: 0.7, 21: 0.7, 22: 0.7, 25: 0.7, 26: 0.7,
       19: 0.3, 20: 0.3, 23: 0.3, 24: 0.3, 27: 0.3, 28: 0.3, 29: 0.1, 30: 0.0}


def block_reduce(a, f, how):
    h, w = a.shape[0] // f, a.shape[1] // f
    b = a[:h * f, :w * f].reshape(h, f, w, f)
    if how == "mean":
        return b.mean(axis=(1, 3))
    if how == "max":
        return b.max(axis=(1, 3))
    if how == "majority":   # for 0/1 masks
        return (b.mean(axis=(1, 3)) >= 0.5).astype(np.uint8)
    if how == "center":
        return a[f // 2::f, f // 2::f][:h, :w]
    raise ValueError(how)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", required=True, help="world pack folder (with manifest.json)")
    ap.add_argument("--factor", type=int, default=2, help="pack grid / sim grid (Unity uses 2)")
    ap.add_argument("--min-spacing", type=float, default=11.0, help="spacing in sim cells at capacity 1")
    ap.add_argument("--max-spacing", type=float, default=34.0, help="spacing in sim cells at capacity 0")
    ap.add_argument("--min-capacity", type=float, default=0.04, help="cells below this never get a seat")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=None, help="output yaml (default <pack>/seats.yaml)")
    args = ap.parse_args()

    t0 = time.time()
    man = json.load(open(os.path.join(args.pack, "manifest.json"), encoding="utf-8"))
    W, H, f = man["width"], man["height"], args.factor
    lonMin, lonMax = man["bounds"]["lonMin"], man["bounds"]["lonMax"]
    latMin, latMax = man["bounds"]["latMin"], man["bounds"]["latMax"]

    elev_rgb = np.array(Image.open(os.path.join(args.pack, man["layers"]["elevation"]["file"])).convert("RGB"))
    e16 = elev_rgb[:, :, 0].astype(np.float32) * 256 + elev_rgb[:, :, 1].astype(np.float32)
    meters_full = SEA + e16 / 65535.0 * (PEAK - SEA)
    land_full = (np.array(Image.open(os.path.join(args.pack, man["layers"]["landMask"]["file"])).convert("L")) > 127).astype(np.uint8)
    kop_small = np.array(Image.open(os.path.join(args.pack, man["layers"]["koppen"]["file"])).convert("L"))
    riv_file = man["layers"].get("rivers", {}).get("file")
    riv_full = np.array(Image.open(os.path.join(args.pack, riv_file)).convert("L")) if riv_file else np.zeros_like(land_full)

    # Sim grid (row 0 = north in image space).
    meters = block_reduce(meters_full, f, "mean")
    land = block_reduce(land_full, f, "majority")
    river = block_reduce(riv_full, f, "max")
    sh, sw = land.shape
    # Köppen is stored at 2048x1024; resample to the sim grid by nearest.
    ky = (np.arange(sh) * kop_small.shape[0] / sh).astype(int)
    kx = (np.arange(sw) * kop_small.shape[1] / sw).astype(int)
    kop = kop_small[ky][:, kx]

    cap = np.vectorize(lambda k: CAP.get(int(k), 0.5))(kop).astype(np.float32)
    cap = np.where(meters > 4000, cap * 0.1, np.where(meters > 2500, cap * 0.3, np.where(meters > 1500, cap * 0.7, cap)))
    cap = np.where(river == 3, np.maximum(cap, 1.0), np.where(river == 2, np.maximum(cap, 0.8), np.where(river == 1, np.minimum(1.0, cap + 0.25), cap)))
    cap = np.where(land == 1, cap, 0.0)

    # Coast bonus: land cell with a water 4-neighbour (wrap in x).
    water = land == 0
    coast = land.astype(bool) & (np.roll(water, 1, 1) | np.roll(water, -1, 1) | np.roll(water, 1, 0) | np.roll(water, -1, 0))
    score = cap + 0.2 * coast + 0.15 * (river > 0)

    rng = np.random.default_rng(args.seed)
    score = score + rng.uniform(0, 0.08, score.shape)   # jitter breaks ties in uniform regions
    cand = np.argwhere((land == 1) & (cap >= args.min_capacity))
    order = np.argsort(-score[cand[:, 0], cand[:, 1]], kind="stable")
    cand = cand[order]

    # Greedy placement with a spatial hash; spacing shrinks with capacity, x is scaled by cos(lat).
    cell = args.min_spacing
    grid = {}
    seats = []
    def lat_of(y): return latMax - (y + 0.5) * (latMax - latMin) / sh
    for y, x in cand:
        c = float(cap[y, x])
        spacing = args.min_spacing + (args.max_spacing - args.min_spacing) * (1.0 - min(1.0, c))
        cosl = max(0.15, math.cos(math.radians(lat_of(y))))
        gx, gy = int(x * cosl // cell), int(y // cell)
        ok = True
        reach = int(math.ceil(args.max_spacing / cell)) + 1
        for dy in range(-reach, reach + 1):
            for dx in range(-reach, reach + 1):
                for (sx, sy, ss) in grid.get((gx + dx, gy + dy), ()):
                    ddx = abs(sx - x)
                    ddx = min(ddx, sw - ddx) * cosl
                    d = math.hypot(ddx, sy - y)
                    if d < max(spacing, ss):
                        ok = False; break
                if not ok: break
            if not ok: break
        if not ok:
            continue
        grid.setdefault((gx, gy), []).append((int(x), int(y), spacing))
        seats.append((int(x), int(y), c))

    out = args.out or os.path.join(args.pack, "seats.yaml")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(f"# Province seats for world pack \"{man['name']}\". Generated by Terra_Form games/culture_wars/generate_seats.py\n")
        fh.write(f"# ({len(seats)} seats, sim grid {sw}x{sh}, spacing {args.min_spacing}-{args.max_spacing} cells, seed {args.seed}).\n")
        fh.write("schema: culturewars-seats/1\n")
        fh.write(f"pack: {man['name']}\n")
        fh.write("seats:\n")
        for i, (x, y, c) in enumerate(seats, start=1):
            lon = lonMin + (x + 0.5) * (lonMax - lonMin) / sw
            lat = lat_of(y)
            fh.write(f"  - id: {i}\n    lat: {lat:.3f}\n    lon: {lon:.3f}\n    city_map: null\n")
    by_cap = np.histogram([s[2] for s in seats], bins=[0, 0.1, 0.35, 0.6, 0.85, 1.01])[0]
    print(f"{len(seats)} seats -> {out}  (by capacity <0.1/<0.35/<0.6/<0.85/<=1: {by_cap.tolist()}) in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
