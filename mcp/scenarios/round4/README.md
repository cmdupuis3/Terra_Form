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
| (follow-up) latitude banding in map 4; atolls homogeneous blobs | the climate tables are read at a meandering latitude (+-3.5°, waves ~10° long), so climate borders wander like storm tracks; atolls are rebuilt as thin rings (map 3). |

## 1. Earthlike world — `R4_1_earthlike.png` (sculpt)

70°N..70°S, seed 77. Two continents from irregular blobs with ridges (a western cordillera, a high plateau and
an east-west range), a rift, three stamps of real relief (the Ethiopian Highlands, the Alps, the Altiplano, each rotated), three
hotspot chains, sea level set for 30% land.

| | |
|---|---|
| land | 32% |
| continents | 1149 and 1092 tiles; subcontinents 263, 173, 151 |
| climate | arid 42%, tropical 19%, temperate 18%, continental 11%, tundra 9%, ice 2% |
| by latitude | 0-15° tropical 63%; 15-30° arid 86%; 30-45° arid 41% / temperate 38%; 45-60° continental 63% |
| rivers | 20 systems, all reach the sea; 3 also have a branch ending in a closed basin |
| cradles | the river valleys on the subtropical deserts' wet margins (west continent's south, east continent's centre) |

## 2. Desert — `R4_2_desert.png` (sculpt)

36°N..14°N, seed 23. A broad low platform, a plateau and two long ranges, a deep rift that floods into a narrow
sea, an inland basin and a second rift that make an inner gulf, five real-relief stamps (Zagros, Tibesti, Ahaggar,
the Hajar, the Hejaz), two shallow basins, noise. Closed basins become salt flats with a terminal lake in their
deepest part; arid basins are not filled into lakes.

| | |
|---|---|
| land | 88% |
| climate | arid 76%, temperate 13% (the northern ranges), tropical 6% (the far south), tundra 5% (peaks) |
| closed basins | 6, from 103 tiles of salt flat with an 18-tile lake down to 24 tiles |
| rivers | 28 systems: 15 reach the sea or a lake, 10 leave across the map border, 3 end in salt flats |
| oases, flood plains | features on (oasis density 0.8): the oases and valley floors are the ground worth fighting over |

## 3. Tropical islands — `R4_3_tropical.png` (sculpt)

16°N..16°S, seed 41. Six hotspot chains on separate tracks with open ocean between them: two short parallel
atoll chains (Ralik/Ratak style), one long atoll chain with large rings (`atollRadius:[2.2,4]`), one chain ageing
from high islands to atolls, a short high chain, and one large high island at the centre with its own tail.

Atolls are one-tile rings around a shallow lagoon, up to 7 tiles across, elongated and oriented at random. The rim
is islets (motus) and reef with passes between them, more islets on the windward east side. The share of the rim
that is land varies per atoll, so some are nearly all reef and some a near-closed ring. The oldest high islands of
each chain sit inside a barrier reef (the Bora Bora stage), and the volcanoes are elongated along their rift zones,
so no two islands share a shape. Atoll size is capped at a third of the spacing, so a chain stays a row of distinct
atolls instead of a reef band.

| | |
|---|---|
| land | 6% |
| islands | the largest high islands 122, 93, 88 tiles; the rest are islets and atoll rims |
| climate | tropical 85%, temperate 14% (the high islands' uplands) |
| balance | no chain is more than a few tiles from open sea; every island is reachable by water from several sides |

## 4. Temperate with mountain chains — `R4_4_temperate.png` (compose + fuse + reclimate)

Real pieces cut by lassos: New Zealand's Southern Alps (flipped N-S), western Norway, the Scottish Highlands,
Jutland, western Ireland and the Pannonian basin. They are fused with `attach {overlap:'auto'}`; `fill_gaps` closes
the sea between them in the south-west, keeping lakes and river mouths open. Then `reclimate` on a 56°N..40°N
canvas with wetness 0.38, so the basin interior and the lee of the ranges become steppe; then `trim_rivers` and
`extend_river`.

| | |
|---|---|
| land | 50% (round 3: 40%), one main landmass of 4782 tiles |
| terrain | forest 1275, grass 1090, plains 508, hills 1103, peaks 502 |
| climate | temperate 49%, continental 34%, arid (steppe) 12%, tundra 6% (high ranges) |
| rivers | 44 systems, 43 reach water; 2 seam dead ends and 3 stubs of one or two edges remain |

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
| 1 | 20 | 20 | 3 with a branch into a closed basin |
| 2 | 28 | 15 | 10 exit across the border, 3 end in salt flats |
| 3 | 0 | — | islands too small and wet-flat for a channel |
| 4 | 44 | 43 | 2 seam dead ends and 3 stubs |
