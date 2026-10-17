# Round 4: the four briefs again, answering the round-3 critique

Built live on 2026-10-17 through the MCP (Civ4 module, 120x80). Saves are in `mcp/out/round4/` (gitignored);
thumbnails here (generated rivers orange, real ones blue). River checks are from an independent reader of the
exported `.CivBeyondSwordWBSave` (connected components of river edges, followed by flow direction).

The critique of round 3, and what changed in the tools because of it:

| critique | answer |
|---|---|
| Map 2 is "an inverted Middle East"; the MCP should not assume Earth-likeness | **sculpt pathway**: an original height field built from shapes (blob, ridge, rift, plateau, basin, chain, fjords, noise) and small *stamps* of real relief (a few degrees across, rotated and scaled), then a climate model and the game's classifier. No piece of the coastline is a real one. |
| Map 1's continents are copy-paste, with no climate check | the same pathway, and every realize/reclimate runs `core/climate.js`: temperature by latitude and lapse rate, maritime warmth on windward coasts, seasonality from continentality, moisture advected on the prevailing wind with orographic rain and rain shadows, patchy rainfall, then the Köppen tree. The report gives climate shares by latitude band so the agent can check the zonation. |
| Map 3's islands are too evenly spread; chains should be linear with wide gaps | `sculpt_shape {kind:'chain'}`: a hotspot track along a path, volcanoes ageing from high islands to atolls, with jitter across the track. Chains are laid along separate paths with open ocean between them. |
| Map 3 pastes the same island several times | pastes are unique per lasso chunk: `place`/`scatter` refuse a snapshot already on the canvas unless `allowRepeat:true`; `scatter` refuses more stamps than distinct snapshots. |
| Map 4 has too much ocean; fill the interstitial spaces | `attach {overlap:'auto'}` *fuses* pieces along an interest-weighted min-cut seam that prefers land meeting land; `fill_gaps` closes sea gaps between pieces into lowland (lakes and river mouths kept); `reclimate` gives the collage the climate of where its pieces now sit. |
| the MCP is timid about mashing landforms together | each snapshot gets a per-tile **interest** map (0-9: relief, capes and bay heads, climate boundaries, rivers, oases, flood plains, salt) shown by `overlay:'interest'`, with per-edge interest in `snapshot_info`; the fuse seam runs through low-interest land. |
| broken rivers | fixed at the source (below). |

## 1. Earthlike world — `R4_1_earthlike.png` (sculpt)

70°N..70°S, seed 77. Two continents from irregular blobs with ridges (a western cordillera, a high plateau and
an east-west range), a rift, three stamps of real relief (the Ethiopian Highlands, the Alps, the Altiplano, each rotated), three
hotspot chains, sea level set for 30% land.

| | |
|---|---|
| land | 32% |
| continents | 1149 and 1092 tiles; subcontinents 263, 173, 151 |
| climate | arid 41%, tropical 20%, temperate 18%, continental 11%, tundra 8%, ice 2% |
| by latitude | 0-15° tropical 66%; 15-30° arid 86%; 30-45° arid 40% / temperate 39%; 45-60° continental 63% |
| rivers | 18 systems, all reach the sea; 3 flagged (end in closed basins) |
| cradles | the river valleys on the subtropical deserts' wet margins (west continent's south, east continent's centre) |

## 2. Desert — `R4_2_desert.png` (sculpt)

36°N..14°N, seed 23. A broad low platform, a plateau and two long ranges, a deep rift that floods into a narrow
sea, an inland basin and a second rift that make an inner gulf, five real-relief stamps (Zagros, Tibesti, Ahaggar,
the Hajar, the Hejaz), two shallow basins, noise. Closed basins become salt flats with a terminal lake in their
deepest part; arid basins are not filled into lakes.

| | |
|---|---|
| land | 88% |
| climate | arid 76%, temperate 14% (the northern ranges), tundra 5% (peaks), tropical 5% (the far south) |
| closed basins | 6, from 103 tiles of salt flat with an 18-tile lake down to 24 tiles |
| rivers | 28 systems: 16 reach the sea or a lake, 11 leave across the map border, 5 end in salt flats |
| oases, flood plains | features on (oasis density 0.8): the oases and valley floors are the ground worth fighting over |

## 3. Tropical islands — `R4_3_tropical.png` (sculpt)

16°N..16°S, seed 41. Six hotspot chains on separate tracks with open ocean between them: two long low atoll
chains (Ralik/Ratak style, parallel), one long chain ageing from high islands to atolls, two short high chains,
and one large high island at the centre with its own tail of atolls.

| | |
|---|---|
| land | 7% |
| landmasses | 38; the largest 119, 86, 82 tiles; the rest are islets and atolls |
| climate | tropical 86%, temperate 14% (the high islands' uplands) |
| balance | no chain is more than a few tiles from open sea; every island is reachable by water from several sides |

## 4. Temperate with mountain chains — `R4_4_temperate.png` (compose + fuse + reclimate)

Real pieces cut by lassos: New Zealand's Southern Alps (flipped N-S), western Norway, the Scottish Highlands,
Jutland, western Ireland and the Pannonian basin. They are fused with `attach {overlap:'auto'}`; `fill_gaps` closes
the sea between them in the south-west, keeping lakes and river mouths open. Then `reclimate` on a 56°N..40°N
canvas with wetness 0.3, so the basin and the lee of the ranges become steppe; then `trim_rivers` and
`extend_river`.

| | |
|---|---|
| land | 50% (round 3: 40%), one main landmass of 4782 tiles |
| terrain | forest 1070, plains 920, grass 893, hills 1104, peaks 503 |
| climate | temperate 58%, arid (steppe) 19%, continental 16%, tundra 8% (high ranges) |
| rivers | 45 systems, 44 reach water; 2 seam dead ends and 3 stubs of one or two edges remain |

## Rivers

Fixes in this round:

- **flip_snapshot** was off by one row or column for river edges (the main cause of round 3's broken rivers).
- **extend_river** had wrong corner moves, joined rivers into themselves or into another river's dead end, and
  could pair two dead ends into a loop; a join now counts only where the other river flows on and reaches the sea.
- **trim_rivers** walks true corners and drops stubs of one or two edges.
- **fill_gaps** buried river mouths and closed lakes a river crossed; it now fills only sea-connected water and
  keeps an estuary channel to the open sea, or a lake, for every mouth it would bury.
- **Sculpt rivers** now leave the map straight across the border. The flood router treats each border tile as an
  outlet at its own height, so drainage just inside a raised border ran along the edge to its lowest point.

| map | river systems | reach water | other |
|---|---|---|---|
| 1 | 18 | 18 | 3 end in closed basins |
| 2 | 28 | 16 | 11 exit across the border, 5 end in salt flats |
| 3 | 1 | 1 | |
| 4 | 45 | 44 | 2 seam dead ends and 3 stubs |
