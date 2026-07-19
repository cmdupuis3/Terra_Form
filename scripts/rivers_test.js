/* rivers_test.js -- validate the corner-snap rasterizer + serializer mapping. */
const fs = require("fs");
const { reachesToEdges, plotRiverLines, nudgeRiverEdges } = require("./rivers_core.js");

let fails = 0;
const ok = (name, cond, extra) => { console.log((cond ? "  PASS " : "  FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };
const V = { lonL: 0, lonR: 2, latT: 2, latB: 0 }, W = 10, H = 10;

// direction + flag-type per axis
(() => { const { nof, wof } = reachesToEdges([{ d: 5000, l: [[[0.1, 1.0], [1.9, 1.0]]] }], V, W, H);
  ok("W->E: isNOfRiver only, all East", wof.size === 0 && nof.size > 0 && [...nof.values()].every(e => e.dir === 1)); })();
(() => { const { nof, wof } = reachesToEdges([{ d: 5000, l: [[[1.0, 0.1], [1.0, 1.9]]] }], V, W, H);
  ok("S->N: isWOfRiver only, all North", nof.size === 0 && wof.size > 0 && [...wof.values()].every(e => e.dir === 0)); })();
(() => { const e2w = reachesToEdges([{ d: 1, l: [[[1.9, 1.0], [0.1, 1.0]]] }], V, W, H);
  const n2s = reachesToEdges([{ d: 1, l: [[[1.0, 1.9], [1.0, 0.1]]] }], V, W, H);
  ok("E->W: flow West (3)", [...e2w.nof.values()].every(e => e.dir === 3));
  ok("N->S: flow South (2)", [...n2s.wof.values()].every(e => e.dir === 2)); })();
(() => { const { nof, wof } = reachesToEdges([{ d: 3000, l: [[[0.2, 0.2], [1.8, 1.8]]] }], V, W, H);
  ok("NE diag: both edge types, E + N", nof.size > 0 && wof.size > 0 && [...nof.values()].every(e => e.dir === 1) && [...wof.values()].every(e => e.dir === 0)); })();

// U-turn cancellation: a river that pokes out (E) and back (W) along one row nets to zero -> no edge
(() => { const { nof, wof } = reachesToEdges([{ d: 5000, l: [[[0.2, 1.05], [1.8, 1.05], [1.8, 0.95], [0.2, 0.95]]] }], { lonL: 0, lonR: 2, latT: 2, latB: 0 }, 8, 8);
  ok("U-turn: out-and-back cancels to 0 edges", nof.size + wof.size === 0, `${nof.size + wof.size} edges`); })();
// hairpin across a REACH BOUNDARY: out-leg and back-leg are different reaches of the same channel
(() => { const { nof, wof } = reachesToEdges([
    { d: 100, rid: 7, l: [[[0.2, 1.0], [1.8, 1.0]]] },
    { d: 200, rid: 7, l: [[[1.8, 1.0], [0.2, 1.0]]] }], V, W, H);
  ok("hairpin spanning reaches (same rid) cancels to 0 edges", nof.size + wof.size === 0, `${nof.size + wof.size} edges`); })();
// partial double-back across reaches: only the retraced span cancels; the rest keeps its flow
(() => { const { nof, wof } = reachesToEdges([
    { d: 100, rid: 7, l: [[[0.2, 1.0], [1.8, 1.0]]] },
    { d: 100, rid: 7, l: [[[1.8, 1.0], [1.0, 1.0], [1.0, 0.2]]] }], V, W, H);
  ok("partial double-back: retraced span drops, remainder flows E then S",
    nof.size === 4 && wof.size === 4 && [...nof.values()].every(e => e.dir === 1) && [...wof.values()].every(e => e.dir === 2),
    `${nof.size} H + ${wof.size} V edges`); })();
// DIFFERENT channels must never cancel: tributary running opposite the main stem loses to discharge
(() => { const { nof, wof } = reachesToEdges([
    { d: 5000, rid: 1, l: [[[0.2, 1.0], [1.8, 1.0]]] },
    { d: 10, rid: 2, l: [[[1.8, 1.0], [0.2, 1.0]]] }], V, W, H);
  ok("cross-channel opposition survives; higher discharge sets direction",
    nof.size === 8 && wof.size === 0 && [...nof.values()].every(e => e.dir === 1), `${nof.size} edges`); })();
// S-shape (E high, W low, on different rows) must survive
(() => { const { nof } = reachesToEdges([{ d: 5000, l: [[[0.2, 1.6], [1.8, 1.6], [1.8, 0.4], [0.2, 0.4]]] }], { lonL: 0, lonR: 2, latT: 2, latB: 0 }, 8, 8);
  ok("S-shape survives (edges on >1 row)", nof.size > 0 && new Set([...nof.keys()].map(k => k.split(",")[0])).size > 1); })();

// serializer flip: north-edge river -> civY=H-1, not civY=0
(() => { const { nof, wof } = reachesToEdges([{ d: 9, l: [[[0.1, 1.85], [1.9, 1.85]]] }], V, W, H);
  ok("flip: north row 0", [...nof.keys()].every(k => +k.split(",")[0] === 0));
  ok("flip: serializes at civY=H-1 not civY=0",
    plotRiverLines(nof, wof, 5, H - 1, H).some(s => s.includes("isNOfRiver")) && plotRiverLines(nof, wof, 5, 0, H).length === 0); })();

// connectivity on real data: each distinct river should render as ~one connected component
function comps(nof, wof) {
  const adj = new Map(), link = (a, b) => { (adj.get(a) || adj.set(a, new Set()).get(a)).add(b); (adj.get(b) || adj.set(b, new Set()).get(b)).add(a); };
  for (const k of nof.keys()) { const [gr, gx] = k.split(",").map(Number), cy = gr + 1; link(`${gx},${cy}`, `${gx + 1},${cy}`); }
  for (const k of wof.keys()) { const [gy, gx] = k.split(",").map(Number), cx = gx + 1; link(`${cx},${gy}`, `${cx},${gy + 1}`); }
  const seen = new Set(); let c = 0; for (const s of adj.keys()) { if (seen.has(s)) continue; c++; const st = [s]; while (st.length) { const v = st.pop(); if (seen.has(v)) continue; seen.add(v); for (const w of adj.get(v) || []) if (!seen.has(w)) st.push(w); } } return c;
}
// nudgeRiverEdges: clears every 4-sided tile (invalid rivers-on-all-4-sides) without splitting any
// channel, and collapses single-channel 3-edge hairpin wraps onto the missing-side chord.
function fourSided(nof, wof, W, H) { let n = 0; for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) if (nof.has((gy - 1) + "," + gx) && nof.has(gy + "," + gx) && wof.has(gy + "," + gx) && wof.has(gy + "," + (gx - 1))) n++; return n; }
function perChannelComps(nof, wof) {   // rid -> component count over that channel's own edges only
  const byRid = new Map(), link = (rid, a, b) => { let g = byRid.get(rid); if (!g) byRid.set(rid, g = new Map()); (g.get(a) || g.set(a, new Set()).get(a)).add(b); (g.get(b) || g.set(b, new Set()).get(b)).add(a); };
  for (const [k, e] of nof) { const p = k.split(",").map(Number); link(e.rid, p[1] + "," + (p[0] + 1), (p[1] + 1) + "," + (p[0] + 1)); }
  for (const [k, e] of wof) { const p = k.split(",").map(Number); link(e.rid, (p[1] + 1) + "," + p[0], (p[1] + 1) + "," + (p[0] + 1)); }
  const out = new Map();
  for (const [rid, g] of byRid) { const seen = new Set(); let c = 0;
    for (const s of g.keys()) { if (seen.has(s)) continue; c++; const st = [s]; while (st.length) { const v = st.pop(); if (seen.has(v)) continue; seen.add(v); for (const w of g.get(v)) if (!seen.has(w)) st.push(w); } }
    out.set(rid, c); }
  return out;
}
(() => { const mk = (dir, rid, d) => ({ dir, d: d == null ? 100 : d, rid });   // near-hairpin: junction at SW corner of tile (5,5)
  const nof = new Map([["4,5", mk(1, 1)], ["5,5", mk(3, 1)], ["5,4", mk(3, 1)]]), wof = new Map([["5,5", mk(2, 1)], ["5,4", mk(0, 1)], ["6,4", mk(0, 1)]]);
  const c0 = comps(nof, wof); nudgeRiverEdges(nof, wof, 10, 10);
  ok("io<=1 four-sided loop removed, channel intact", fourSided(nof, wof, 10, 10) === 0 && comps(nof, wof) === c0 && nof.has("5,4") && wof.has("6,4")); })();
(() => { const mk = (dir, rid, d) => ({ dir, d, rid });   // two channels (rid1 d100 N+W, rid2 d5000 S+E) enclose tile (5,5)
  const nof = new Map([["4,5", mk(3, 1, 100)], ["5,5", mk(1, 2, 5000)]]), wof = new Map([["5,4", mk(2, 1, 100)], ["5,5", mk(0, 2, 5000)]]);
  const c0 = comps(nof, wof); nudgeRiverEdges(nof, wof, 10, 10);
  ok("multi-channel enclosure broken, both channels connected", fourSided(nof, wof, 10, 10) === 0 && comps(nof, wof) === c0 && wof.has("5,5") && nof.has("5,5")); })();
(() => { const mk = (dir, rid, d) => ({ dir, d: d == null ? 100 : d, rid });
  // hairpin wrap: channel 1 runs W->E along row 5, detours N+E+S around tile (5,5), then continues E.
  // arc: N(dir E) + E(dir S) + S enters/exits at SW... entry edge nof "5,4" (E), wrap N "4,5"(E), E "5,5"(S), exit "5,6"?? --
  // simplest: approach along S row: in-edge nof "5,4" dir1, wrap N="4,5" dir1, E wof "5,5" dir2, out-edge nof "5,6" dir1, W wof "5,4" dir0 (up into the wrap)
  const nof = new Map([["5,4", mk(1, 1)], ["4,5", mk(1, 1)], ["5,6", mk(1, 1)]]);
  const wof = new Map([["5,4", mk(0, 1)], ["5,5", mk(2, 1)]]);
  const pc0 = perChannelComps(nof, wof);
  nudgeRiverEdges(nof, wof, 10, 10);
  const pc1 = perChannelComps(nof, wof);
  ok("hairpin wrap collapsed onto chord (3 edges -> 1), flow E, channel still one piece",
    !wof.has("5,4") && !nof.has("4,5") && !wof.has("5,5") && nof.get("5,5") && nof.get("5,5").dir === 1 && nof.get("5,5").rid === 1 && pc1.get(1) === pc0.get(1),
    JSON.stringify([...nof.keys()]) + " " + JSON.stringify([...wof.keys()])); })();
(() => { const mk = (dir, rid, d) => ({ dir, d: d == null ? 100 : d, rid });
  // wrap against the west map border: chord would be wof "5,-1" (unrepresentable) -> must NOT collapse
  const nof = new Map([["4,0", mk(1, 1)], ["5,0", mk(3, 1)]]), wof = new Map([["5,0", mk(2, 1)]]);
  nudgeRiverEdges(nof, wof, 10, 10);
  ok("border wrap left alone (chord out of grid)", nof.size === 2 && wof.size === 1); })();
(() => { const mk = (dir, rid, d) => ({ dir, d: d == null ? 100 : d, rid });
  // edgeOk veto: same hairpin as above but the chord slot is water -> wrap stays
  const nof = new Map([["5,4", mk(1, 1)], ["4,5", mk(1, 1)], ["5,6", mk(1, 1)]]);
  const wof = new Map([["5,4", mk(0, 1)], ["5,5", mk(2, 1)]]);
  nudgeRiverEdges(nof, wof, 10, 10, (m, key) => !(m === "nof" && key === "5,5"));
  ok("edgeOk vetoes the chord: hairpin kept rather than routed through water", wof.has("5,4") && nof.has("4,5") && wof.has("5,5") && !nof.has("5,5")); })();
(() => { const mk = (dir, rid, d) => ({ dir, d, rid });
  // enclosure where the old pass would cut the low-d channel MID-COURSE: rid1 (d10) passes through
  // with N+W of tile (5,5) mid-path (extends both ways); rid2 (d5000) has S+E as its terminal tip.
  // New pass must prefer the tip-trim (class 1) over the mid-course split (class 2) despite rid2's d.
  const nof = new Map([["4,4", mk(1, 1, 10)], ["4,5", mk(1, 1, 10)], ["5,5", mk(3, 2, 5000)]]);
  const wof = new Map([["5,4", mk(2, 1, 10)], ["6,4", mk(2, 1, 10)], ["5,5", mk(0, 2, 5000)], ["6,5", mk(2, 2, 5000)]]);
  const pc0 = perChannelComps(nof, wof);
  nudgeRiverEdges(nof, wof, 10, 10);
  const pc1 = perChannelComps(nof, wof);
  ok("enclosure: tip-trim preferred over mid-course split (no channel gains a component)",
    fourSided(nof, wof, 10, 10) === 0 && [...pc1.entries()].every(([r, c]) => c <= (pc0.get(r) || 1)),
    JSON.stringify([...pc0]) + " -> " + JSON.stringify([...pc1])); })();
function distinctRivers(reaches) {
  const par = reaches.map((_, i) => i), find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }, em = new Map();
  reaches.forEach((f, i) => { const a = f.l[0][0], z = f.l.at(-1).at(-1); for (const e of [a[0] + "," + a[1], z[0] + "," + z[1]]) { if (em.has(e)) { const x = find(em.get(e)), y = find(i); if (x !== y) par[x] = y; } else em.set(e, i); } });
  return new Set(reaches.map((_, i) => find(i))).size;
}
const RIVERS_JSON = process.env.RIVERS_JSON || "/mnt/user-data/uploads/rivers_o3.json";
function region(name, box, W, H) {
  if (!fs.existsSync(RIVERS_JSON)) { console.log(`  SKIP [${name}] (no ${RIVERS_JSON}; set RIVERS_JSON to run)`); return; }
  const j = JSON.parse(fs.readFileSync(RIVERS_JSON, "utf8"));
  const inb = (lo, la) => lo >= box.lonL && lo <= box.lonR && la >= box.latB && la <= box.latT;
  const reaches = j.features.filter(f => f.l.some(p => p.some(([lo, la]) => inb(lo, la))));
  const { nof, wof } = reachesToEdges(reaches, box, W, H);
  const ec = comps(nof, wof), rv = distinctRivers(reaches);
  console.log(`  [${name}] ${reaches.length} reaches, ${rv} distinct rivers -> ${nof.size + wof.size} edges, ${ec} components`);
  ok(`${name}: connected (components <= distinct rivers + 2)`, ec <= rv + 2, `${ec} comps vs ${rv} rivers`);
}
region("amazon2deg", { lonL: -60, lonR: -58, latT: -2, latB: -4 }, 52, 52);
region("louisiana", { lonL: -96, lonR: -86, latT: 34, latB: 26 }, 104, 83);

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PASS");
process.exit(fails ? 1 : 0);
