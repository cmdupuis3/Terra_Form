#!/usr/bin/env python3
"""Export an OpenFront map (openfront.io) from Terra_Form's data layers.

An OpenFront map is a pixel map: every pixel is one game tile, water or land, and a land tile carries a
magnitude 0..30 that the game reads as its terrain (GameMapImpl.terrainType): under 10 plains, under 20
highland, otherwise mountain. Maps are authored as the input of OpenFront's map generator
(map-generator/, Go), one folder per map:

  image.png   the terrain. Blue 106 is water (red and green are ignored); any other colour is land of
              magnitude ceil((clamp(blue, 140, 200) - 140) / 2). Written here in OpenFront's own
              palette (the colours its shipped maps use, blue = 140 + 2 * magnitude) as a 32-colour
              palette PNG. Both sides are multiples of 4 (the generator crops to that).
  info.json   id (UpperCamelCase of the folder name), name, translation_key, categories,
              multiplayer_frequency and nations [{coordinates: [x, y] in image pixels, name, flag}].

The generator (`npm run gen-maps` in an OpenFront checkout) drops land bodies under 30 tiles and lakes
under 200, finds the ocean, the shore and the water depth, writes resources/maps/<folder>/ (map.bin,
map4x.bin, map16x.bin, manifest.json, thumbnail.webp) and registers the map (Maps.gen.ts, en.json).
--compiled writes those runtime files here instead, through scripts/openfront_compile.py (a port of the
generator, checked byte for byte against OpenFront's shipped maps); a map still needs gen-maps to be
registered in the game, so --compiled is for checking what the game will see. --preview draws the
compiled map in the game's colours.

The world comes from export_world_pack.py: a FRAME (a lon/lat box at a pixel density, W > E crosses the
antimeridian) with the same elevation (ETOPO 2022, fine hgt_tiles above the working density), land mask
(OpenStreetMap coast tiles, HydroLAKES with the reservoirs gone and the historic lakes back, Natural
Earth playas as land) and small-island expander. On top of it this module adds OpenFront's two pieces:

The land classifier. Magnitude follows elevation on a square-root scale with three anchors (metres):
plains below --plains-top, highland below --highland-top, magnitude 30 at --mountain-top and above.
The defaults (250, 1000, 2250) are fitted to OpenFront's own World map: registered on our layers
(equirectangular, lon -168.25..191.75, lat 83.5..-80, 97.8 % land agreement) its magnitude is a
function of elevation alone (Spearman 0.92; local relief adds nothing), and 0.63 * sqrt(metres) fits
every band: on that frame this classifier gives the World map's terrain type on 85 % of its land tiles
(median magnitude error 1) and its plains / highland / mountain mix to within 2 points. Africa, Mena
and Australia follow the same curve. Those are absolute heights, so a lowland region comes out all
plains, as those maps have it; --mix PLAINS,HIGHLAND sets the anchors from the frame's own land heights
instead (e.g. --mix 40,45 for 40 % plains, 45 % highland, the rest mountain), the way OpenFront's
regional maps stretch their relief.

Desert depends on the map. The maps above give desert no lift: at a given height a desert tile has the
same magnitude as any other. Some of the desert maps draw desert as mid-rough terrain instead: Horn of
Africa (desert ~15 from 150 m up, the humid lowland 0), the Levant (desert ~5 above wetter land at the
same height below 250 m), the Middle East and Bab el-Mandeb (nearly all inland desert highland). In all
of them a low coastal desert strip stays plains. --desert [MAG] follows that convention: Koppen BW land
is at least magnitude MAG (12 when no value is given), on a square-root ramp from 0 at sea level that
reaches highland at 50 m. A big river's valley floor (within 15 km of a channel of 100 m3/s or more
and no more than 30 m above it) is left as the elevation has it, so the Nile, the Euphrates and the
Indus stay plains through the desert. On those four maps it raises the desert tiles' terrain-type
agreement from 50-70 % to 64-80 %; on the World, Africa, Mena, Australia and Hormuz maps it would lower
it by 6-27 points, so it is off unless asked for. Steppe (BS) is left alone: lifting it helped on none.

--rivers CLASS cuts the river channels of that class and larger (1 minor, 2 >= 100 m3/s, 3 >= 1000 m3/s)
into the land as water: waterways for the ships, barriers on land.

The output format, above. The aspect is equirectangular: with --aspect true (the default, except on a
whole-globe frame) a pixel is cos(mid-latitude) as wide in degrees as it is tall, so the frame's middle
reads at true shape; --aspect plate keeps square degrees (the World map's convention). The size defaults
to --pixels 2.5 M, the middle of the generator's recommended 2-3 M.

Nations come from the curated gazetteer (data/seats/historic_*.csv): the best-scoring sites under the
frame (significance, capitals first), snapped onto land that survives the generator, spread out by a
minimum spacing that is relaxed until --nations of them fit; --nation-names country keeps one per country
and names it after the country. Flags are the country's code in OpenFront's resources/countries.json
(--openfront points at a checkout; without one the flags are left empty, which OpenFront accepts).
--nations-file takes your own: a CSV or JSON of name, lat, lon and optional flag.

    # The Aegean, into an OpenFront checkout, with the runtime files and a preview
    python scripts/export_openfront.py --bounds 19 34 30 42 --name "Aegean Sea" --openfront C:/src/OpenFrontIO \\
        --out C:/src/OpenFrontIO/map-generator/assets/maps/aegeansea \\
        --compiled C:/src/OpenFrontIO/resources/maps/aegeansea --preview aegean_preview.png
    # The British Isles, relief stretched to the region, 24 nations, the big rivers navigable
    python scripts/export_openfront.py --bounds -11 49.5 2.5 61 --name "Isles" --mix 40,45 --nations 24 --rivers 3 \\
        --out out/isles --preview out/isles_preview.png
    # Arabia with its desert as rough ground
    python scripts/export_openfront.py --bounds 34 12 60 32 --name "Arabia" --desert --out out/arabia --preview out/arabia.png

Data credits for the map's CREDITS.md entry are printed at the end (OpenStreetMap is ODbL: maps made
from it are produced works that need the credit line).
"""
import argparse, csv, glob, json, math, os, re, sys, time, unicodedata
import numpy as np
from PIL import Image
from rasterio import features
from rasterio.transform import Affine
from scipy import ndimage as nd

