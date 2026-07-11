/* rivers_test.js -- validate the corner-snap rasterizer + serializer mapping. */
const fs = require("fs");
const { reachesToEdges, plotRiverLines } = require("./rivers_core.js");

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
function distinctRivers(reaches) {
  const par = reaches.map((_, i) => i), find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }, em = new Map();
  reaches.forEach((f, i) => { const a = f.l[0][0], z = f.l.at(-1).at(-1); for (const e of [a[0] + "," + a[1], z[0] + "," + z[1]]) { if (em.has(e)) { const x = find(em.get(e)), y = find(i); if (x !== y) par[x] = y; } else em.set(e, i); } });
  return new Set(reaches.map((_, i) => find(i))).size;
}
function region(name, box, W, H) {
  const j = JSON.parse(fs.readFileSync("/mnt/user-data/uploads/rivers_o3.json", "utf8"));
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
