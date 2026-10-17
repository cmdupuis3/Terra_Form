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
`latitudes:{top:80,bottom:-80}` and `targetLand:[0.28,0.38]` (the budget line), `place` with `ragged:true`
(feathered frame cuts) and `avoidLand:true, gap:2` (continents never merge), `erase` (inland seas), `scatter`
with `avoidLand` (the archipelago), `trim_rivers`, `describe`, `compose_view`, `export`.

**Assertions.**

| assertion | how it is measured |
|---|---|
| land 28-38% | land glyphs over the canvas |
| 4-6 continents (landmasses >= 60 tiles whose centroid is outside the top and bottom 10% of rows: the cap strips are landmasses too), plus >= 8 landmasses under 20 tiles | `describe.landmasses` |
| snow/tundra only in the top and bottom 15% of rows | `s t S T` glyphs per row |
| tropical Köppen groups only in the middle 40% of rows | `describe {rows:true}` `.rows[].groups[3]` |
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

**Tools to reach for.** `catalog_search` (atoll, volcanic, single-island), `snapshot_from_catalog` (the single
atolls at their default 8x8 with `params:{islandExpand}` setting the islet size, 1-6 tiles), `compose_new`,
`scatter` along arc segments with a different snapshot list per segment (big volcanic islands south-west,
mid-size islets, then one-tile atolls north-east) with `avoidLand:true, gap:2`, `describe`.

**Assertions.**

| assertion | how it is measured |
|---|---|
| land 6-14% | land glyphs |
| 12-30 landmasses | `describe.landmassCount` |
| minimum gap between islands of 5+ tiles >= 2 water tiles | 8-connected components of land glyphs; the smallest Chebyshev distance between tiles of two different islands of 5+ tiles, minus one (a piece's own satellite islets sit 1 tile off its coast and are left out) |
| 2-4 landmasses >= 20 tiles, the rest <= 6 | `describe.landmasses[].size` |
| centroids fit a circle, mean residual <= 2 tiles | algebraic circle fit on `landmasses[].at` |
| size falls monotonically along the arc SW -> NE | landmasses sorted by t = x - y, split into 3 bins; mean log size non-increasing bin to bin and first > last |
| all land tropical (A group) or arid-coastal | `landmasses[].climate[0]` |

## Scenario 4 — A temperate region with mountain chains (Civ4, 112x70 canvas)

**Prompt.** "A temperate land with two mountain chains meeting at a knot, forested windward slopes, drier basins
in the lee, rivers draining from the ranges to two different coasts."

**Tools to reach for.** `catalog_search` (mountain-chain, mountain-wall, two-coasts, rain-shadow),
`snapshot_from_catalog` with a `bounds` override (the Caucasus isthmus wide enough to enclose the Caspian),
`place` with `landOnly:false` (keeps the Caspian as an inland sea), `attach` (the Cascades' east edge onto the
Caucasus' west edge, overlapping 22 with `align:'relief'` so the N-S range's edge anchor meets the E-W
range's, and `ragged:true` for a min-cut seam), `trim_rivers`, `tune` (forest density, relief thresholds,
more rivers), `describe`, `compose_view`.

**Assertions.**

| assertion | how it is measured |
|---|---|
| temperate/continental >= 70% of land | `describe {rows:true}` `.rows[].groups` |
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

### Summary (second round; the sequence in `scenarios.mjs` is the best one per scenario)

| scenario | round 1 | round 2 | notes |
|---|---|---|---|
| 1 Earthlike alien world | 4 / 8 | 8 / 8 | the budget line sized the pieces (28.7% land), `avoidLand` kept four continents apart, `ragged` feathered the frame cuts, `trim_rivers` dropped the rivers the seams and erasures cut (36/36 reach water), zero warnings |
| 2 A desert | 7 / 7 | 7 / 7 | unchanged; the single-frame scenario |
| 3 Tropical island chain | 5 / 7 (two vacuous) | 7 / 7 | restated assertions (gap >= 2 water tiles between 5+ tile islands, monotone size along the arc); single atolls at their default size with the island expander set per entry, `scatter {avoidLand, gap:2}` |
| 4 Temperate with mountain chains | 4 / 7 | 4 / 7 | `align:'relief'` made the two ranges one relief component (366 tiles, chain 54) and `ragged` + `trim_rivers` cleared every warning (19/19 rivers reach water); climate share (66.2%), the knot and the grass/plains flip still fail |

26 / 29 in the final run (18 / 29 before this round), reproducible from default settings. Per-assertion
results, describe paragraphs, warnings and the full feedback transcripts: [scenarios/RESULTS.md](scenarios/RESULTS.md).
Thumbnails: `scenarios/s1.png` .. `s4.png`. Exports: `mcp/out/scenario<N>.CivBeyondSwordWBSave` (not committed).

Run history, for the record: run 1 (first sequences) 10 / 29; run 2 (larger canvas, land-centred scatter, raised
relief thresholds) 15 / 29; run 3 (bigger continents, atoll chains as pieces, deeper ridge overlap) 14 / 29;
run 4 (partial) exposed the settings-persistence drift; run 5 (every scenario reset first) 18 / 29. Second
round: run 6 (the new tools dropped into the old sequences, scenario 3 restated) 20 / 29: scenario 1 lost
land to the feathering and scenario 3's blobs crowded the arc; run 7 (pieces resized against the budget
line, `avoidLand` placements, the archipelago moved into the tropical band, atolls at their default size
with per-entry island expander, the arc split into a mid-size and a one-tile segment) 26 / 29.