import export_world_pack as wp

WATER_BLUE = 106
PLAINS_TOP, HIGHLAND_TOP, MOUNTAIN_TOP = 250.0, 1000.0, 2250.0   # metres; the World map fit (docstring)
DESERT = (4, 5)          # Koppen BWh, BWk
DESERT_MAG = 12          # --desert's default floor: mid-highland (fitted to the desert maps, docstring)
DESERT_HIGHLAND_M = 50.0 # the floor's square-root ramp reaches highland (10) at this height
VALLEY_KM, VALLEY_RISE_M = 15.0, 30.0   # a big river's valley floor in the desert: this near it, this little above it
TARGET_PIXELS = 2_500_000
MIN_ISLAND = 30          # the generator turns 4-connected land bodies under this many tiles into water
NAME_MAX = 27            # OpenFront's nation-name limit (tests/NationName.test.ts), printable Latin-1
CATEGORIES = ("featured", "new", "world", "continental", "europe", "asia", "north_america", "africa",
              "south_america", "oceania", "antarctica", "countries", "cosmic", "fictional", "arcade", "tournament")
# Gazetteer country names that countries.json spells another way.
COUNTRY_ALIASES = {"united states": "us", "turkey": "tr", "czechia": "cz", "palestine": "ps", "cape verde": "cv",
                   "united states virgin islands": "vi", "british virgin islands": "vg", "brunei": "bn",
                   "sao tome and principe": "st", "pitcairn islands": "pn"}


# ---------------------------------------------------------------- the land classifier

