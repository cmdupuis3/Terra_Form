"""Choose city sites for a Culture Wars world pack by cultural relevance across history, with regional balance.

    python games/culture_wars/select_city_seats.py --pack "<Unity>/Assets/StreamingAssets/WorldPacks/earth8k" \
        --geonames data/seats/cities5000.txt --curated data/seats --target 10000 --out seats.yaml

Inputs:
  --pack       a world pack folder (manifest.json, landmask/elevation/koppen/rivers PNGs); reduced to the
               game's sim grid (pack / --factor, majority land, as ConductivityBuilder.Downsample does)
  --geonames   GeoNames cities5000.txt (towns with population >= 5000; CC BY 4.0, download.geonames.org;
               not kept in the repo, fetch it from https://download.geonames.org/export/dump/cities5000.zip)
  --curated    a folder of historic_*.csv gazetteers (name,lat,lon,country,eras,significance,kind,confidence)
Output: seats.yaml (culturewars-seats/1: id, lat, lon, city_map, name) and seats_report.txt beside it.

Method: every candidate gets a score = max(modern, historic) + 0.3*min(...) where modern comes from
population and administrative rank and historic from the curated significance and the number of eras
the place mattered in. Candidates fall into ~45 regions, each with a quota (a share of the target that
reflects how dense historical urbanism was there: Europe, South Asia, China and Japan dense; the Sahara,
Siberia, the Amazon and the Australian interior sparse; the Pacific islands guaranteed). Seats are placed
greedily from the best score down with a minimum spacing that is the region's (bisected to meet its quota)
times a climate factor (deserts and tundra wider, rainforest a little wider, major rivers and coasts
tighter) times a score factor (great cities tolerate close neighbours). National capitals and the
world-historical sites go first with only the hard floor, and every island of a few cells gets a seat if
anything is on it. The towns are clumpy, so dense regions saturate at the floor (random packing with a
five-cell floor is ~45 cells a seat); what the named sites cannot fill is topped up with unnamed minor
sites on each region's best habitable land, within the same spacing. Every seat is written at the centre
of a sim land cell within three cells of the place, as the game itself snaps it (SimDriver.SnapToLand).
"""
import argparse, csv, glob, json, math, os, sys, time, unicodedata
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
Image.MAX_IMAGE_PIXELS = None

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--pack", required=True)
ap.add_argument("--geonames", required=True)
ap.add_argument("--curated", required=True, help="folder with historic_*.csv")
ap.add_argument("--target", type=int, default=10000)
ap.add_argument("--factor", type=int, default=2, help="pack grid / sim grid")
ap.add_argument("--out", default=None, help="output yaml (default <pack>/seats.yaml)")
ap.add_argument("--seed", type=int, default=7)
args = ap.parse_args()
TARGET = args.target
# Spacing is tuned in kilometres (the user judged the look at ~40 km between seats) and converted to cells
# once the grid is known; the game's own rules are in cells (5x5 reticules, MinCells 25, snap radius 3).
FLOOR_KM = 34.0    # grid Chebyshev distance between any two seats (Kyoto, Nara and Osaka all fit; Utrecht still folds under Amsterdam)
TERRITORY_KM2 = 2900.0   # every seat keeps this much land nearer to it than to any other (or its whole islet)
CAP_KM = 690.0     # widest regional spacing
SNAP = 3           # the game's own snap radius, in sim cells

# ----------------------------------------------------------------------------- grid
t0 = time.time()
man = json.load(open(os.path.join(args.pack, "manifest.json"), encoding="utf-8"))
f = args.factor
def rd(a, how):
    h, w = a.shape[0] // f, a.shape[1] // f
    b = a[:h*f, :w*f].reshape(h, f, w, f)
    if how == "mean": return b.mean(axis=(1, 3))
    if how == "majority": return (b.mean(axis=(1, 3)) >= 0.5).astype(np.uint8)
    if how == "max": return b.max(axis=(1, 3))
    if how == "center": return a[f//2::f, f//2::f][:h, :w]
L = man["layers"]
land = rd((np.array(Image.open(os.path.join(args.pack, L["landMask"]["file"])).convert("L")) > 127).astype(np.uint8), "majority")
e = np.array(Image.open(os.path.join(args.pack, L["elevation"]["file"])).convert("RGB"))
e16 = e[:, :, 0].astype(np.float32) * 256 + e[:, :, 1].astype(np.float32)
meters = rd(L["elevation"]["minMeters"] + e16 / 65535.0 * (L["elevation"]["maxMeters"] - L["elevation"]["minMeters"]), "mean").astype(np.float32)
del e, e16
kop_full = np.array(Image.open(os.path.join(args.pack, L["koppen"]["file"])).convert("L"))
if kop_full.shape == land.shape: kop = kop_full
elif kop_full.shape[0] == land.shape[0] * f: kop = rd(kop_full, "center")
else:   # a coarser climate layer: nearest
    ky = (np.arange(land.shape[0]) * kop_full.shape[0] / land.shape[0]).astype(int)
    kx = (np.arange(land.shape[1]) * kop_full.shape[1] / land.shape[1]).astype(int)
    kop = kop_full[ky][:, kx]
kop = kop.astype(np.uint8)
riv_file = L.get("rivers", {}).get("file")
river = rd(np.array(Image.open(os.path.join(args.pack, riv_file)).convert("L")), "max").astype(np.uint8) if riv_file else np.zeros_like(land)
near_river = ndimage.binary_dilation(river >= 2, structure=np.ones((3, 3))).astype(np.uint8)
water = land == 0
coast = (land.astype(bool) & (np.roll(water, 1, 1) | np.roll(water, -1, 1) | np.roll(water, 1, 0) | np.roll(water, -1, 0))).astype(np.uint8)
# Islands: 8-connected land components, stitched across the seam.
island, ncomp = ndimage.label(land, structure=np.ones((3, 3)))
left, right = island[:, 0], island[:, -1]
parent = np.arange(ncomp + 1)
def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]; a = parent[a]
    return a