### Findings: tool and feedback shortcomings the runs exposed

Round 1's eleven findings, with what the second round did about each; new ones follow.

0. **Settings persist on the page.** Fixed in round 1 (`tune {reset:true}`); every scenario starts from it.
   It came back once more as finding 3's real cause (below).
1. **Land share is hard to steer.** Fixed: `compose_new {targetLand}` puts a `budget:` line in every compose
   block (`land 20.7% of target 25-35% (add 152..504 land tiles)`) and `place {preview:true}` is a dry run.
   Scenario 1 was sized against it in one pass (21.8% -> 27.2% -> 28.7%).
2. **No collision avoidance.** Fixed: `place` / `scatter {avoidLand, gap}` shift a stamp to the nearest spot
   whose land is at least `gap` water tiles from existing land (reported as `shifted`), and every compose
   block carries `collisions: [1]x[2] 38 land tiles` or `none`. Scenario 1's continents stay four (they
   merged into 1974 tiles without it); scenario 3's islets never touch.
3. **Single atolls fall below the sampling floor.** Not a floor after all: with default settings Tarawa
   captures at 8x8 as 14 tiles, at 16x16 as 52 and at 24x24 as 106 (the island expander fills the lagoon, so
   they are blobs, not rings), and `islandExpand` sets the islet size (0.3 -> 5 tiles, 0.5 -> 9). The 0-1
   tile captures of round 1 were finding 0: another scenario's settings were still active. Documented in
   the README under scatter.
4. **Big real islands are not tropical.** Fixed: `catalog_index` now records each entry's measured climate mix
   (`climateMeasured`, from the captured landmasses; 57 of 58 entries, the Marshall Islands capture no land
   at 40x32) and `catalog_search {climate}` matches it alongside the hand-written field. Hawaii reads
   `tropical 64%, temperate 33%`, Hawaii Big Island `temperate 65%, tropical 28%`.
5. **`attach` aligns rectangles, not features.** Half fixed: connectors carry anchors (`relief@`, `land@` with
   the land runs) and `attach {align:'relief'|'coast'}` lines them up. In scenario 4 the Cascades and the
   Caucasus now form one relief component (362 tiles, chain 53, was two of 222 and 152) and the seam lint is
   clean. The skeleton still reports 0 knots on it: the ranges meet end to end, an L, not a T; a knot needs
   a third arm. Getting a T needs the N-S range to cross the E-W one, which `align` does not try.
6. **Real pieces carry their own climate mix.** Scenario 4 is at 66.2% temperate + continental (was 54.7%):
   the Caucasus isthmus is 73% continental, 15% arid (the catalog now says so). Reaching 70% is a piece
   choice, not a tool gap.
