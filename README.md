# Terra-WBS

Convert real-world geographic data into a viable **Civilization IV** WorldBuilder
save (`.CivBeyondSwordWBSave`). Frame a region in the viewer, tune the
classification, preview the discrete Civ terrain, and export.

This build uses **real elevation** (NASA-derived), the **real 10 m Natural Earth
coastline + lakes**, a **real Köppen-Geiger climate map** (Beck et al. 2023,
30 classes, 1-km source downsampled to the working grid), and **real satellite
colour** (NASA Blue Marble, 2 km). The colour is only procedural as a fallback if
the satellite image fails to load; the **reseed** button varies that fallback
texture. The header pill reads `REAL ELEVATION · COAST · KÖPPEN · SATELLITE`.
Working grid is 4096×2048 (~9.8 km/px); the coastline vector renders windowed
and crisp when you zoom past the cutoff.

**Resolution ceiling (honest):** a single global raster can't feed a deep
single-region map — e.g. a Civ map of *just* Utah wants ~1 km/px locally, i.e. a
~40k-px global grid. That needs windowed reads from a full-res source (the
streaming path), not an embedded global raster. This build raises the ceiling
~4× over the old 512×256 but does not remove it.

## Run it

**Windows:** double-click `Terra-WBS.exe`. It opens the app in its own native
window (WebView2, the browser engine built into Windows 11) — no server, no
browser tab. The exe must stay in this folder next to `index.html` and `data\`.
Exports still arrive via the normal download flow (default: your Downloads
folder).

Two builds, identical behaviour:

- `Terra-WBS.exe` (~1 MB) — needs the .NET 7 Desktop Runtime (present on a
  machine with the .NET SDK).
- `Terra-WBS-standalone.exe` (~68 MB) — no .NET needed; use this one when
  sharing the folder. Only requirement is the WebView2 runtime, which ships
  with Windows 11 (and Windows 10 via Edge).

**Any OS (fallback):** run `python3 serve.py` and use it as a web app. Serving
over http is required only because browsers block `fetch()` of the `data/`
files from `file://`; the app itself is fully client-side (world build,
classification, WBS export all run in the page).

To rebuild the exe after changing the wrapper (`app/Program.cs`):

```powershell
# runtime-dependent (~1 MB)
dotnet publish app\TerraWBS.csproj -c Release -r win-x64 --self-contained false /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:DebugType=none -o app\publish
copy app\publish\Terra-WBS.exe .

# self-contained (~68 MB, no .NET required)
dotnet publish app\TerraWBS.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true /p:IncludeNativeLibrariesForSelfExtract=true /p:EnableCompressionInSingleFile=true /p:DebugType=none /p:AssemblyName=Terra-WBS-standalone -o app\publish-sc
copy app\publish-sc\Terra-WBS-standalone.exe .
```

Changes to `index.html` need no rebuild — the exe just loads whatever is in
the folder.

- Drag to pan, scroll to zoom. The viewer aspect is locked to the output grid
  (W×H), so what you frame is exactly what gets sampled into tiles.
- **Ctrl+drag rotates** the world behind the frame (−180…180°; soft-snaps at
  0/±90/180, hold Shift for 15° detents; ctrl+double-click or zoom-reset returns
  to north-up). Rotation happens *before* sampling: the civ preview, captured
  snapshots and the export all read the rotated frame at full fidelity, so a
  snapshot arrives in compose already rotated and fixed — compose itself never
  rotates anything. Rotation is defined in the plate-carrée pixel grid, so away
  from the equator a rotated frame shears in real-world terms (E–W scale ∝
  cos lat), same as the unrotated sampling contract. Axis tick labels hide while
  rotated (the readout shows the angle); a rotated frame never sets `wrap X`.
  The **box** mask stays rectangular *in the viewer* at any rotation, so a capture
  always crops to a clean tile rectangle instead of a staircase with empty
  corners; it keeps its grip on the geography through its diagonal. A **lasso**
  is freeform and stays pinned to the world, unchanged.
- View modes: satellite colour, elevation (hypsometric), roughness (heat ramp),
  Köppen climate (Beck et al. 2018 palette; ocean shown white), and the Civ tile
  preview.
- Elevation and roughness switch from the 4096-px base to the fine height tiles as
  soon as a base pixel would cover more than ~0.8 screen (CSS) pixels, i.e. just before
  the base would start to magnify, provided the view is regional (the padded view spans
  at most 1600 of the 2.5-degree tile cells, roughly an 80-degree window); past the
  vector cutoff below they are always on. The fine buffer is built with a margin around
  the view so dragging glides instead of re-snapping to whole base pixels.
