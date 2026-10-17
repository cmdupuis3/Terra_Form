#!/usr/bin/env python3
"""Export a Culture Wars *world pack* from Terra_Form's data layers (the frame and the layers are
terraform/frame.py's; this script writes them in the pack format).

A world pack is a folder with a manifest.json and a few rasters that the Unity project
(Culture Wars) loads at runtime from StreamingAssets/WorldPacks/<name>/:

  elevation.png  RG16-encoded elevation (R = high byte, G = low byte), 0..65535 spans
                 [minMeters, maxMeters]
  landmask.png   8-bit L, 255 = land, 0 = water. Rasterised from the coastline polygons with
                 lakes punched out (same rule as the app's buildLandMask()).
  koppen.png     8-bit L class-index raster (0 = none, 1..30 = Beck et al. 2023 classes)
  rivers.png     8-bit L, 0 = none, 1 = minor (< 100 m3/s), 2 = medium (100..1000), 3 = major
                 (>= 1000 m3/s) river passing through the cell. Rasterised from data/river_tiles
                 (HydroRIVERS channels, all LOD bands), one cell wide.
  rivers.bin     the same channels as vectors, for the map's river line (the game draws a river
                 from the real geometry, not from the raster's staircase): every channel with a
                 reach of 100 m3/s or more, and the minor channels that run through dry country
                 (Koppen BW/BS, where the game lays oasis ground along them). Little-endian:
                 "CWRV", u32 version 1, u32 channels, u32 reaches, u32 vertices; per channel i32 id,
                 u8 terminal kind (0 unknown, 1 mouth, 2 confluence, 3 sink), u8 class (1..3, the
                 largest reach), u16 reaches; per reach f32 discharge, u16 vertices, then (f32 lon,
                 f32 lat) each. A terminal is a confluence when it is a vertex of another channel,
                 a mouth when the land mask has water under it, a sink otherwise.
  playas.bin     the salt pans (data/playas.json, Natural Earth's playas) under the frame as polygons,
                 for the map's salt crust. Little-endian: "CWPL", u32 version 1, u32 polygons; per
                 polygon u32 rings; per ring u32 vertices, then (f32 lon, f32 lat) each; the first ring
                 is the outside, the rest holes, rings not closed. The same polygons are burned back
                 into landmask.png as LAND after the lakes are punched out: a salt flat takes precedence
                 over a lake polygon that covers it (Uyuni, the Bonneville flats).

--island-expand E (0..1, default 0) is the app's small-island expander: an island under --island-min-deg
(default 0.15 deg) on its longer side is scaled about its centre E of the way toward that size and burned
all-touched, so atolls and islets that the pixel grid would lose still mark cells as land (the game can
then put a city site on Funafuti or Male). Pieces of larger land clipped at a coast tile edge are never
scaled. Two rules keep it off continental coasts, where every skerry would otherwise claim a cell and
weld onto the shore: an expansion that would touch bigger land (anything of --island-min-deg or more)
under a 3x3 stencil is dropped (--island-merge allows it; islets may still union with each other, an
atoll is many polygons), and --island-isolation KM expands only islets at least that far from bigger
land. --island-regions names lon/lat boxes where the isolation gate is waived (atoll country, where one
long rim strip would gate out the rest of its ring): the composite is the plain coast everywhere, the
expander in those regions and on isolated islets. data/island_regions.json holds the Pacific atoll
groups and the Maldives; the earth packs use --island-isolation 25 with it.

A pack is a FRAME of the Earth: a lon/lat box (--bounds W S E N; W > E crosses the antimeridian)
at a pixel density (--ppd pixels per degree, or --width to fix the pixel width). The default is the
whole globe on the app's 4096x2048 working grid.

The pixel grid is anchored at (-180, 90) and every edge snaps OUTWARD to a multiple of --snap
pixels, so the requested box is always inside the pack, a frame at the working density lines up
pixel for pixel with the global export (rasters exactly; a rasterised line can differ where it
grazes a pixel corner), and the game's downsample factors still divide both sides. The manifest carries the snapped bounds.

Each layer is drawn from the finest source the density calls for (--elev-source, --koppen-source,
--coast-source: auto | base | fine; auto = fine only above the working density):

  elevation  base: data/elev_4096.png          fine: data/hgt_tiles (120 px/deg, land only; the
                                                     dropped ocean cells are filled from the base)
  koppen     base: data/koppen_2048.png        fine: data/koppen_tiles polygons, rasterised
             (written at its own resolution when the frame is a whole multiple of it)
  land       base: data/coast_10m + lakes_10m  fine: data/coast_tiles (OSM land polygons, ODbL; the
                                                     fine LOD) + lakes_hires; coast_hires when the
                                                     tile set is absent
  rivers     data/river_tiles, rasterised at any density

    # the Earth without the poles, on the working grid
    python games/culture_wars/export_world_pack.py --out "<UnityProject>/Assets/StreamingAssets/WorldPacks/earth" --bounds -180 -60 180 85
    # the Aegean with as many cells across as the world map
    python games/culture_wars/export_world_pack.py --out "<UnityProject>/Assets/StreamingAssets/WorldPacks/aegean" --bounds 19 34 30 42 --width 4096

Rotation is a future option (see docs/PLAN.md in Culture Wars).
"""
import argparse, json, os, sys, time
import numpy as np
from PIL import Image

