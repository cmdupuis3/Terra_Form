#!/usr/bin/env python3
"""Check openfront_compile.py (beside this script) against the runtime files OpenFront ships.

For each map it compiles map-generator/assets/maps/<name>/image.png and compares with
resources/maps/<name>/: map.bin, map4x.bin and map16x.bin byte-for-byte (on a mismatch: counts by
differing field and the first few tiles decoded), the manifest's three size blocks, and the
thumbnail's dimensions (the WebP is lossy, so only its size is checked).

  python -P games/openfront/openfront_compile_test.py --openfront <extracted OpenFrontIO folder>
                                                      [--maps world,britannia,...] [--no-all] [--test-maps]

By default a spread of maps (palette, RGB, RGBA, 16-bit grey+alpha, anti-aliased edges, impassable
terrain, lakes, tiny islands) is reported in detail, then every map is run for the overall pass rate.
--test-maps also checks assets/test_maps against tests/testdata/maps, which Go compiles with island
and lake removal switched off (the --keep-small path).
"""
import argparse, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # -P / -I leave the script folder off sys.path
import numpy as np
from PIL import Image

import openfront_compile as oc

DEFAULT_MAPS = ["world", "britannia", "europe", "fourislands", "levant", "conakry", "hecatestrait", "sierpinski",
                "thebox", "labyrinth", "greatlakes", "archipelagosea", "gulfofstlawrence", "amazonriver"]

FIELDS = ("land", "shore", "ocean", "mag", "impassable")


def decode(byte):
    return dict(land=bool(byte & 0x80), shore=bool(byte & 0x40), ocean=bool(byte & 0x20), mag=int(byte & 0x1F),
                impassable=(byte & 0x80) != 0 and (byte & 0x1F) == 31)


