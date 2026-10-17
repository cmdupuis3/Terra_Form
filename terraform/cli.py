"""The command-line arguments every exporter shares: the frame, the layer sources and the small-island
expander (terraform/frame.py's build_landmask). A game's exporter adds them to its own parser:

    ap = argparse.ArgumentParser(...)
    cli.add_frame_args(ap)                  # --bounds --ppd --width --snap --*-source --island-*
    args = ap.parse_args()
    frame = cli.frame_from_args(args)
    fine = cli.fine_sources(args, frame)    # {"elev": bool, "koppen": bool, "coast": bool}
    mask, land_src = build_landmask(frame, fine["coast"], **cli.island_kwargs(args))

An exporter that sizes its frame its own way (OpenFront's --pixels / --aspect) passes resolution=False and
builds the Frame itself.
"""
from .frame import BASE_PPD, EPS, Frame, parse_regions

SOURCE_LAYERS = ("elev", "koppen", "coast")


def add_frame_args(ap, bounds_required=False, resolution=True, islands=True):
    """--bounds (the whole globe by default, or required), --ppd / --width / --snap (when `resolution`),
    --elev-source / --koppen-source / --coast-source, and the --island-* expander (when `islands`)."""
    if bounds_required:
        ap.add_argument("--bounds", type=float, nargs=4, metavar=("W", "S", "E", "N"), required=True,
                        help="lon/lat box (W > E crosses 180)")
    else:
        ap.add_argument("--bounds", type=float, nargs=4, metavar=("W", "S", "E", "N"), default=[-180.0, -90.0, 180.0, 90.0],
                        help="lon/lat box to export (default: the whole globe)")
    if resolution:
        res = ap.add_mutually_exclusive_group()
        res.add_argument("--ppd", type=float, help=f"pixels per degree (default {BASE_PPD:.4f}, the working grid)")
        res.add_argument("--width", type=int, help="pixel width of the requested box; sets --ppd")
        ap.add_argument("--snap", type=int, default=4, help="edges snap outward to a multiple of this many pixels")
    for layer in SOURCE_LAYERS:
        ap.add_argument(f"--{layer}-source", choices=("auto", "base", "fine"), default="auto")
    if islands:
        add_island_args(ap)


def add_island_args(ap):
    """The small-island expander's arguments (build_landmask's island_* parameters; see island_kwargs)."""
    ap.add_argument("--island-expand", type=float, default=0.0,
                    help="the app's small-island expander: islands under --island-min-deg across are scaled toward it by this much (0..1) and burned all-touched")
    ap.add_argument("--island-min-deg", type=float, default=0.15, help="the size (degrees, longer side) small islands are expanded toward")
    ap.add_argument("--island-min-area", type=float, default=0.3, help="km2; islets smaller than this are not expanded (rocks and skerries)")
    ap.add_argument("--island-isolation", type=float, default=0.0,
                    help="km; only islets at least this far from bigger land (anything of --island-min-deg or more) are expanded, so continental coasts keep their skerries as they are")
    ap.add_argument("--island-regions", default="",
                    help="lon/lat boxes where the isolation gate is waived and every islet expands (atoll country): 'W,S,E,N;W,S,E,N' or a JSON file of {name, bounds} items, e.g. data/island_regions.json; with a huge --island-isolation this is 'expand only here'")
    ap.add_argument("--island-merge", action="store_true",
                    help="let an expanded islet touch other land (by default an expansion that would join another land mass under a 3x3 stencil is dropped and the islet keeps its plain burn)")


def frame_from_args(args):
    """The Frame for --bounds at --ppd, or at the density that gives the requested box --width pixels, or at
    the working grid (BASE_PPD); edges snapped to --snap."""
    w, s, e, n = args.bounds
    span = 360.0 if e - w >= 360.0 else (e - w) % 360.0 or 360.0
    ppd = args.ppd or (args.width / span if args.width else BASE_PPD)
    return Frame(args.bounds, ppd, args.snap)


def fine_sources(args, frame):
    """{layer: use the fine source} from --<layer>-source: fine, base, or auto = fine only above the
    working density."""
    return {k: (v == "fine" or (v == "auto" and frame.ppd > BASE_PPD + EPS))
            for k, v in ((layer, getattr(args, f"{layer}_source")) for layer in SOURCE_LAYERS)}


def island_kwargs(args):
    """The --island-* arguments as build_landmask keyword arguments (island_regions parsed)."""
    return {"island_expand": args.island_expand, "island_min_deg": args.island_min_deg,
            "island_min_area": args.island_min_area, "island_isolation_km": args.island_isolation,
            "island_regions": parse_regions(args.island_regions), "island_merge": args.island_merge}
