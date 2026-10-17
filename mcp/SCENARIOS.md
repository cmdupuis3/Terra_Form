# Acceptance scenarios for the Terra Form MCP

Four end-to-end prompts an agent should be able to satisfy with the tool surface, each with the tools it should
reach for and machine-checkable assertions on the feedback block. `node mcp/scenarios.mjs` plays each one through
the real MCP tools (the sequence an agent would issue), evaluates the assertions from the `describe` JSON and the
glyph grid, writes thumbnails and a results file to `mcp/scenarios/`, and exports each map to `mcp/out/`.
Assertion failures are findings about the tool surface, not things to paper over: the last section lists them.

Canvases are larger than the prompts' suggested sizes (the owner allowed large resolutions), so catalog pieces
keep their natural tile sizes.

## Scenario 1 — Earthlike alien world (Civ4, 120x78 canvas)

**Prompt.** "Build an Earthlike world that is not recognisable as Earth: 4-6 continents of varied size, polar
caps top and bottom, tropics in the middle, at least two inland seas and one large archipelago."

**Tools to reach for.** `catalog_search` (peninsula, polar, island), `snapshot_from_catalog`, `flip_snapshot`
(to disguise recognisable shapes and to turn the Antarctic coast into a north cap), `compose_new` with
`latitudes:{top:80,bottom:-80}`, `place`, `erase` (inland seas), `scatter` (the archipelago), `describe`,
`compose_view`, `export`.

**Assertions.**

| assertion | how it is measured |
|---|---|
| land 28-38% | land glyphs over the canvas |
| 4-6 landmasses with >= 60 tiles, plus >= 8 landmasses under 20 tiles | `describe.landmasses` |
| snow/tundra only in the top and bottom 15% of rows | `s t S T` glyphs per row |
| tropical Köppen groups only in the middle 40% of rows | `describe.rows[].groups[3]` |
| >= 2 inland seas | `describe.seas[].inland` |
| zero seam-lint warnings | `describe.warnings` |
| >= 80% of river systems reach water | `describe.rivers` |

## Scenario 2 — A desert (Civ4, 72x48 frame)

**Prompt.** "A desert map with a Nile-like exotic river running from a mountain rim to the sea, an oasis belt
along the river, a salt pan basin, and a semi-arid steppe fringe on one edge."

**Tools to reach for.** `catalog_search` (desert, exotic-river, salt-pan), `set_frame` on "Sahara and the
Nile", `tune` (features on, flood-plain amount, oasis density, relief thresholds, top-N rivers), `frame_view`
with `overlay:'rivers'`, `describe`, `export`. Single-region augmentation: no compose canvas.

**Assertions.**

| assertion | how it is measured |
|---|---|
| desert >= 55% of land (flood plains and oases count as desert) | `d D r o` glyphs |
| plains/grass <= 25% of land | `g p G P f F` glyphs |
| plains/grass within 3 tiles of the river or on the steppe edge (>= 80% of them) | `=` tiles of the river overlay, Chebyshev distance 3; the north edge rows 0-3 count as the steppe fringe |
| >= 1 river with >= 15 edges reaching the coast | `describe.rivers.systemsTop` |
| hills+peaks 10-25% of land | `describe.landmasses[].hills/peaks` |
| relief forms a connected ridge along one side | largest `describe.spines` holds >= half the relief and its bbox touches a map side |
| flood plains present along the river | `r` glyphs |

## Scenario 3 — A tropical island chain (Civ4, 96x60 ocean canvas)

**Prompt.** "An ocean map with a curving chain of atolls and a few larger volcanic islands, spaced so none touch,
a size gradient from big in the southwest to tiny in the northeast."

**Tools to reach for.** `catalog_search` (atoll, volcanic, single-island), `snapshot_from_catalog` (the entries
carry island-expander params so islets survive sampling), `compose_new`, `scatter` along arc segments with a
different snapshot list per segment (big volcanic islands south-west, atolls north-east), `describe`.

**Assertions.**