7. **River continuity across patches is the weakest seam.** Fixed: `trim_rivers` drops the systems the seams,
   erasures and overlaps cut (whole systems, and dangling side branches of systems that do reach the sea),
   keeps the ones that were endorheic in their source, and `extend_river` carries a dead end to the nearest
   water or into another river (a tributary now reaches what its trunk reaches). Scenarios 1 and 4 went
   from 29/43 and 16/27 to 36/36 and 19/19 systems reaching water.
8. **Describe gaps.** `rows` is opt-in (it was half the payload), `codes:true` adds the landform codebook
   summary, warnings and notes are separate. Still missing: a coast-type rule, geomorphons / TPI.
9. **The desert grid is readable** once features are on (unchanged).
10. **Assertion framing.** Restated: the gap assertion measures water tiles between islands of 5+ tiles
    (a piece's own satellite islets sit 1 tile off its coast and are left out); the size gradient is
    checked as non-increasing mean log size over 3 bins along SW -> NE with first > last. Both pass.

New in the second round (from the owner's Oman + Morocco test and the runs):

11. **Cut edges read as coastline.** Fixed in layers: snapshots carry the mask-fill tiles (`cut`), connectors
    say `cut edge`, the seam cost ignores cut pairs (40 of 116 on the Oman seam), the `straight-edge-coast`
    rule flags collinear shores and says whether they are a lasso cut, the capture rectangle's edge, or a
    straight real coast, and `ragged:true` feathers the cuts and min-cuts the overlap. What remains: the
    rule also flags straight *real* coasts of 7+ tiles (Morocco's Mediterranean shore) and says so; and a
    rect crop has no mask fill, so its edges are "rect/frame cut" only by position.
12. **The lasso itself was rectangular.** `suggest_lasso` / `snapshot {lassoFrom}` trace the polygon from the
    frame: a landmass outline with a sea margin (Oman: 22 vertices, the Gulf trimmed, the coast kept) or one
    side of a mountain spine with the crest (Morocco: the Atlantic side plus the Atlas, cut along the
    Saharan foot). Limits: the ridge cut keeps the whole relief component, and on Morocco that is 296 of
    695 land tiles, so "the north side" is a 48-tile strip plus the crest; on Oman no land lies west of the
    spine, so the ridge lasso equals the land lasso.
13. **`attach` ignored the canvas edge.** Fixed: B is clamped along the seam when its land fits, and the block
    reports what still overhangs (`clipped: 17 land tiles off the canvas (3 rows south)` on a 24-row canvas).
14. **Best shift on the window edge.** The window is `searchShift` (default 16, was 8) and the block flags an
    optimum on the edge. The Oman seam's optimum is 9.
15. **Feathering costs land and leaves specks.** `ragged` removes about 3% of a continent's land along its
    cut edges (scenario 1 fell from 24.7% to 21.8% before the pieces were resized; the budget line shows
    it) and at first left 1-3 tile scraps, now dropped. The owner's Morocco south edge keeps a few straight
    runs of 4-6 tiles after feathering.
16. **Scale mismatch is a seam.** The `scale-mismatch` rule fires when touching patches sit more than one
    codebook band apart (Tahiti at 0.075°/tile against Morocco at 0.325°/tile: bands 5 and 3). The compose
    canvas' own scale is the patches' median unless `compose_new {degPerTile}` declares it.
17. **The codebook port holds.** `describe {codes:true}` and `overlay:'codes'` read the Oman + Morocco collage
    as `desert / plain / pen/cape 23%, desert / plain / depression 11%, range/mtn / desert / basin 10%` at
    band 3; the JS codes equal the Python ones on all but one tile of 3800 across bands 2, 3 and 5.
18. **Scenario 4's grass/plains flip flipped.** With the ranges aligned the Cascades sit 4 rows further
    north, both sides of the main spine read plains-dominated (22% vs 4% grass) and the lee/windward
    contrast shows in forest only (3.13x). The assertion should probably be stated on forest + grass
    together, or on the Köppen groups per side.