def compare_bin(key, got, want, width, log, verbose):
    if got == want:
        return True
    if len(got) != len(want):
        log(f"    {key}: size {len(got)} vs shipped {len(want)}")
        return False
    g = np.frombuffer(got, dtype=np.uint8)
    w = np.frombuffer(want, dtype=np.uint8)
    diff = np.flatnonzero(g != w)
    gl, wl = (g[diff] & 0x80) != 0, (w[diff] & 0x80) != 0
    by = {"type (land/water)": int((gl != wl).sum()),
          "impassable": int(((gl & ((g[diff] & 0x1F) == 31)) != (wl & ((w[diff] & 0x1F) == 31))).sum()),
          "shore": int((((g[diff] ^ w[diff]) & 0x40) != 0).sum()),
          "ocean": int((((g[diff] ^ w[diff]) & 0x20) != 0).sum()),
          "mag": int((((g[diff] ^ w[diff]) & 0x1F) != 0).sum())}
    log(f"    {key}: {len(diff)} of {len(g)} tiles differ; by field: " + ", ".join(f"{k} {v}" for k, v in by.items() if v))
    for i in diff[:8 if verbose else 3]:
        x, y = int(i % width), int(i // width)
        a, b = decode(int(g[i])), decode(int(w[i]))
        log(f"      ({x},{y}) got {int(g[i]):#04x} {a}  shipped {int(w[i]):#04x} {b}")
    return False


def check_map(name, assets_dir, shipped_dir, remove_small, log, verbose):
    t0 = time.time()
    rgba = oc.load_image(os.path.join(assets_dir, "image.png"))
    with open(os.path.join(assets_dir, "info.json"), encoding="utf-8") as f:
        info = json.load(f)
    t_load = time.time() - t0
    compiled = oc.compile_map(rgba, remove_small=remove_small)
    t_compile = time.time() - t0 - t_load

    ok = True
    for key in ("map", "map4x", "map16x"):
        with open(os.path.join(shipped_dir, key + ".bin"), "rb") as f:
            want = f.read()
        ok &= compare_bin(key, compiled.bins[key], want, compiled.sizes[key]["width"], log, verbose)

    with open(os.path.join(shipped_dir, "manifest.json"), encoding="utf-8") as f:
        shipped = json.load(f)
    mine = oc.manifest(info, compiled)
    for key in ("map", "map4x", "map16x"):
        if shipped.get(key) != mine[key]:
            log(f"    manifest {key}: {mine[key]} vs shipped {shipped.get(key)}")
            ok = False
    extra = {k: v for k, v in shipped.items() if k not in ("map", "map4x", "map16x") and mine.get(k) != v}
    if extra:
        log(f"    manifest: shipped keys that differ from info.json: {sorted(extra)}")

    thumb = oc.thumbnail(compiled)
    with Image.open(os.path.join(shipped_dir, "thumbnail.webp")) as im:
        if im.size != thumb.size:
            log(f"    thumbnail {thumb.size} vs shipped {im.size}")
            ok = False

    s = compiled.stats
    detail = (f"{compiled.width}x{compiled.height}, land {compiled.sizes['map']['num_land_tiles']}, "
              f"islands -{s['map']['islands_removed']}/-{s['map4x']['islands_removed']}, lakes -{s['map']['lakes_filled']}, "
              f"impassable {s['map']['impassable_tiles']}, load {t_load:.2f}s compile {t_compile:.2f}s")
    log(f"  {'PASS' if ok else 'FAIL'} {name}: {detail}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--openfront", required=True, help="extracted OpenFrontIO source folder")
    ap.add_argument("--maps", help="comma-separated map folders to check in detail (default: a spread of formats)")
    ap.add_argument("--no-all", action="store_true", help="skip the pass over every map")
    ap.add_argument("--test-maps", action="store_true", help="also check assets/test_maps (compiled without small-body removal)")
    args = ap.parse_args()

    root = args.openfront
    assets = os.path.join(root, "map-generator", "assets", "maps")
    shipped = os.path.join(root, "resources", "maps")
    all_maps = sorted(d for d in os.listdir(assets) if os.path.isfile(os.path.join(assets, d, "image.png")))
    detailed = args.maps.split(",") if args.maps else [m for m in DEFAULT_MAPS if m in all_maps]
    log = lambda s: print(s, flush=True)

    results = {}
    log(f"detailed set ({len(detailed)} maps):")
    for name in detailed:
        try:
            results[name] = check_map(name, os.path.join(assets, name), os.path.join(shipped, name), True, log, True)
        except Exception as e:                                   # noqa: BLE001 - report and carry on
            log(f"  ERROR {name}: {type(e).__name__}: {e}")
            results[name] = False

    if not args.no_all and not args.maps:
        rest = [m for m in all_maps if m not in results]
        log(f"all maps ({len(rest)} more):")
        for name in rest:
            try:
                results[name] = check_map(name, os.path.join(assets, name), os.path.join(shipped, name), True, log, False)
            except Exception as e:                               # noqa: BLE001
                log(f"  ERROR {name}: {type(e).__name__}: {e}")
                results[name] = False

    if args.test_maps:
        tassets = os.path.join(root, "map-generator", "assets", "test_maps")
        tshipped = os.path.join(root, "tests", "testdata", "maps")
        names = sorted(d for d in os.listdir(tassets) if os.path.isfile(os.path.join(tassets, d, "image.png")))
        log(f"test maps ({len(names)}, no small-body removal):")
        for name in names:
            try:
                results["test:" + name] = check_map(name, os.path.join(tassets, name), os.path.join(tshipped, name), False, log, True)
            except Exception as e:                               # noqa: BLE001
                log(f"  ERROR {name}: {type(e).__name__}: {e}")
                results["test:" + name] = False

    passed = sum(results.values())
    failed = [n for n, ok in results.items() if not ok]
    log(f"\n{passed}/{len(results)} maps byte-identical" + (f"; failing: {', '.join(failed)}" if failed else ""))
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