| assertion | how it is measured |
|---|---|
| land 6-14% | land glyphs |
| 12-30 landmasses | `describe.landmassCount` |
| no two landmasses adjacent (8-neighbourhood) | holds by construction: landmasses are 8-connected components |
| 2-4 landmasses >= 20 tiles, the rest <= 6 | `describe.landmasses[].size` |
| centroids fit a circle, mean residual <= 2 tiles | algebraic circle fit on `landmasses[].at` |
| size correlates with position along the arc | Pearson of angle-around-the-fitted-centre vs log size, |r| >= 0.5 |
| all land tropical (A group) or arid-coastal | `landmasses[].climate[0]` |

## Scenario 4 — A temperate region with mountain chains (Civ4, 112x70 canvas)

**Prompt.** "A temperate land with two mountain chains meeting at a knot, forested windward slopes, drier basins
in the lee, rivers draining from the ranges to two different coasts."

**Tools to reach for.** `catalog_search` (mountain-chain, mountain-wall, two-coasts, rain-shadow),
`snapshot_from_catalog` with a `bounds` override (the Caucasus isthmus wide enough to enclose the Caspian),
`place` with `landOnly:false` (keeps the Caspian as an inland sea), `attach` (the Cascades' east edge onto the
Caucasus' west edge, overlapping so the N-S and E-W chains meet), `tune` (forest density, relief thresholds,
more rivers), `describe`, `compose_view`.

**Assertions.**

| assertion | how it is measured |
|---|---|
| temperate/continental >= 70% of land | `describe.rows[].groups` |
| hills+peaks 18-35% of land | `describe.landmasses` |
| 1-2 chains >= 25 tiles with a junction | `describe.spines` (junction: not machine-detected, see findings) |
| forest density on one side of the main chain >= 1.5x the other | `f F` glyphs split by the main spine's axis |
| grass/plains ratio flips across the chain | `g G` vs `p P` glyphs per side |
| zero truncated-wall warnings | `describe.warnings` |
| >= 2 rivers reaching distinct coasts (different water bodies) | `describe.rivers.seasReached` |

## Results

See [scenarios/RESULTS.md](scenarios/RESULTS.md) for the full transcripts (the final tool-call sequence, every
feedback block, the describe paragraph and warnings) and `scenarios/s1.png` .. `s4.png` for the thumbnails.
Summary and findings below.

### Summary (three runs; the sequence in `scenarios.mjs` is the best one per scenario)

| scenario | pass | notes |
|---|---|---|
| 1 Earthlike alien world | 4 / 8 | climate bands, caps, inland seas and the archipelago hold; land share (24.7%), continent count (7: the two cap strips count), seam lint and river continuity fail |
| 2 A desert | 7 / 7 | all assertions hold on the real Nile/Sahara frame with features on and relief thresholds raised |
| 3 Tropical island chain | 5 / 7 | the arc fits and the land is tropical, but single atolls vanish at capture, so the chain has 5 landmasses, not 12 |
| 4 Temperate with mountain chains | 4 / 7 | relief share, rain shadow, grass/plains flip and two coasts hold; climate share, the knot and seam lint fail |

18 / 29 in the final run, reproducible (the same sequence gives the same numbers once every scenario starts
from default settings). Per-assertion results, describe paragraphs, warnings and the full feedback transcripts:
[scenarios/RESULTS.md](scenarios/RESULTS.md). Thumbnails: `scenarios/s1.png` .. `s4.png` (the app's own
renderer, via the `thumbnail` tool). Exports: `mcp/out/scenario<N>.CivBeyondSwordWBSave` (not committed).

Run history, for the record: run 1 (first sequences) 10 / 29; run 2 (larger canvas, land-centred scatter, raised
relief thresholds) 15 / 29; run 3 (bigger continents, atoll chains as pieces, deeper ridge overlap) 14 / 29,
better on 2 and 4 and worse on 1 and 3, so the file keeps run 2's sequences for 1 and 3 and run 3's for 2 and 4;
run 4 (partial) exposed the settings-persistence drift; run 5 (every scenario reset first) 18 / 29.

### Findings: tool and feedback shortcomings the runs exposed

Agent-side misses are listed too where they point at a missing handle.