def magnitude(elev_m, anchors):
    """Land magnitude 0..30 from metres: square-root scale through the band anchors, floored so the plains
    and highland bands end exactly at their anchors. Land at or below sea level is plains 0."""
    p, m, t = (math.sqrt(a) for a in anchors)
    s = np.sqrt(np.clip(elev_m, 0.0, None))
    mag = np.where(s < p, 10.0 * s / p, np.where(s < m, 10.0 + 10.0 * (s - p) / (m - p), 20.0 + 10.0 * (s - m) / (t - m)))
    return np.clip(np.floor(mag), 0, 30).astype(np.uint8)


def desert_floor(elev_m, floor_mag):
    """--desert: the least magnitude a desert tile takes, climbing on a square-root ramp from 0 at sea level
    through highland at DESERT_HIGHLAND_M to floor_mag, so a low coastal desert strip stays plains."""
    ramp = np.floor(10.0 * np.sqrt(np.clip(elev_m, 0.0, None) / DESERT_HIGHLAND_M))
    return np.minimum(float(floor_mag), ramp).astype(np.uint8)


def river_valleys(grid, elev):
    """Tiles on the valley floor of a big river (a channel of 100 m3/s or more): within VALLEY_KM of it and
    at most VALLEY_RISE_M above it. --desert leaves them as the elevation has them, so the Nile, the
    Euphrates and the Indus stay plains through the desert while the plateaus beside them are lifted."""
    shapes = [(g, 1) for g, c in wp.river_shapes(grid.frame) if c >= 2]
    river = grid.burn(shapes, all_touched=True).astype(bool) if shapes else None
    if river is None or not river.any():
        return np.zeros(elev.shape, bool)
    bed = nd.minimum_filter(elev, size=5)          # the burned line can sit a pixel or two off the valley floor
    dist, (iy, ix) = nd.distance_transform_edt(~river, return_indices=True)
    return (dist * grid.res_y * 111.32 <= VALLEY_KM) & (elev - bed[iy, ix] <= VALLEY_RISE_M)


def anchors_for_mix(land_heights, plains_pct, highland_pct):
    """Anchors that give the frame's land the requested plains / highland shares; the mountain band is as
    wide on the square-root scale as the highland band."""
    q = np.percentile(np.clip(land_heights, 0.0, None), [plains_pct, plains_pct + highland_pct])
    p = max(1.0, float(q[0]))
    m = max(p + 1.0, float(q[1]))
    t = (2.0 * math.sqrt(m) - math.sqrt(p)) ** 2
    return p, m, t


def land_rgb(mag):
    """OpenFront's map palette for a land magnitude (its shipped image.png files use exactly these)."""
    if mag < 10:
        return 190, 220 - 2 * mag, 140 + 2 * mag
    if mag < 20:
        return 200 + 2 * mag, 183 + 2 * mag, 140 + 2 * mag
    return 230 + mag // 2, 230 + mag // 2, 140 + 2 * mag


