# Landform codebook

A learned, labelled vocabulary of tile-scale landforms for Terra Form's tile grids, one codebook per
scale band: `data/landform/codebook.json` holds, for each of 8 tile sizes from 0.01 to 3 degrees per tile
(1 km to 333 km), K centroids of 7x7 windows of (land, relief, Köppen group, river) learned from Earth at
that tile size. Each code is captioned with the Natural Earth physical-geography labels over-represented
under it ("delta", "isthmus", "range/mtn", "strait" ...) and paired with a hand-designed geomorphon form. A
describe pass cuts a map into windows, picks the band from the map's tile size, assigns each window to its
nearest code, and can say "this looks like what Earth calls an island group / strait at this scale", with
the lift numbers to back it.

Files:

- `scripts/landform_windows.py` samples the Earth into tile grids and windows per band ->
  `data/landform/windows.npz` and the label cache `data/landform/ne_physical.json` (Natural Earth, public
  domain, with scalerank and min_label).
- `terraform/landform_codebook.py` fits the per-band codebooks -> `data/landform/codebook.json`,
  `docs/landform-codes.txt` (every code of every band as ASCII) and the generated section at the end of
  this page. It also holds the inference hook (`assign`) and the geomorphon classifier.

## Scale is a first-class variable

What a 7x7 window contains changes with the tile size: at 3 deg/tile a "ridge" is a cordillera and a
window holds a whole peninsula; at 0.26 it is one range or one valley; at 0.02 it is a cove, a headland or
a delta's distributaries. So the codebook is not scale invariant and does not try to be: each band has its
own codes, every window is tagged with its band, inference picks the band from the tile size, and the
report measures how many codes recur between adjacent bands instead of assuming they do.

The bands are log-spaced over 0.01..3.0 deg/tile (`--bands MIN,MAX,N`), each snapped so the globe is an
even number of tiles wide, with ranges at the geometric midpoints:

| band | deg/tile | km/tile | what a 7x7 window spans | sampled how |
|---|---|---|---|---|
| 0 | 3.0 | 333 | 2300 km: a subcontinent | the whole globe, 120x60 tiles, base rasters |
| 1 | 1.33 | 148 | 1000 km: a cordillera, a large peninsula | globe 270x135 |
| 2 | 0.588 | 65 | 460 km: a range, a gulf (Europe at 80x52 is ~0.75) | globe 612x306 |
| 3 | 0.26 | 29 | 200 km: a valley, an archipelago (Italy at 60 wide is ~0.2) | globe 1382x691 |
| 4 | 0.115 | 12.8 | 90 km: a fjord, a big delta | 48 frames of 80x52 tiles, fine sources |
| 5 | 0.051 | 5.7 | 40 km: a bay, a river mouth | 48 frames |
| 6 | 0.0226 | 2.5 | 18 km: a cove, a headland, a single ridge | 48 frames |
| 7 | 0.01 | 1.1 | 8 km: a valley floor, a spit | 48 frames |

Bands at or above 0.2 deg/tile (`--global-min-deg`) enumerate the whole globe from the base rasters
(elev_4096 at 11.4 px/deg, koppen_2048, coast_10m + lakes_10m), averaging the layer pixels under each tile
the way the app does. Finer bands cannot be enumerated (0.02 deg/tile is 18000x9000 tiles), so 48 random
map-sized frames per band (80x52 tiles plus a 5-tile margin) are built with the fine sources the
exporters use at those densities: `hgt_tiles` (ETOPO at 120 px/deg), OSM `coast_tiles` + `lakes_hires`,
`koppen_tiles`. Frame centres are drawn from the band-3 globe grid, stratified over delta, archipelago,
strait/fjord/channel/sound, mountain, desert, coast, hills and plain tiles (shares 2 : 1.5 : 1.5 : 1.5 :
1 : 2 : 1 : 1.5), and the delta frames go round-robin over the named Natural Earth deltas (Nile, Ganges,
Mississippi, Mekong, Niger, Irrawaddy, Indus, Danube, Volga, Lena, Amazon, Zambezi), so each one is in
every fine band. Every frame's bounds are stored in the npz (`frames`) and the whole sample is
reproducible from `--seed`.

## How a band is built

**Tile grids.** Per tile, mimicking how `core/app.js` samples a frame:

