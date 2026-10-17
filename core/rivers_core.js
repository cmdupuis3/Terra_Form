/* rivers_core.js -- centerline -> Civ4 river-edge rasterizer (corner-path + per-CHANNEL net-flow)
 * + serializer fragment. Kept in sync with the inlined copy in index.html; validated by rivers_test.js.
 *
 *   view: {lonL,lonR,latT,latB} (lonL<lonR, latT>latB).  fx:0=west..W=east  fy:0=NORTH..H=south.
 *   proj (optional): rotation-aware lon/lat -> grid, see makeRiverProj. The grid is FRAME space --
 *   screen-aligned, view-centred -- and equals the view rect above whenever rot is 0.
 *   tile (gx,gy): gx=0 west, gy=0 NORTH == classifier tiles[gy][gx].
 *   serialize flip: grid[(H-1)-civY][gx]; maps keyed in gridRow space (gr,gx), gr=0 NORTH.
 *   horizontal edge = south edge of tile to its NORTH -> isNOfRiver + RiverWEDirection (E=1,W=3)
 *   vertical   edge = east  edge of tile to its WEST  -> isWOfRiver + RiverNSDirection (N=0,S=2)
 *
 * Corner-snap: snap each reach vertex to the nearest tile corner, Bresenham-connect. Net-flow is
 * accumulated PER CHANNEL (rid): a hairpin that doubles back along the same edge cancels to nothing
 * even when the out-leg and the back-leg are DIFFERENT REACHES of the channel (per-reach netting
 * missed those, leaving a spurious edge with an arbitrary direction). Channels are netted
 * independently, so a tributary (its own rid by the channel decomposition) is never cancelled
 * against the river it joins. A reach without a rid is its own channel (old per-reach behaviour).
 */
