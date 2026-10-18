# South Louisiana as a desert (base map)

`base_plan.json` is the MCP call sequence that builds `base_desert.png` (Civ4, 128x62, below Alexandria,
Beaumont to the Chandeleurs). Each entry is `[tool, args]`, in order. Tile coordinates: x east from the
west edge, y south from row 0; the frame reports bounds W -94.35 S 28.62 E -88.55 N 31.43, so
x = (lon + 94.35) / 5.8 * 128 and y = (31.43 - lat) / 2.81 * 62.

How it was built: a real frame with 30 rivers and relief thresholds hill 0.8 / peak 0.95 (flat country,
so percentile relief gives ~850 hills and ~110 peaks); the Chandeleur arc re-traced with `add_island`
(it is too thin to survive 4-km tiles); the Mississippi's last reach restored with `add_island` levees and
`extend_river` (edges flanked by coast are dropped when a snapshot is made, so the delta channel ended
at Venice); the Vermilion and upper Bayou Lafourche hand-drawn with `add_river {path}` and joined with
`extend_river`; `reclimate` at wetness 0.6 for a desert with steppe and flood plains; `paint` jungle into
the Atchafalaya, Maurepas, Barataria and Pearl swamps and oases over the flat desert; `trim_rivers`.

Landmarks (tile x,y): Lake Charles 25,27 · Lafayette 52,27 · Morgan City 69.5,38 · Donaldsonville 74,29
(the Mississippi runs along the row 28/29 boundary there) · Thibodaux 78,36 · Houma 80,40 · Baton Rouge
70,22 · New Orleans 94,33 · Lake Pontchartrain 92-104,25-31 · Atchafalaya basin x 60-71, y 18-38 ·
Red River enters at the top near 45,5 · Chandeleurs along 121,30 -> 114,43.
