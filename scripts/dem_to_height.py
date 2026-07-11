#!/usr/bin/env python3
"""
dem_to_height.py  —  turn a real DEM into the equirectangular height raster the
app consumes (a grayscale PNG on the plate-carree grid, north-up).

The bundled build uses a NASA-derived Earth elevation bump map (convenient, but
of informal provenance). For anything beyond prototyping, use a properly-licensed
DEM and regenerate with this script:

  * ETOPO 2022, 60 arc-second global GeoTIFF  (public domain, NOAA)
      https://www.ncei.noaa.gov/products/etopo-global-relief-model
  * GEBCO 2023 15 arc-second  (open)          https://www.gebco.net
  * Copernicus GLO-90 DEM  (free)             land only, no bathymetry

Usage:
  pip install rasterio numpy pillow
  python dem_to_height.py etopo_2022_60s.tif --width 2048 --height 1024 --out elev_2048.png

The output encodes land relief as brightness (oceans dark, peaks bright), matching
what the app decodes: heightArr = gray/255. Land/water is NOT taken from this — the
coastline owns that — so ocean/bathymetry values only need to sit below land.
"""
import argparse
import numpy as np
from PIL import Image


def load_equirect(path, width, height):
    """Reproject/resample the DEM to a plate-carree grid of (width x height),
    north-up, covering the whole globe. Returns elevation in metres as float32."""
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds
    from rasterio.crs import CRS

    dst = np.full((height, width), np.nan, dtype="float32")
    dst_transform = from_bounds(-180, -90, 180, 90, width, height)
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs or CRS.from_epsg(4326),
            dst_transform=dst_transform,
            dst_crs=CRS.from_epsg(4326),
            resampling=Resampling.average,   # average when downsampling a fine DEM
        )
    return dst


def encode(elev_m, sea_floor=-500.0, peak=6000.0):
    """Map metres -> 0..255. Land relief fills most of the range; anything at or
    below sea_floor pins to the dark end (oceans), peaks to the bright end."""
    e = np.nan_to_num(elev_m, nan=sea_floor)
    t = (e - sea_floor) / (peak - sea_floor)
    return (np.clip(t, 0.0, 1.0) * 255.0).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dem", help="global DEM (GeoTIFF, ideally WGS84 lon/lat)")
    ap.add_argument("--width", type=int, default=2048)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--sea-floor", type=float, default=-500.0, help="metres mapped to black")
    ap.add_argument("--peak", type=float, default=6000.0, help="metres mapped to white")
    ap.add_argument("--out", default="elev.png")
    args = ap.parse_args()
    assert args.width == 2 * args.height, "equirectangular grid must be 2:1"

    elev = load_equirect(args.dem, args.width, args.height)
    gray = encode(elev, args.sea_floor, args.peak)
    Image.fromarray(gray, mode="L").save(args.out, optimize=True)
    valid = np.isfinite(elev)
    print(f"grid   {args.width}x{args.height}  ({360/args.width:.4f} deg/px)")
    print(f"elev   min {np.nanmin(elev):.0f} m  max {np.nanmax(elev):.0f} m")
    print(f"wrote  {args.out}  (embed as a data: URL in index.html's ELEV_SRC)")


if __name__ == "__main__":
    main()
