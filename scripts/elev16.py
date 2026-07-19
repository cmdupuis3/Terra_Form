# N-bit two-channel greyscale elevation from a real DEM.
#   * base <bw>x<bh> (decimated average) -> data/elev_4096.png   (skip with --no-base)
#   * fine hgt tiles: <px> px per <deg>-deg cell, RG16 container (R=high byte, G=low byte),
#     low bits masked to --bits. Pure-ocean cells (max elev < sea level) are dropped and
#     a `tiles` manifest of the ones written is put in index.json (the app skips the rest).
#
# The bundled data is ETOPO 2022 30 arc-sec (43200x21600 = 120 px/deg native, full-globe
# plate carree). At --deg 2.5 / --px 300 the fine tiles are a 1:1 crop of the native grid
# (120 px/deg) -- 2x finer than the 60 px/deg satellite tiles. The old 60s build used
# --deg 10 --px 600. 12-bit keeps 1.6 m precision at ~30% smaller PNGs than full 16-bit.
#
#   pip install rasterio numpy pillow
#   python scripts/elev16.py ETOPO_2022_v1_30s_N90W180_surface.tif \
#       --out-dir data/hgt_tiles --deg 2.5 --px 300 --bits 12 --no-base
import argparse, os, json, shutil
import numpy as np, rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from PIL import Image

SEA, PEAK = -500.0, 6000.0

def enc(a, bits=16):
    """metres -> RG16 PNG bytes, low bits masked to `bits` (R=hi byte, G=lo byte)."""
    g = np.rint(np.clip((a - SEA) / (PEAK - SEA), 0, 1) * 65535.0).astype(np.uint16)
    if bits < 16:
        g = (g & ((0xFFFF << (16 - bits)) & 0xFFFF)).astype(np.uint16)
    return np.stack([(g >> 8).astype(np.uint8), (g & 255).astype(np.uint8),
                     np.zeros(g.shape, np.uint8)], -1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dem")
    ap.add_argument("--out-dir", default="../data/hgt_tiles")
    ap.add_argument("--base", default="../data/elev_4096.png")
    ap.add_argument("--base-width", type=int, default=4096)
    ap.add_argument("--deg", type=float, default=2.5, help="cell size in degrees")
    ap.add_argument("--px", type=int, default=300, help="output px per cell (<= deg*src_res)")
    ap.add_argument("--bits", type=int, default=12, help="precision bits kept (<=16)")
    ap.add_argument("--sea-keep", type=float, default=0.0,
                    help="keep a tile only if its max elevation (m) >= this")
    ap.add_argument("--no-base", action="store_true", help="skip regenerating the base raster")
    args = ap.parse_args()

    src = rasterio.open(args.dem)
    print(f"DEM {src.width}x{src.height}  {360/src.width:.5f} deg/px = {src.width/360:.0f} px/deg")

    # --- base decimated raster (16-bit, average) ---
    if not args.no_base:
        bw = args.base_width; bh = bw // 2
        base = src.read(1, out_shape=(bh, bw), resampling=Resampling.average).astype("float32")
        Image.fromarray(enc(base, args.bits), "RGB").save(args.base, optimize=True)
        print(f"base {bw}x{bh} -> {args.base}  ({os.path.getsize(args.base)//1024} KB)")

    # --- fine sparse tiles: <px> px per <deg> cell, ocean dropped, staged then swapped ---
    DEG, TILE = args.deg, args.px
    cols = int(round(360 / DEG)); rows = int(round(180 / DEG))
    nbw = int(round(DEG * src.width / 360.0))    # native px per cell (x)
    nbh = int(round(DEG * src.height / 180.0))   # native px per cell (y)
    assert nbw % TILE == 0 and nbh % TILE == 0, \
        f"--px {TILE} must divide native cell {nbw}x{nbh}"
    fx, fy = nbw // TILE, nbh // TILE             # decimation factor (1 = 1:1 crop)

    stage = args.out_dir + "_new"
    if os.path.isdir(stage): shutil.rmtree(stage)
    os.makedirs(stage)
    manifest = []; land_px = 0
    for r in range(rows):
        band = src.read(1, window=Window(0, r * nbh, src.width, nbh)).astype("float32")
        for c in range(cols):
            cell = band[:, c * nbw:(c + 1) * nbw][:fy * TILE, :fx * TILE]
            if cell.max() < args.sea_keep:       # pure ocean -> drop
                continue
            if fx > 1 or fy > 1:
                cell = cell.reshape(TILE, fy, TILE, fx).mean(axis=(1, 3))
            Image.fromarray(enc(cell, args.bits), "RGB").save(
                os.path.join(stage, f"{c}_{r}.png"), optimize=True)
            manifest.append(f"{c}_{r}"); land_px += cell.size
        print(f"  row {r+1}/{rows}  kept {len(manifest)}")
    json.dump({"deg": DEG, "cols": cols, "rows": rows, "tileW": TILE, "tileH": TILE,
               "ext": "png", "enc": "rg16", "bits": args.bits, "tiles": manifest},
              open(os.path.join(stage, "index.json"), "w"))

    # atomic-ish swap
    if os.path.isdir(args.out_dir): shutil.rmtree(args.out_dir)
    os.rename(stage, args.out_dir)
    n = len([f for f in os.listdir(args.out_dir) if f.endswith(".png")])
    total = sum(os.path.getsize(os.path.join(args.out_dir, f))
                for f in os.listdir(args.out_dir)) / 1e6
    print(f"fine {TILE}px/{DEG}deg = {TILE/DEG:.0f} px/deg  {args.bits}-bit  ({fx}x{fy} decimation)")
    print(f"kept {n}/{cols*rows} land tiles ({n/(cols*rows)*100:.0f}%)  {total:.0f} MB -> {args.out_dir}")

if __name__ == "__main__":
    main()