def write_image(path, land, mag):
    """image.png as a palette PNG: index 0 water, 1 + m land of magnitude m."""
    idx = np.where(land, mag.astype(np.uint8) + 1, 0).astype(np.uint8)
    pal = [0, 0, WATER_BLUE]
    for m in range(31):
        pal += land_rgb(m)
    im = Image.fromarray(idx, "P")
    im.putpalette(pal + [0, 0, 0] * (256 - len(pal) // 3))
    im.save(path, optimize=True)


# ---------------------------------------------------------------- the frame, squeezed to true aspect

def squeeze_x(a, w):
    """Area-average the columns of `a` (H x W0) down to `w` columns covering the same span."""
    a = a.astype(np.float32, copy=False)
    h, w0 = a.shape
    if w == w0:
        return a.copy()
    c = np.zeros((h, w0 + 1), np.float64)
    np.cumsum(a, axis=1, out=c[:, 1:])
    e = np.linspace(0.0, w0, w + 1)
    i = np.minimum(np.floor(e).astype(np.int64), w0 - 1)
    ce = c[:, i] + (e - i)[None, :] * a[:, i]
    return ((ce[:, 1:] - ce[:, :-1]) / np.diff(e)[None, :]).astype(np.float32)


class Grid:
    """The output grid: the frame's rows, its columns squeezed to `w`. Pixel (x, y) covers lon
    lon_min + x * res_x .. + res_x, lat lat_max - y * res_y .. - res_y."""

    def __init__(self, frame, w):
        self.frame, self.w, self.h = frame, w, frame.h
        self.res_x, self.res_y = (frame.lon_max - frame.lon_min) / w, frame.res

    def transform(self, lon_shift=0.0):
        return Affine(self.res_x, 0.0, self.frame.lon_min + lon_shift, 0.0, -self.res_y, self.frame.lat_max)

    def pixel(self, lon, lat):
        lon = lon if lon >= self.frame.lon_min - wp.EPS else lon + 360.0
        return (lon - self.frame.lon_min) / self.res_x, (self.frame.lat_max - lat) / self.res_y

    def burn(self, shapes, all_touched=False):
        out = np.zeros((self.h, self.w), np.uint8)
        for shift in self.frame.shifts():
            part = features.rasterize(shapes, out_shape=out.shape, transform=self.transform(shift), fill=0,
                                      dtype="uint8", all_touched=all_touched)
            np.copyto(out, part, where=part != 0)
        return out


def frame_for(args):
    """The world-pack frame (rows at the vertical density) and the output width after the squeeze."""
    w, s, e, n = args.bounds
    span = 360.0 if e - w >= 360.0 else (e - w) % 360.0 or 360.0
    plate = args.aspect == "plate" or (args.aspect == "auto" and span >= 360.0)
    kx = 1.0 if plate else max(0.05, math.cos(math.radians((s + n) / 2.0)))
    if args.ppd:
        ppd = args.ppd
    elif args.width:
        ppd = args.width / (span * kx)
    elif args.height:
        ppd = args.height / (n - s)
    else:
        ppd = math.sqrt(args.pixels / (span * (n - s) * kx))
    frame = wp.Frame(args.bounds, ppd, 4)
    width = max(4, int(round(frame.w * kx / 4.0)) * 4)
    return frame, width, kx


# ---------------------------------------------------------------- nations

def latin1_name(name):
    """A nation name OpenFront accepts: printable Latin-1 (other letters lose their accents), <= 27 chars."""
    out = []
    for ch in unicodedata.normalize("NFC", name):
        o = ord(ch)
        if 0x20 <= o <= 0x7E or 0xA0 <= o <= 0xFF:
            out.append(ch)
        else:
            out += [c for c in unicodedata.normalize("NFKD", ch) if 0x20 <= ord(c) <= 0x7E]
    s = re.sub(r"\s+", " ", "".join(out)).strip()
    if len(s) > NAME_MAX:
        cut = s[:NAME_MAX + 1].rsplit(" ", 1)[0]
        s = (cut if len(cut) >= NAME_MAX // 2 else s[:NAME_MAX]).rstrip(" ,-")
    return s


def fold(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower().strip()


def flag_lookup(openfront):
    """country name -> flag code, from an OpenFront checkout's resources/countries.json (codes whose svg exists)."""
    if not openfront:
        return None
    path = os.path.join(openfront, "resources", "countries.json")
    if not os.path.exists(path):
        sys.exit(f"--openfront: {path} not found")
    flags = os.path.join(openfront, "resources", "flags")
    have = {os.path.splitext(f)[0] for f in os.listdir(flags)} if os.path.isdir(flags) else None
    table = {fold(c["name"]): c["code"] for c in json.load(open(path, encoding="utf-8"))}
    table.update(COUNTRY_ALIASES)
    return {k: v for k, v in table.items() if have is None or v in have}


def read_gazetteer(pattern):
    """Candidate sites: (score, name, lat, lon, country). Capitals and the significant first."""
    out = []
    for path in sorted(glob.glob(pattern)):
        for r in csv.DictReader(open(path, encoding="utf-8", errors="replace")):
            try:
                lat, lon, sig = float(r["lat"]), float(r["lon"]), int(r.get("significance") or 1)
            except (KeyError, ValueError):
                continue
            eras = [e for e in (r.get("eras") or "").split(";") if e]
            score = 4.0 * sig + (3.0 if r.get("kind") == "capital" else 0.0) + 0.5 * len(eras) + (1.0 if r.get("confidence") == "high" else 0.0)
            out.append((score, r["name"], lat, lon, r.get("country", "")))
    out.sort(key=lambda c: (-c[0], c[1]))
    return out


def read_nations_file(path):
    """Your own nations, in order: CSV (name, lat, lon[, flag]) or JSON [{name, lat, lon, flag?}]."""
    rows = json.load(open(path, encoding="utf-8")) if path.lower().endswith(".json") else \
        list(csv.DictReader(open(path, encoding="utf-8")))
    return [(1e9 - i, r["name"], float(r["lat"]), float(r["lon"]), "", r.get("flag")) for i, r in enumerate(rows)]


def pick_nations(grid, land, want, cands, by_country, flags, log, spaced=True):
    """Greedy by score with a minimum spacing (when `spaced`), relaxed until `want` fit. Each site moves to
    the nearest tile of land the generator keeps (a body of MIN_ISLAND tiles or more) within 3 % of the
    map's diagonal; a site with none is skipped."""
    lab, n = nd.label(land)
    sizes = np.bincount(lab.ravel())
    keep = land & (sizes[lab] >= MIN_ISLAND)
    if not keep.any() or want <= 0:
        return []
    dist, (iy, ix) = nd.distance_transform_edt(~keep, return_indices=True)
    reach = 0.03 * math.hypot(grid.w, grid.h)
    sites = []
    for c in cands:
        x, y = grid.pixel(c[3], c[2])
        if not (0 <= x < grid.w and 0 <= y < grid.h):
            continue
        xi, yi = int(x), int(y)
        if dist[yi, xi] > reach:
            continue
        sites.append((c, int(ix[yi, xi]), int(iy[yi, xi])))
    if not sites:
        return []
    # No more than the sites can give: one per country, or one per distinct name.
    want = min(want, len({fold(c[4]) for c, _, _ in sites if c[4]} if by_country else {latin1_name(c[1]).lower() for c, _, _ in sites}))
    spacing = 0.75 * math.sqrt(keep.sum() / max(1, want)) if spaced else 0.0
    while True:
        picked, names, countries = [], set(), set()
        for c, x, y in sites:
            country = fold(c[4])
            if by_country and (not country or country in countries):
                continue
            name = latin1_name(c[4] if by_country else c[1])
            if not name or name.lower() in names:
                continue
            if any((x - px) ** 2 + (y - py) ** 2 < spacing * spacing for _, px, py, _, _ in picked):
                continue
            flag = c[5] if len(c) > 5 and c[5] is not None else (flags.get(country, "") if flags else "")
            picked.append((name, x, y, flag, c))
            names.add(name.lower())
            countries.add(country)
            if len(picked) == want:
                break
        if len(picked) >= want or spacing < 2.0:
            break
        spacing *= 0.85
    log(f"nations: {len(picked)} from {len(sites)} sites on the map" + (f", spacing {spacing:.0f} px" if spaced else ""))
    return [{"coordinates": [x, y], "name": name, "flag": flag} for name, x, y, flag, _ in picked]


# ---------------------------------------------------------------- info.json

def map_id(name):
    words = re.findall(r"[A-Za-z0-9]+", fold(name))
    ident = "".join(w[:1].upper() + w[1:] for w in words)
    if not ident or not ident[0].isalpha():
        ident = "Map" + ident
    return ident


def guess_categories(frame):
    if frame.wrap:
        return ["world"]
    lon = ((frame.lon_min + frame.lon_max) / 2.0 + 180.0) % 360.0 - 180.0
    lat = (frame.lat_min + frame.lat_max) / 2.0
    boxes = [("antarctica", -180, -90, 180, -60), ("europe", -25, 35, 45, 72), ("africa", -20, -36, 52, 35),
             ("south_america", -92, -57, -30, 13), ("north_america", -170, 7, -50, 85),
             ("oceania", 110, -50, 180, 0), ("oceania", -180, -50, -120, 0), ("asia", 25, -11, 180, 82)]
    for cat, w, s, e, n in boxes:
        if w <= lon <= e and s <= lat <= n:
            return [cat]
    return ["continental"]


def info_json(args, folder, frame, nations):
    ident = map_id(args.id or args.name)
    cats = [c.strip() for c in args.categories.split(",") if c.strip()] if args.categories else guess_categories(frame)
    bad = [c for c in cats if c not in CATEGORIES]
    if bad:
        sys.exit(f"--categories: not OpenFront categories: {', '.join(bad)} (allowed: {', '.join(CATEGORIES)})")
    return {"id": ident, "name": args.name, "translation_key": f"map.{ident.lower()}", "categories": cats,
            "multiplayer_frequency": args.frequency, "nations": nations}


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="folder for image.png + info.json (an OpenFront map-generator/assets/maps/<folder>)")
    ap.add_argument("--name", required=True, help="the map's name (OpenFront's wire name: never change it once the map ships)")
    ap.add_argument("--id", help="UpperCamelCase id; lowercased it is the folder name (default: from --name)")
    ap.add_argument("--bounds", type=float, nargs=4, metavar=("W", "S", "E", "N"), required=True, help="lon/lat box (W > E crosses 180)")
    size = ap.add_mutually_exclusive_group()
    size.add_argument("--pixels", type=float, default=TARGET_PIXELS, help="target tile count (default 2.5 M)")
    size.add_argument("--width", type=int, help="pixel width")
    size.add_argument("--height", type=int, help="pixel height")
    size.add_argument("--ppd", type=float, help="rows per degree of latitude")
    ap.add_argument("--aspect", choices=("auto", "true", "plate"), default="auto",
                    help="true: columns cos(mid-latitude) as wide, shapes true at the middle; plate: square degrees; auto: plate only for the whole globe")
    for layer in ("elev", "coast", "koppen"):
        ap.add_argument(f"--{layer}-source", choices=("auto", "base", "fine"), default="auto")
    ap.add_argument("--plains-top", type=float, default=PLAINS_TOP, help="metres; plains below (default fitted to OpenFront's World map)")
    ap.add_argument("--highland-top", type=float, default=HIGHLAND_TOP, help="metres; highland below, mountain above")
    ap.add_argument("--mountain-top", type=float, default=MOUNTAIN_TOP, help="metres; magnitude 30 from here")
    ap.add_argument("--mix", help="PLAINS,HIGHLAND percent of the land: anchors from the frame's own heights instead")
    ap.add_argument("--desert", type=int, nargs="?", const=DESERT_MAG, choices=range(10, 20), metavar="MAG",
                    help=f"Koppen desert (BW) as mid-rough terrain, as some of OpenFront's desert maps draw it: at least "
                         f"magnitude MAG (default {DESERT_MAG}) from 50 m up; off unless given")
    ap.add_argument("--rivers", type=int, default=0, choices=(0, 1, 2, 3),
                    help="cut channels of this class and up into the land as water (1 minor, 2 >= 100 m3/s, 3 >= 1000; 0 off)")
    ap.add_argument("--island-expand", type=float, default=0.0, help="the small-island expander (export_world_pack.py), 0..1")
    ap.add_argument("--island-min-deg", type=float, default=0.15)
    ap.add_argument("--island-min-area", type=float, default=0.3)
    ap.add_argument("--island-isolation", type=float, default=0.0)
    ap.add_argument("--island-regions", default="")
    ap.add_argument("--island-merge", action="store_true")
    ap.add_argument("--nations", type=int, help="how many nations (default: one per ~60,000 land tiles, 4..60; OpenFront's maps run 40-80,000)")
    ap.add_argument("--nation-names", choices=("city", "country"), default="city",
                    help="city: sites named after the place; country: one site per country, named after it")
    ap.add_argument("--nations-file", help="CSV/JSON of name, lat, lon[, flag] to use instead of the gazetteer")
    ap.add_argument("--gazetteer", default=os.path.join(wp.DATA, "seats", "historic_*.csv"))
    ap.add_argument("--openfront", help="an OpenFront checkout: flags from its resources/countries.json")
    ap.add_argument("--categories", help=f"comma-separated (default: guessed from the frame); one of {', '.join(CATEGORIES)}")
    ap.add_argument("--frequency", type=int, default=1, help="multiplayer_frequency (OpenFront's tests want > 0)")
    ap.add_argument("--compiled", help="also write the runtime files (map.bin, map4x.bin, map16x.bin, manifest.json, thumbnail.webp) here")
    ap.add_argument("--preview", help="PNG of the compiled map in the game's colours")
    args = ap.parse_args()
    if args.island_regions and not os.path.exists(args.island_regions) and "," not in args.island_regions:
        sys.exit("--island-regions: neither a file nor W,S,E,N boxes")

    t0 = time.time()
    frame, width, kx = frame_for(args)
    grid = Grid(frame, width)
    print(f"frame {frame.w}x{frame.h} at {frame.ppd:.4f} rows/deg -> {grid.w}x{grid.h} ({grid.w * grid.h / 1e6:.2f} M tiles, "
          f"x squeeze {kx:.3f}): lon {frame.lon_min:.4f}..{frame.lon_max:.4f}, lat {frame.lat_min:.4f}..{frame.lat_max:.4f}")
    fine = {k: (v == "fine" or (v == "auto" and frame.ppd > wp.BASE_PPD + wp.EPS))
            for k, v in (("elev", args.elev_source), ("coast", args.coast_source), ("koppen", args.koppen_source))}

    code, elev_src = wp.build_elevation(frame, os.path.join(wp.DATA, "elev_4096.png"), fine["elev"])
    elev = squeeze_x(wp.SEA + code * np.float32((wp.PEAK - wp.SEA) / 65535.0), grid.w)
    del code
    mask, land_src = wp.build_landmask(frame, fine["coast"], args.island_expand, args.island_min_deg, args.island_min_area,
                                       args.island_isolation, wp.parse_regions(args.island_regions), args.island_merge)
    land = squeeze_x(mask, grid.w) >= 127.5
    del mask
    print(f"elevation from {elev_src}\nland from {land_src}: {100.0 * land.mean():.1f}% land")
    if args.rivers:
        shapes = [(g, 1) for g, c in wp.river_shapes(frame) if c >= args.rivers]
        cut = grid.burn(shapes, all_touched=True).astype(bool) & land
        land &= ~cut
        print(f"rivers: {len(shapes)} reaches of class >= {args.rivers} cut {cut.sum()} land tiles to water")

    if args.mix:
        pl, hl = (float(v) for v in args.mix.split(","))
        if pl < 0 or hl < 0 or pl + hl > 100:
            sys.exit("--mix: PLAINS,HIGHLAND percentages summing to at most 100")
        anchors = anchors_for_mix(elev[land], pl, hl)
    else:
        anchors = (args.plains_top, args.highland_top, args.mountain_top)
    if not anchors[0] < anchors[1] < anchors[2]:
        sys.exit("the anchors must rise: plains top < highland top < mountain top")
    mag = magnitude(elev, anchors)
    n_land = int(land.sum())
    if not n_land:
        sys.exit("no land in the frame")
    if args.desert is not None:
        kop, kop_src = wp.build_koppen(frame, os.path.join(wp.DATA, "koppen_2048.png"), fine["koppen"])
        if kop.shape != (frame.h, frame.w):    # the base raster at its own resolution, the frame a whole multiple of it
            k = frame.h // kop.shape[0]
            kop = np.repeat(np.repeat(kop, k, axis=0), k, axis=1)
        desert = land & (squeeze_x(np.isin(kop, DESERT).astype(np.float32), grid.w) >= 0.5)
        del kop
        valley = desert & river_valleys(grid, elev)
        floor = desert_floor(elev, args.desert)
        lifted = desert & ~valley & (floor > mag)
        mag = np.where(lifted, floor, mag).astype(np.uint8)
        print(f"desert (Koppen BW from {kop_src}): {100.0 * desert.sum() / n_land:.1f}% of the land, "
              f"{100.0 * lifted.sum() / n_land:.1f}% lifted toward magnitude {args.desert}, "
              f"{100.0 * valley.sum() / n_land:.1f}% kept as river valley floor")
    lm = mag[land]
    print(f"terrain (anchors {anchors[0]:.0f} / {anchors[1]:.0f} / {anchors[2]:.0f} m): plains {100 * (lm < 10).mean():.1f}%, "
          f"highland {100 * ((lm >= 10) & (lm < 20)).mean():.1f}%, mountain {100 * (lm >= 20).mean():.1f}%")

    flags = flag_lookup(args.openfront)
    cands = read_nations_file(args.nations_file) if args.nations_file else read_gazetteer(args.gazetteer)
    if args.nations is not None:
        want = args.nations
    else:
        want = len(cands) if args.nations_file else max(4, min(60, int(round(n_land / 60000.0))))
    nations = pick_nations(grid, land, want, cands, args.nation_names == "country" and not args.nations_file, flags, print,
                           spaced=not args.nations_file)
    if len(nations) < want:
        print(f"  ({want} wanted, {len(nations)} placed: " + ("the rest are off the map, unnamed or far from land)" if args.nations_file else
              "the gazetteer runs out under this frame; --nations-file adds your own)"))
    codes = set(flags.values()) if flags else None
    for nat in nations:
        if codes is not None and nat["flag"] and not nat["flag"].startswith("!") and nat["flag"] not in codes:
            print(f"  warning: {nat['name']}: no flag {nat['flag']!r} in {args.openfront}/resources/flags")
    if flags is None and not args.nations_file:
        print("  (no --openfront checkout: nation flags left empty)")

    os.makedirs(args.out, exist_ok=True)
    folder = os.path.basename(os.path.normpath(args.out))
    info = info_json(args, folder, frame, nations)
    if info["id"].lower() != folder.lower():
        print(f"  note: OpenFront wants the folder named {info['id'].lower()!r} (lowercased id); this one is {folder!r}")
    write_image(os.path.join(args.out, "image.png"), land, mag)
    with open(os.path.join(args.out, "info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote image.png + info.json to {args.out}")

    if args.compiled or args.preview:
        import openfront_compile as ofc
        compiled = ofc.compile_map(ofc.load_image(os.path.join(args.out, "image.png")))
        sz, st = compiled.sizes, compiled.stats["map"]
        print(f"compiled: {sz['map']['num_land_tiles']} land tiles ({sz['map4x']['num_land_tiles']} at 4x, "
              f"{sz['map16x']['num_land_tiles']} at 16x); the generator drops {st['islands_removed']} islets "
              f"({st['island_tiles']} tiles) and fills {st['lakes_filled']} small lakes ({st['lake_tiles']} tiles)")
        if args.compiled:
            ofc.write_resources(args.compiled, info, compiled)
            print(f"wrote the runtime files to {args.compiled}")
        if args.preview:
            ofc.render_preview(compiled.bins["map"], compiled.width, compiled.height).save(args.preview)
            print(f"wrote {args.preview}")

    credits = ["Elevation: ETOPO 2022 (NOAA NCEI), public domain"]
    credits.append("Coastline: OpenStreetMap land polygons, (c) OpenStreetMap contributors, ODbL 1.0"
                   if "OpenStreetMap" in land_src else "Coastline: Natural Earth, public domain")
    credits.append("Lakes: HydroLAKES v1.0, Messager et al. 2016, CC BY 4.0"
                   if "HydroLAKES" in land_src else "Lakes: Natural Earth, public domain")
    if args.rivers:
        credits.append("Rivers: HydroRIVERS v1.0, Lehner & Grill 2013, CC BY 4.0")
    print("credits (for OpenFront's CREDITS.md):\n  " + "\n  ".join(credits))
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
