# Round 3: four maps at 120x80 from detailed briefs

Built live through the registered `terra-form` MCP server on 2026-10-17 (Civ4 module, compose canvas 120x80).
Saves are in `mcp/out/round3/` (gitignored); thumbnails here (generated rivers drawn orange, real ones blue).
Every export passed all eight validator rows.

## 1. Earthlike world — `R3_1_earthlike.png`

Brief: ~70% ocean, two main continents, a few subcontinents, occasional island chains, diverse ecosystems,
obvious cradles of civilisation.

Built at 1.75°/tile on a canvas declared 70°N..70°S so real climate bands land at plausible rows:
continent A = Africa + Arabia (lasso traced from its own coast with `suggest_lasso`, mirrored E-W);
continent B = South and East Asia (hand-drawn wiggly lasso through Central Asia, mirrored); subcontinents
Australia, Southern Cone, western Europe, Fennoscandia (mirrored) and Mesoamerica (flipped into the southern
hemisphere); island arcs from Indonesia/Philippines and the Antilles. Two straight cut coasts were bitten
irregular with `erase`, then `trim_rivers` dropped the three fragments the bites cut.

| | |
|---|---|
| ocean | 74% |
| continents | 914 and 877 tiles |
| subcontinents | 224, 131, 124, 66, 64 tiles |
| landmasses | 21 |
| cradles | Nile and Tigris-Euphrates (A); Indus, Ganges, Yellow River (B) |

Weakness: a mirrored Africa is still recognisably Africa.

## 2. Desert — `R3_2_desert.png`

Brief: sprawling desert, a few seas and inlets, rugged terrain and vast sand seas, fertile river valleys,
mountain hideaways, occasional oases worth fighting over.

One coherent real frame (eastern Sahara, Nile, Red Sea, Arabia, Gulf; 0.35°/tile) with relief thresholds
raised so the sand seas read as open ground, then generated features on the frame: a salt-fringed lake in the
deepest depression (it landed in the Jordan rift — a Dead Sea), two exotic rivers across the sand (37 and 30
tiles, 1200 and 600 m³/s) and two salt pans; features and oases on; mirrored E-W.

| | |
|---|---|
| land | 77% (Red Sea and Gulf as inlets) |
| terrain | desert 3926, hills 1665, peaks 895, flood plains 304, oases 17, salt pan 77 |
| rivers | 16 systems, 523 edges |

Weakness: the mirrored Red Sea and Gulf remain recognisable.

## 3. Tropical islands — `R3_3_tropical.png`

Brief: multiple atoll chains with a sprinkling of larger high islands; no area clearly dominant or safe from
naval flanking.

Eight real high islands (Savai'i, Upolu, Tahiti, Efate, Viti Levu, Espiritu Santo, Guadalcanal, Kauai)
captured at sizes that equalise them, placed on a jittered grid; six atoll arcs built with `scatter
{avoidLand, gap:2}` from four single atolls (Tarawa, Funafuti, Addu, Majuro) captured flat; the Maldives
double chain as a seventh.

| | |
|---|---|
| land | 9% |
| high islands | 8, each 59-74 tiles |
| landmasses | 65, no two touching |

Weakness: only four atoll shapes repeat.

## 4. Temperate mountains — `R3_4_temperate.png`

Brief: forest, grassland and plains; complex tectonic history; open but obstructive passes; a fair amount of
sea and fjords; fertile valleys and good ports.

A "North Sea" world of five pieces whose ranges run in three directions: the Southern Alps island (Alpine
Fault, Fiordland; flipped N-S), western Norway's fjord coast, the Scottish Highlands (Great Glen), Denmark's
lowlands and Ireland. Captured with `mtnPass 0.6` (passes carved), forest density lowered; Denmark and Ireland
recaptured with stricter relief thresholds (see findings).

| | |
|---|---|
| land | 32% |
| landmasses | 16 (5 large) |
| terrain | forest 831, grass 687, hills 938, peaks 460, snow/tundra 117 |
| rivers | 63/63 reach water |

Weaknesses: fjords barely resolve at 0.17°/tile; oceanic climates classify as grass/forest with almost no
plains; 28 jungle tiles leak into cool oceanic spots; Scotland, Ireland and Denmark are recognisable.

## Findings for the next round

1. **Relief is relative to each view.** The highest ground in any frame ranks as hills/peaks, so atolls and
   flat Denmark came out with peaks until the thresholds were raised by hand. Compose pieces need an absolute
   relief option (thresholds in metres) so pieces captured separately agree.
2. **Frame auto-placement ignores earlier pans.** A second automatic `add_salt_pan` landed on the first one's
   seed; frame features should block each other the way compose features do.
3. **Atoll chains vanish at chain scale** even with the island expander; scattering single atolls works, but
   `scatter` should vary flips/rotations so a chain does not repeat four shapes.
4. **Mirroring is a weak disguise** for iconic outlines (Africa, the Red Sea); a rotate or mild warp operator
   would help.
5. **Fjords need finer capture** than the rest of a map; mixing scales trips the scale-mismatch rule by design,
   so a "detail inset" workflow (capture fine, downsample coast only) would be worth designing.
6. **Climate vocabulary:** temperate oceanic pieces yield almost no plains and a little jungle; the Civ4
   classifier's jungle weight for C climates and a plains bias for the brief would be worth exposing.
