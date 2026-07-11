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

Open `index.html` in a browser. It is self-contained: the reduced coastline is
embedded, and everything else (world build, classification, WBS export) runs
client-side. No server, no build step needed to just use it.

- Drag to pan, scroll to zoom. The viewer aspect is locked to the output grid
  (W×H), so what you frame is exactly what gets sampled into tiles.
- View modes: satellite colour, elevation (hypsometric), roughness (heat ramp),
  Köppen climate (Beck et al. 2018 palette; ocean shown white), and the Civ tile
  preview.
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
- **Generate** writes a `.CivBeyondSwordWBSave` and runs a validator
  (plot count = W×H, land↔plot-type consistency, starts on land, header present).

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
index.html                     the app (self-contained; coastline embedded)
data/
  coast_reduced.json           simplified coastline embedded in index.html
  landmask_3600x1800.png       equirectangular land/water mask (batch pipeline)
scripts/
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
- Elevation (bundled): a NASA-derived Earth elevation bump map from a public
  globe-rendering repo — convenient but of informal provenance, and it materially
  **underrepresents some ranges**: e.g. the Scandes read a max height of ~0.32
  (below the 0.5 sea reference) versus the Alps ~0.50 and Tibet ~0.88. That is why
  Norway's snow is driven by the satellite snow-fraction rather than by altitude —
  an altitude tilt keyed on this DEM cannot see Norway's mountains. For anything
  beyond prototyping, regenerate from a clearly-licensed DEM (ETOPO 2022 is public
  domain; GEBCO / Copernicus are open) with `scripts/dem_to_height.py`, then embed
  the PNG as a data: URL in `index.html`'s `ELEV_SRC`.

## Next steps (not yet done)

- (done) Rivers: HydroRIVERS vectors, rasterized on demand onto the tile grid,
  then projected to Civ's edge-based rivers. See "Rivers" below.

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

```bash
pip install pyogrio geopandas shapely numpy pillow
python3 scripts/reduce_rivers.py HydroRIVERS_v10.gdb --koppen data/koppen_2048.png \
    --out-dir data/river_tiles
```
- Higher-resolution colour analysis: the satellite source is 2 km, but the
  working grid is 4096×2048 (~9.8 km/px), so per-tile colour is averaged at
  that scale. The grid size is the single constant `WSRC,HSRC` in `index.html`;
  raising it further is possible but memory/compute scale with it (a browser tops
  out well below the source's native 2 km), so the windowed streaming path below is
  the real fix for finer analysis.
- Decide the consume-side architecture (browser loading rasters vs a Python
  backend serving windowed COG reads) before scaling past whole-Earth zoom.