0. **Settings persist on the page.** Sliders set by one scenario (or one agent) stay set for the next; a
   re-run of scenario 1 after scenario 4 came out with 30% land instead of 25% because scenario 4's relief
   thresholds and river count were still active. There was no way to reset. Added during the runs:
   `tune {reset:true}`; every scenario now starts with it. The shelf likewise accumulates same-named snapshots
   across runs (names resolve to the newest), which is fine for an agent but worth knowing when reading the app.
1. **Land share is hard to steer.** `snapshot` reports a piece's land count, but the agent has to add them up
   and guess the canvas total; a `place` dry-run (`preview:true`, returning the block without stamping) or a
   `budget` line in the compose block ("land 24.7%, target 28-38%") would make the loop converge. Scenario 1
   went 23% -> 25% -> 40% across runs by resizing pieces blind.
2. **No collision avoidance.** `place` and `scatter` stamp wherever told; overlapping land-only stamps merged
   two continents into one 4455-tile landmass in run 3 and produced most of scenario 1's `truncated-wall` and
   `climate-jump` warnings (island stamps overlapping each other). Wanted: `avoidLand:true` (shift to the nearest
   free spot) and a `collisions` line in the block naming the patches that overlap on land.
3. **Single atolls fall below the sampling floor.** The frame cannot be narrower than 6 source px (0.53°), so a
   0.5° atoll captured on a 12x12 grid gets about half a source pixel per tile; with the island expander at 0.9
   Tarawa, Majuro and Addu came out as 0-1 tiles and only 5-6 landmasses survived (needed 12-30). Whole chains
   (Maldives, Tuvalu) do survive as 4-7 islets each. Capturing atolls needs the OSM coast tiles at a finer
   window than the viewer allows, or a catalog note that atoll entries are chains, not islands.
4. **Big real islands are not tropical.** Hawaii's Big Island reads as temperate (Köppen C on the volcano
   slopes) and its summit as snow; Savaii is 97% tropical. The catalog now says so for Hawaii; a `climate`
   field computed at index time would let `catalog_search {climate:'tropical'}` be trusted.
5. **`attach` aligns rectangles, not features.** The Cascades' N-S range never met the Caucasus' E-W range
   because the Caucasus piece's west edge is a coast strip, so the two spines stay separate (0 knots in every
   run) however deep the overlap. Connectors should carry *where along the edge* the mountain wall is (anchor
   positions, Mawhorter & Mateas), and `attach` should offer `align:'relief'` to line those up; the seam cost
   and `bestShift` only reduce mismatch, they do not create a junction.
6. **Real pieces carry their own climate mix.** Scenario 4's 70% temperate target cannot be met by the Caucasus
   isthmus (45% arid) plus the Cascades' lee basins. Either the assertion should be stated as *relative* to the
   pieces' native mix, or the tool needs a per-patch climate summary so the agent can pick pieces by numbers
   (`snapshot` now prints the landmass climate mix; `catalog_search` does not). Scenario 2's "green only near the
   river" rule, which failed while scenario 4's settings leaked into it, passes from default settings.
7. **River continuity across patches is the weakest seam.** 29/43 and 14/27 systems reach water in the composed
   maps; the rest end at patch boundaries or in the sea of a land-only stamp. The lint names them, but there is
   no repair handle: a `trim_rivers` (drop systems that cannot reach water) or `extend_river` operator would turn
   the warning into an action.
8. **Describe gaps closed during the runs.** Junction detection was missing (the skeleton graph now reports
   `knots`); water bodies and "which sea does this river reach" were missing (now `seas` and `seasReached`);
   per-row climate counts were missing (now `rows` in the JSON); the climate rule was hand-written (now mined
   from the Köppen raster). Still missing: a coast-type rule, geomorphons/TPI (needs an elevation field; Civ4
   tiles have only the relief class), and a min-cut ragged seam.
9. **The desert grid is readable after all** once features are on: `r` flood plains, `o` oases, `^`/uppercase
   relief and the `overlay:'rivers'` `=` marks give the structure the prompt asks about; without `feat:true`
   the grid is a field of `d`.
10. **Assertion framing.** "No two landmasses adjacent" is vacuous on this lattice (landmasses are
    8-connected components), and "size correlates with position" is unstable with 5-6 points; both should be
    restated (minimum gap in tiles between landmasses; a monotone size check along the arc).
