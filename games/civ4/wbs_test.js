/* civ4_wbs_test.js -- validate wbs_core.js against the vanilla WBSave format
 * (grounded on PublicMaps/Europe.CivBeyondSwordWBSave, Version=11).
 * Dual-mode: `node games/civ4/wbs_test.js`, or in a browser load wbs_core.js and
 * core/rivers_core.js first (they attach Civ4WBS / RiversCore to globalThis) then this file.
 */
(function () {
    "use strict";
    const isNode = typeof module !== "undefined" && module.exports;
    const { worldSizeFor, plotRiverLines, serialize: serializeRaw } = isNode ? require("./wbs_core.js") : globalThis.Civ4WBS;
    const { reachesToEdges } = isNode ? require("../../core/rivers_core.js") : globalThis.RiversCore;
    let fails = 0;
    const ok = (name, cond, extra) => { console.log((cond ? "  PASS " : "  FAIL ") + name + (extra ? "  " + extra : "")); if (!cond)
        fails++; };
    // The real output is CRLF (Civ4 requires it); the structural checks below are written with \n,
    // so run them against a normalized copy and assert the CRLF-ness separately.
    const serialize = (g, o) => serializeRaw(g, o).replace(/\r\n/g, "\n");
    // tiny south-origin-agnostic fixture: 3 wide x 2 tall, row 0 = NORTH
    const G = (t, p, f) => ({ terrain: t, plot: p, feature: f });
    const grid = [
        [G("TERRAIN_SNOW", 0), G("TERRAIN_TUNDRA", 1), G("TERRAIN_COAST", 3)], // north row
        [G("TERRAIN_GRASS", 2, "FEATURE_FOREST"), G("TERRAIN_PLAINS", 2), G("TERRAIN_OCEAN", 3)], // south row
    ];
    const W = 3, H = 2;
    const base = { W, H, topLat: 62, botLat: 48 };
    const text = serialize(grid, base);
    // ---- CRLF line endings (Civ4 parser is Windows-native; LF-only -> findInfoTypeNum -> CTD) ----
    const rawText = serializeRaw(grid, base);
    ok("output uses CRLF line endings", rawText.includes("\r\n") && !/[^\r]\n/.test(rawText) && !rawText.startsWith("\n"));
    ok("no bare LF anywhere in output", rawText.split("\n").every((seg, i, a) => i === a.length - 1 || seg.endsWith("\r")));
    ok("terminates with CRLF", rawText.endsWith("\r\n"));
    // ---- header / structure (vanilla-format invariants) ----
    ok("Version=11 first line", text.startsWith("Version=11\n"));
    ok("BeginGame/EndGame present", /BeginGame\n[\s\S]*?EndGame/.test(text));
    ok("BeginMap block with grid size", text.includes("\tgrid width=3") && text.includes("\tgrid height=2"));
    ok("num plots written", text.includes("\tnum plots written=6"));
    ok("plot count = W*H", (text.match(/BeginPlot/g) || []).length === 6);
    ok("### Plot Info ### marker", text.includes("### Plot Info ###"));
    ok("latitudes written", text.includes("\ttop latitude=62") && text.includes("\tbottom latitude=48"));
    ok("regional default: wrap X=0 (Europe-style)", text.includes("\twrap X=0"));
    ok("wrapX opt: wrap X=1", serialize(grid, { ...base, wrapX: 1 }).includes("\twrap X=1"));
    ok("Randomize Resources=true by default (no bonuses written)", text.includes("\tRandomize Resources=true"));
    ok("randomizeResources:false drops it", !serialize(grid, { ...base, randomizeResources: false }).includes("Randomize Resources"));
    // ---- special-tile bonus (BonusType) ----
    const bgrid = [
        [{ terrain: "TERRAIN_PLAINS", plot: 2, bonus: "BONUS_WHEAT" }, { terrain: "TERRAIN_DESERT", plot: 2, bonus: "BONUS_INCENSE", feature: "FEATURE_FOREST" }],
        [{ terrain: "TERRAIN_GRASS", plot: 2 }, { terrain: "TERRAIN_OCEAN", plot: 3 }]
    ];
    const btext = serialize(bgrid, { W: 2, H: 2, topLat: 10, botLat: 0 });
    ok("BonusType written for each tile with a bonus", (btext.match(/\tBonusType=BONUS_/g) || []).length === 2);
    ok("BonusType precedes FeatureType then TerrainType", /\tBonusType=BONUS_INCENSE\n\tFeatureType=FEATURE_FOREST, FeatureVariety=0\n\tTerrainType=TERRAIN_DESERT/.test(btext));
    ok("bonuses coexist with Randomize Resources=true", btext.includes("\tRandomize Resources=true") && /BonusType=BONUS_WHEAT/.test(btext));
    // ---- players: vanilla placeholder seats when none placed ----
    ok("18 placeholder players (LeaderType=NONE)", (text.match(/\tLeaderType=NONE/g) || []).length === 18);
    ok("placeholders use RandomStartLocation=true", (text.match(/\tRandomStartLocation=true/g) || []).length === 18);
    ok("no team blocks in placeholder mode (vanilla Europe has none)", !text.includes("BeginTeam"));
    // ---- placed civs: MUST define all 18 slots + 18 teams, else BtS reads undefined players -> CTD ----
    const withP = serialize(grid, { ...base, players: [
            { leader: "LEADER_CYRUS", civ: "CIVILIZATION_PERSIA", x: 1, y: 0 },
            { leader: "LEADER_CAESAR", civ: "CIVILIZATION_ROME", x: 0, y: 1 },
        ] });
    ok("placed civs: real player fields present", withP.includes("\tLeaderType=LEADER_CYRUS") && withP.includes("\tStartingX=1, StartingY=0") &&
        withP.includes("\tPlayableCiv=1") && withP.includes("\tHandicap=HANDICAP_NOBLE"));
    ok("placed civs: all 18 civ slots written (2 real + 16 NONE)", (withP.match(/^BeginPlayer/gm) || []).length === 18 && (withP.match(/\tLeaderType=NONE/g) || []).length === 16);
    ok("placed civs: 18 team blocks", (withP.match(/^BeginTeam/gm) || []).length === 18);
    ok("placed civs: teams numbered 0..17 on players", Array.from({ length: 18 }, (_, i) => "\tTeam=" + i).every(t => withP.includes(t)));
    ok("placed civs: filler NONE slots carry no StartingX/RandomStartLocation", !withP.includes("RandomStartLocation") &&
        (withP.match(/\tStartingX=/g) || []).length === 2);
    // ---- plot serialization: order, flip, fields ----
    // parse the plot blocks back and compare against the input grid
    function parsePlots(t) {
        const out = new Map();
        for (const m of t.matchAll(/BeginPlot\n([\s\S]*?)EndPlot/g)) {
            const b = m[1], xy = /\tx=(\d+),y=(\d+)/.exec(b);
            const feat = /\tFeatureType=(\S+), FeatureVariety=(\d+)/.exec(b);
            out.set(xy[1] + "," + xy[2], {
                terrain: /\tTerrainType=(\S+)/.exec(b)[1],
                plot: +/\tPlotType=(\d+)/.exec(b)[1],
                feature: feat ? feat[1] : undefined, fv: feat ? +feat[2] : undefined,
                order: m.index,
            });
        }
        return out;
    }
    const P = parsePlots(text);
    let flipOk = true, fieldOk = true;
    for (let gy = 0; gy < H; gy++)
        for (let gx = 0; gx < W; gx++) {
            const civY = (H - 1) - gy, t = grid[gy][gx], p = P.get(gx + "," + civY);
            if (!p) {
                flipOk = false;
                continue;
            }
            if (p.terrain !== t.terrain || p.plot !== t.plot)
                fieldOk = false;
            if ((t.feature || undefined) !== p.feature)
                fieldOk = false;
        }
    ok("south-origin flip: grid row 0 (north) lands at y=H-1", flipOk && P.get("0,1").terrain === "TERRAIN_SNOW");
    ok("terrain/plot/feature round-trip for all plots", fieldOk);
    ok("feature line before terrain (vanilla order)", /BeginPlot\n\tx=0,y=0\n\tFeatureType=FEATURE_FOREST, FeatureVariety=0\n\tTerrainType=TERRAIN_GRASS/.test(text));
    ok("column-major plot order (x outer, y inner)", P.get("0,0").order < P.get("0,1").order && P.get("0,1").order < P.get("1,0").order);
    // land <-> plot-type consistency of the emitted text (same rule as the app validator)
    let bad = 0;
    for (const [, p] of P) {
        const isW = p.terrain === "TERRAIN_OCEAN" || p.terrain === "TERRAIN_COAST";
        if (isW !== (p.plot === 3))
            bad++;
    }
    ok("land <-> plot-type consistent in output", bad === 0, bad + " mismatched");
    // ---- world size thresholds ----
    ok("worldSizeFor thresholds", worldSizeFor(40, 24) === "WORLDSIZE_DUEL" && worldSizeFor(41, 24) === "WORLDSIZE_TINY" &&
        worldSizeFor(84, 52) === "WORLDSIZE_STANDARD" && worldSizeFor(105, 64) === "WORLDSIZE_HUGE");
    // ---- rivers: manual edge maps land on the right plot with the right flag ----
    (() => {
        const nof = new Map([["0,1", { dir: 1 }]]); // south edge of NORTH-row tile gx=1
        const wof = new Map([["1,0", { dir: 2 }]]); // east edge of SOUTH-row tile gx=0
        const t = serialize(grid, { ...base, rivers: { nof, wof } });
        const block = (x, y) => new RegExp("BeginPlot\\n\\tx=" + x + ",y=" + y + "\\n([\\s\\S]*?)EndPlot").exec(t)[1];
        ok("isNOfRiver flag on the north-row tile across the flip (x=1,y=1)", /\tisNOfRiver\n\tRiverWEDirection=1/.test(block(1, 1)));
        ok("isWOfRiver flag on the south-row tile across the flip (x=0,y=0)", /\tisWOfRiver\n\tRiverNSDirection=2/.test(block(0, 0)));
        ok("river edge count in text matches maps", (t.match(/isNOfRiver|isWOfRiver/g) || []).length === 2);
        ok("plotRiverLines: empty off-edge", plotRiverLines(nof, wof, 2, 0, H).length === 0);
    })();
    // ---- end-to-end: centerline -> rivers_core edges -> serialized flags ----
    (() => {
        const V = { lonL: 0, lonR: 2, latT: 2, latB: 0 }, w = 10, h = 10;
        const g = Array.from({ length: h }, () => Array.from({ length: w }, () => G("TERRAIN_GRASS", 2)));
        const { nof, wof } = reachesToEdges([{ d: 5000, l: [[[0.1, 1.0], [1.9, 1.0]]] }], V, w, h);
        const t = serialize(g, { W: w, H: h, topLat: 2, botLat: 0, rivers: { nof, wof } });
        const got = (t.match(/isNOfRiver/g) || []).length;
        ok("W->E centerline: every rasterized edge serialized once", got === nof.size && wof.size === 0, got + " / " + nof.size);
        ok("all flow East across the flip", (t.match(/RiverWEDirection=1/g) || []).length === got);
    })();
    console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nALL PASS");
    if (isNode)
        process.exit(fails ? 1 : 0);
    return fails;
})();