for a, b in set(zip(left[(left > 0) & (right > 0)].tolist(), right[(left > 0) & (right > 0)].tolist())):
    ra, rb = find(a), find(b)
    if ra != rb: parent[max(ra, rb)] = min(ra, rb)
for i in range(1, ncomp + 1): parent[i] = find(i)
island = parent[island].astype(np.int32)
island_size = np.bincount(island.ravel(), minlength=ncomp + 1).astype(np.int32); island_size[0] = 0
b = man["bounds"]; lonMin, lonMax, latMin, latMax = b["lonMin"], b["lonMax"], b["latMin"], b["latMax"]
H, W = land.shape
CELL_KM = 40075.0 / W                      # a cell's width at the equator (its height everywhere)
FLOOR = float(round(FLOOR_KM / CELL_KM))
TERRITORY = int(round(TERRITORY_KM2 / (CELL_KM * CELL_KM)))
TWIN = int(round(2.75 * FLOOR))
CAP = CAP_KM / CELL_KM
print(f"sim grid {W}x{H} ({CELL_KM:.2f} km cells): floor {FLOOR:g} cells, territory {TERRITORY} cells, cap {CAP:.0f}; "
      f"land {int(land.sum())} cells, {int((island_size > 0).sum())} islands, in {time.time() - t0:.1f}s")

def cell_of(lat, lon):
    """Sim column and image row (row 0 = north) of a lon/lat, as the game computes them."""
    x = int((lon - lonMin) / (lonMax - lonMin) * W) % W
    ys = int((lat - latMin) / (latMax - latMin) * H)      # sim y, 0 = south
    ys = min(max(ys, 0), H - 1)
    return x, H - 1 - ys

def latlon_of(x, row):
    ys = H - 1 - row
    return latMin + (ys + 0.5) * (latMax - latMin) / H, lonMin + (x + 0.5) * (lonMax - lonMin) / W

def snap(x, row):
    """The land cell the game would put this on (SimDriver.SnapToLand: rings 1..3, first land hit), or None."""
    if land[row, x]: return x, row
    for r in range(1, SNAP + 1):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                nx = (x + dx) % W; ny = row - dy            # sim dy = -r first means south first; row grows north->south
                if 0 <= ny < H and land[ny, nx]: return nx, ny
    return None

def coslat(row):
    lat, _ = latlon_of(0, row)
    return max(0.15, math.cos(math.radians(lat)))

# ----------------------------------------------------------------------------- climate factor
# Beck 2023 class index -> spacing multiplier.
CLIM = {1: 1.35, 2: 1.15, 3: 1.0, 4: 2.3, 5: 1.9, 6: 1.3, 7: 1.25, 8: 0.9, 9: 0.9, 10: 1.1,
        11: 0.95, 12: 0.95, 13: 1.1, 14: 0.85, 15: 0.85, 16: 1.1, 17: 1.2, 18: 1.2, 19: 1.5, 20: 1.9,
        21: 1.05, 22: 1.2, 23: 1.6, 24: 1.9, 25: 1.0, 26: 1.05, 27: 1.6, 28: 1.9, 29: 2.0, 30: 3.0}

def climate_factor(x, row):
    f = CLIM.get(int(kop[row, x]), 1.0)
    m = float(meters[row, x])
    if m > 4000: f *= 1.6
    elif m > 2500: f *= 1.25
    if near_river[row, x]: f *= 0.6
    if coast[row, x]: f *= 0.85
    return min(max(f, 0.5), 3.0)

# ----------------------------------------------------------------------------- regions
# quota weights: shares of the target. Chosen for the density of historical urbanism, with the user's
# asks: Low Countries dense, Sahara sparse, Pacific islands well covered, Africa and the Amazon not packed.
QUOTA = {
    "EUR_WEST": 520, "EUR_BRIT": 200, "EUR_IBERIA": 250, "EUR_ITALY": 260, "EUR_NORDIC": 200,
    "EUR_CENTRAL": 230, "EUR_BALKAN": 270, "EUR_EAST": 330,
    "ANATOLIA": 200, "LEVANT_MESO": 240, "ARABIA": 160, "IRAN_AFG": 230, "CAUCASUS": 65, "C_ASIA": 190,
    "EGYPT_NILE": 130, "MAGHREB": 210, "SAHARA": 100,
    "W_AFRICA": 330, "C_AFRICA": 140, "E_AFRICA": 210, "S_AFRICA": 160, "MADAGASCAR": 50,
    "S_ASIA": 900, "SE_ASIA_MAIN": 360, "SE_ASIA_ISL": 330, "BORNEO": 45, "SUMATRA": 80,
    "CHINA": 750, "INNER_ASIA": 140, "KOREA": 110, "JAPAN": 260, "SIBERIA": 180,
    "N_AMERICA": 680, "MESOAMERICA": 300, "CARIBBEAN": 100, "ANDES": 280, "N_SAMERICA": 65,
    "AMAZON": 90, "BRAZIL": 210, "S_CONE": 230,
    "AUSTRALIA": 190, "NEW_ZEALAND": 55, "NEW_GUINEA": 70, "MELANESIA": 50, "MICRONESIA": 35, "POLYNESIA": 85,
}
qs = sum(QUOTA.values())
QUOTA = {k: v * TARGET / qs for k, v in QUOTA.items()}

