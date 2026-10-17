# Game modules

Terra Form is game-agnostic. The core (`core/app.js`, loaded by `index.html`, and the `terraform/` Python
package for batch work) reads the real world and measures it; everything a particular game needs
lives in `games/<id>/`:

| | in the app (`games/<id>/module.js`) | batch (`games/<id>/*.py`) |
|---|---|---|
| 1. grid | `grid`: square or hex lattice, min / max / default size, step | the exporter's own `--width` / `--ppd` / `--pixels` arguments |
| 2. classifier | `classify(samples)`: per-tile measurements -> the game's tiles | the script's own functions on `terraform.Frame` layers |
| 3. export | `export.build(region)`: the map file(s) | the script's writer |

Nothing in the core knows a game's vocabulary (no `TERRAIN_GRASS`, no magnitude 0..30, no hex).
To add a game you write one folder and list its script in `index.html`; no core change, no PR.

```
games/
  civ4/           Civilization IV: classifier, features, preview, .CivBeyondSwordWBSave writer (wbs_core.js + wbs_test.js)
  civ5/           Civilization V: the Civ4 module on the hex lattice (Civ5 imports the Civ4 save)
  openfront/      OpenFront: preview + image.png/info.json in the app; the full exporter and generator port in Python
  culture_wars/   Culture Wars (local, WIP): frame picker in the app; world-pack and city-site exporters in Python
```

## The app contract (`window.TerraForm`)

`index.html` defines a tiny registry before the module scripts load, then the app fills in the
helpers. A module is a classic script (no ES modules: the Windows launcher and `serve.py` both
serve the folder as-is) that calls `TerraForm.registerGame({...})`. Everything it reads from the
core it reads at call time through `TerraForm.util`, never at load time.

```js
(function () {
  const T = window.TerraForm;
  T.registerGame({
    id: 'mygame', name: 'My Game',                       // id = the folder name; name = the Game selector label
    grid: { kind: 'square',                              // 'square' | 'hex' (odd-r, Civ5 style: odd rows half a tile east, row pitch sqrt(3)/2)
            min: { W: 8, H: 8 }, max: { W: 256, H: 256 }, default: { W: 64, H: 40 }, step: 1 },   // step: sizes snap to a multiple
    classify(S, ctx) { ... return { tiles }; },          // required: tiles[y][x] = any object you like, row 0 north
    features(tiles, S, rivers, ctx) { ... },             // optional: a pass after the river edges exist (Civ4 lays flood plains here)
    finalize(tiles, W, H) { ... },                       // optional: re-derive adjacency-dependent fields after tiles were rearranged (compose, mask crop); Civ4's ocean-vs-coast ring
    isWater(t) { return ...; },                          // required: the core counts land, stamps "land only" patches and keeps rivers off water with this
    blankTile(kind) { ... },                             // required: 'water' | 'barrier' (the Mountain-fill toggle) for mask margins and the compose canvas
    validateTile(t) { return null | 'what is wrong'; },  // optional: pasted snapshots are checked tile by tile
    preview: { color(t) -> [r,g,b],                      // required
               glyph(g, t, px, py, w, h) { ... },        // optional: draw over the tile (hills, oasis...) on the 2D context g
               legend() -> [[label, [r,g,b]], [label, null, 'Λ'], ...] },   // required: swatches, or a text glyph instead of a colour
    sizeLabel(W, H) -> 'STANDARD',                       // optional: the "world size" stat
    ui: { rail: '<button ...>',                        // optional: controls mounted on the rail outside any panel (Civ4's Emit Features toggle)
          panels: [{ section, title, help, html }],      // optional: inspector panels mounted once, shown while this game is active
          bind(api) { ... }, refresh() { ... } },        // bind listeners (api below); refresh the readouts
    export: {
      caption: 'MY GAME · FMT', ext: '.ext', title: 'tooltip',   // caption: the Export settings tag; ext: the file suffix shown and stripped from the name box
      pickerType: { description, accept },               // optional: the Save As file type (single-file exports)
      optionsHTML: '<div class="ctl">...</div>',         // optional: controls under "Export settings"; bindOptions(api) wires them
      async build(region, ctx) { return { files: [{ name, data: string|Blob, mime }], dir? }; },   // required
      validate(region, built, ctx) -> [[label, ok, detail], ...],   // optional: the Validation list
      note(region, ctx) -> 'text'                        // optional: appended to the save hint (e.g. the matching Python command)
    }
  });
})();
```

Add the script to `index.html` under the other game modules (`<script src="games/mygame/module.js">`),
after any file it depends on (Civ4 loads `wbs_core.js` first; Civ5 is registered after Civ4
because it reuses that module object).

### What `classify` receives: `samples`