- **Coastline panel** — *vector cutoff* sets the coarse↔crisp zoom switch; *island
  bias* (↑) lowers the land %% a coastal tile needs so small islands survive; *seaway
  bias* (↑) raises it in land-surrounded spots so channels (e.g. around Marajó) open;
  *small-island expander* (↑) enlarges islands smaller than 10% of the view area,
  each growing toward a cap of half the largest scaled island's area (never beyond;
  the smallest reaches it at max slider) so nothing overshoots; *expander steepness*
  (number box) shapes the area falloff. Land is filled per-polygon, so overlapping/
  expanded islands union (OR) instead of cancelling to sea. Vector regime only.
  A halo around each tile decides which regime it's in; the halo radius scales with zoom (larger when zoomed in) for stable classification at high zoom.
- **⟳ reseed climate** reseeds the moisture-driven colour & Köppen; real height &
  coastline are untouched.
- **hex grid (Civ5 import layout)** — Output grid panel checkbox. Civ5 imports a
  Civ4 map by placing square plot (x,y) on its hex plot (x,y): odd rows (in Civ5's
  south-origin count) sit half a tile east and rows are √3/2 ≈ 0.866 tile apart.
  In hex mode the app computes tiles on that lattice so the import lands right:
  sampling footprints on shifted rows move +½ tile east (including the crisp
  vector-coast regime), the viewer/sampling frame uses the 0.866 row pitch (so the
  imported map isn't ~15% vertically stretched), and game adjacency — coast
  detection, seaway/mountain-pass chokepoints — runs on the hex 6-neighbourhood
  instead of the square 8 (oasis spacing stays a mode-independent 3×3 box; the
  hex 6-ring packed them too densely). The civ preview draws real pointy-top
  hexagons (odd rows indented half a tile) with authentic jagged edges — the block
  is fitted with a thin margin so all four borders show the ragged hex teeth
  (half-tile zig-zag on the sides, sawtooth top/bottom). The export is still a
  normal Civ4 WBS. Known limits: rivers stay on the square lattice (Civ5's importer
  auto-converts them), so in the hex preview river lines cross shifted-row tile
  interiors — expected, not a bug; on regional (non-wrapping) maps the last tile
  of each shifted row samples ~half a footprint at the frame edge; edge-of-map
  adjacency doesn't wrap on wrap-X maps (same as square mode).
- **Generate** writes a `.CivBeyondSwordWBSave` and runs a validator
  (plot count = W×H, land↔plot-type consistency, starts on land, header present).
- **Save destination** (under the Generate button) controls where the file lands.
  In the WebView2 app (and any Chromium browser) *Choose folder…* lets you pick a
  target once — e.g. Civ4's `PublicMaps`, or
  `Documents\My Games\Beyond the Sword\CustomMaps` — and every Generate writes
  straight into it; the choice persists across restarts (permission is re-confirmed
  on the first save each session). The filename box sets the base name. If the
  folder API is unavailable (e.g. `serve.py` in Firefox) Generate opens a native
  *Save As* dialog, or as a last resort downloads to the browser's Downloads folder.
  Browsers only expose the chosen folder's *name*, not its full path, so the panel
  shows the folder name rather than an absolute path.
  The serializer lives in `scripts/civ4_wbs_core.js` (inlined in `index.html`, the
  two kept in sync like the rivers core; `scripts/civ4_wbs_test.js` validates both
  against the vanilla `PublicMaps/Europe.CivBeyondSwordWBSave` format). Format
  choices grounded in that vanilla map: with 0 players placed it writes 18
  `LeaderType=NONE` + `RandomStartLocation=true` seats (no team blocks) so the game
  seats any civ count. When civs *are* placed, all 18 civ slots are still written
  (the placed ones first, the rest as `LeaderType=NONE` fillers) plus 18 teams —
  BtS reads every slot at game init, and a file that defines only the placed
  players crashes (`findInfoTypeNum` → CTD) on the undefined ones. `Randomize
  Resources=true` is set because no `BonusType` lines are written; `wrap X=1` only
  when the frame spans the full 360° (regional maps get `wrap X=0`, like vanilla
  Europe). Output is written with
  **CRLF line endings** — Civ4's WorldBuilder parser is Windows-native and
  misreads LF-only files (token boundaries slip → a `findInfoTypeNum` error and a
  crash to desktop at game start), so CRLF is required, not cosmetic.

## How the coastline works

Height is now pure procedural terrain used only for colouring and relief — the
coastline owns land/water, so the height carries no coast cliff (which is why the
roughness view no longer spikes at coasts). The roughness map is a normalized
gradient computed on a height workspace that downsamples when zoomed out and
refines as you zoom in.

The coastline is used two ways, switched by zoom (the "Coastline" panel sets the
cutoff, in degrees of window width):

- **Outside the cutoff (zoomed out):** land/water comes from a coarse mask baked
  into the source at load — cheap, adequate when the coast is a few pixels wide.
- **Inside the cutoff (zoomed in):** only the coastline polygons intersecting the
  window are rasterized, at the window's own resolution — crisp coasts without
  ever rendering the whole globe at full detail. The Civ preview and the exported
  map use this same windowed land/water, so what you see matches what you get.

Polygon holes are filled with the even-odd rule, so inland lakes come out as
water automatically.

## Layout

```
Terra-WBS.exe                  Windows launcher (native window, no server)
Terra-WBS-standalone.exe       same, bundled .NET — for sharing the folder
app/                           source for the launcher (C# + WebView2)
index.html                     the app (self-contained; coastline embedded)
data/
  coast_reduced.json           simplified coastline embedded in index.html
  landmask_3600x1800.png       equirectangular land/water mask (batch pipeline)
  elev_4096.png                coarse base elevation (RG16), zoomed-out fallback
  hgt_tiles/                   fine elevation: 30 arc-sec (120 px/deg), 2.5-deg RG16 12-bit
                               tiles, LAND ONLY -- index.json carries a `tiles` manifest so
                               the app skips the dropped pure-ocean cells
scripts/
  civ4_wbs_core.js             viewer tile grid -> Civ4 WBSave serializer (inlined in index.html)
  civ4_wbs_test.js             serializer test suite (dual node/browser; no node needed)
  coastline_to_mask.py         land-polygon vector -> equirectangular raster mask
  reduce_coastline.py          land-polygon vector -> compact JSON for the app
```

## Regenerating the coastline data

All coastline sources are WGS84 lon/lat land polygons, so the same scripts work
for Natural Earth (public domain), GSHHG, or OSM land polygons. Natural Earth
ships GeoJSON; GSHHG/OSM ship shapefiles (read those via `fiona` and yield
`feat["geometry"]` the same way).

```bash
pip install rasterio numpy pillow

# 1) batch equirectangular land/water mask (for whole-map generation)
python scripts/coastline_to_mask.py ne_50m_land.geojson --width 3600 --height 1800 --stem landmask

# 2) compact coastline for the interactive app (windowed LOD renderer)
python scripts/reduce_coastline.py ne_50m_land.geojson --eps 0.04 --out coast_reduced.json
#    then embed: replace the `const COAST=...;` value in index.html with the file contents
```

Lower `--eps` for higher fidelity (e.g. GSHHG full resolution); raise it for a
smaller embed.

```bash
# real elevation -> equirectangular height PNG (embed as ELEV_SRC data: URL)
python scripts/dem_to_height.py etopo_2022_60s.tif --width 2048 --height 1024 --out elev.png
```

## Coordinate conventions

Everything is plate carrée (equirectangular, EPSG:4326 as a pixel grid), row 0 =
north. Rasters get reprojected into this space once; the coastline vector, already
in lon/lat, needs no reprojection. The Civ south-origin flip happens only at
serialize time.

## Data provenance

- Coastline & lakes: Natural Earth 1:10m land + lakes (public domain).
- Köppen: Beck et al. (2023) high-resolution (1 km) Köppen-Geiger map
  (`koppen_geiger_0p00833333.tif`, CC BY 4.0, gloh2o.org), area-majority
  downsampled to the 2048×1024 working grid and embedded as the class-index
  `KOPPEN_SRC` PNG. Class indices 1-30 and the display palette follow the
  bundled `legend.txt`. (`scripts/koppen_to_zones.py` remains for the older
  Rubel-Kottek rasterization path.)
- Satellite colour: NASA Blue Marble Next Generation, Aug 2004 topography
  composite (`world_topo_200408_3x21600x10800_geo.tif`, 2 km, public domain),
  area-averaged to the 4096×2048 working grid and embedded as `SAT_SRC` (lossless
  PNG data: URL). Loaded into `colorArr`, so the colour view and all colour-based
  classification use real imagery: the moisture split (grass/plains/desert)
  includes a steppe brightness split, an iron-red arid-soil rule (saturated red
  hue in B climates → desert, catching Australia/Somalia), and a salt-pan rule
  (bright + desaturated, or a high white-pixel fraction, inside an arid B climate
  → desert, immune to the cold override — this is how bright white is read as a
  salt flat rather than snow). Snow-capped ranges are caught by the white-pixel
  *fraction* per tile (the "Alpine cold" tilt), not by average colour, since tile
  averaging washes thin snow into "plains". If the load fails, the procedural
  interior is used as a fallback. To swap the source, replace `SAT_SRC` in `index.html`.
- Elevation: **ETOPO 2022** (NOAA, public domain). The fine `data/hgt_tiles/` are
  generated from the 30 arc-second surface DEM at native 120 px/deg (2× finer than the
  60 px/deg satellite, so elevation is now the finest raster layer), packed RG16 at 12-bit
  precision, on a 2.5-deg grid, **land only** — pure-ocean cells are dropped and the
  survivors listed in `index.json`'s `tiles` manifest. The coarse `data/elev_4096.png` base
  is the zoomed-out fallback. Regenerate with `scripts/elev16.py` (see its header). Norway's
  snow is still driven by the satellite snow-fraction rather than altitude, a holdover from
  the old low-fidelity bump map. `scripts/dem_to_height.py` remains as a simpler single-PNG
  path (embed as `ELEV_SRC`).

## Next steps (not yet done)

- (done) Rivers: HydroRIVERS vectors, rasterized on demand onto the tile grid,
  then projected to Civ's edge-based rivers. See "Rivers" below.
- (done) Features: forest, jungle, flood plains, oasis. See "Features" below.

## Rivers

HydroRIVERS v10 (global, ~8.5M reaches) is pruned to an app-sized subset by
`scripts/reduce_rivers.py` and shipped as `data/rivers.json`
(`{schema, features:[{d, l}]}` — `d` = average discharge in m3/s, `l` =
downstream-ordered lon/lat polyline; HydroRIVERS vertices already run downstream,
so no separate flow field is needed). The current file is `ORD_FLOW <= 4`
(>= 100 m3/s), simplified to 0.008 deg: 273k reaches, ~16 MB.

HydroRIVERS v10 (global, ~8.5M reaches) is pruned to an app-sized subset by
`scripts/reduce_rivers.py` and shipped as **terminal-tiled** files under
`data/river_tiles/` (`<tx>_<ty>.json` on a 20 deg grid + a `manifest.json` listing each
tile's bbox). Each tile holds whole channels (see below) whose TERMINAL falls in that grid
cell, so no channel is split across files; the app loads only the tiles whose bbox overlaps
the current view. Per-reach records are `{d, c, l}` — `d` = avg discharge m3/s, `c` = channel
id, `l` = downstream-ordered lon/lat polyline.

Channel decomposition: at each confluence the highest-discharge upstream branch continues the
channel and the others start new channels, so the main stem, each tributary, and each
distributary become distinct channels ranked independently by the "Show top-N rivers" slider
(top-1 over the Amazon is the main stem alone, not the whole watershed).

Koppen-weighted keep: a channel is kept if its peak discharge clears a threshold that depends
on the climate at its terminal (sampled from `data/koppen_2048.png`): arid BW deserts keep the
smallest rivers (>= ~1 m3/s), semi-arid BS steppes keep small (>= ~10), everywhere else keeps
only the base (>= ~100). This preserves the small desert rivers that are prominent in dry
regions without ballooning the total. Inland deltas / endorheic sinks are handled naturally —
a channel is tiled and climate-sampled wherever it drains, ocean or inland.

The same set is drawn (blue, 8% tile width) and written to the save — WYSIWYG.

Centerline -> Civ edges (corner-snap): each reach vertex is snapped to the nearest tile
corner and consecutive corners are Manhattan-connected; because consecutive reaches share
endpoints, each channel renders as one connected chain. Edges map to Civ flags as:
horizontal edge = south edge of the tile to its north (`isNOfRiver` +
`RiverWEDirection`), vertical edge = east edge of the tile to its west
(`isWOfRiver` + `RiverNSDirection`); N=0,E=1,S=2,W=3. Edges touching a coast tile or
between two water tiles are dropped. The rasterizer + serializer mapping is validated offline
by `scripts/rivers_test.js` (`node scripts/rivers_test.js`); the same logic is inlined in
`index.html`.

Four-sided tiles (river edges on all four sides — invalid in Civ) and hairpin wraps (a river
looping around three sides of one tile) are cleared by a single post-pass, `nudgeRiverEdges`.
Phase 1 deletes edges to clear every four-sided tile while preserving *per-channel*
connectivity: a single-channel wrap is a same-channel cycle, so it drops the junction-free arc
(or the whole zero-net loop); a multi-channel enclosure prefers deleting the weakest channel's
whole edge-group when every corner it fully owns is bare — each severed end then lands on a
corner shared with the surviving channel, so the tributary reads as braiding into the bigger
river for one tile (no stub, no leftover wrap) — otherwise it deletes the single edge that
hurts its own channel least (redundant > tip-trim > mid-course split). Phase 2 is the actual
nudge: a 3-edge single-channel wrap with bare interior corners is replaced by the one-edge
chord on the missing side — identical endpoints, so connectivity is exact — guarded so it never
creates a four-sided tile and never places an edge that touches coast/water. Verified on live
data (Amazon/Louisiana/Ganges/Congo/Europe): zero four-sided tiles remain, hairpin wraps drop
~75–90%, and no channel is ever left with a floating fragment.

```bash
pip install pyogrio geopandas shapely numpy pillow
python3 scripts/reduce_rivers.py HydroRIVERS_v10.gdb --koppen data/koppen_2048.png \
    --out-dir data/river_tiles
```

## Features

Forest, jungle, flood plains and oasis are placed by `applyFeatures` as a
**post-pass after river edges are known** (flood plains need river adjacency,
and river edges are only resolved once tiles are classified). The "emit
features" toggle gates the whole pass; placement is seeded so the preview and
the exported save always agree, and **⟳ re-roll features** just bumps the seed.
Terrain gates follow Civ4 validity: jungle on grassland only, forest on
grass/plains/tundra, flood plains and oasis on flat desert.

- **Flood plains** — flat desert tiles that carry a river edge. Score =
  satellite colour contrast against the surrounding desert (green/dark strips
  like the Nile score high; bright/desaturated salt strips score lower but
  positive) blended with the reach's discharge, plus ~20% seeded randomness.
  The *Flood-plain amount* slider sets the score threshold. Because the colour
  of a green floodplain would otherwise pull the tile to plains/grass, the
  classifier keeps true-desert Köppen (BWh/BWk) tiles as desert when *keep arid
  deserts* is on — turn it off for plains/grass colour variety on zoomed-in
  regional maps (where flood plains matter less).
- **Forest & jungle** — a climate prior (Köppen group) is the base rate, nudged
  up by relief (forests cluster on hills/rough ground) and by colour contrast
  (forest reads darker than open cropland; taiga reads greener than the browner
  open tundra), then drawn against the seed. The prior is deliberately
  *potential / pre-industrial*, not present-day cover: Blue Marble shows cleared
  cropland where temperate forest once stood, so a colour-only rule would
  under-forest exactly the historically wooded regions. A real potential-natural
  -vegetation raster (e.g. Hengl et al. 2018, or Ramankutty–Foley) would be the
  data-driven upgrade, mirroring how Köppen and satellite became real layers.
- **Oasis** — flat desert, no river, not on a coast, with a green/wet colour
  anomaly, kept from clustering (no two adjacent oases). Forest, jungle and oasis
  densities are slider-controlled (oasis density is tied to the flood-plain slider).

- **Special tiles** — a game-agnostic marker (`markSpecialTile`, `t.special`) for
  tiles that get a per-game treatment on the rectangular grid (a hex mode may add
  its own adjacency later). Currently a flat-desert tile sitting in a river's
  *corner* bend (a would-be oasis, but the river only touches its corner vertex,
  not an edge) is marked. The **Civ4 specialisation** gives it one random bonus —
  incense (on desert), or wheat / dye / horses / ivory (on plains) — written to
  the save as a `BonusType`. `Randomize Resources=true` is kept: Civ4's
  `addBonuses()` skips plots that already have a bonus, so these survive alongside
  the game's own random resources.

- Higher-resolution colour analysis: the satellite source is 2 km, but the
  working grid is 4096×2048 (~9.8 km/px), so per-tile colour is averaged at
  that scale. The grid size is the single constant `WSRC,HSRC` in `index.html`;
  raising it further is possible but memory/compute scale with it (a browser tops
  out well below the source's native 2 km), so the windowed streaming path below is
  the real fix for finer analysis.
- Decide the consume-side architecture (browser loading rasters vs a Python
  backend serving windowed COG reads) before scaling past whole-Earth zoom.