CC_REGION = {}
def _r(region, *ccs):
    for c in ccs: CC_REGION[c] = region
_r("EUR_WEST", "FR", "BE", "NL", "LU", "DE", "CH", "AT", "LI", "MC")
_r("EUR_BRIT", "GB", "IE", "IM", "JE", "GG")
_r("EUR_IBERIA", "ES", "PT", "AD", "GI")
_r("EUR_ITALY", "IT", "MT", "SM", "VA")
_r("EUR_NORDIC", "NO", "SE", "FI", "DK", "IS", "EE", "LV", "LT", "FO", "AX", "SJ")
_r("EUR_CENTRAL", "PL", "CZ", "SK", "HU", "SI")
_r("EUR_BALKAN", "HR", "BA", "RS", "ME", "MK", "XK", "AL", "GR", "BG", "RO", "MD")
_r("EUR_EAST", "UA", "BY", "RU")
_r("ANATOLIA", "TR")
_r("LEVANT_MESO", "SY", "LB", "IL", "PS", "JO", "IQ", "KW", "CY")
_r("ARABIA", "SA", "YE", "OM", "AE", "QA", "BH")
_r("IRAN_AFG", "IR", "AF")
_r("CAUCASUS", "GE", "AM", "AZ")
_r("C_ASIA", "KZ", "UZ", "TM", "KG", "TJ")
_r("EGYPT_NILE", "EG")
_r("MAGHREB", "MA", "DZ", "TN", "LY", "EH")
_r("W_AFRICA", "MR", "SN", "GM", "GW", "GN", "SL", "LR", "CI", "GH", "TG", "BJ", "BF", "ML", "NE", "NG", "TD", "CM", "CV")
_r("C_AFRICA", "CF", "CG", "CD", "GA", "GQ", "ST", "AO", "ZM")
_r("E_AFRICA", "SD", "SS", "ET", "ER", "DJ", "SO", "KE", "UG", "TZ", "RW", "BI")
_r("S_AFRICA", "MZ", "ZW", "MW", "BW", "NA", "ZA", "LS", "SZ", "SH")
_r("MADAGASCAR", "MG", "KM", "MU", "RE", "SC", "YT", "IO", "TF")
_r("S_ASIA", "IN", "PK", "BD", "NP", "BT", "LK", "MV")
_r("SE_ASIA_MAIN", "MM", "TH", "LA", "KH", "VN")
_r("SE_ASIA_ISL", "MY", "SG", "BN", "ID", "TL", "PH", "CX", "CC")
_r("CHINA", "CN", "TW", "HK", "MO")
_r("INNER_ASIA", "MN")
_r("KOREA", "KR", "KP")
_r("JAPAN", "JP")
_r("N_AMERICA", "US", "CA", "GL", "BM", "PM")
_r("MESOAMERICA", "MX", "GT", "BZ", "HN", "SV", "NI", "CR", "PA")
_r("CARIBBEAN", "CU", "HT", "DO", "JM", "PR", "BS", "TC", "KY", "VI", "VG", "AI", "AG", "KN", "MS", "GP", "DM", "MQ", "LC", "VC", "BB", "GD", "TT", "AW", "CW", "SX", "BQ", "BL", "MF")
_r("ANDES", "CO", "EC", "PE", "BO")
_r("N_SAMERICA", "VE", "GY", "SR", "GF")
_r("BRAZIL", "BR")
_r("S_CONE", "AR", "CL", "UY", "PY", "FK", "GS")
_r("AUSTRALIA", "AU", "NF", "HM")
_r("NEW_ZEALAND", "NZ")
_r("NEW_GUINEA", "PG")
_r("MELANESIA", "SB", "VU", "NC", "FJ")
_r("MICRONESIA", "PW", "GU", "MP", "FM", "MH", "NR", "KI")
_r("POLYNESIA", "TO", "WS", "AS", "TV", "TK", "CK", "NU", "PF", "PN", "WF", "UM")

def region_of(cc, lat, lon, x, row):
    r = CC_REGION.get(cc)
    # Splits of big countries and of the desert.
    if cc == "RU": r = "SIBERIA" if lon > 60 else "EUR_EAST"
    elif cc == "US":
        if lat < 30 and lon < -150: r = "POLYNESIA"            # Hawaii
        elif lon < -130 and lat > 50: r = "N_AMERICA"          # Alaska
    elif cc == "CN":
        if (lon < 97 and lat > 27) or (lon < 104 and lat > 36 and lon < 108 and lat > 40) or (lon < 92): r = "INNER_ASIA"   # Tibet, Qinghai, Xinjiang
        elif lat > 41 and lon < 122 and lon > 97: r = "INNER_ASIA"    # Inner Mongolia
    elif cc == "ID" and lon > 130: r = "NEW_GUINEA"
    elif cc in ("ID", "MY", "BN") and 108.5 < lon < 119.5 and -4.5 < lat < 7.5: r = "BORNEO"
    elif cc == "ID" and 95 < lon < 106.2 and -6.2 < lat < 6: r = "SUMATRA"
    elif cc == "BR":
        if lat > -12 and lon < -46 and not (lat > -2.5 and lon > -50): r = "AMAZON"   # interior north, Belém and the coast stay BRAZIL
    elif cc in ("PE", "CO", "BO", "EC") and lon > -70 and lat < 2 and lat > -17 and float(meters[row, x]) < 500: r = "AMAZON"
    elif cc == "KI" and lon < 0: r = "POLYNESIA"               # Line and Phoenix islands
    elif cc == "SD" and lat < 16: r = "E_AFRICA"
    elif cc == "SD": r = "EGYPT_NILE"
    elif cc == "EC" and lon < -85: r = "ANDES"                 # Galápagos
    elif cc == "CL" and lon < -100: r = "POLYNESIA"            # Rapa Nui
    elif cc == "NO" and lat > 74: r = "EUR_NORDIC"
    elif cc == "PT" and lon < -20: r = "EUR_IBERIA"
    elif cc == "AU" and lat > -12 and lon > 160: r = "MELANESIA"
    if r is None:
        # Fall back on a coarse geography.
        if lat > 35 and -25 < lon < 60: r = "EUR_EAST" if lon > 30 else "EUR_WEST"
        elif lon < -30: r = "N_AMERICA" if lat > 15 else "BRAZIL"
        elif lon > 100 and lat < 0: r = "POLYNESIA" if lon > 160 or lon < -100 else "SE_ASIA_ISL"
        elif 60 < lon < 100 and lat < 35: r = "S_ASIA"
        elif lon >= 100: r = "CHINA"
        else: r = "W_AFRICA" if lat < 20 else "LEVANT_MESO"
    # The Sahara proper: hot desert between the Sahel and the Mediterranean, off the Nile and the coast.
    if 15.5 < lat < 31.5 and -17 < lon < 37 and int(kop[row, x]) in (4, 5) and not near_river[row, x] and not coast[row, x] \
            and r in ("MAGHREB", "EGYPT_NILE", "W_AFRICA", "E_AFRICA"):
        # Egypt's Delta/Nile is caught by near_river; the Red Sea coast by coast; the oases remain.
        r = "SAHARA"
    return r