`S` describes the framed region on the game's grid, one entry per tile, row-major, row 0 north.
Typed arrays of length `S.W * S.H` unless noted:

| field | meaning |
|---|---|
| `h` | height, 0..1 on the RG16 scale (`TerraForm.util.heightMetres(h)` gives metres; 0 = -500 m, 1 = 6000 m) |
| `rough` | normalised roughness (gradient magnitude) at the viewer's smoothing halo |
| `reliefHill`, `reliefPeak` | the two relief metrics: per-view land percentiles blended between raw height and roughness by the Elevation panel |
| `relief` | `Uint8`: 0 flat, 1 hills, 2 peak from the Elevation panel's thresholds, after its mountain-pass and flat-spot passes; 0 on water |
| `land` | `Uint8`: 1 land, 0 water, after the coast halo (island / seaway bias) and the seaway carving |
| `landFrac` | the raw land fraction of the tile's footprint |
| `kc` | `Uint8`: dominant Köppen class 1..30 (`TerraForm.util.KOPPEN_KEYS[kc]`, `classGroup(kc)`), 0 none |
| `r`, `g`, `b` | mean satellite colour of the footprint (0..255) |
| `white` | fraction of the footprint that is snow/salt white |
| `playa` | fraction inside a Natural Earth salt-pan polygon |
| `lat` | latitude of the tile centre (rotation-aware) |
| `polar` | 1 at an ET/EF zone, decaying outward (~1/e per 8°) |
| `surrArid`, `surrTemp` | the surrounding non-white land tiles: arid (B) fraction and mean base temperature |
| `moistJit` | a smooth low-frequency ±0.08 field for dithering moisture thresholds (reseeded by the texture button) |

`ctx` is `{ W, H, hex, grid }`. `rivers` (in `features`) is `{ nof, wof }`: maps keyed `'row,col'` of
river edges on the square lattice (`nof` = the north edge of tile (col,row), `wof` = its west edge),
each `{ dir, d (discharge m³/s), rid, bridge? }`. `TerraForm.util.tileRiverDischarge(rivers,x,y)` and
`atRiverCorner(rivers,x,y,W,H)` read them.

### `TerraForm.util`

`clamp01`, `hsv(r,g,b) -> [hue, sat, val]`, `fhash(x,y,seed)` (deterministic 0..1 per tile),
`vnoise`, `classGroup(kc)` (0 EF, 1 ET, 2 arid, 3 tropical, 4 temperate, 5 continental),
`KOPPEN_KEYS`, `KOPPEN_TEMP` (per-class base temperature, 1 hot .. 0 cold), `KOPPEN_PALETTE`,
`BECK2018`, `colorAridity(hue,sat,val)`, `heightMetres(h)`, `elevColor(h)` (the viewer's hypsometric
ramp), `latOf`, `lonOf`, `wrapLon`, `gridRing(y,H)` (the 8- or 6-neighbourhood of the active
lattice, in circular order), `hexShiftX(y,H)`, `isShoreAt(tiles,W,H,x,y)`.

### `api` (given to `ui.bind` and `export.bindOptions`)

`invalidate()` re-evaluates the frame (call after a parameter changed), `rerender()`,
`legendChanged()` (after something that changes `preview.legend()`),
`refreshStats()`, `makeMultiSlider(el, opts)` (the coupled multi-thumb slider the
Elevation panel uses).

### `region` (given to `export.build` / `validate`)

`{ tiles, W, H, samples, rivers, land, hills, peaks, topLat, botLat, bounds: {W,S,E,N}, frame,
wrapX, hex, game }`. In compose mode `samples` is absent and the latitudes are nominal.
`ctx` is `{ mode: 'frame' | 'compose', hex, riverN, patches, baseName }`.

### Snapshots and compose

A snapshot records `game` (its id) and the tiles as the module made them. Placing a snapshot from
another game on the compose canvas is allowed but warned about: the tiles are stamped as they are
(tagged `_g` with their game id and drawn magenta) and exported unchanged. `registerGame` rejects a
module missing `id`, `grid` (min/max/default), `classify`, `isWater`, `blankTile`, `preview.color`,
`preview.legend` or `export.build`.

## The Python contract (`terraform/`)

`from terraform import Frame, build_elevation, build_koppen, build_landmask, river_shapes, ...`
gives a lon/lat frame at a pixel density and its raw layers (elevation in metres, land mask with
the curated lakes and the island expander, Köppen classes, river channels, salt pans).
`terraform.cli.add_frame_args(parser)` adds the shared `--bounds / --ppd / --width / --*-source /
--island-*` arguments so every game exporter takes the same frame the same way. A game exporter
is any script that builds its format from those layers; see `games/openfront/export_openfront.py`
(a classifier + writer + CLI in one file) and `games/culture_wars/export_world_pack.py`.
