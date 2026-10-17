# OpenFront maps (`games/openfront/export_openfront.py`)

[OpenFront](https://openfront.io) maps are pixel maps: one tile per pixel, water
or land, with a land magnitude 0–30 that the game reads as plains (< 10),
highland (< 20) or mountain. The exporter builds the frame with Terra Form's
core (`terraform/frame.py`, the pipeline Culture Wars' world pack uses too: same
elevation, OSM coast, curated lakes, playas and island expander), so only the
OpenFront parts, in this folder, are new:

- **Land classifier.** The magnitude follows elevation on a square-root scale
  through three anchors: plains below 250 m, highland below 1000 m, and 30 from
  2250 m (`--plains-top/--highland-top/--mountain-top`). These come from
  OpenFront's own World map. Registered on our layers (97.8 % land agreement),
  its magnitude is a function of elevation alone, ≈ 0.63·√metres. Our classifier
  reproduces its terrain type on 85 % of land tiles, and the
  plains/highland/mountain mix to within ~2 points.
  Africa, Mena and Australia follow the same curve. `--mix 40,45` sets the
  anchors from the frame's own land heights instead, the way OpenFront's
  regional maps stretch their relief.
- **Desert depends on the map.** The maps above give desert no lift. Some of
  the desert maps (Horn of Africa, the Levant, the Middle East, Bab el-Mandeb)
  draw desert as mid-rough terrain, highland ~12-15, with only a low coastal
  strip left as plains. `--desert [MAG]` follows that convention. Köppen BW
  land is at least magnitude MAG (default 12), on a square-root ramp that
  reaches highland at 50 m. A big river's valley floor (≤ 15 km from a channel
  of ≥ 100 m³/s, ≤ 30 m above it) keeps its elevation magnitude, so the Nile
  and the Euphrates stay plains. On those four maps it lifts the desert tiles'
  terrain-type agreement from 50-70 % to 64-80 %. On the elevation-style maps
  it would cost 6-27 points, so it is off by default. Steppe (BS) is never
  lifted: that helped on none of them. `--rivers 1|2|3` cuts
  channels of that class and larger into the land as navigable water.
- **Output.** It writes the map generator's input, `image.png` (a 32-colour
  palette PNG in OpenFront's own map palette, blue 106 = water, land blue
  = 140 + 2·magnitude, both sides multiples of 4) and `info.json` (id, name,
  translation key, categories, frequency, nations). By default the size is
  2.5 M tiles. The aspect is equirectangular with the columns squeezed by
  cos(mid-latitude), so the frame's middle is true to shape (`--aspect plate`
  keeps square degrees).
- **Nations.** These are the best-scoring sites of the curated gazetteer
  (`data/seats/historic_*.csv`) under the frame, snapped onto land the
  generator keeps and spaced out. `--nation-names country` gives one per
  country, named after it. Flags come from `resources/countries.json` of the
  OpenFront checkout given as `--openfront`. `--nations-file` takes your own
  list.
- **Compiled files.** `--compiled DIR` also writes OpenFront's runtime files
  (`map.bin`, `map4x.bin`, `map16x.bin`, `manifest.json`, `thumbnail.webp`)
  through `games/openfront/openfront_compile.py`. That is a port of OpenFront's Go
  generator, checked byte for byte against its shipped maps by
  `games/openfront/openfront_compile_test.py` (it needs an extracted OpenFront
  checkout: `--openfront <folder>`). `--preview PNG` draws the compiled map
  in the game's colours.

```bash
python games/openfront/export_openfront.py --bounds 19 34 30 42 --name "Aegean Sea" \
    --openfront C:/src/OpenFrontIO --out C:/src/OpenFrontIO/map-generator/assets/maps/aegeansea \
    --preview aegean_preview.png
cd C:/src/OpenFrontIO && npm run gen-maps     # compiles and registers the map (needs Go)
```

The output folder's name must be the lowercased id (`AegeanSea` → `aegeansea`).
A map only appears in the game once `gen-maps` has added it to `Maps.gen.ts`, so
`--compiled` is for checking what the game will see, not for skipping that step.
The script prints the data credits for OpenFront's `CREDITS.md`; the
OpenStreetMap coast is ODbL, and a map made from it is a produced work that
needs the credit line.

Every option is in `python games/openfront/export_openfront.py --help` (the
module docstring); the frame, `--*-source` and `--island-*` arguments are the
shared ones from `terraform/cli.py`.