# ----------------------------------------------------------------------------- candidates
def ascii(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii").strip() or s

ADMIN = {"PPLC": 0.5, "PPLA": 0.22, "PPLG": 0.2, "PPLCH": 0.3, "PPLA2": 0.08}
cands = []   # dicts
t0 = time.time()
gn_xy = []
with open(args.geonames, encoding="utf-8") as fh:
    for line in fh:
        f = line.rstrip("\n").split("\t")
        code = f[7]
        if code in ("PPLX", "PPLL", "PPLQ", "PPLW", "STLMT"): continue
        lat, lon, pop = float(f[4]), float(f[5]), int(f[14] or 0)
        if not (latMin <= lat <= latMax): continue
        m = min(1.0, max(0.0, (math.log10(max(pop, 1)) - 3.6) / 3.4)) + ADMIN.get(code, 0.0)
        cands.append({"name": f[2] or ascii(f[1]), "lat": lat, "lon": lon, "cc": f[8], "pop": pop, "code": code,
                      "modern": m, "hist": 0.0, "sig": 0, "eras": 0, "src": "gn", "must": code == "PPLC", "kind": "city"})
print(f"GeoNames: {len(cands)} towns in {time.time()-t0:.1f}s")

# A grid over GeoNames for matching curated rows (0.5 degree bins).
bins = {}
for i, c in enumerate(cands):
    bins.setdefault((int(c["lat"] // 0.5), int(c["lon"] // 0.5)), []).append(i)
def nearby(lat, lon, deg):
    out = []
    for by in range(int((lat - deg) // 0.5), int((lat + deg) // 0.5) + 1):
        for bx in range(int((lon - deg) // 0.5), int((lon + deg) // 0.5) + 1):
            out.extend(bins.get((by, bx), ()))
    return out
def km(lat1, lon1, lat2, lon2):
    dlon = abs(lon1 - lon2); dlon = min(dlon, 360 - dlon)
    return 111.0 * math.hypot(lat1 - lat2, dlon * math.cos(math.radians((lat1 + lat2) / 2)))

curated_files = sorted(glob.glob(os.path.join(args.curated, "historic_*.csv")))
ncur = 0; merged = 0; bad = 0
for path in curated_files:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                lat, lon = float(row["lat"]), float(row["lon"]); sig = int(float(row["significance"]))
            except (ValueError, KeyError, TypeError):
                bad += 1; continue
            if not (latMin <= lat <= latMax) or not (-180 <= lon <= 180): bad += 1; continue
            eras = len([e for e in (row.get("eras") or "").replace(",", ";").split(";") if e.strip()])
            h = (sig / 5.0) * (0.75 + 0.1 * max(1, eras))
            conf = (row.get("confidence") or "high").strip().lower()
            kind = (row.get("kind") or "city").strip().lower()
            ncur += 1
            # Same place as a GeoNames town? Within 12 km (or 25 km when the coordinates are rough).
            best = None; bestd = 12.0 if conf == "high" else 25.0
            nm = ascii(row["name"]).lower()
            for i in nearby(lat, lon, 0.3):
                c = cands[i]
                if c["src"] != "gn": continue
                d = km(lat, lon, c["lat"], c["lon"])
                if ascii(c["name"]).lower() == nm: d *= 0.5
                if d < bestd: best, bestd = i, d
            if best is not None:
                c = cands[best]
                if h > c["hist"]:
                    c["hist"] = h; c["sig"] = sig; c["eras"] = eras
                    # A great historic site outranking the modern town on its ground keeps its own name
                    # (Babylon over Al Hillah, Nineveh over Mosul's east bank).
                    if h >= 0.75 and h > c["modern"]: c["name"] = ascii(row["name"])
                c["must"] = c["must"] or sig == 5 or (sig == 4 and eras >= 3)
                merged += 1
            else:
                cands.append({"name": ascii(row["name"]), "lat": lat, "lon": lon, "cc": None, "pop": 0, "code": "HIST",
                              "modern": 0.0, "hist": h, "sig": sig, "eras": eras, "src": "cur",
                              "must": sig == 5 or (sig == 4 and eras >= 3), "kind": kind})
print(f"curated: {ncur} rows from {len(curated_files)} files, {merged} merged into GeoNames towns, {bad} unreadable; {len(cands)} candidates")

# Country of a curated site: its nearest GeoNames town within 200 km (region rules want a country code).
for c in cands:
    if c["cc"] is None:
        best = None; bestd = 200.0
        for i in nearby(c["lat"], c["lon"], 2.0):
            g = cands[i]
            if g["src"] != "gn": continue
            d = km(c["lat"], c["lon"], g["lat"], g["lon"])
            if d < bestd: best, bestd = i, d
        c["cc"] = cands[best]["cc"] if best is not None else "??"

# Score, cell, region.
dropped_offland = []
for c in cands:
    a, b = c["modern"], c["hist"]
    c["score"] = max(a, b) + 0.3 * min(a, b)
    x, row = cell_of(c["lat"], c["lon"])
    s = snap(x, row)
    if s is None:
        c["cell"] = None; dropped_offland.append(c); continue
    c["cell"] = s
    c["score"] += 0.03 * float(coast[s[1], s[0]])
    c["region"] = region_of(c["cc"], c["lat"], c["lon"], s[0], s[1])
    c["clim"] = climate_factor(s[0], s[1])
    c["island"] = int(island[s[1], s[0]])
cands = [c for c in cands if c["cell"] is not None]
cands.sort(key=lambda c: -c["score"])
print(f"{len(dropped_offland)} candidates have no land within {SNAP} cells (atolls, mask gaps) and are dropped")

# ----------------------------------------------------------------------------- placement
def score_factor(s):
    if s >= 1.0: return 0.7
    if s <= 0.2: return 1.15
    return 1.15 - 0.45 * (s - 0.2) / 0.8

class Hash:
    """Seats placed so far, in bins of BIN cells (unscaled grid), for two tests: the floor is a grid
    Chebyshev distance (reticules are grid squares), the regional spacing a cos(lat)-scaled Euclidean one."""
    BIN = 24
    def __init__(self):
        self.g = {}; self.max_sp = FLOOR
    def key(self, x, row):
        return (x // self.BIN, row // self.BIN)
    def territory_ok(self, x, row):
        """With a seat here, do it and every seat within reach keep TERRITORY land cells of their own
        (nearest by grid Chebyshev distance, ties to nobody)? Counted in a window: an undercount, so a
        seat on a wide coast passes easily and only a hemmed-in one is refused."""
        x0, y0 = x - TWIN, row - TWIN
        ys = np.arange(max(0, y0), min(H, row + TWIN + 1))
        xs_ = (np.arange(x0, x + TWIN + 1)) % W
        win = land[ys][:, xs_].astype(bool)
        seats = [(x, row)]
        kx, ky = self.key(x, row)
        r = (2 * TWIN) // self.BIN + 1
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                for (sx, sy, _) in self.g.get(((kx + dx) % ((W + self.BIN - 1) // self.BIN), ky + dy), ()):
                    ddx = abs(sx - x); ddx = min(ddx, W - ddx)
                    if ddx <= 2 * TWIN and abs(sy - row) <= 2 * TWIN: seats.append((sx, sy))
        gy, gx = np.meshgrid(ys, np.arange(x0, x + TWIN + 1), indexing="ij")
        best = np.full(win.shape, 10 ** 6, np.int32); owner = np.full(win.shape, -1, np.int32)
        for i, (sx, sy) in enumerate(seats):
            ddx = np.abs(gx - sx); ddx = np.minimum(ddx, W - ddx)
            d = np.maximum(ddx, np.abs(gy - sy))
            owner = np.where(d < best, i, np.where(d == best, -1, owner)); best = np.minimum(best, d)
        owner = np.where(win, owner, -1)
        counts = np.bincount(owner[owner >= 0], minlength=len(seats))
        # A small island asks only for itself (the game keeps sites on islets; a province there is the
        # mainland's business).
        def need(sx, sy): return min(TERRITORY, int(island_size[island[sy, sx]]))
        if counts[0] < need(x, row): return False
        for i, (sx, sy) in enumerate(seats[1:], start=1):
            if max(min(abs(sx - x), W - abs(sx - x)), abs(sy - row)) <= 2 * FLOOR and counts[i] < need(sx, sy): return False
        return True
    def ok(self, x, row, spacing):
        cl = coslat(row)
        reach = int(math.ceil(max(self.max_sp, spacing) / (cl * self.BIN))) + 1
        reachy = int(math.ceil(max(self.max_sp, spacing) / self.BIN)) + 1
        kx, ky = self.key(x, row)
        for dy in range(-reachy, reachy + 1):
            for dx in range(-reach, reach + 1):
                for (sx, sy, ss) in self.g.get(((kx + dx) % ((W + self.BIN - 1) // self.BIN), ky + dy), ()):
                    ddx = abs(sx - x); ddx = min(ddx, W - ddx)
                    ddy = abs(sy - row)
                    if max(ddx, ddy) < FLOOR: return False
                    # At the floor only the grid rule applies (provinces are measured in cells); above it
                    # the regional spacing is a true distance, scaled by the latitude.
                    need = max(spacing, ss)
                    if need > FLOOR + 1e-6 and math.hypot(ddx * cl, ddy) < need: return False
        return self.territory_ok(x, row)
    def add(self, x, row, spacing):
        self.g.setdefault(self.key(x, row), []).append((x, row, spacing))
        if spacing > self.max_sp: self.max_sp = spacing

def place(region_spacing):
    h = Hash(); taken = []; by_region = {}
    seen_island = set()
    def accept(c, sp):
        h.add(c["cell"][0], c["cell"][1], sp); taken.append(c)
        by_region[c["region"]] = by_region.get(c["region"], 0) + 1
        seen_island.add(c["island"])
    # 1. must-haves: capitals and the world-historical sites, floor only.
    for c in cands:
        if c["must"] and h.ok(c["cell"][0], c["cell"][1], FLOOR): accept(c, FLOOR)
        else: c["_pending"] = True
    # 2. everything else by score with the regional spacing.
    for c in cands:
        if not c.get("_pending"): continue
        c["_pending"] = False
        sp = min(CAP, max(FLOOR, region_spacing[c["region"]] * c["clim"] * score_factor(c["score"])))
        if h.ok(c["cell"][0], c["cell"][1], sp): accept(c, sp)
    # 3. islands of three cells or more that have a candidate but no seat get their best one.
    for c in cands:
        isl = c["island"]
        if isl in seen_island or island_size[isl] < 3: continue
        if h.ok(c["cell"][0], c["cell"][1], FLOOR): accept(c, FLOOR)
    return taken, by_region

# How far above its quota a region may be filled when the dense regions cannot take their share (they
# saturate at the floor: random packing with a 5-cell Chebyshev floor is ~45 cells a seat). The user's
# asks: the Amazon, the Sahara and Siberia take no surplus, Africa little, the settler Americas and
# eastern Europe more.
SURPLUS = {"N_AMERICA": 1.8, "EUR_EAST": 1.6, "S_CONE": 1.6, "AUSTRALIA": 1.6, "MESOAMERICA": 1.3,
           "CHINA": 1.0, "S_ASIA": 1.0, "SE_ASIA_ISL": 1.0, "SE_ASIA_MAIN": 1.0, "BORNEO": 1.0, "SUMATRA": 1.0,
           "BRAZIL": 1.0, "AMAZON": 1.0, "SAHARA": 1.0, "SIBERIA": 1.15, "N_SAMERICA": 1.3,
           "E_AFRICA": 1.1, "W_AFRICA": 1.0, "S_AFRICA": 1.1, "C_AFRICA": 1.1, "MADAGASCAR": 1.0}
def cap_of(r, m): return QUOTA[r] * (1.0 + (SURPLUS.get(r, 1.3) - 1.0) * m)

def solve(m, rounds=14):
    spacing = {r: 2.5 * FLOOR for r in QUOTA}
    eff = dict(QUOTA)
    for it in range(rounds):
        taken, by_region = place(spacing)
        got = {r: by_region.get(r, 0) for r in QUOTA}
        saturated = {r for r in QUOTA if spacing[r] <= FLOOR + 1e-6 and got[r] < 0.98 * eff[r]}
        eff = dict(QUOTA)
        for r in saturated: eff[r] = got[r]
        for _ in range(8):
            fixed = sum(eff[r] for r in saturated) + sum(eff[r] for r in QUOTA if r not in saturated and eff[r] >= cap_of(r, m) - 1e-6)
            free = [r for r in QUOTA if r not in saturated and eff[r] < cap_of(r, m) - 1e-6]
            if not free: break
            base = sum(QUOTA[r] for r in free)
            for r in free: eff[r] = min(cap_of(r, m), (TARGET - fixed) * QUOTA[r] / base)
        for r in QUOTA:
            if got[r] == 0: spacing[r] = max(FLOOR, spacing[r] * 0.7); continue
            spacing[r] = min(CAP * 1.5, max(FLOOR, spacing[r] * (got[r] / max(1.0, eff[r])) ** 0.5))
    taken, by_region = place(spacing)
    return taken, by_region, spacing, eff

taken, by_region, spacing, eff = solve(1.0)
print(f"  named sites placed: {len(taken)}")

# ----------------------------------------------------------------------------- fill
# The towns and sites are clumpy: at the floor, random packing leaves holes, and the candidate set as a
# whole saturates near 8,900. Regions still under their quota are topped up with unnamed minor sites on
# their best habitable land (the old generator's rule: Köppen capacity, elevation, rivers, coast), at the
# region's spacing, never nearer the floor to a named site. Every land cell belongs to the region of its
# nearest candidate.
CAPK = {1: 0.85, 2: 0.85, 3: 0.9, 4: 0.05, 5: 0.05, 6: 0.35, 7: 0.35, 8: 0.8, 9: 0.8, 10: 0.8,
        11: 0.9, 12: 0.9, 13: 0.9, 14: 1.0, 15: 1.0, 16: 1.0, 17: 0.7, 18: 0.7, 21: 0.7, 22: 0.7, 25: 0.7, 26: 0.7,
        19: 0.3, 20: 0.3, 23: 0.3, 24: 0.3, 27: 0.3, 28: 0.3, 29: 0.1, 30: 0.0}
def xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)
regions = sorted(QUOTA)
rindex = {r: i for i, r in enumerate(regions)}
tree = cKDTree(xyz(np.array([c["lat"] for c in cands]), np.array([c["lon"] for c in cands])))
rows, xs = np.nonzero(land[::2, ::2]); rows = rows * 2; xs = xs * 2   # a stride-2 lattice is plenty for minor sites
lats = latMin + (H - 1 - rows + 0.5) * (latMax - latMin) / H
lons = lonMin + (xs + 0.5) * (lonMax - lonMin) / W
_, nn = tree.query(xyz(lats, lons), workers=-1)
cell_region = np.array([rindex[cands[i]["region"]] for i in nn], dtype=np.int16)
capk = np.vectorize(lambda k: CAPK.get(int(k), 0.5))(kop[rows, xs]).astype(np.float32)
mm = meters[rows, xs]
capk = np.where(mm > 4000, capk * 0.1, np.where(mm > 2500, capk * 0.3, np.where(mm > 1500, capk * 0.7, capk)))
rv = river[rows, xs]
# Rivers and coasts help in proportion to the climate (a tundra river is still tundra), and the fill
# stays off poor land: it goes to the next region's quota instead.
hab = capk * (1.0 + 0.35 * (rv >= 2) + 0.2 * (rv == 1) + 0.25 * coast[rows, xs]) + np.random.default_rng(args.seed).uniform(0, 0.08, capk.shape)
usable = (capk >= 0.35) & (mm < 3500)
order = np.argsort(-hab, kind="stable")
h = Hash()
for c in taken: h.add(c["cell"][0], c["cell"][1], FLOOR)
got = {r: by_region.get(r, 0) for r in QUOTA}
# The fill's targets: the target shared by quota, capped by each region's surplus allowance, water-filled.
want = dict(QUOTA)
for _ in range(8):
    fixed = sum(want[r] for r in QUOTA if want[r] >= cap_of(r, 1.0) - 1e-6)
    free = [r for r in QUOTA if want[r] < cap_of(r, 1.0) - 1e-6]
    if not free: break
    base = sum(QUOTA[r] for r in free)
    for r in free: want[r] = min(cap_of(r, 1.0), (TARGET - fixed) * QUOTA[r] / base)
# Never more than 40% of a region's named seats as fill: the fill is texture, not the map.
named_by = {r: by_region.get(r, 0) for r in QUOTA}
want = {r: int(round(min(v, named_by[r] * 1.4 if named_by[r] >= 5 else v))) for r, v in want.items()}
short = TARGET - sum(max(got[r], want[r]) for r in QUOTA)
if short > 0:
    for r in sorted(QUOTA, key=lambda r: -QUOTA[r])[:short]: want[r] += 1
filled = []
def fill_pass(want):
    n0 = len(filled)
    for i in order:
        if not usable[i]: continue
        r = regions[cell_region[i]]
        if got[r] >= want[r]: continue
        x, row = int(xs[i]), int(rows[i])
        sp = min(CAP, max(FLOOR, spacing[r] * climate_factor(x, row) * 1.3))
        if h.ok(x, row, sp):
            h.add(x, row, sp); got[r] += 1
            filled.append({"name": None, "lat": float(lats[i]), "lon": float(lons[i]), "cc": None, "pop": 0, "code": "FILL",
                           "modern": 0.0, "hist": 0.0, "sig": 0, "eras": 0, "src": "fill", "must": False, "kind": "site",
                           "score": float(hab[i]) * 0.1, "cell": (x, row), "region": r, "island": int(island[row, x])})
        if all(got[q] >= want[q] for q in QUOTA): break
    return len(filled) - n0
m = 1.0
for p in range(5):
    added = fill_pass(want)
    deficit = TARGET - sum(got.values())
    print(f"  fill pass {p}: +{added}, {deficit} short")
    if deficit <= 0: break
    # Regions that met their want have room; spread the deficit over them in proportion, within the caps,
    # loosening the caps if that is not enough.
    for _ in range(6):
        met = [r for r in QUOTA if got[r] >= want[r] and want[r] < cap_of(r, m) - 0.5]
        if met: break
        m += 0.5
    if not met: break
    base = sum(QUOTA[r] for r in met)
    for r in met: want[r] = min(int(round(cap_of(r, m))), int(round(named_by[r] * 1.4)) if named_by[r] >= 5 else 10 ** 6, want[r] + int(math.ceil(deficit * QUOTA[r] / base)))
# A last top-up for the few the caps left: the regions below the median density take one more each in
# turn (named candidates first, then lattice cells) until the target is met.
deficit = TARGET - len(taken) - len(filled)
if deficit > 0:
    dens = {r: got[r] / max(1, int(np.sum(cell_region == rindex[r]))) for r in QUOTA}
    median = float(np.median(list(dens.values())))
    low = {r for r in QUOTA if dens[r] <= median}
    have = set(id(c) for c in taken)
    for c in cands:
        if deficit <= 0: break
        if id(c) in have or c["region"] not in low: continue
        sp = min(CAP, max(FLOOR, spacing[c["region"]] * c["clim"] * score_factor(c["score"])))
        if h.ok(c["cell"][0], c["cell"][1], sp): h.add(c["cell"][0], c["cell"][1], sp); taken.append(c); have.add(id(c)); got[c["region"]] += 1; deficit -= 1
    for i in order:
        if deficit <= 0: break
        if not usable[i]: continue
        r = regions[cell_region[i]]
        if r not in low: continue
        x, row = int(xs[i]), int(rows[i])
        sp = min(CAP, max(FLOOR, spacing[r] * climate_factor(x, row) * 1.3))
        if h.ok(x, row, sp):
            h.add(x, row, sp); got[r] += 1; deficit -= 1
            filled.append({"name": None, "lat": float(lats[i]), "lon": float(lons[i]), "cc": None, "pop": 0, "code": "FILL",
                           "modern": 0.0, "hist": 0.0, "sig": 0, "eras": 0, "src": "fill", "must": False, "kind": "site",
                           "score": float(hab[i]) * 0.1, "cell": (x, row), "region": r, "island": int(island[row, x])})
    print(f"  top-up in the sparser half of the regions: {TARGET - len(taken) - len(filled)} still short")
taken = taken + filled
if len(taken) > TARGET:
    taken.sort(key=lambda c: (c["src"] == "fill", -c["score"]))
    taken = taken[:TARGET]
taken.sort(key=lambda c: -c["score"])
by_region = {}
for c in taken: by_region[c["region"]] = by_region.get(c["region"], 0) + 1

# ----------------------------------------------------------------------------- write
def yaml_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
out = args.out or os.path.join(args.pack, "seats.yaml")
with open(out, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(f"# City sites for world pack \"{man['name']}\": chosen by cultural relevance across history (GeoNames towns,\n")
    fh.write("# CC BY 4.0, plus a curated historic gazetteer), balanced by region, on the sim grid's land. Generated by\n")
    fh.write(f"# Terra_Form games/culture_wars/select_city_seats.py ({len(taken)} seats, sim grid {W}x{H}, floor {FLOOR:g} cells, seed {args.seed}).\n")
    fh.write(f"schema: culturewars-seats/1\npack: {man['name']}\nseats:\n")
    for i, c in enumerate(taken, start=1):
        lat, lon = latlon_of(*c["cell"])
        NL = chr(10)
        name = (NL + "    name: " + yaml_str(ascii(c["name"]))) if c["name"] else ""
        fh.write("  - id: %d" % i + NL + "    lat: %.4f" % lat + NL + "    lon: %.4f" % lon + NL + "    city_map: null" + name + NL)

# ----------------------------------------------------------------------------- report
rep = [f"{len(taken)} seats written to {out}", ""]
land_by = np.bincount(cell_region, minlength=len(regions)) * 4
rep.append(f"{'region':14s} {'seats':>6s} {'quota':>7s} {'effective':>9s} {'spacing':>8s} {'per10k':>7s}")
fillby = {}
for c in taken:
    if c["src"] == "fill": fillby[c["region"]] = fillby.get(c["region"], 0) + 1
rep[-1] += f" {'fill':>5s}"
for r in sorted(QUOTA, key=lambda r: -QUOTA[r]):
    dens = 1e4 * by_region.get(r, 0) / max(1, land_by[rindex[r]])
    rep.append(f"{r:14s} {by_region.get(r,0):6d} {QUOTA[r]:7.0f} {eff[r]:9.0f} {spacing[r]:8.1f} {dens:7.1f} {fillby.get(r,0):5d}")
src = {"gn": 0, "cur": 0, "fill": 0}
for c in taken: src[c["src"]] += 1
hist_only = sum(1 for c in taken if c["src"] == "cur")
with_hist = sum(1 for c in taken if c["hist"] > 0)
rep += ["", f"from GeoNames: {src['gn']} (of which {with_hist - hist_only} also in the curated list); curated-only sites: {hist_only}; unnamed fill: {src['fill']}",
        f"capitals (PPLC) placed: {sum(1 for c in taken if c['code']=='PPLC')} of {sum(1 for c in cands if c['code']=='PPLC')}",
        f"islands with a seat: {len(set(c['island'] for c in taken))}",
        f"off-land drops ({len(dropped_offland)}): " + ", ".join(sorted(set(c['name'] for c in dropped_offland))[:60])]
# Named checks the user asked for or that stand for a region.
names = {ascii(c["name"]).lower(): c for c in taken if c["name"]}
checks = ["Funafuti", "Male", "Majuro", "Tarawa", "Nauru", "Amsterdam", "Brussels", "Antwerp", "Rotterdam", "Utrecht", "Bruges", "Ghent", "Leiden", "Haarlem", "The Hague", "Luxembourg", "Timbuktu", "Agadez", "Tamanrasset", "Siwa", "Nan Madol", "Honolulu", "Papeete", "Apia", "Nuku'alofa", "Suva", "Manaus", "Iquitos", "Kinshasa", "Lagos", "Kano", "Great Zimbabwe", "Babylon", "Ur", "Xi'an", "Kyoto", "Cusco", "Teotihuacan", "Cahokia"]
rep.append("named: " + ", ".join(f"{n}={'Y' if n.lower() in names else 'n'}" for n in checks))
# Must-haves that did not fit, and what stands on their ground.
placed_ids = set(id(c) for c in taken)
hcells = {}
for c in taken: hcells.setdefault((c["cell"][0] // 8, c["cell"][1] // 8), []).append(c)
missing = []
for c in cands:
    if not c["must"] or id(c) in placed_ids: continue
    near = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for o in hcells.get((c["cell"][0] // 8 + dx, c["cell"][1] // 8 + dy), ()):
                if max(abs(o["cell"][0] - c["cell"][0]), abs(o["cell"][1] - c["cell"][1])) < FLOOR: near.append(o["name"] or "(fill)")
    missing.append(f"{c['name']} <- {', '.join(near) or '?'}")
rep.append(f"must-haves not placed ({len(missing)}): " + "; ".join(missing[:80]))
# Pairwise floor check (the grid rule alone).
viol = 0; seen = {}
for c in taken:
    x, row = c["cell"]
    for dx in range(-int(FLOOR) + 1, int(FLOOR)):
        for dy in range(-int(FLOOR) + 1, int(FLOOR)):
            if ((x + dx) % W, row + dy) in seen: viol += 1
    seen[(x, row)] = True
rep.append(f"pairs closer than the floor: {viol}; cells not land: {sum(1 for c in taken if not land[c['cell'][1], c['cell'][0]])}")
# Low-score tail.
rep.append("score quantiles (min/10/50/90/max): " + " ".join(f"{np.percentile([c['score'] for c in taken], q):.2f}" for q in (0, 10, 50, 90, 100)))
open(os.path.join(os.path.dirname(os.path.abspath(out)), "seats_report.txt"), "w", encoding="utf-8").write("\n".join(rep) + "\n")
print("\n".join(rep))