(function (root) {
  "use strict";

  /* Rotation-aware lon/lat -> grid projection (the ctrl+drag view rotation). o:
   *   {WSRC,HSRC,rect:{x,y,w,h},W,H,rot,cx,cy} -- rect/cx/cy in source px, rot in degrees about (cx,cy).
   * Returns (lon,lat)->[fx,fy] in the very grid coords the axis-aligned FX/FY produce: lon/lat -> world
   * source px -> worldToFrame -> grid. With rot=0 it is algebraically identical to FX/FY, which is why
   * reachesToEdges' default (no proj) path can stay the literal old formula. */
  /* The world copy is chosen ONCE PER POLYLINE and carried: the first vertex takes the copy nearest
   * the view, every later vertex the copy nearest ITS PREDECESSOR. Per-vertex choice breaks at the
   * antipode, where (cx-wx)/WS lands on the .5 rounding boundary and two adjacent vertices of one
   * river fall a whole world apart -- the staircase then joins opposite frame corners and paints a
   * diagonal across the viewer. Carrying the copy also unwraps a real +/-180 crossing. reset()
   * starts a new polyline; call it per reach, and before any standalone single-point probe. */
  function makeRiverProj(o) {
    const rad = (o.rot || 0) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const R = o.rect, WS = o.WSRC, HS = o.HSRC, cx = o.cx, cy = o.cy;
    let ref = null;
    const P = (lon, lat) => {
      let wx = (lon + 180) / 360 * WS; const wy = (90 - lat) / 180 * HS;
      wx += Math.round(((ref == null ? cx : ref) - wx) / WS) * WS;   // to the view for the first vertex, to the predecessor after
      ref = wx;
      let fx = wx, fy = wy;
      if (rad) { const dx = wx - cx, dy = wy - cy; fx = cx + c * dx + s * dy; fy = cy - s * dx + c * dy; }   // worldToFrame
      return [(fx - R.x) / R.w * o.W, (fy - R.y) / R.h * o.H];
    };
    P.reset = () => { ref = null; };
    return P;
  }

  // proj (optional): (lon,lat)->[fx,fy] grid coords, e.g. makeRiverProj(). Omitted => the axis-aligned
  // view rect, i.e. the north-up behaviour. Everything past the vertex snap is grid-space either way.
  function reachesToEdges(reaches, view, W, H, proj) {
    const nof = new Map(), wof = new Map();
    const { lonL, lonR, latT, latB } = view;
    const sx = W / (lonR - lonL), sy = H / (latT - latB);
    const FX = (lon) => (lon - lonL) * sx, FY = (lat) => (latT - lat) * sy;
    const cl = (v, hi) => v < 0 ? 0 : v > hi ? hi : v;
    const chans = new Map(); let anon = 0;                       // rid -> per-channel signed traversal
    for (const r of reaches) {
      const ck = r.rid != null ? r.rid : "~" + (anon++);
      let C = chans.get(ck); if (!C) { C = { NH: new Map(), VE: new Map(), rid: r.rid }; chans.set(ck, C); }
      const accN = (gr, gx, s) => { if (gr < 0 || gr >= H || gx < 0 || gx >= W) return; const k = gr + "," + gx; let e = C.NH.get(k); if (!e) C.NH.set(k, e = { n: 0, d: 0 }); e.n += s; if (r.d > e.d) e.d = r.d; };
      const accW = (gy, gx, s) => { if (gy < 0 || gy >= H || gx < 0 || gx >= W) return; const k = gy + "," + gx; let e = C.VE.get(k); if (!e) C.VE.set(k, e = { n: 0, d: 0 }); e.n += s; if (r.d > e.d) e.d = r.d; };
      const step = (x0, y0, x1, y1) => {                          // one unit lattice edge, signed (E/S=+1, W/N=-1)
        if (y0 === y1) accN(y0 - 1, Math.min(x0, x1), x1 > x0 ? 1 : -1);   // horizontal: south edge of north tile
        else accW(Math.min(y0, y1), x0 - 1, y1 > y0 ? 1 : -1);             // vertical: east edge of west tile (fy grows south)
      };
      const connect = (ax, ay, bx, by) => {   // Bresenham staircase, not an L: follows the true line, tile by tile
        let x = ax, y = ay; const adx = Math.abs(bx - ax), ady = Math.abs(by - ay), sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
        let err = adx - ady;
        while (x !== bx || y !== by) { const e2 = 2 * err; let moved = false;
          if (e2 > -ady && x !== bx) { err -= ady; step(x, y, x + sx, y); x += sx; moved = true; }
          if (e2 < adx && y !== by) { err += adx; step(x, y, x, y + sy); y += sy; moved = true; }
          if (!moved) break; }
      };
      let px = null, py = null; if (proj && proj.reset) proj.reset();   // one world copy per reach, like px/py
      for (const part of r.l) for (const pt of part) {
        const g = proj ? proj(pt[0], pt[1]) : [FX(pt[0]), FY(pt[1])];
        const cx = cl(Math.round(g[0]), W), cy = cl(Math.round(g[1]), H);
        if (px !== null && (cx !== px || cy !== py)) connect(px, py, cx, cy);
        px = cx; py = cy;
      }
    }
    for (const C of chans.values()) {                            // merge channels: higher discharge wins an edge
      for (const [k, e] of C.NH) { if (!e.n) continue; const cur = nof.get(k); if (!cur || e.d > cur.d) nof.set(k, { dir: e.n > 0 ? 1 : 3, d: e.d, rid: C.rid }); }
      for (const [k, e] of C.VE) { if (!e.n) continue; const cur = wof.get(k); if (!cur || e.d > cur.d) wof.set(k, { dir: e.n > 0 ? 2 : 0, d: e.d, rid: C.rid }); }
    }
    return { nof, wof };
  }

  function plotRiverLines(nof, wof, gx, civY, H) {
    const gr = (H - 1) - civY, out = [];
    const n = nof.get(gr + "," + gx), w = wof.get(gr + "," + gx);
    if (n) { out.push("\tisNOfRiver"); out.push("\tRiverWEDirection=" + n.dir); }
    if (w) { out.push("\tisWOfRiver"); out.push("\tRiverNSDirection=" + w.dir); }
    return out;
  }

  /* nudgeRiverEdges: clear every four-sided tile (river on all 4 sides -- invalid in Civ) and straighten
     single-channel hairpin wraps (river on 3 sides of one tile), preserving PER-CHANNEL connectivity.
     Replaces the old sanitizeHairpins / nudgeNearHairpins / nudgeEnclosedTiles trio, which (a) missed
     single-channel wraps with 3+ junction corners, (b) split channels mid-course when breaking
     multi-channel enclosures, and (c) CREATED hairpin wraps + stubs by leaving 3-edge U's behind.

     Phase 1 (deletion only -- cannot create new four-sided tiles; one sweep reaches the fixpoint):
       single channel: the 4 edges are a same-channel cycle, so any subset deletion that keeps the
         junction corners connected keeps the channel connected. Junctions J = corners with external
         edges. |J|<=1 -> drop the whole zero-net-displacement loop; |J|==2 -> drop the junction-free
         longer arc (interiors are pure by definition of J); |J|>=3 -> drop one edge (cycle => safe),
         preferring no new degree-1 tips, then low discharge.
       multi channel: prefer deleting one channel's WHOLE edge-group when that is "clean" -- every
         corner it fully owns carries nothing external, so each severed end lands on a corner it
         shares with the surviving channel (the tributary visibly braids into the bigger river for
         one tile; no stub, no leftover 3-sided wrap). The common anti-parallel 2+2 squeeze resolves
         this way. Otherwise score each single edge by the damage deleting it does TO ITS OWN channel:
         0 = redundant (channel stays one piece), 1 = trims a channel tip, 2 = true mid-course split
         (last resort); ties by discharge, then fewest stubs, then side order. The old pass picked the
         lowest-discharge channel blindly and routinely cut tributaries in half.
     Phase 2 (the actual nudge, run to a fixpoint): a tile with river on exactly 3 sides, all one
       channel, whose two interior corners carry nothing else, is a one-tile detour. Replace the
       3-edge arc with the single chord edge on the missing side -- identical endpoints, so channel
       connectivity is exact; flow direction is carried over from the arc. Guarded: the chord must be
       in-grid, pass edgeOk (land rules -- rivers may not touch coast/water), and must not push the
       neighbouring tile past 2 edges unless all its edges are the same channel (then the wrap has
       merely moved and a later sweep collapses it too). Each collapse removes 2 net edges, so the
       loop terminates and can never create a four-sided tile. */
  function nudgeRiverEdges(nof, wof, W, H, edgeOk) {
    const ok = edgeOk || (() => true), M = (m) => (m === "nof" ? nof : wof);
    const deg = new Map();
    const bump = (cx, cy, s) => { const k = cx + "," + cy, v = (deg.get(k) || 0) + s; if (v) deg.set(k, v); else deg.delete(k); };
    const cornersOf = (m, key) => { const p = key.split(",").map(Number), a = p[0], b = p[1];
      return m === "nof" ? [[b, a + 1], [b + 1, a + 1]] : [[b + 1, a], [b + 1, a + 1]]; };
    const applyDeg = (m, key, s) => { for (const c of cornersOf(m, key)) bump(c[0], c[1], s); };
    for (const k of nof.keys()) applyDeg("nof", k, 1);
    for (const k of wof.keys()) applyDeg("wof", k, 1);
    const D = (c) => deg.get(c[0] + "," + c[1]) || 0;
    const delE = (m, key) => { M(m).delete(key); applyDeg(m, key, -1); };
    const setE = (m, key, v) => { M(m).set(key, v); applyDeg(m, key, 1); };
    // tile cycle: corners NW,NE,SE,SW; edge i joins corner i and i+1 (mod 4)
    const tileC = (gx, gy) => [[gx, gy], [gx + 1, gy], [gx + 1, gy + 1], [gx, gy + 1]];
    const tileE = (gx, gy) => [
      { s: "N", m: "nof", key: (gy - 1) + "," + gx }, { s: "E", m: "wof", key: gy + "," + gx },
      { s: "S", m: "nof", key: gy + "," + gx }, { s: "W", m: "wof", key: gy + "," + (gx - 1) }];
    const ord = { N: 0, E: 1, S: 2, W: 3 };
    // per-channel probes (channels are tiny subgraphs; on-demand scans are cheap and only run on violations)
    const chanAt = (rid, cx, cy) => { let n = 0;
      for (const m of ["nof", "wof"]) for (const [k, e] of M(m).entries()) { if (e.rid !== rid) continue;
        for (const c of cornersOf(m, k)) if (c[0] === cx && c[1] === cy) { n++; break; } }
      return n; };
    const chanComps = (rid, skipM, skipKey) => {
      const adj = new Map(), link = (a, b) => { (adj.get(a) || adj.set(a, new Set()).get(a)).add(b); (adj.get(b) || adj.set(b, new Set()).get(b)).add(a); };
      for (const m of ["nof", "wof"]) for (const [k, e] of M(m).entries()) { if (e.rid !== rid || (m === skipM && k === skipKey)) continue;
        const cs = cornersOf(m, k); link(cs[0].join(","), cs[1].join(",")); }
      let c = 0; const seen = new Set();
      for (const s of adj.keys()) { if (seen.has(s)) continue; c++; const st = [s];
        while (st.length) { const v = st.pop(); if (seen.has(v)) continue; seen.add(v); for (const w of adj.get(v)) if (!seen.has(w)) st.push(w); } }
      return c; };
    // ---- phase 1: four-sided tiles (every such tile has both horizontal edges, so nof keys find them all)
    const seenT = new Set();
    for (const k0 of [...nof.keys()]) {
      const p0 = k0.split(",").map(Number);
      for (const gy of [p0[0], p0[0] + 1]) {           // k0 = S edge of (gx,gy0) and N edge of (gx,gy0+1)
        const gx = p0[1], tk = gx + "," + gy; if (seenT.has(tk)) continue; seenT.add(tk);
        const E4 = tileE(gx, gy), V4 = E4.map(e => M(e.m).get(e.key));
        if (V4.some(v => !v)) continue;
        const C4 = tileC(gx, gy), rid0 = V4[0].rid;
        if (rid0 != null && V4.every(v => v.rid === rid0)) {
          const J = []; for (let i = 0; i < 4; i++) if (D(C4[i]) > 2) J.push(i);
          if (J.length <= 1) { for (const e of E4) delE(e.m, e.key); continue; }
          if (J.length === 2) {
            const a = J[0], fl = J[1] - a, from = fl >= 4 - fl ? a : J[1], n = Math.max(fl, 4 - fl);
            for (let i = 0; i < n; i++) { const e = E4[(from + i) % 4]; delE(e.m, e.key); }
            continue;
          }
          let pick = null;
          for (let i = 0; i < 4; i++) { const stubs = (D(C4[i]) <= 2 ? 1 : 0) + (D(C4[(i + 1) % 4]) <= 2 ? 1 : 0), d = V4[i].d || 0;
            if (!pick || stubs < pick.stubs || (stubs === pick.stubs && d < pick.d)) pick = { i, stubs, d }; }
          delE(E4[pick.i].m, E4[pick.i].key); continue;
        }
        const groups = new Map();                      // rid group -> indices into E4 (corner c touches edges c and (c+3)%4)
        for (let i = 0; i < 4; i++) { const gk = V4[i].rid == null ? "~" + i : "r" + V4[i].rid;
          let g = groups.get(gk); if (!g) groups.set(gk, g = { idx: [], maxd: 0 }); g.idx.push(i); if ((V4[i].d || 0) > g.maxd) g.maxd = V4[i].d || 0; }
        let minMaxd = Infinity; for (const g of groups.values()) if (g.maxd < minMaxd) minMaxd = g.maxd;
        let sac = null;                                // clean whole-group deletion of the WEAKEST channel: braid, not split
        for (const g of groups.values()) {
          if (g.maxd > minMaxd) continue;              // never sacrifice a dominant channel's line
          let clean = true;
          for (let c = 0; c < 4 && clean; c++) if (g.idx.includes(c) && g.idx.includes((c + 3) % 4) && D(C4[c]) > 2) clean = false;
          if (clean && (!sac || g.idx.length < sac.idx.length || (g.idx.length === sac.idx.length && Math.min(...g.idx) < Math.min(...sac.idx)))) sac = g;
        }
        if (sac) { for (const i of sac.idx) delE(E4[i].m, E4[i].key); continue; }
        let pick = null;
        for (let i = 0; i < 4; i++) { const v = V4[i], e = E4[i]; let cls;
          if (v.rid == null) cls = 1;
          else if (chanAt(v.rid, C4[i][0], C4[i][1]) === 1 || chanAt(v.rid, C4[(i + 1) % 4][0], C4[(i + 1) % 4][1]) === 1) cls = 1;
          else cls = (chanComps(v.rid, e.m, e.key) === chanComps(v.rid, null, null)) ? 0 : 2;
          const stubs = (D(C4[i]) <= 2 ? 1 : 0) + (D(C4[(i + 1) % 4]) <= 2 ? 1 : 0), d = v.d || 0;
          if (!pick || cls < pick.cls || (cls === pick.cls && (d < pick.d || (d === pick.d && (stubs < pick.stubs || (stubs === pick.stubs && ord[e.s] < ord[pick.e.s])))))) pick = { e, cls, d, stubs };
        }
        delE(pick.e.m, pick.e.key);
      }
    }
    // ---- phase 2: collapse single-channel 3-edge wraps onto the missing-side chord (fixpoint)
    let guard = 0;
    for (let changed = true; changed && guard++ < 10000;) {
      changed = false;
      for (const k0 of [...nof.keys()]) {
        if (!nof.has(k0)) continue;                    // consumed by an earlier collapse this sweep
        const p0 = k0.split(",").map(Number);
        for (const gy of [p0[0], p0[0] + 1]) {
          const gx = p0[1], E4 = tileE(gx, gy), V4 = E4.map(e => M(e.m).get(e.key));
          if (V4.filter(Boolean).length !== 3) continue;
          const mi = V4.findIndex(v => !v), ch = E4[mi];
          const kp = ch.key.split(",").map(Number);
          if (kp[0] < 0 || kp[0] >= H || kp[1] < 0 || kp[1] >= W) continue;   // chord not representable
          const C4 = tileC(gx, gy), arcI = [(mi + 1) % 4, (mi + 2) % 4, (mi + 3) % 4];
          const rid = V4[arcI[0]].rid;
          if (rid == null || arcI.some(i => V4[i].rid !== rid)) continue;
          if (D(C4[(mi + 2) % 4]) !== 2 || D(C4[(mi + 3) % 4]) !== 2) continue;   // interior corners must carry nothing else
          if (!ok(ch.m, ch.key)) continue;
          const nb = mi === 0 ? [gx, gy - 1] : mi === 1 ? [gx + 1, gy] : mi === 2 ? [gx, gy + 1] : [gx - 1, gy];
          const nbV = tileE(nb[0], nb[1]).map(e => M(e.m).get(e.key)).filter(Boolean);
          if (nbV.length > 2 || (nbV.length === 2 && !nbV.every(v => v.rid === rid))) continue;
          let vote = 0, cur = C4[(mi + 1) % 4];        // flow orientation along the arc path C[mi+1] -> C[mi]
          for (const i of arcI) { const nxt = C4[(i + 1) % 4], v = V4[i];
            vote += (E4[i].m === "nof" ? (nxt[0] > cur[0] ? v.dir === 1 : v.dir === 3) : (nxt[1] > cur[1] ? v.dir === 2 : v.dir === 0)) ? 1 : -1;
            cur = nxt; }
          const A = vote >= 0 ? C4[(mi + 1) % 4] : C4[mi], B = vote >= 0 ? C4[mi] : C4[(mi + 1) % 4];
          const dir = ch.m === "nof" ? (B[0] > A[0] ? 1 : 3) : (B[1] > A[1] ? 2 : 0);
          let d = 0, br = false;
          for (const i of arcI) { if ((V4[i].d || 0) > d) d = V4[i].d || 0; if (V4[i].bridge) br = true; }
          for (const i of arcI) delE(E4[i].m, E4[i].key);
          const entc = { dir, d, rid }; if (br) entc.bridge = true;
          setE(ch.m, ch.key, entc);
          changed = true; break;                       // this tile's other flank no longer applies
        }
      }
    }
  }

  const api = { reachesToEdges, makeRiverProj, plotRiverLines, nudgeRiverEdges };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RiversCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
