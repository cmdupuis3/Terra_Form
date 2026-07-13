/* rivers_core.js -- centerline -> Civ4 river-edge rasterizer (corner-path + per-CHANNEL net-flow)
 * + serializer fragment. Kept in sync with the inlined copy in index.html; validated by rivers_test.js.
 *
 *   view: {lonL,lonR,latT,latB} (lonL<lonR, latT>latB).  fx:0=west..W=east  fy:0=NORTH..H=south.
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

  function reachesToEdges(reaches, view, W, H) {
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
      let px = null, py = null;
      for (const part of r.l) for (const pt of part) {
        const cx = cl(Math.round(FX(pt[0])), W), cy = cl(Math.round(FY(pt[1])), H);
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

  const api = { reachesToEdges, plotRiverLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RiversCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