| channel | per tile | mimics |
|---|---|---|
| land | land fraction >= 0.5 (lakes punched out, playas back as land) | `landThreshold` at bias 0 |
| height | mean elevation of the land pixels, metres (0 on water) | `hA` |
| relief | 0 flat / 1 hills / 2 peak: peak when `0.3*hp + 0.7*rp > 0.8`, hills when `0.1*hp + 0.9*rp > 0.55`; hp / rp = the tile's percentile of height / roughness among **that frame's** land tiles (a world map and a regional map each get their own hills and peaks, as in the app's per-view normalisation); roughness = gradient magnitude of the coded height, normalised, gamma 0.7 | `P.blendHill/blendPeak/hill/peak`, `buildRoughLayer` |
| koppen | dominant Köppen class of the footprint, as `classGroup` 0..5 (ice, tundra, arid, tropical, temperate, continental) | `kcA` + `classGroup` |
| river | a HydroRIVERS channel of class >= 2 (100 m³/s) crosses the tile, land tiles only | the games' river class 2 |

Relief being relative, every globe band comes out 56 % flat / 33 % hills / 11 % peak of land, and every
frame has its own distribution.

**Windows.** Every tile that is land, or water with land in its 8-neighbourhood, is a candidate centre of
a 7x7 window (globe bands: between 60°S and 84°N, longitude wrapping; frames: inside the margin). A band's
candidates are subsampled to `--per-band` 20,000 source windows, stratified by (land or coast centre,
rarest label at the centre) with a floor of 400 per stratum so rare landforms survive the cut; the
coarsest bands have fewer candidates than that and keep them all. Each kept window is stored with its 8
dihedral symmetries (4 rotations x mirror), its band, frame, centre, geomorphon, height and labels.

**Features.** A window is one-hot encoded per cell into 11 channels: water / flat / hills / peak (one is
1), six climate channels (one is 1 on land, all 0 on water) and river (0/1 on land); 7x7x11 = 539
features. The climate channels are weighted 0.5 and the river channel 0.75 in the distance
(`--climate-weight`, `--river-weight`), so a code is first a shape of land, water and relief and only then
a climate (with equal weights a third of the codes were the same flat plain in six climates).

**k-means per band.** K = 128 per band (`-k`; a band with few windows gets one code per 40 windows at
least), seeded with k-means++ and run as *orbit k-means*: a window may sit in any of its 8 orientations
and is assigned to the centroid nearest any of them, then contributes to that centroid in that
orientation. Codes are therefore rotation and mirror invariant within a band by construction (a rotated or
mirrored window gets the same code 100 % of the time) and none of the K is spent on four rotations of
the same coast. Codes are numbered by frequency within their band; a code's full name is `band:id`.
`--method augmented` is plain k-means on the 8x augmented set (sklearn when installed) for comparison.

**Labels, scale-filtered and footprint-weighted.** Natural Earth 10m `ne_10m_geography_regions_polys`
(range/mtn, plateau, basin, plain, desert, island, island group, pen/cape, delta, isthmus, valley,
lowland, foothills, wetlands, gorge, depression, tundra, coast, peninsula) and
`ne_10m_geography_marine_polys` (bay, gulf, strait, channel, sound, fjord, lagoon, reef, inlet) are
burned onto each band's tile grid *all-touched*; continent, geoarea, ocean, sea, generic, river, lake
and "dragons-be-here" are dropped. A polygon part counts at a band only when it is at least two tiles
across and its `scalerank` is within the band's edition: <= 3 (the 110m-like set) from 2 deg/tile up,
<= 6 (the 50m-like set) from 0.5, everything in 10m below. (NE's `min_label` is monotone in feature
size but the regions and marine files use different conventions for it, so the size rule is the
band-consistent one and scalerank the edition gate.) Each window records the labels at its centre tile
(a bitmask: a tile can be "range/mtn" inside "plateau" inside "pen/cape") and, per label, how many of its
49 tiles the label covers. Captions use the coverage: a code's *cover* for a label is the mean fraction of
its windows' footprint under the label, *lift* is cover over the band's base cover, and the caption is
the labels with lift >= 1.5 and cover >= 5 %, ordered by cover x log2(lift) (pointwise mutual information
weighted by how much of the code the label fills), three at most. The 10m edition is the finest Natural
Earth makes, and it thins out below about 0.1 deg/tile: there the labels that still apply are the ones
whose polygons are tens of kilometres across (ranges, plateaus, deserts, big deltas, large bays, straits,
island groups), the rest of a fine window's neighbourhood is simply unlabelled, and codes without a
qualifying label stay "unlabelled" rather than mislabelled. The finer label source for a later pass is
OSM `natural=bay / cape / peninsula / strait / isthmus / valley / ridge` (and `place=island`), fetched the
way `scripts/fetch_osm_waterways.py` does it (Overture's GeoParquet release with bbox pushdown, cached per
block under an ignored directory, ODbL attribution); it is not built here.

Two Natural Earth quirks to know: every polygon of featurecla *Peninsula* is in Antarctica, so that label
never fires inside the latitude band; the familiar peninsulas (Iberia, Italy, Florida, Korea, Kamchatka,
Yucatán, Arabia, India, Scandinavia...) are *Pen/cape*, which also makes "pen/cape" a very broad label.
*Basin* is nine huge polygons (Amazon, Congo, Great Artesian, Great Basin, Tarim, Sichuan...), so "basin"
captions flat tropical river country rather than a topographic basin.

**Geomorphons.** `terraform.landform_codebook.geomorphons` implements the Jasiewicz & Stepinski form on
each band's tile height grid (water tiles at sea level): along the 8 lines of sight out to a lookback of
5 tiles, a direction is *higher* when the steepest rise exceeds the steepest drop by more than 100 m per
tile of distance (`--geo-flat`), *lower* in the mirror case, and the (lower, higher) counts index the
standard 10-form table (flat, peak, ridge, shoulder, spur, slope, hollow, footslope, valley, pit). The
threshold is in metres per tile, so the form is relative to the band too. Each code records its windows'
centre-form distribution and the leading form with its share and lift.

## Results

All numbers are from the build in the generated section below (seed 0); the tables there are the source,
this is the reading of them.

### What separates well

- **Coarse and middle bands (3 to 0.26 deg/tile, the globe-enumerated ones) caption 125-127 of 128
  codes** and the lifts are far above chance: island group x7.7-10, island x7.7-12.5, isthmus x21-44,
  strait x11-19, channel x13-24, sound x16-31, fjord x17-61, gorge x31-68, valley x23-38, wetlands x22-43,
  depression x13-24, lagoon x157 at 0.26 (127 windows, one code). Delta is x19-22 from 1.3 down to 0.26
  deg/tile (36, 198 and 548 windows): a river mouth on a flat coast is already a code of its own at 65 km
  tiles.
- **Plateau / range vs plain / lowland**: solid peak and hill blocks caption "range/mtn" and "plateau"
  (plateau x5-6, range/mtn x3-4.5: the labels are too broad to concentrate further, a quarter of all
  windows are "range/mtn"); flat continental blocks with rivers caption "lowland / plain / tundra" (lowland
  x7-10) and agree with the geomorphon *flat* form on 84-98 % of their windows.
- **Deserts** keep their own codes at every band (desert x7-10), the climate channel still counting at
  weight 0.5.
- **Geomorphons** agree with 18-37 codes per band on at least half their windows once the flatness
  threshold is relative to the grid (1.5 x the median land height step: 191 m per tile at 3 deg/tile down
  to 8 m at 0.01); the form base rates are then the same at every band (24-30 % flat, 14-20 % slope,
  9-13 % ridge, 16-25 % footslope). With the earlier fixed 100 m per tile, 76 % of the finest band was
  "flat".

### What separates poorly

- **Natural Earth captions stop being reliable at about 0.05 deg/tile.** The labels are measured against
  their base rate within each window's own frame (the globe for the coarse bands), so a polygon that
  blankets a sampled frame has lift 1 and cannot caption. At 0.115 deg/tile 103 of 128 codes still get a
  caption (delta x7.2, bay x5.9, strait x4.4, fjord x3.6); at 0.051 it is 92 of 128 (range/mtn x8,
  fjord x10, delta x2.6); at 0.0226 and 0.01 only 48 and 41 of 128, and the "mixed" column of the label
  table shows why: island group, lowland, basin and isthmus are 0 % mixed at the finest bands (every frame
  that has them is covered by them), delta falls from 96 % mixed at 0.051 to 57 % at 0.01. The 10m
  edition has no polygon smaller than a fine frame, so a cove, a headland or one distributary has nothing
  to be labelled with. Those codes are left "unlabelled" rather than named after the frame they came from
  (which is what the plain band-wide lift did: the Alps at 0.05 deg/tile read "island group" because the
  comparable peaks in the sample sat in Iceland and New Zealand frames; that lift is still stored as
  `lift_band`). OSM `natural=*` is the label source for those bands.
- **Deltas at fine scale are seen but not confirmed.** The Mississippi at 0.0226 deg/tile is an open-water
  code with "delta" on 9 of the 25 windows around its centre, the Nile at 0.051 a flat valley-floor code,
  the Okavango a "valley" code among unlabelled inland flats: the shapes (distributary river tiles, lobate
  coast, a river fan ending in a flat) are in the codebook, but the delta polygon is the whole frame and
  gives no lift. Confirming them needs the finer labels above, or a shape rule (river tiles fanning into
  water).
- **Ice and tundra climates inherit Arctic captions.** Greenland is Natural Earth's "island", Svalbard an
  "island group", so the ice-cap and tundra-peak codes caption that way, and the Tibetan plateau at 1.3
  and 0.26 deg/tile reads "island / island group / tundra". It is the climate channel matching Tibet to
  Greenland; `--climate-weight 0` would remove it at the cost of losing desert codes.
- **Broad labels.** "pen/cape" covers India, Arabia and Scandinavia (x2-6 and spread over many codes),
  "basin" is nine huge polygons (Amazon, Congo, Tarim...) so it captions flat tropical river country, and
  "range/mtn" is a quarter of all windows.
- **Climate still splits shapes.** Even at weight 0.5 the flat-plain codes split by climate and by river
  density; that is Earth's distribution, not a clustering failure, but a describe pass that wants pure
  shape should group codes by their `kind` or retrain with `--climate-weight 0 --river-weight 0`.

### How the vocabulary shifts across the decades

The kinds table in the generated section counts codes by their centroid's content, band by band:

- **Coarse end (3 deg/tile, 333 km tiles, K = 58 from 2,355 windows).** 32 of 58 codes are coast and 8
  more are open water with islands: at this scale almost every land tile is within a window of the sea,
  and the codes are subcontinents, cordillera-plus-coast and island arcs ("island group / island",
  "plateau / range/mtn / lowland", "desert / pen/cape"). Only one code is an inland peak block. Isthmus,
  delta, fjord, gorge, lagoon and wetlands have under 30 windows and no code.
- **Middle (1.3 to 0.26 deg/tile).** The geographer's vocabulary: range/mtn leads 24-26 codes, island group
  12-19, desert 13-16, with isthmus (6-7 codes), strait, channel, sound, fjord, gorge, valley, wetlands and
  depression each owning codes with lifts in the tens. Coast codes fall from 50 to 46 of 128, inland
  hills rise from 31 to 33, inland peaks 14 to 18.
- **Fine (0.115 to 0.01 deg/tile).** Open-water codes fall to 5-7 and coast codes to 31-37 of 128 while
  inland hills climb from 33 to 55 and inland flats from 21 to 26-32: the windows are now single valleys,
  spurs and slope breaks inside one range, lake-and-river flats inside one plain, and the shoreline codes
  are coves, headlands and single islands (the "island" label, 7.5x at every fine band, is the one Natural
  Earth label that still means one shape: an islet a few tiles across). Range/mtn still captions 27-28
  codes at 0.115 and 0.051 (a mountain frame is mixed, the range polygon covers part of it) but only 4-5 at
  0.0226 and 0.01. What exists only here: valley-floor and gorge codes with a river down the middle, bay
  and sound codes that are a single inlet, delta codes that are river fans (band 7 has 7 codes led by
  "delta", band 6 three, all from the delta frames). What exists only at the coarse end: codes that are a
  whole cordillera with both its coasts, archipelago codes spanning a sea, the desert-with-a-coast codes.
- **Stability.** Between adjacent bands 74-84 of 128 centroids are mutual nearest neighbours closer than
  two codes of one band ever are (32 of 58 between bands 0 and 1): the *shapes* recur across scale, and
  the pooled check agrees (a single K = 192 codebook over every band ends with 191 codes shared by two or
  more bands and none band-specific). The *names* do not recur: the leading caption agrees on 52-58 of the
  stable pairs between bands 1-2 and 2-3, and on 11-26 between bands 3-4, 4-5 and 5-6 (where the captions
  change meaning and then thin out), 52 between 6-7 (both mostly "unlabelled"). That is the measured
  version of "the meaning legitimately changes": a 7x7 blob of hills with water on one side is the same
  code shape at 1.3 deg/tile (a peninsula) and at 0.02 (a headland), and the same window-shape at 3 deg/tile
  is Scandinavia. One codebook per band with the band recorded on every code is the right structure; the
  pooled codebook would caption Scandinavia and a headland alike.

### Spot check (frames built around named places, this build)

| place | 0.26 deg/tile | 0.051 | 0.0226 |
|---|---|---|---|
| Nile delta | desert / plain / delta (coast) | valley / plateau (inland flat) | unlabelled (inland hills) |
| Mississippi delta | island group / channel / bay (open water) | sound / bay / gulf | unlabelled; "delta" on 9 of the 25 windows around it |
| Ganges delta | delta / pen/cape / isthmus (coast) | range/mtn / plateau / island (the frame reaches the Chittagong hills) | plateau / range/mtn |
| Okavango delta | desert / depression / plain | valley | unlabelled, "valley" around it |
| Mekong delta | - | wetlands / range/mtn / plateau | unlabelled, "gulf / coast" around it |
| Panama isthmus | island group / channel / island; "bay / gulf / isthmus" around it | delta / wetlands | - |
| Gibraltar | island group / island / channel; "range/mtn / strait" around it | lagoon / strait | gulf / strait / channel |
| Sognefjord | - | range/mtn (coast kind, geomorphon pit) | unlabelled (coast kind, geomorphon valley) |
| Grand Canyon | - | unlabelled (inland hills) | valley / delta (inland hills, geomorphon slope) |
| Aegean | island group / strait / channel | sound / bay / gulf | - |
| Alps (Valais) | range/mtn (peaks, geomorphon ridge) | plain (hills, slope) | - |
| Great Plains | plain / tundra at 0.26; lowland / plateau / tundra at 1.3 | - | - |
| Tibetan plateau | island group / island / tundra at 0.26; island / island group / channel at 1.3 | - | - |

The middle band names the big landforms as a geographer would (Ganges delta, Aegean, Alps, Great Plains);
the fine bands have the shapes (Gibraltar is "strait" at every band; the Mississippi's bird-foot is an
open-water-with-channels code) but, where Natural Earth has no polygon smaller than the frame, no name.

## Inference and a JavaScript port

Python:

```python
from terraform.landform_codebook import load_codebook, windows_from_grid, assign
cb = load_codebook()                                                    # data/landform/codebook.json
win = windows_from_grid(land, relief, koppen, river, cb["window"])      # (H*W, 7, 7, 4) uint8, row-major tiles
codes, orient, band = assign(win, deg_per_tile=span_x / W, codebook=cb)
caption = cb["bands"][band]["codes"][codes[i]]["caption"]
```

`windows_from_grid` pads off-grid cells with water (or wraps columns with `wrap_x=True`); `relief` is
0/1/2, `koppen` the 0..5 group, `river` 0/1, all as the app's samples give them. `deg_per_tile` is the
tile size in degrees: a snapshot's frame gives it as its longitude span divided by its width in tiles
(`spanX / W`), and `band_for(cb, deg_per_tile)` is the band whose `range` holds it (`range[1]` null =
open at the coarse end). The band index comes back with the codes because a code id is only meaningful
with its band.

The JSON is laid out for a port: `bands[b].codes[k].centroid` is the mean one-hot window of the code
(539 numbers, feature `(y*7 + x)*11 + channel`, channels in `onehot_channels`), `channel_weights` the 11
per-channel weights, `codes[k].norm2` the centroid's squared norm in the weighted space. For a window,
build the one-hot vector `x` (water/flat/hills/peak one-hot per cell, climate one-hot on land, river 0/1
on land) and for each of the 8 orientations `t` (rotate the 7x7 grid by `t*90°` for `t < 4`; mirror the
columns first for `t >= 4`) score every code of the chosen band as

```
score(k, t) = norm2[k] - 2 * sum_i (w[i % 11]^2 * x_t[i] * centroid[k][i])
```

and take the smallest score over `k` and `t` (the `|w x|^2` term is the same for every `k` and is
dropped). Premultiplying each centroid by the squared channel weights once at load turns the inner sum
into a plain dot product, and because `x_t` is 0/1 the dot product is a sum of at most 7x7x3 centroid
entries, so a whole map is a few million additions. Python's `assign` was checked against this exact
formula (identical codes) and against the stored training assignment (identical).

**Scale mismatch is itself a seam.** Two patches spliced into one map with very different deg/tile (a
0.05 deg/tile Nile delta next to a 0.6 deg/tile Anatolia) carry codes from different bands, and no code of
one band is a code of the other. The codebook records each code's band so a seam lint can flag a join
whose two sides were described in different bands, or whose source frames differ in deg/tile by more than
a band's width (a factor of about 2.3); that rule belongs to the MCP session, this page only supplies the
band per code and the band ranges.

## Regenerating

Natural Earth download (only needed to rebuild `data/landform/ne_physical.json`; the download is untrusted
data, so it goes in its own fresh directory and nothing is run from inside it):

```bash
mkdir "C:/Users/me/Downloads/ne_10m_physical_labels" && cd "C:/Users/me/Downloads/ne_10m_physical_labels" && for f in ne_10m_geography_regions_polys ne_10m_geography_marine_polys; do curl -sSL -o "$f.zip" "https://naciscdn.org/naturalearth/10m/physical/$f.zip" && mkdir "$f" && unzip -q "$f.zip" -d "$f"; done
```

Then, from the repo root:

```bash
python -P scripts/landform_windows.py --ne-dir "C:/Users/me/Downloads/ne_10m_physical_labels"
```

```bash
python -P scripts/landform_windows.py
```

```bash
python -P terraform/landform_codebook.py
```

The first form rebuilds the label cache from the shapefiles (needs `pyogrio`, which `geopandas` brings); the
second reads the cache. Both write `data/landform/windows.npz`; the per-band sampling times are in the
generated section (140 s in all: 2-6 s per globe band, 21-41 s per frame band of 45-48 frames). The codebook run (numpy + scipy; sklearn only for `--method
augmented`) writes `codebook.json`, `docs/landform-codes.txt` and the section below. Options: `--bands
0.05,3,6` for other bands, `--global-min-deg 0.3`, `--frames 96`, `--per-band 30000`, `--window 9`,
`--lat -90 90`, `--river-class 3`, `--geo-flat 50`, `--seed 1`; `-k 192`, `--pooled-k 0`,
`--climate-weight 0`.

Data: ETOPO 2022 (elev_4096, hgt_tiles), Beck et al. 2023 Köppen (koppen_2048, koppen_tiles), Natural
Earth coast / lakes / playas and physical labels (public domain), OSM land polygons (coast_tiles, ODbL),
HydroLAKES (lakes_hires), HydroRIVERS (river_tiles).

<!-- generated:start (python -P terraform/landform_codebook.py rewrites this section) -->
Built 2026-10-16: 8 scale bands, 7x7 windows, method `orbit` (seed 0), 167715 source windows x 8 symmetries, channel weights 1 form / 0.5 climate / 0.75 river, geomorphon lookback 5 tiles at auto m per tile (auto = 1.5 x each grid's median land height step); sampling 136 s, fitting 182 s.

### Bands

| band | deg/tile | km/tile | range (deg/tile) | source | windows | K | captioned | labelled centres | geomorphon flat m/tile | sampling s | fit s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 3 | 333 | 1.99 - open | globe 120x60 | 2355 | 58 | 50 | 81% | 190.7 | 2 | 1 |
| 1 | 1.32 | 147 | 0.882 - 1.99 | globe 272x136 | 11188 | 128 | 125 | 85% | 116.6 | 2 | 6 |
| 2 | 0.588 | 65.3 | 0.391 - 0.882 | globe 612x306 | 23428 | 128 | 126 | 85% | 70.5 | 3 | 12 |
| 3 | 0.26 | 28.9 | 0.173 - 0.391 | globe 1382x691 | 28666 | 128 | 127 | 86% | 41.4 | 6 | 15 |
| 4 | 0.115 | 12.8 | 0.0767 - 0.173 | 48 frames of 90x62 | 25803 | 128 | 103 | 87% | 41.2 | 41 | 17 |
| 5 | 0.051 | 5.66 | 0.0339 - 0.0767 | 45 frames of 90x62 | 25924 | 128 | 92 | 82% | 18.9 | 28 | 15 |
| 6 | 0.0226 | 2.51 | 0.015 - 0.0339 | 45 frames of 90x62 | 25688 | 128 | 48 | 77% | 17.2 | 27 | 14 |
| 7 | 0.01 | 1.11 | 0 - 0.015 | 45 frames of 90x62 | 24663 | 128 | 41 | 87% | 7.9 | 21 | 12 |

### Vocabulary across the scales

Codes per kind (and the share of the band's windows they hold), kind from the centroid's water and relief content:

| band | deg/tile | open water / islands | coast | inland peaks | inland hills | inland flat |
|---|---|---|---|---|---|---|
| 0 | 3 | 8 (24%) | 32 (44%) | 1 (2%) | 9 (11%) | 8 (19%) |
| 1 | 1.32 | 11 (15%) | 50 (33%) | 14 (7%) | 31 (18%) | 22 (27%) |
| 2 | 0.588 | 11 (12%) | 47 (27%) | 17 (10%) | 30 (21%) | 23 (29%) |
| 3 | 0.26 | 10 (9%) | 46 (27%) | 18 (10%) | 33 (24%) | 21 (30%) |
| 4 | 0.115 | 5 (6%) | 37 (22%) | 15 (8%) | 49 (31%) | 22 (32%) |
| 5 | 0.051 | 7 (8%) | 31 (19%) | 15 (9%) | 43 (25%) | 32 (39%) |
| 6 | 0.0226 | 5 (5%) | 33 (18%) | 15 (8%) | 46 (30%) | 29 (39%) |
| 7 | 0.01 | 5 (6%) | 31 (18%) | 11 (7%) | 55 (35%) | 26 (35%) |

Label reliability per band: windows with the label at the centre / best coverage lift any code gives it / for the frame bands, the share of those windows in frames where the label is mixed (marks 10..90 % of the frame; a label that blankets its frames is a frame constant, not a shape) (blank = under 20 windows):

| label | b0 3 | b1 1.3 | b2 0.59 | b3 0.26 | b4 0.12 | b5 0.051 | b6 0.023 | b7 0.01 |
|---|---|---|---|---|---|---|---|---|
| range/mtn | 551 / x3.1 | 2727 / x3.5 | 4450 / x3.9 | 4519 / x4.5 | 3493 / x3.9 / 91% | 3897 / x8.0 / 82% | 4738 / x2.2 / 10% | 2786 / x11.8 / 40% |
| pen/cape | 241 / x5.9 | 1203 / x5.4 | 2485 / x3.8 | 3044 / x4.4 | 4755 / x2.5 / 81% | 3655 / x5.0 / 84% | 3643 / x2.8 / 24% | 4325 / x2.0 / 23% |
| island | 223 / x12.5 | 1438 / x9.8 | 3376 / x8.4 | 4317 / x7.7 | 3408 / x2.9 / 74% | 3642 / x2.1 / 64% | 2614 / x1.9 / 80% | 3245 / x1.8 / 83% |
| plain | 420 / x3.7 | 1742 / x4.6 | 3218 / x4.7 | 3849 / x5.5 | 2301 / x6.4 / 96% | 3331 / x2.8 / 82% | 3075 / x4.5 / 31% | 4136 / x1.7 / 20% |
| plateau | 378 / x4.1 | 1986 / x5.3 | 3445 / x5.9 | 3643 / x6.0 | 2439 / x2.9 / 71% | 2387 / x4.1 / 75% | 1676 / x14.1 / 36% | 2132 / x1.2 / 27% |
| island group | 245 / x5.3 | 1225 / x10.0 | 2783 / x7.8 | 3325 / x7.7 | 2349 / x2.5 / 23% | 3121 / x1.2 / 0% | 2479 / x1.3 / 4% | 2442 / x1.0 / 0% |
| desert | 269 / x7.4 | 1298 / x8.4 | 2409 / x7.0 | 2781 / x6.9 | 2841 / x1.4 / 58% | 1193 / x1.4 / 50% | 1698 / x1.3 / 18% | 1534 / x1.3 / 30% |
| tundra | 135 / x5.7 | 559 / x10.0 | 1124 / x8.2 | 1451 / x7.2 | 2253 / x1.6 / 68% | 1990 / x1.2 / 30% | 1304 / x1.4 / 37% | 1992 / x2.1 / 12% |
| delta |  | 36 / x21.8 | 198 / x20.2 | 548 / x19.1 | 1001 / x7.2 / 94% | 1984 / x2.6 / 96% | 2793 / x6.6 / 66% | 3403 / x1.9 / 57% |
| basin | 183 / x10.0 | 788 / x13.6 | 1581 / x13.4 | 1690 / x14.3 | 751 / x3.6 / 93% | 1275 / x2.9 / 50% | 737 / x1.5 / 100% | 1063 / x1.0 / 0% |
| gulf | 120 / x9.5 | 617 / x4.0 | 934 / x5.5 | 989 / x5.6 | 845 / x5.2 / 81% | 784 / x2.8 / 98% | 722 / x4.3 / 100% | 602 / x2.2 / 100% |
| channel | 29 / x3.1 | 293 / x24.0 | 816 / x17.8 | 845 / x13.4 | 850 / x4.5 / 87% | 808 / x2.5 / 100% | 649 / x2.2 / 100% | 800 / x3.8 / 100% |
| bay | 76 / x11.6 | 378 / x8.6 | 917 / x5.8 | 1015 / x6.1 | 942 / x5.9 / 93% | 815 / x6.4 / 93% | 757 / x3.1 / 98% | 164 / x3.8 / 95% |
| strait | 34 / x17.3 | 210 / x12.7 | 566 / x18.7 | 830 / x11.4 | 815 / x4.4 / 77% | 510 / x2.6 / 100% | 709 / x12.5 / 95% | 800 / x2.2 / 100% |
| lowland | 76 / x7.1 | 318 / x8.6 | 534 / x10.1 | 544 / x10.1 | 420 / x2.9 / 100% | 471 / x2.5 / 100% | 584 / x1.7 / 100% | 530 / x1.0 / 0% |
| sound |  | 61 / x29.9 | 186 / x30.9 | 800 / x15.7 | 711 / x26.3 / 96% | 700 / x8.5 / 84% |  | 200 / x2.8 / 100% |
| valley | 28 / x23.4 | 97 / x37.6 | 330 / x29.2 | 513 / x31.0 | 540 / x4.0 / 100% | 426 / x1.7 / 100% | 473 / x3.3 / 100% |  |
| wetlands |  | 43 / x21.8 | 160 / x43.0 | 407 / x25.6 | 345 / x2.3 / 100% | 696 / x1.6 / 100% | 401 / x2.3 / 100% |  |
| coast |  | 88 / x13.0 | 262 / x12.4 | 610 / x17.5 | 138 / x2.9 / 100% | 58 / x9.3 / 100% | 456 / x1.9 / 100% |  |
| isthmus | 22 / x5.5 | 65 / x44.5 | 262 / x43.4 | 608 / x21.1 |  |  |  | 546 / x1.0 / 0% |
| foothills | 28 / x8.4 | 120 / x37.8 | 400 / x41.7 | 401 / x29.2 | 57 / x5.8 / 100% |  | 400 / x2.0 / 100% |  |
| fjord |  | 38 / x16.6 | 93 / x61.3 | 411 / x20.4 | 224 / x3.6 / 100% | 57 / x10.1 / 0% |  | 466 / x2.4 / 100% |
| depression |  | 42 / x24.1 | 159 / x19.0 | 400 / x13.0 |  |  |  |  |
| reef |  | 29 / x23.4 | 59 / x17.9 | 141 / x46.1 |  | 148 / x3.9 / 100% |  |  |
| gorge |  |  | 58 / x67.7 | 240 / x30.6 |  |  |  |  |
| lagoon |  |  |  | 127 / x157.0 | 22 / x3.7 / 0% | 139 / x3.5 / 100% |  |  |

### Stability between adjacent bands

Mutual nearest-neighbour centroid pairs closer than tau (the median distance between a code and its nearest other code within a band), with three examples each:

| bands | K | tau | stable pairs | same leading caption | examples |
|---|---|---|---|---|---|
| 0 - 1 | 58 / 128 | 11.26 | 32 | 13 | 0:island group / island ~ 1:island group / island / channel; 5:tundra / plain / lowland ~ 7:tundra / plain / lowland; 4:gulf ~ 30:pen/cape / gulf / bay |
| 1 - 2 | 128 / 128 | 9.68 | 74 | 52 | 9:basin / plateau / foothills ~ 3:basin / foothills / plateau; 6:desert / plain ~ 4:desert / plain; 1:island group / island / channel ~ 5:island group / island / channel |
| 2 - 3 | 128 / 128 | 8.69 | 84 | 58 | 5:island group / island / channel ~ 7:island group / strait / channel; 1:desert / depression / plain ~ 0:desert / depression / plain; 18:island ~ 28:island |
| 3 - 4 | 128 / 128 | 8.06 | 76 | 11 | 0:desert / depression / plain ~ 0:basin / plain; 28:island ~ 8:unlabelled; 1:lowland / tundra / plain ~ 1:unlabelled |
| 4 - 5 | 128 / 128 | 7.49 | 78 | 26 | 0:basin / plain ~ 1:valley / plateau; 3:valley ~ 5:unlabelled; 1:unlabelled ~ 0:lowland |
| 5 - 6 | 128 / 128 | 7.28 | 78 | 21 | 4:basin ~ 3:foothills / wetlands; 1:valley / plateau ~ 1:unlabelled; 13:pen/cape ~ 5:lowland |
| 6 - 7 | 128 / 128 | 7.11 | 81 | 52 | 1:unlabelled ~ 1:unlabelled; 0:delta / island ~ 3:unlabelled; 3:foothills / wetlands ~ 9:unlabelled |

Pooled check: one codebook of K = 192 over every band (no scale channel) ends with 191 codes shared by two or more bands (each holding >= 15 % of the code), 0 band-specific (one band >= 85 %) and 1 in between; codes by majority band: b0 0, b1 17, b2 23, b3 40, b4 30, b5 23, b6 40, b7 19 (89 s).

### Top 6 codes per band

Relief `~ water . flat n hills ^ peak`; climate `* ice t tundra D arid A tropical c temperate K continental`; river `= river (p >= 0.5)`. Cover = mean fraction of the code's windows under the label, lift = cover / the label's mean cover over the same frames (the globe for the coarse bands); every code of every band is in docs/landform-codes.txt.

#### Band 0: 3 deg/tile (333 km)

**Code 0:0** - 6.41% of windows, open water / islands - caption **island group / island** - geomorphon flat (68%, x2.3)  
labels: island group x4.5 (48%), island x3.7 (27%), isthmus x5.5 (4%), gulf x0.8 (4%)

```
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~A~~  ~~~~=~~
    ~~~~nn~  ~~~~AA~  ~~~~==~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
```

**Code 0:1** - 4.46% of windows, open water / islands - caption **island / island group** - geomorphon flat (49%, x1.6)  
labels: island x2.2 (16%), island group x1.6 (17%), channel x3.1 (3%), bay x1.0 (3%)

```
    ~~~nnnn  ~~~KcDK  ~~~====
    ~~~~nnn  ~~~~cKc  ~~~~===
    ~~~~nn~  ~~~~cKc  ~~~~== 
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
```

**Code 0:2** - 3.52% of windows, inland flat - caption **plain / lowland / tundra** - geomorphon flat (80%, x2.7)  
labels: plain x3.4 (57%), lowland x7.1 (20%), tundra x3.5 (19%), plateau x0.6 (9%)

```
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKD  =======
    .......  KKKKKKD  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
```

**Code 0:3** - 3.18% of windows, inland flat - caption **plateau / range/mtn / lowland** - geomorphon footslope (47%, x1.9)  
labels: plateau x2.3 (34%), range/mtn x1.8 (37%), lowland x3.0 (9%), tundra x1.1 (6%)

```
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    ....nnn  KKKKKKK  =======
    .nnnnnn  KKKKKKK  =======
    nnnnnnn  KKKKKKK  =======
```

**Code 0:4** - 3.14% of windows, open water / islands - caption **gulf** - geomorphon flat (58%, x1.9)  
labels: island group x1.3 (14%), gulf x1.6 (7%), desert x1.1 (11%), island x0.8 (6%)

```
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ...~~~~  DDDD~~~   =  ~~~
    ....~~~  DDDDD~~     = ~~
    .....~~  DDDDD~~     ==~~
```

**Code 0:5** - 3.06% of windows, inland flat - caption **tundra / plain / lowland** - geomorphon flat (78%, x2.6)  
labels: tundra x5.5 (29%), plain x2.6 (43%), lowland x4.4 (13%), bay x2.3 (7%)

```
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  ====== 
    ...~~~~  KKK~~~~  == ~~~~
```

#### Band 1: 1.32 deg/tile (147 km)

**Code 1:0** - 4.26% of windows, inland flat - caption **lowland / plain / tundra** - geomorphon flat (90%, x3.6)  
labels: lowland x8.6 (24%), plain x2.8 (42%), tundra x3.9 (19%), gulf x0.3 (2%)

```
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK   ======
    .......  KKKKKKK     ====
    .......  KKKKKKK     ====
    .......  KKKKKKK  =  ====
    .......  KKKKKKK  = =====
```

**Code 1:1** - 3.24% of windows, open water / islands - caption **island group / island / channel** - geomorphon flat (53%, x2.1)  
labels: island group x5.6 (55%), island x2.8 (28%), channel x2.1 (5%), strait x2.4 (4%)

```
    ~~~~n~~  ~~~~t~~  ~~~~ ~~
    ~~~~n~~  ~~~~t~~  ~~~~ ~~
    ~~~~n~~  ~~~~t~~  ~~~~ ~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
```

**Code 1:2** - 2.58% of windows, inland flat - caption **desert / plain / plateau** - geomorphon flat (58%, x2.3)  
labels: desert x5.5 (62%), plain x2.4 (37%), plateau x1.6 (28%), basin x2.0 (14%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 1:3** - 2.15% of windows, inland flat - caption **lowland / plateau / tundra** - geomorphon flat (49%, x2.0)  
labels: lowland x5.5 (15%), plateau x1.9 (33%), tundra x3.1 (15%), plain x1.9 (28%)

```
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .......  KKKKKKK  =======
    .....nn  KKKKKKK  =======
    ...nnnn  KKKKKKK  =======
```

**Code 1:4** - 1.98% of windows, open water / islands - caption **island group / island / strait** - geomorphon footslope (38%, x1.7)  
labels: island group x5.7 (56%), island x3.3 (33%), strait x3.7 (6%), isthmus x2.8 (1%)

```
    ~~~~~nn  ~~~~ccc  ~~~~ = 
    ~~~~n~~  ~~~ccc~  ~~~ = ~
    ~~~n~~~  ~~cc~~~  ~~ =~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
```

**Code 1:5** - 1.96% of windows, open water / islands - caption **channel** - geomorphon footslope (50%, x2.3)  
labels: strait x2.9 (5%), channel x2.2 (5%), island x1.4 (14%), coast x2.4 (1%)

```
    nnnnn~~  KKKcc~~  ==== ~~
    nnnn~~~  KKcc~~~  === ~~~
    nnn~~~~  cKKc~~~   =  ~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
```

#### Band 2: 0.588 deg/tile (65.3 km)

**Code 2:0** - 3.52% of windows, inland flat - caption **lowland / tundra / plain** - geomorphon flat (84%, x3.5)  
labels: lowland x10.1 (23%), tundra x5.2 (24%), plain x2.6 (35%), pen/cape x0.1 (1%)

```
    .......  KKKKKKK  =      
    .......  KKKKKKK  ==     
    .......  KKKKKKK  === =  
    .......  KKKKKKK  ===    
    .......  KKKKKKK  ===    
    .......  KKKKKKK   ==    
    .......  KKKKKKK   ===   
```

**Code 2:1** - 3.27% of windows, inland flat - caption **desert / depression / plain** - geomorphon flat (53%, x2.2)  
labels: desert x7.0 (70%), depression x19.0 (11%), plain x2.1 (28%), plateau x1.5 (22%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 2:2** - 2.99% of windows, inland flat - caption **plain / lowland / tundra** - geomorphon flat (78%, x3.2)  
labels: plain x3.0 (40%), lowland x8.2 (19%), tundra x3.7 (17%), gulf x0.3 (1%)

```
    .......  KKKKKKK         
    .......  KKKKKKK       ==
    .......  KKKKKKK       ==
    .......  KKKKKKK       ==
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 2:3** - 2.42% of windows, inland flat - caption **basin / foothills / plateau** - geomorphon flat (80%, x3.3)  
labels: basin x13.4 (90%), foothills x20.9 (31%), plateau x1.5 (22%), delta x4.2 (2%)

```
    .......  AAAAAAA  =======
    .......  AAAAAAA  =======
    .......  AAAAAAA  =======
    .......  AAAAAAA  =======
    .......  AAAAAAA  =======
    .......  AAAAAAA  =======
    .......  AAAAAAA  =======
```

**Code 2:4** - 2.16% of windows, inland flat - caption **desert / plain** - geomorphon footslope (31%, x1.6)  
labels: desert x6.8 (68%), plain x2.0 (26%), depression x8.1 (4%), pen/cape x1.4 (12%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    ....nnn  DDDDDDD         
    ...nnnn  DDDDDDD         
```

**Code 2:5** - 2.02% of windows, open water / islands - caption **island group / island / channel** - geomorphon flat (57%, x2.4)  
labels: island group x5.3 (60%), island x1.7 (20%), channel x2.8 (8%), strait x3.0 (6%)

```
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~nn~~~~  tAA~~~~     ~~~~
    ~~~~~~~  ~~A~~~~  ~~ ~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
    ~~~~~~~  ~~~~~~~  ~~~~~~~
```

#### Band 3: 0.26 deg/tile (28.9 km)

**Code 3:0** - 5.46% of windows, inland flat - caption **desert / depression / plain** - geomorphon flat (61%, x2.5)  
labels: desert x6.7 (62%), depression x13.0 (15%), plain x2.6 (33%), basin x1.9 (11%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 3:1** - 3.87% of windows, inland flat - caption **lowland / tundra / plain** - geomorphon flat (71%, x2.9)  
labels: lowland x9.8 (18%), tundra x4.6 (22%), plain x2.5 (33%), inlet x8.8 (0%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 3:2** - 2.98% of windows, inland flat - caption **lowland / tundra / plain** - geomorphon flat (69%, x2.9)  
labels: lowland x10.1 (19%), tundra x5.2 (25%), plain x2.4 (30%), gulf x0.1 (0%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK   ===   
    .......  KKKKKKK     ====
    .......  KKKKKKK       = 
```

**Code 3:3** - 1.97% of windows, inland hills - caption **range/mtn / plateau** - geomorphon slope (23%, x1.3)  
labels: range/mtn x2.0 (30%), plateau x1.9 (24%), pen/cape x0.8 (7%), plain x0.2 (2%)

```
    nnnnnnn  KKKKKKK         
    nnnnnnn  KKKKKKK  =      
    nnnnnnn  KKKKKKK  =      
    nnnnnnn  KKKKKKK         
    nnnnnnn  KKKKKKK         
    nnnnnnn  KKKKKKK         
    nnnnnnn  KKKKKKK         
```

**Code 3:4** - 1.90% of windows, inland flat - caption **desert / plain / depression** - geomorphon flat (31%, x1.3)  
labels: desert x6.5 (61%), plain x2.2 (28%), depression x7.6 (9%), pen/cape x1.1 (10%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    ....nnn  DDDDDDD         
```

**Code 3:5** - 1.89% of windows, inland flat - caption **wetlands / plain / delta** - geomorphon flat (82%, x3.4)  
labels: wetlands x25.6 (29%), plain x4.4 (56%), delta x5.9 (7%), foothills x3.9 (5%)

```
    .......  ccccccc         
    .......  ccccccc  =      
    .......  ccccccc  ==     
    .......  ccccccc  ===    
    .......  ccccccc   ==    
    .......  ccccccc         
    .......  ccccccc         
```

#### Band 4: 0.115 deg/tile (12.8 km)

**Code 4:0** - 4.97% of windows, inland flat - caption **basin / plain** - geomorphon flat (63%, x2.5)  
labels: desert x1.4 (49%), basin x2.3 (10%), plain x2.1 (10%), pen/cape x1.2 (25%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 4:1** - 3.01% of windows, inland flat - caption **unlabelled** - geomorphon flat (52%, x2.0)  
labels: plain x1.5 (30%), plateau x1.3 (26%), tundra x1.1 (22%), lowland x1.8 (4%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 4:2** - 2.23% of windows, inland flat - caption **delta / wetlands / plain** - geomorphon flat (75%, x2.9)  
labels: delta x1.8 (53%), wetlands x2.3 (28%), plain x1.6 (34%), pen/cape x1.2 (58%)

```
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
```

**Code 4:3** - 2.17% of windows, inland flat - caption **valley** - geomorphon flat (32%, x1.3)  
labels: desert x1.2 (39%), valley x2.4 (5%), basin x1.4 (7%), pen/cape x1.1 (25%)

```
    nnn....  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 4:4** - 1.93% of windows, inland flat - caption **lowland** - geomorphon flat (27%, x1.1)  
labels: plain x1.4 (19%), lowland x1.9 (9%), tundra x1.1 (28%), pen/cape x0.6 (6%)

```
    n......  KKKKKKK         
    n......  KKKKKKK         
    n......  KKKKKKK         
    n......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 4:5** - 1.82% of windows, inland flat - caption **basin** - geomorphon footslope (30%, x1.7)  
labels: desert x1.3 (45%), pen/cape x1.1 (29%), basin x1.6 (7%), valley x1.4 (2%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .nn....  DDDDDDD         
    ..n....  DDDDDDD         
```

#### Band 5: 0.051 deg/tile (5.66 km)

**Code 5:0** - 3.57% of windows, inland flat - caption **lowland** - geomorphon flat (56%, x2.0)  
labels: lowland x2.5 (19%), pen/cape x0.9 (3%), plain x0.9 (20%), plateau x0.9 (18%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 5:1** - 2.93% of windows, inland flat - caption **valley / plateau** - geomorphon flat (71%, x2.6)  
labels: desert x1.4 (44%), valley x1.7 (12%), plateau x1.6 (12%), basin x1.3 (10%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 5:2** - 2.07% of windows, inland flat - caption **delta / wetlands** - geomorphon flat (78%, x2.9)  
labels: delta x1.6 (66%), pen/cape x1.2 (77%), wetlands x1.6 (26%), plain x1.2 (29%)

```
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
```

**Code 5:3** - 1.98% of windows, inland flat - caption **plateau** - geomorphon flat (59%, x2.2)  
labels: island x1.4 (60%), plateau x1.8 (14%), delta x1.4 (18%), range/mtn x1.0 (19%)

```
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
```

**Code 5:4** - 1.89% of windows, inland flat - caption **basin** - geomorphon flat (76%, x2.8)  
labels: basin x1.9 (25%), plain x1.2 (9%), delta x1.3 (6%), pen/cape x1.1 (15%)

```
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
```

**Code 5:5** - 1.84% of windows, inland flat - caption **unlabelled** - geomorphon flat (36%, x1.3)  
labels: desert x1.3 (35%), plateau x1.4 (19%), valley x1.4 (11%), pen/cape x1.1 (4%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    nnn....  DDDDDDD         
```

#### Band 6: 0.0226 deg/tile (2.51 km)

**Code 6:0** - 3.45% of windows, inland flat - caption **delta / island** - geomorphon flat (72%, x2.5)  
labels: delta x1.5 (41%), island x1.8 (10%), basin x1.4 (16%), wetlands x2.1 (5%)

```
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
```

**Code 6:1** - 2.76% of windows, inland flat - caption **unlabelled** - geomorphon flat (70%, x2.4)  
labels: pen/cape x1.4 (8%), valley x1.5 (3%), plateau x1.1 (6%), desert x0.9 (22%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 6:2** - 2.72% of windows, inland flat - caption **lowland / delta** - geomorphon flat (64%, x2.2)  
labels: lowland x1.7 (21%), plateau x1.4 (20%), delta x1.7 (8%), plain x1.2 (14%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 6:3** - 2.42% of windows, inland flat - caption **foothills / wetlands** - geomorphon flat (90%, x3.1)  
labels: foothills x2.0 (41%), wetlands x2.3 (8%), pen/cape x1.4 (16%), delta x1.3 (15%)

```
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
    .......  ccccccc         
```

**Code 6:4** - 2.33% of windows, inland flat - caption **lowland** - geomorphon flat (37%, x1.3)  
labels: lowland x1.5 (6%), plain x1.2 (4%), plateau x1.3 (2%), island x1.1 (6%)

```
    nnn....  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 6:5** - 2.24% of windows, inland flat - caption **lowland** - geomorphon flat (23%, x0.8)  
labels: lowland x1.6 (6%), plateau x1.3 (3%), island x1.1 (4%), plain x1.2 (2%)

```
    .......  KKKKKKK         
    ..nn...  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

#### Band 7: 0.01 deg/tile (1.11 km)

**Code 7:0** - 3.87% of windows, inland flat - caption **unlabelled** - geomorphon flat (66%, x2.7)  
labels: delta x1.2 (12%), island x1.4 (5%), plain x1.0 (45%), sound x1.7 (2%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
```

**Code 7:1** - 3.72% of windows, inland flat - caption **unlabelled** - geomorphon flat (59%, x2.4)  
labels: desert x1.3 (48%), range/mtn x1.1 (41%), delta x1.0 (1%), pen/cape x1.0 (1%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
```

**Code 7:2** - 2.09% of windows, inland flat - caption **unlabelled** - geomorphon flat (37%, x1.5)  
labels: desert x1.1 (40%), delta x1.0 (5%), pen/cape x1.0 (5%), basin x1.0 (13%)

```
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    .......  DDDDDDD         
    ....nnn  DDDDDDD         
```

**Code 7:3** - 2.01% of windows, inland flat - caption **unlabelled** - geomorphon flat (84%, x3.4)  
labels: pen/cape x1.2 (40%), delta x1.1 (41%), isthmus x1.0 (28%), basin x1.0 (3%)

```
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
    .......  AAAAAAA         
```

**Code 7:4** - 1.99% of windows, inland flat - caption **delta** - geomorphon flat (53%, x2.2)  
labels: delta x1.7 (30%), island x1.4 (35%), island group x1.0 (29%), pen/cape x1.0 (24%)

```
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
    .......  ttttttt         
```

**Code 7:5** - 1.89% of windows, inland flat - caption **unlabelled** - geomorphon flat (31%, x1.3)  
labels: delta x1.2 (7%), tundra x1.0 (20%), island x1.2 (2%), plateau x1.0 (23%)

```
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    .......  KKKKKKK         
    nnn....  KKKKKKK         
    nnnnn..  KKKKKKK         
```

<!-- generated:end -->
