"""Terra Form: raw geographic layers (elevation, land, Koppen climate, rivers, salt pans) on a lon/lat
frame, for any game. The game-specific parts (a terrain classifier, an export format, a CLI) live in
games/<game>/; a game's exporter imports this package and never needs to change it:

    import os, sys
    sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")))
    from terraform import frame as tf      # or: from terraform import Frame, build_elevation, ...
    from terraform import cli              # the shared --bounds / --*-source / --island-* arguments

terraform/frame.py documents the frame and the layers; terraform/elev16.py the RG16 elevation codec.
"""
from .elev16 import SEA, PEAK
from .frame import (
    HERE, ROOT, DATA,
    KOPPEN_KEYS, BASE_PPD, MAX_WINDOW_PX, EPS, CRS,
    Frame,
    resample_global, global_to_frame, rg16_decode, rg16_encode,
    build_elevation, build_koppen,
    rings_to_polygon, polys_in_frame, burn, decode_coast_tile, vector_tile_polys,
    parse_regions, in_regions, expand_islands, burn_islands, build_landmask,
    river_shapes, river_channels, playa_shapes,
)

__all__ = [
    "HERE", "ROOT", "DATA", "SEA", "PEAK",
    "KOPPEN_KEYS", "BASE_PPD", "MAX_WINDOW_PX", "EPS", "CRS",
    "Frame",
    "resample_global", "global_to_frame", "rg16_decode", "rg16_encode",
    "build_elevation", "build_koppen",
    "rings_to_polygon", "polys_in_frame", "burn", "decode_coast_tile", "vector_tile_polys",
    "parse_regions", "in_regions", "expand_islands", "burn_islands", "build_landmask",
    "river_shapes", "river_channels", "playa_shapes",
]