# The core (terraform/, two folders up): the frame and its layers. This file is only the pack writer.
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")))
from terraform import cli                                                          # noqa: E402
from terraform import (DATA, KOPPEN_KEYS, PEAK, SEA, build_elevation, build_koppen, build_landmask, burn,  # noqa: E402
                       playa_shapes, rg16_encode, river_channels, river_shapes)


# ---------------------------------------------------------------- the pack's binary layers

def write_playas(path, playas):
    """playas.bin, as the module docstring lays it out. Returns the polygon count."""
    import struct
    with open(path, "wb") as f:
        f.write(b"CWPL" + struct.pack("<II", 1, len(playas)))
        for g in playas:
            rings = g["coordinates"]
            f.write(struct.pack("<I", len(rings)))
            for r in rings:
                pts = r[:-1] if len(r) > 1 and r[0] == r[-1] else r
                f.write(struct.pack("<I", len(pts)))
                f.write(np.asarray(pts, dtype="<f4").tobytes())
    return len(playas)


def write_river_channels(path, channels):
    """rivers.bin, as the module docstring lays it out. Returns (channels, reaches, vertices)."""
    import struct
    n_reach = sum(len(r) for _, _, _, r in channels)
    n_vert = sum(len(pts) for _, _, _, r in channels for _, pts in r)
    with open(path, "wb") as f:
        f.write(b"CWRV" + struct.pack("<IIII", 1, len(channels), n_reach, n_vert))
        for cid, kind, cls, reaches in channels:
            f.write(struct.pack("<iBBH", cid, kind, cls, len(reaches)))
            for d, pts in reaches:
                f.write(struct.pack("<fH", d, len(pts)))
                f.write(np.asarray(pts, dtype="<f4").tobytes())
    return len(channels), n_reach, n_vert


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output pack folder (created)")
    ap.add_argument("--name", help="pack name (default: the output folder's name)")
    cli.add_frame_args(ap, islands=False)      # --bounds --ppd --width --snap --elev-source --koppen-source --coast-source
    ap.add_argument("--elev", default=os.path.join(DATA, "elev_4096.png"), help="base elevation raster")
    ap.add_argument("--koppen", default=os.path.join(DATA, "koppen_2048.png"), help="base Koppen raster")
    cli.add_island_args(ap)                    # --island-expand --island-min-deg --island-min-area --island-isolation --island-regions --island-merge
    args = ap.parse_args()

    w, s, e, n = args.bounds
    frame = cli.frame_from_args(args)
    fine = cli.fine_sources(args, frame)
    name = args.name or os.path.basename(os.path.normpath(args.out))

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    print(f"frame {frame.w}x{frame.h} at {frame.ppd:.4f} px/deg: lon {frame.lon_min:.6f}..{frame.lon_max:.6f}, "
          f"lat {frame.lat_min:.6f}..{frame.lat_max:.6f}, wrapX {frame.wrap}")

    code, elev_src = build_elevation(frame, args.elev, fine["elev"])
    Image.fromarray(rg16_encode(code), "RGB").save(os.path.join(args.out, "elevation.png"), optimize=True)
    print(f"elevation {frame.w}x{frame.h} from {elev_src}")

    kop, kop_src = build_koppen(frame, args.koppen, fine["koppen"])
    Image.fromarray(np.ascontiguousarray(kop), "L").save(os.path.join(args.out, "koppen.png"), optimize=True)
    print(f"koppen {kop.shape[1]}x{kop.shape[0]} from {kop_src}")

    islands = cli.island_kwargs(args)
    regions = islands["island_regions"]
    mask, land_src = build_landmask(frame, fine["coast"], **islands)
    Image.fromarray(mask, "L").save(os.path.join(args.out, "landmask.png"), optimize=True)
    print(f"landmask from {land_src}: {100.0 * (mask > 0).mean():.1f}% land")

    shapes = river_shapes(frame)
    rivers = burn(frame, shapes, all_touched=True)
    Image.fromarray(rivers, "L").save(os.path.join(args.out, "rivers.png"), optimize=True)
    print(f"rivers from {len(shapes)} reaches: minor {(rivers == 1).sum()} medium {(rivers == 2).sum()} major {(rivers == 3).sum()} cells")

    n_playas = write_playas(os.path.join(args.out, "playas.bin"), playa_shapes(frame))
    print(f"playas: {n_playas} salt pans under the frame")

    channels, cstats = river_channels(frame, kop, mask)
    n_ch, n_reach, n_vert = write_river_channels(os.path.join(args.out, "rivers.bin"), channels)
    print(f"river channels: {n_ch} kept of {cstats['channels']} ({cstats['minor_dropped']} minor channels off the drylands dropped), "
          f"{n_reach} reaches, {n_vert} vertices; terminals: {cstats['mouth']} mouths, {cstats['confluence']} confluences, "
          f"{cstats['sink']} sinks, {cstats['unknown']} off the frame")

    manifest = {
        "format": "culturewars-worldpack",
        "version": 1,
        "name": name,
        "width": frame.w,
        "height": frame.h,
        "bounds": {"lonMin": frame.lon_min, "lonMax": frame.lon_max, "latMin": frame.lat_min, "latMax": frame.lat_max},
        "wrapX": frame.wrap,
        "rotationDeg": 0.0,
        "layers": {
            "elevation": {"file": "elevation.png", "encoding": "rg16", "width": frame.w, "height": frame.h,
                           "minMeters": SEA, "maxMeters": PEAK},
            "landMask": {"file": "landmask.png", "encoding": "l8", "width": frame.w, "height": frame.h},
            "rivers": {"file": "rivers.png", "encoding": "index8", "width": frame.w, "height": frame.h,
                       "classes": ["", "minor", "medium", "major"]},
            "riversVector": {"file": "rivers.bin", "encoding": "channels-bin-v1", "channels": n_ch, "reaches": n_reach, "vertices": n_vert},
            "playas": {"file": "playas.bin", "encoding": "polygons-bin-v1", "polygons": n_playas},
            "koppen": {"file": "koppen.png", "encoding": "index8", "width": int(kop.shape[1]), "height": int(kop.shape[0]),
                        "classes": ["" if k is None else k for k in KOPPEN_KEYS]},
        },
        "frame": {"requestedBounds": [w, s, e, n], "ppd": frame.ppd, "snap": args.snap,
                  "islandExpand": args.island_expand, "islandMinDeg": args.island_min_deg, "islandMinAreaKm2": args.island_min_area,
                  "islandIsolationKm": args.island_isolation, "islandRegions": [list(r) for r in regions], "islandMerge": args.island_merge,
                  "sources": {"elevation": elev_src, "koppen": kop_src, "landMask": land_src, "rivers": "river_tiles",
                              "riversVector": "river_tiles (channels >= 100 m3/s, and minor channels through Koppen BW/BS)",
                              "playas": "playas.json (Natural Earth 10 m playas), also burned back into landMask as land"}},
        "attribution": [
            "Elevation: ETOPO 2022 (NOAA NCEI), " + ("30 arc-second" if fine["elev"] else "decimated to the working grid"),
            ("Coastline: OpenStreetMap land polygons (© OpenStreetMap contributors, ODbL 1.0)"
             if "OpenStreetMap" in land_src else "Coastline: Natural Earth 10 m (public domain)"),
            ("Lakes: HydroLAKES v1.0, Messager et al. 2016 (CC BY 4.0)"
             if "HydroLAKES" in land_src else "Lakes: Natural Earth 10 m (public domain)"),
            "Climate: Koppen-Geiger, Beck et al. 2023 (CC BY 4.0)",
            "Rivers: HydroRIVERS v1.0 (CC BY 4.0), channel-reduced by Terra_Form",
            "Salt pans: Natural Earth 10 m playas (public domain)",
        ],
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {os.path.join(args.out, 'manifest.json')} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
