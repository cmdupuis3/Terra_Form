/* rivers_core.js -- centerline -> Civ4 river-edge rasterizer (corner-path + per-reach net-flow)
 * + serializer fragment. Kept in sync with the inlined copy in index.html; validated by rivers_test.js.
 *
 *   view: {lonL,lonR,latT,latB} (lonL<lonR, latT>latB).  fx:0=west..W=east  fy:0=NORTH..H=south.
 *   tile (gx,gy): gx=0 west, gy=0 NORTH == classifier tiles[gy][gx].
 *   serialize flip: grid[(H-1)-civY][gx]; maps keyed in gridRow space (gr,gx), gr=0 NORTH.
 *   horizontal edge = south edge of tile to its NORTH -> isNOfRiver + RiverWEDirection (E=1,W=3)
 *   vertical   edge = east  edge of tile to its WEST  -> isWOfRiver + RiverNSDirection (N=0,S=2)
 *
 * Corner-snap: snap each reach vertex to the nearest tile corner, Manhattan-connect. Net-flow is
 * accumulated PER REACH (a single reach's out-and-back U-turn cancels to nothing) then merged across
 * reaches -- so U-turns drop but a tributary is never cancelled against the river it joins.
 */
(function (root) {
  "use strict";

  function reachesToEdges(reaches, view, W, H) {
    const nof = new Map(), wof = new Map();
    const { lonL, lonR, latT, latB } = view;
    const sx = W / (lonR - lonL), sy = H / (latT - latB);
    const FX = (lon) => (lon - lonL) * sx, FY = (lat) => (latT - lat) * sy;
    const cl = (v, hi) => v < 0 ? 0 : v > hi ? hi : v;
    for (const r of reaches) {
      const NH = new Map(), VE = new Map();
      const accN = (gr, gx, s) => { if (gr < 0 || gr >= H || gx < 0 || gx >= W) return; const k = gr + "," + gx; NH.set(k, (NH.get(k) || 0) + s); };
      const accW = (gy, gx, s) => { if (gy < 0 || gy >= H || gx < 0 || gx >= W) return; const k = gy + "," + gx; VE.set(k, (VE.get(k) || 0) + s); };
      const step = (x0, y0, x1, y1) => {
        if (y0 === y1) accN(y0 - 1, Math.min(x0, x1), x1 > x0 ? 1 : -1);
        else accW(Math.min(y0, y1), x0 - 1, y1 > y0 ? 1 : -1);
      };
      const connect = (ax, ay, bx, by) => {
        let x = ax, y = ay; const dx = Math.sign(bx - ax), dy = Math.sign(by - ay), xFirst = Math.abs(bx - ax) >= Math.abs(by - ay);
        if (xFirst) { while (x !== bx) { step(x, y, x + dx, y); x += dx; } while (y !== by) { step(x, y, x, y + dy); y += dy; } }
        else { while (y !== by) { step(x, y, x, y + dy); y += dy; } while (x !== bx) { step(x, y, x + dx, y); x += dx; } }
      };
      let px = null, py = null;
      for (const part of r.l) for (const pt of part) {
        const cx = cl(Math.round(FX(pt[0])), W), cy = cl(Math.round(FY(pt[1])), H);
        if (px !== null && (cx !== px || cy !== py)) connect(px, py, cx, cy);
        px = cx; py = cy;
      }
      for (const [k, net] of NH) { if (net > 0) { const e = nof.get(k); if (!e || r.d > e.d) nof.set(k, { dir: 1, d: r.d }); } else if (net < 0) { const e = nof.get(k); if (!e || r.d > e.d) nof.set(k, { dir: 3, d: r.d }); } }
      for (const [k, net] of VE) { if (net > 0) { const e = wof.get(k); if (!e || r.d > e.d) wof.set(k, { dir: 2, d: r.d }); } else if (net < 0) { const e = wof.get(k); if (!e || r.d > e.d) wof.set(k, { dir: 0, d: r.d }); } }
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
