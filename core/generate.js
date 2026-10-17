/* core/generate.js -- lakes, salt pans and rivers generated on the height field, for both of the app's pathways.
 *
 * FRAME pathway (a region of the real Earth): a feature is computed on an analysis grid laid over the current
 * frame (k x k cells per tile, heights from the working elevation grid) and stored WORLD-PINNED in lon/lat, so it
 * behaves like the real data it imitates: a lake or salt pan is a polygon that sampleRegion folds into each tile's
 * land fraction / playa fraction (genApplySamples), a river is a polyline that computeRiverEdges adds to the real
 * river reaches (genReaches). Every later frame, snapshot and export of that part of the world carries them; a
 * snapshot bakes them into its tiles and river edges.
 *
 * COMPOSE pathway (the collage): a feature is computed on the composite's own tiles (heights from the `_h` every
 * evaluated tile carries; a pseudo-height from relief and distance to water for tiles that lack it) and stored in
 * canvas tile coordinates, like an erasure: lakes and salt pans repaint tiles through the game module's optional
 * paint(t, kind) hook, rivers are polylines rasterised onto tile edges by the same corner-snap rasteriser as real
 * rivers (reachesToEdges). They are applied after every patch and erasure (genApplyCompose), so they stay where
 * they were drawn when patches move.
 *
 * The two algorithms are the same in both pathways:
 *   lake / salt pan  basin fill: from the seed, walk downhill to the local low point, then flood lowest-first
 *                    (height + a small distance penalty that keeps the shape compact) until the target area is
 *                    reached. Water and the cells next to it are never flooded, so a lake cannot become a bay.
 *                    The natural basin (the depression the seed drains into, from a priority flood) is reported
 *                    so the agent knows whether the lake would overflow; outlet:'auto' then sends a river from the
 *                    lowest rim cell to the sea unless the lake sits in arid climate (endorheic).
 *   river            priority flood (Barnes et al. 2014) from every water cell gives each land cell a receiver
 *                    on a depression-free surface; a river follows the receivers from its source until it meets
 *                    water or an existing river (a confluence). The polyline is smoothed (Chaikin) and given a
 *                    small seeded meander before rasterisation.
 *
 * Classic script: it reads core/app.js's globals (view, srcRect, heightArr, comp, evaluateFrame, ...) at CALL
 * time, never at load time, and exposes TerraForm.api.gen for core/bridge.js (the MCP server).
 */
(function () {
  const T = window.TerraForm;

  /* ---------- small helpers ---------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function hash01(a, b, s) { let h = (Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul((s | 0) + 1, 1274126177)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; h ^= h >>> 16; return h / 4294967296; }

  /* binary min-heap over (key, value) */
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  };
  Object.defineProperty(Heap.prototype, 'size', { get() { return this.k.length; } });

  /* ---------- the algorithms (pure: grids in, grids out) ---------- */

  /* Priority flood from the outlet cells (water, else the map border): filled[] is the depression-free surface,
     recv[] the downstream neighbour of each reached cell (-1 at an outlet, -2 if never reached: blocked or walled
     off), order[] the cells in the order they were reached (outlets first), so a reverse walk accumulates flow. */
  function priorityFlood(h, W, H, isOutlet, blocked, edgeOutlets) {   // edgeOutlets: the map border drains too (the world goes on past the frame)
    const N = W * H, filled = new Float32Array(N), recv = new Int32Array(N).fill(-2), seen = new Uint8Array(N), order = [], q = new Heap();
    for (let i = 0; i < N; i++) { if (blocked && blocked[i]) { seen[i] = 1; continue; } const x = i % W, y = (i - x) / W; if (isOutlet(i) || (edgeOutlets && (x === 0 || y === 0 || x === W - 1 || y === H - 1))) { seen[i] = 1; filled[i] = h[i]; recv[i] = -1; q.push(h[i], i); } }
    if (!q.size) for (let i = 0; i < N; i++) { const x = i % W, y = (i - x) / W; if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && !seen[i]) { seen[i] = 1; filled[i] = h[i]; recv[i] = -1; q.push(h[i], i); } }
    while (q.size) {
      const c = q.pop(), cx = c % W, cy = (c - cx) / W; order.push(c);
      for (const [dx, dy] of N8) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx; if (seen[n]) continue; seen[n] = 1;
        filled[n] = Math.max(h[n], filled[c] + 1e-6); recv[n] = c; q.push(filled[n], n);
      }
    }
    return { filled, recv, order };
  }
  /* path length (in cells) from every cell to its outlet along the receivers */
  function pathLengths(PF, W) {
    const len = new Float32Array(PF.recv.length);
    for (const c of PF.order) { const r = PF.recv[c]; if (r < 0) continue; const dx = Math.abs(c % W - r % W), dy = Math.abs(((c / W) | 0) - ((r / W) | 0)); len[c] = len[r] + (dx && dy ? 1.414 : 1); }
    return len;
  }
  /* the natural basin around a pit: cells whose filled surface stands above the terrain, connected to it */
  function basinOf(PF, h, W, H, seed) {
    const out = [], seen = new Uint8Array(W * H), st = [seed]; seen[seed] = 1;
    if (!(PF.filled[seed] - h[seed] > 1e-5)) return out;
    while (st.length) {
      const c = st.pop(); out.push(c); const cx = c % W, cy = (c - cx) / W;
      for (const [dx, dy] of N8) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (seen[n]) continue; seen[n] = 1; if (PF.filled[n] - h[n] > 1e-5) st.push(n); }
    }
    return out;
  }
  /* walk downhill on the raw height from the seed to the local low point, never into a blocked cell */
  function descend(h, W, H, seed, blocked) {
    let c = seed;
    for (let step = 0; step < 4 * (W + H); step++) {
      const cx = c % W, cy = (c - cx) / W; let best = c, bh = h[c];
      for (const [dx, dy] of N8) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (blocked[n]) continue; if (h[n] < bh - 1e-7) { bh = h[n]; best = n; } }
      if (best === c) break; c = best;
    }
    return c;
  }
  /* basin fill: lowest-first from the seed until `area` cells, a distance penalty (per cell) keeping it compact */
  function fillBasin(h, W, H, seed, area, blocked, compact) {
    const taken = new Uint8Array(W * H), q = new Heap(), cells = [], sx = seed % W, sy = (seed - sx) / W;
    let level = -Infinity; q.push(h[seed], seed);
    while (q.size && cells.length < area) {
      const c = q.pop(); if (taken[c]) continue; taken[c] = 1; cells.push(c); if (h[c] > level) level = h[c];
      const cx = c % W, cy = (c - cx) / W;
      for (const [dx, dy] of N4) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (taken[n] || blocked[n]) continue; q.push(h[n] + compact * Math.hypot(nx - sx, ny - sy), n); }
    }
    return { cells, level, taken };
  }
  /* closed boundary rings of a cell mask, in cell-corner coordinates (outer rings and holes; fill even-odd) */
  function maskRings(mask, W, H) {
    const out = new Map(), key = (x, y) => x + ',' + y, add = (ax, ay, bx, by) => { const k = key(ax, ay); let l = out.get(k); if (!l) out.set(k, l = []); l.push([ax, ay, bx, by]); };
    const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y); if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1); if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
    const rings = [];
    for (const [, list] of out) while (list.length) {
      let e = list.pop(); const ring = [[e[0], e[1]]], sk = key(e[0], e[1]);
      for (let guard = 0; guard < 4 * W * H + 8; guard++) {
        const k = key(e[2], e[3]); ring.push([e[2], e[3]]); if (k === sk) break;
        const nl = out.get(k); if (!nl || !nl.length) break;
        let pick = 0; if (nl.length > 1) { const dx = e[2] - e[0], dy = e[3] - e[1]; for (let i = 0; i < nl.length; i++) { const ex = nl[i][2] - nl[i][0], ey = nl[i][3] - nl[i][1]; if (dx * ey - dy * ex > 0) { pick = i; break; } } }   // at a pinch corner turn right, so diagonal neighbours stay separate rings
        e = nl.splice(pick, 1)[0];
      }
      ring.pop();
      const r = ring.filter((p, i) => { const a = ring[(i - 1 + ring.length) % ring.length], b = ring[(i + 1) % ring.length]; return (b[0] - a[0]) * (p[1] - a[1]) !== (b[1] - a[1]) * (p[0] - a[0]); });   // drop collinear corners
      if (r.length >= 3) rings.push(r);
    }
    return rings;
  }
  function chaikin(pts, iters, closed) {
    let p = pts;
    for (let it = 0; it < iters; it++) {
      const q = [], n = p.length, m = closed ? n : n - 1;
      if (!closed) q.push(p[0]);
      for (let i = 0; i < m; i++) { const a = p[i], b = p[(i + 1) % n]; q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]); }
      if (!closed) q.push(p[n - 1]);
      p = q;
    }
    return p;
  }
  /* a river's cell path as a smoothed, gently meandering polyline (cell-centre units) */
  function riverLine(path, W, meander, seed) {
    let pts = path.map(c => [c % W + 0.5, ((c / W) | 0) + 0.5]);
    if (pts.length > 2 && meander > 0) pts = pts.map((p, i) => { if (i === 0 || i === pts.length - 1) return p; const a = pts[i - 1], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, o = (hash01(i, 7, seed) - 0.5) * meander * 0.9; return [p[0] - dy / L * o, p[1] + dx / L * o]; });
    return chaikin(pts, 2, false);
  }
  function inRings(rings, x, y) { let inside = false; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
  function bboxOf(rings) { let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity; for (const r of rings) for (const p of r) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; } return [w, s, e, n]; }
  const isArid = kc => kc >= 4 && kc <= 7;   // Köppen B (BWh BWk BSh BSk)
  const metres = h => T.util && T.util.heightMetres ? Math.round(T.util.heightMetres(h)) : null;

  function cornersOf(rivers) {   // tile-corner vertices (tile units) of every river edge: nof (gr,gx) is the boundary under row gr, wof (gy,gx) the boundary east of column gx
    const out = [], ents = m => !m ? [] : (typeof m.forEach === 'function' && typeof m.set === 'function' ? Array.from(m) : m);
    for (const [key] of ents(rivers && rivers.nof)) { const p = String(key).split(','), gr = +p[0], gx = +p[1]; out.push([gx, gr + 1], [gx + 1, gr + 1]); }
    for (const [key] of ents(rivers && rivers.wof)) { const p = String(key).split(','), gy = +p[0], gx = +p[1]; out.push([gx + 1, gy], [gx + 1, gy + 1]); }
    return out;
  }
  /* ---------- one analysis context: a grid of heights + water + climate, and mapping back to the tiles ---------- */
  /* ctx = { GW, GH, k, W, H, h, water, kc(i) -> Köppen class or 0, riverTile(i) -> 1 on a tile a river already touches,
             tileOf(i) -> [tx,ty], cellOf(tx,ty) -> centre cell of a tile } */
  function blockedNear(ctx, extra) {   // water, a one-TILE buffer around it (k cells, 8-n), and a one-tile band along the map edge: a lake or pan never touches either
    const { GW, GH, k } = ctx, b = new Uint8Array(GW * GH);   // a whole tile, not a cell: sampling turns a tile at least half lake into water, so a one-cell gap could vanish
    for (let i = 0; i < b.length; i++) {
      if (extra && extra[i]) b[i] = 1;
      const x = i % GW, y = (i - x) / GW;
      if (x < k || y < k || x >= GW - k || y >= GH - k) b[i] = 1;
      if (!ctx.water[i]) continue;
      for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) b[ny * GW + nx] = 1; }
    }
    return b;
  }
  /* automatic placement keeps max(3 tiles, 10% of the shorter side) off the map edge, in cells */
  const autoMargin = (ctx, extraTiles) => (Math.max(3, Math.round(0.1 * Math.min(ctx.GW, ctx.GH) / ctx.k)) + (extraTiles | 0)) * ctx.k;
  function autoBasinSeed(ctx, PF, blocked, wantArid, room) {
    const { GW, GH, k, h } = ctx; let best = -1, bs = -Infinity; const R = autoMargin(ctx, room);   // the same margin the downhill walk keeps, so an automatic seed never starts inside it
    for (let i = 0; i < GW * GH; i++) {
      if (blocked[i]) continue;
      const kc = ctx.kc(i); if (wantArid === true && !isArid(kc)) continue;
      const x = i % GW, y = (i - x) / GW; if (x < R || y < R || x >= GW - R || y >= GH - R) continue;
      let s = 0, n = 0; for (let dy = -R; dy <= R; dy += k) for (let dx = -R; dx <= R; dx += k) { s += h[(y + dy) * GW + x + dx]; n++; }
      const tpi = s / n - h[i], dep = PF.filled[i] - h[i];
      const score = dep * 4000 + tpi * 800 - h[i] * 2 + (wantArid === false && isArid(kc) ? -1 : 0) + hash01(x, y, 3) * 1e-3;
      if (score > bs) { bs = score; best = i; }
    }
    return best;
  }
  function makeBasinFeature(ctx, kind, opts) {
    const { GW, GH, k, h } = ctx, notes = [];
    const avoid = ctx.avoid ? ctx.avoid() : null, blocked = blockedNear(ctx, avoid);
    const PF = priorityFlood(h, GW, GH, i => !!ctx.water[i], null, true);
    const room = Math.ceil(Math.sqrt(clamp(+opts.area || (kind === 'lake' ? 6 : 5), 1, 400)) / 2) + (opts.saltFringe | 0);   // tiles an automatic seed keeps clear of the edge on top of the margin
    let seed;
    if (opts.at) { const c = ctx.cellOf(opts.at[0], opts.at[1]); if (c < 0) throw new Error('at ' + opts.at.join(',') + ' is outside the grid'); if (ctx.water[c]) throw new Error('at ' + opts.at.join(',') + ' is water'); seed = c; if (blocked[seed]) notes.push('the seed touches water; moved to the nearest dry cell'); }
    else { seed = autoBasinSeed(ctx, PF, blocked, kind === 'salt_pan' ? true : null, room); if (seed < 0 && kind === 'salt_pan') { seed = autoBasinSeed(ctx, PF, blocked, null, room); if (seed >= 0) notes.push('no arid land here; the pan was put in the lowest basin anyway'); } if (seed < 0) throw new Error('no dry land away from water to put a ' + kind.replace('_', ' ') + ' on; give at:[x,y]'); }
    if (blocked[seed]) { let best = -1, bd = Infinity; const sx = seed % GW, sy = (seed - sx) / GW; for (let i = 0; i < GW * GH; i++) if (!blocked[i]) { const d = Math.hypot(i % GW - sx, ((i / GW) | 0) - sy); if (d < bd) { bd = d; best = i; } } if (best < 0) throw new Error('no dry land away from water'); seed = best; }
    if (opts.descend !== false) {   // an automatic seed keeps three tiles off the map edge, so the feature is not cut by the frame
      let bl = blocked; if (!opts.at) { bl = Uint8Array.from(blocked); const m = autoMargin(ctx, room); for (let i = 0; i < bl.length; i++) { const x = i % GW, y = (i - x) / GW; if (x < m || y < m || x >= GW - m || y >= GH - m) bl[i] = 1; } }
      seed = descend(h, GW, GH, seed, bl);
    }
    const areaT = clamp(+opts.area || (kind === 'lake' ? 6 : 5), 1, 400), area = Math.max(1, Math.round(areaT * k * k));
    const compact = (opts.compact != null ? +opts.compact : kind === 'salt_pan' ? 0.05 : 0.004) / k;   // a pan is a flat floor: rounder by default, or it threads up a valley and samples as scattered tiles
    const F = fillBasin(h, GW, GH, seed, area, blocked, compact);
    if (F.cells.length < area) notes.push(`only ${(F.cells.length / (k * k)).toFixed(1)} tiles of dry land reachable from the seed`);
    const basin = basinOf(PF, h, GW, GH, seed), mask = new Uint8Array(GW * GH); for (const c of F.cells) mask[c] = 1;
    let fringe = null;
    if (kind === 'lake' && (opts.saltFringe | 0) > 0) {   // an endorheic lake's salt flats: a ring of pan around the water
      fringe = new Uint8Array(GW * GH); const r = (opts.saltFringe | 0) * k;
      for (const c of F.cells) { const x = c % GW, y = (c - x) / GW; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue; const n = ny * GW + nx; if (!mask[n] && !ctx.water[n] && dx * dx + dy * dy <= r * r) fringe[n] = 1; } }
    }
    // climate of the shore decides an outlet when asked for 'auto'
    let aridN = 0, n = 0; for (const c of F.cells) { const kc = ctx.kc(c); if (kc) { n++; if (isArid(kc)) aridN++; } }
    const arid = n ? aridN / n > 0.5 : false;
    const sxT = (seed % GW) / k, syT = ((seed / GW) | 0) / k;
    const info = { kind, at: [Math.floor(sxT), Math.floor(syT)], tiles: +(F.cells.length / (k * k)).toFixed(1), level: metres(F.level), basinTiles: +(basin.length / (k * k)).toFixed(1), climate: n ? (arid ? 'arid' : 'humid') : 'unknown', notes };
    if (basin.length && F.cells.length > basin.length) notes.push(kind === 'lake' ? `larger than its natural basin (${info.basinTiles} tiles): a real lake this size would overflow` : `larger than the closed basin it sits in (${info.basinTiles} tiles): a real pan this size would be an open flat`);
    let outletPath = null;
    const below = PF.filled[seed] - F.level > 1e-6;   // the basin's spill point stands above the water: nothing flows out
    const belowM = below && T.util && T.util.heightMetres ? Math.round(T.util.heightMetres(PF.filled[seed]) - T.util.heightMetres(F.level)) : 0;
    const wantOutlet = kind === 'lake' && (opts.outlet === 'river' || (opts.outlet !== 'none' && !arid && !below && (opts.outlet === 'auto' || opts.outlet == null)));
    if (kind === 'lake' && below && opts.outlet === 'river') notes.push(`the water stands ${belowM} m below the basin's spill point, so the outlet is a carved channel`);
    if (wantOutlet) {
      const PF2 = priorityFlood(h, GW, GH, i => !!ctx.water[i], mask, true);   // the lake itself walled off: the rim drains away from it
      let rim = -1, rh = Infinity;
      for (const c of F.cells) { const x = c % GW, y = (c - x) / GW; for (const [dx, dy] of N4) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue; const q = ny * GW + nx; if (mask[q] || ctx.water[q] || PF2.recv[q] === -2) continue; if (PF2.filled[q] < rh) { rh = PF2.filled[q]; rim = q; } } }
      if (rim >= 0) { outletPath = tracePath(ctx, PF2, rim, null); info.outlet = { to: outletPath.to, lengthTiles: +(outletPath.cells.length / k).toFixed(1) }; }
      else info.outlet = { to: 'none', note: 'no way out of the basin' };
    } else if (kind === 'lake') info.outlet = { to: 'none', note: arid ? 'endorheic (arid shore)' : (below && opts.outlet !== 'none') ? `closed basin: the water stands ${belowM} m below its spill point (outlet:'river' carves one)` : 'none requested' };
    return { mask, fringe, info, outletPath };
  }
  /* follow the receivers from `start` to water, the map edge, or an existing river */
  function tracePath(ctx, PF, start, stopAtRiver) {
    const { GW } = ctx, cells = [start]; let c = start, to = 'map edge';
    for (let g = 0; g < GW * ctx.GH; g++) {
      const r = PF.recv[c]; if (r === -1) { to = ctx.water[c] ? 'water' : 'map edge'; break; } if (r < 0) { to = 'nowhere'; break; }
      cells.push(r); c = r;
      if (ctx.water[c]) { to = ctx.waterKind ? ctx.waterKind(c) : 'water'; break; }
      if (stopAtRiver && ctx.riverTile(c) && cells.length > ctx.k * 2) { to = 'river'; break; }
    }
    return { cells, to };
  }
  function autoRiverSource(ctx, PF, len) {
    const { GW, GH, k, h } = ctx; let best = -1, bs = -Infinity; const near = 2 * k;
    const wet = new Uint8Array(GW * GH); for (const c of PF.order) { const r = PF.recv[c]; wet[c] = r === -1 ? ctx.water[c] : r >= 0 ? wet[r] : 0; }   // drains to water (not out through the map edge)
    for (let i = 0; i < GW * GH; i++) {
      if (ctx.water[i] || PF.recv[i] < 0 || !wet[i]) continue; const kc = ctx.kc(i); if (kc && isArid(kc)) continue;
      const x = i % GW, y = (i - x) / GW; let close = false;
      if (x < 2 * k || y < 2 * k || x >= GW - 2 * k || y >= GH - 2 * k) continue;   // a source on the map edge reads as a river cut by the frame
      for (let dy = -near; dy <= near && !close; dy += k) for (let dx = -near; dx <= near; dx += k) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < GW && ny < GH && ctx.riverTile(ny * GW + nx)) { close = true; break; } }
      if (close) continue;
      const s = len[i] / k * (0.4 + h[i]) + hash01(x, y, 11) * 1e-3; if (s > bs) { bs = s; best = i; }
    }
    return best;
  }
  function makeRiver(ctx, opts) {
    const { GW, GH, k, h } = ctx, notes = [];
    const hh = new Float32Array(h.length); for (let i = 0; i < h.length; i++) { const x = i % GW, y = (i - x) / GW; hh[i] = h[i] + (hash01(x >> 1, y >> 1, 5) - 0.5) * 2e-4; }   // a whisper of noise so flats don't drain in ruler lines
    const PF = priorityFlood(hh, GW, GH, i => !!ctx.water[i], null, true);
    let src;
    if (opts.from) { src = ctx.cellOf(opts.from[0], opts.from[1]); if (src < 0) throw new Error('from ' + opts.from.join(',') + ' is outside the grid'); if (ctx.water[src]) throw new Error('from ' + opts.from.join(',') + ' is water'); }
    else { src = autoRiverSource(ctx, PF, pathLengths(PF, GW)); if (src < 0) throw new Error('no humid land far enough from existing rivers for a new source; give from:[x,y]'); notes.push('source picked automatically (longest path to the sea from high, humid ground)'); }
    const P = tracePath(ctx, PF, src, opts.join !== false);
    if (P.cells.length < 2 * k) throw new Error('the source drains to ' + P.to + ' within a tile; pick a source further inland');
    const lenT = P.cells.length / k, d = +opts.discharge > 0 ? +opts.discharge : dischargeFor(ctx, P.cells, 0);
    const line = riverLine(P.cells, GW, opts.meander != null ? +opts.meander : 0.5, (src * 7) | 0).map(p => [p[0] / k, p[1] / k]);   // tile units
    if (P.to === 'river' && ctx.riverCorners) {   // end exactly on a corner of the river it joins, so the rasterised edges connect
      const e = line[line.length - 1]; let best = null, bd = 2.5;
      for (const c of ctx.riverCorners) { const d = Math.hypot(c[0] - e[0], c[1] - e[1]); if (d < bd) { bd = d; best = c; } }
      if (best) line.push([best[0], best[1]]); else notes.push('no river corner within 2.5 tiles of the confluence; it may stop short');
    }
    if (P.to === 'nowhere' || P.to === 'map edge') notes.push('the river leaves through the map edge');
    return { line, info: { kind: 'river', from: [Math.floor((src % GW) / k), Math.floor(((src / GW) | 0) / k)], to: P.to, lengthTiles: +lenT.toFixed(1), discharge: d, notes } };
  }
  /* Mouth discharge from the river's real length and climate: Hack's law (L = 1.4 A^0.6, km and km²) gives the
     catchment, a runoff of 0.010 m³/s per km² (humid) down to 0.002 (arid) gives the flow. A 300 km humid river
     comes out near 70 m³/s, a 1000 km one near 570; a lake's outlet adds the lake's own catchment. */
  function dischargeFor(ctx, cells, lakeTiles) {
    const km = ctx.kmPerTile || 50, L = Math.max(1, cells.length / ctx.k * km);
    let arid = 0, n = 0; for (const c of cells) { const kc = ctx.kc(c); if (kc) { n++; if (isArid(kc)) arid++; } }
    const af = n ? arid / n : 0, A = Math.pow(L / 1.4, 1 / 0.6) + (lakeTiles || 0) * km * km * 10;
    return Math.round(clamp(A * (0.010 * (1 - af) + 0.002 * af), 5, 30000));
  }
  /* split a tile-unit polyline into four reaches of rising discharge (rivers grow downstream) */
  function reachesOf(line, d, rid, toLL) {
    const out = [], n = line.length, parts = Math.min(4, Math.max(1, Math.floor(n / 6)));
    for (let p = 0; p < parts; p++) {
      const a = Math.floor(p * (n - 1) / parts), b = Math.floor((p + 1) * (n - 1) / parts);
      const l = line.slice(a, b + 1).map(toLL); if (l.length < 2) continue;
      out.push({ rid, d: Math.round(d * (0.35 + 0.65 * (p + 1) / parts)), l: [l], bbox: bboxOf([l]) });
    }
    return out;
  }

  /* ================= FRAME pathway: world-pinned features ================= */
  const GEN = { items: [], gen: 0, next: 1 };
  function frameAnalysis() {
    const ev = evaluateFrame(), W = ev.W, H = ev.H, R = srcRect();
    const k = clamp(Math.round(Math.sqrt(90000 / (W * H))), 1, 6), GW = W * k, GH = H * k, N = GW * GH;
    const rotA = rotRad(), rc = Math.cos(rotA), rs = Math.sin(rotA), vcx = view.cx, vcy = view.cy;
    const toWorld = (fx, fy) => { if (!rotA) return [fx, fy]; const dx = fx - vcx, dy = fy - vcy; return [vcx + rc * dx - rs * dy, vcy + rs * dx + rc * dy]; };
    const cellPx = (cx, cy) => [R.x + cx / GW * R.w, R.y + cy / GH * R.h];   // cell-corner units -> frame px
    const hAt = (wx, wy) => {   // bilinear on the working grid (x wraps, y clamps)
      const x = wx - 0.5, y = clamp(wy - 0.5, 0, HSRC - 1.001), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const X = v => ((v % WSRC) + WSRC) % WSRC, i00 = y0 * WSRC + X(x0), i10 = y0 * WSRC + X(x0 + 1), i01 = (y0 + 1) * WSRC + X(x0), i11 = (y0 + 1) * WSRC + X(x0 + 1);
      return (heightArr[i00] * (1 - fx) + heightArr[i10] * fx) * (1 - fy) + (heightArr[i01] * (1 - fx) + heightArr[i11] * fx) * fy;
    };
    const h = new Float32Array(N), water = new Uint8Array(N);
    const rivT = new Set(); const addR = m => { if (m) for (const [key] of m) { const p = String(key).split(','); rivT.add((+p[0]) * W + (+p[1])); } }; addR(ev.rivers && ev.rivers.nof); addR(ev.rivers && ev.rivers.wof);
    for (let cy = 0; cy < GH; cy++) for (let cx = 0; cx < GW; cx++) {
      const i = cy * GW + cx, [fx, fy] = cellPx(cx + 0.5, cy + 0.5), [wx, wy] = toWorld(fx, fy);
      h[i] = hAt(wx, wy); const t = ev.tiles[(cy / k) | 0][(cx / k) | 0]; water[i] = isWaterTile(t) ? 1 : 0;
    }
    const tileIdx = i => { const cx = i % GW, cy = (i - cx) / GW; return ((cy / k) | 0) * W + ((cx / k) | 0); };
    const lc = lonOf(R.x + R.w / 2);
    const toLL = (cx, cy) => { const [fx, fy] = cellPx(cx, cy), [wx, wy] = toWorld(fx, fy); return [lonOf(wx), latOf(wy)]; };
    return {
      ev, W, H, k, GW, GH, h, water,
      kc: i => ev.samples ? ev.samples.kc[tileIdx(i)] : 0,
      riverTile: i => rivT.has(tileIdx(i)),
      cellOf: (tx, ty) => { const x = Math.floor(tx), y = Math.floor(ty); if (x < 0 || y < 0 || x >= W || y >= H) return -1; return (y * k + (k >> 1)) * GW + x * k + (k >> 1); },
      toLL, lonCentre: lc, riverCorners: cornersOf(ev.rivers),
      kmPerTile: Math.sqrt((R.w / W * 360 / WSRC * 111.32 * Math.cos(latOf(R.y + R.h / 2) * Math.PI / 180)) * (R.h / H * 180 / HSRC * 111.32))
    };
  }
  function frameAdd(kind, opts) {
    opts = opts || {};
    if (opts.lonlat) {   // a lon/lat seed: convert to the frame's tile coordinates
      const R = srcRect(), W = out.W, H = out.H, ll = opts.lonlat, sx = (ll[0] + 180) / 360 * WSRC, sy = (90 - ll[1]) / 180 * HSRC;
      const wx = sx + Math.round((view.cx - sx) / WSRC) * WSRC;   // the world copy nearest the view centre FIRST, then into the (rotated) frame
      let fx = wx, fy = sy; const a = rotRad(); if (a) { const dx = wx - view.cx, dy = sy - view.cy; fx = view.cx + Math.cos(a) * dx + Math.sin(a) * dy; fy = view.cy - Math.sin(a) * dx + Math.cos(a) * dy; }
      const p = [(fx - R.x) / R.w * W, (fy - R.y) / R.h * H]; if (kind === 'river') opts = Object.assign({}, opts, { from: p }); else opts = Object.assign({}, opts, { at: p });
    }
    const A = frameAnalysis(), id = (kind === 'river' ? 'river-' : kind === 'lake' ? 'lake-' : 'pan-') + (GEN.next++);
    const items = [];
    if (kind === 'river') {
      const r = makeRiver(A, opts), rid = 2e9 + GEN.next;
      items.push({ id, kind, name: opts.name || null, info: r.info, reaches: reachesOf(r.line, r.info.discharge, rid, p => A.toLL(p[0] * A.k, p[1] * A.k)), rid });
      r.info.rid = rid;
    } else {
      const f = makeBasinFeature(A, kind, opts);
      const ringsLL = m => maskRings(m, A.GW, A.GH).map(r => chaikin(r, 2, true).map(p => A.toLL(p[0], p[1])));
      const r = ringsLL(f.mask); if (!r.length) throw new Error('the ' + kind.replace('_', ' ') + ' came out empty');
      items.push({ id, kind, name: opts.name || null, info: f.info, rings: r, bbox: bboxOf(r) });
      if (f.fringe) { const fr = ringsLL(f.fringe); if (fr.length) items.push({ id: id + '-salt', kind: 'salt_pan', parent: id, info: { kind: 'salt_pan', tiles: null, notes: ['salt fringe of ' + id] }, rings: fr, bbox: bboxOf(fr) }); }
      if (f.outletPath) {
        const rid = 2e9 + (GEN.next++), line = riverLine(f.outletPath.cells, A.GW, opts.meander != null ? +opts.meander : 0.4, rid & 0xffff).map(p => [p[0] / A.k, p[1] / A.k]);
        const d = dischargeFor(A, f.outletPath.cells, f.info.tiles || 1);
        items.push({ id: id + '-outlet', kind: 'river', parent: id, info: { kind: 'river', from: f.info.at, to: f.outletPath.to, lengthTiles: f.info.outlet.lengthTiles, discharge: d, notes: ['outlet of ' + id] }, reaches: reachesOf(line, d, rid, p => A.toLL(p[0] * A.k, p[1] * A.k)), rid });
        f.info.outlet.river = id + '-outlet';
      }
    }
    for (const it of items) { it.lonCentre = A.lonCentre; if (!it.bbox && it.reaches) { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const r of it.reaches) { b[0] = Math.min(b[0], r.bbox[0]); b[1] = Math.min(b[1], r.bbox[1]); b[2] = Math.max(b[2], r.bbox[2]); b[3] = Math.max(b[3], r.bbox[3]); } it.bbox = b; } GEN.items.push(it); }
    GEN.gen++; lastTiles = null; if (typeof _cleanMemo !== 'undefined') _cleanMemo = null;
    return Object.assign({ id, target: 'frame', also: items.slice(1).map(i => i.id) }, items[0].info);
  }
  /* shift a lon/lat polygon or line to the world copy nearest a reference longitude */
  const lonShift = (lonC, ref) => Math.round((ref - lonC) / 360) * 360;
  function frameLonRef() { const R = srcRect(); return lonOf(R.x + R.w / 2); }

  /* sampleRegion hook: fold the frame's lakes into the land fraction and its pans into the playa fraction */
  window.genApplySamples = function (lf, pA, W, H, R) {
    if (!GEN.items.length) return null;
    const polys = GEN.items.filter(i => i.rings); if (!polys.length) return null;
    const ref = frameLonRef(), rotA = rotRad(), rc = Math.cos(rotA), rs = Math.sin(rotA), vcx = view.cx, vcy = view.cy, S = 3;
    const nX = nudgeX * R.w / W, nY = nudgeY * R.h / H; let pan = null;   // the same footprint as sampleRegion: the nudges, and hex rows half a tile east
    const ll = (fx, fy) => { let wx = fx, wy = fy; if (rotA) { const dx = fx - vcx, dy = fy - vcy; wx = vcx + rc * dx - rs * dy; wy = vcy + rs * dx + rc * dy; } return [lonOf(wx), latOf(wy)]; };
    const tw = R.w / W, th = R.h / H, tdeg = Math.max(tw, th) * 360 / WSRC * 1.5;
    for (const it of polys) {
      const sh = lonShift(it.bbox[0] / 2 + it.bbox[2] / 2, ref), b = [it.bbox[0] + sh - tdeg, it.bbox[1] - tdeg, it.bbox[2] + sh + tdeg, it.bbox[3] + tdeg];
      for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
        const ox = R.x + nX + hexShiftX(ty, H) * tw, oy = R.y + nY;
        const c = ll(ox + (tx + 0.5) * tw, oy + (ty + 0.5) * th); if (c[0] < b[0] || c[0] > b[2] || c[1] < b[1] || c[1] > b[3]) continue;
        let hit = 0; for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) { const p = ll(ox + (tx + (sx + 0.5) / S) * tw, oy + (ty + (sy + 0.5) / S) * th); if (inRings(it.rings, p[0] - sh, p[1])) hit++; }
        if (!hit) continue; const cov = hit / (S * S), i = ty * W + tx;
        if (it.kind === 'lake') lf[i] = cov >= 0.5 ? 0 : lf[i] * (1 - cov); else { pA[i] = Math.max(pA[i], cov); if (cov >= 0.5) { if (!pan) pan = new Uint8Array(W * H); pan[i] = 1; } }   // a tile at least half lake is water outright: the coast threshold (land from ~30% up) would otherwise shrink every lake by its shore ring
      }
    }
    return pan;   // tiles that are mostly generated salt pan: sampleRegion flattens them and the game's features pass skips them
  };
  /* computeRiverEdges hook: the frame's generated rivers as extra reaches (on the world copy nearest the frame) */
  window.genReaches = function () {
    const rs = GEN.items.filter(i => i.reaches); if (!rs.length) return [];
    const ref = frameLonRef(), out = [];
    for (const it of rs) for (const r of it.reaches) { const sh = lonShift(r.bbox[0] / 2 + r.bbox[2] / 2, ref); out.push(sh ? { rid: r.rid, d: r.d, l: r.l.map(part => part.map(p => [p[0] + sh, p[1]])), bbox: [r.bbox[0] + sh, r.bbox[1], r.bbox[2] + sh, r.bbox[3]] } : r); }
    return out;
  };
  window.genSig = function () { return 'g' + GEN.gen; };

  /* ================= COMPOSE pathway: canvas-pinned features ================= */
  function composeKm() {   // the collage's scale: declared degPerTile, else the median of its patches' (snapshots carry their latitude span)
    let d = comp.degPerTile; if (!d) { const ds = comp.patches.map(p => p.snap && Math.abs((+p.snap.topLat) - (+p.snap.botLat)) / Math.max(1, p.snap.H)).filter(v => isFinite(v) && v > 0).sort((a, b) => a - b); d = ds.length ? ds[ds.length >> 1] : null; }
    return d ? d * 111.32 : 50;
  }
  function composeAnalysis() {
    const C = compositeCompose(), W = C.W, H = C.H, N = W * H, g = activeGame(), rel = (g.preview && g.preview.relief) || (t => t.relief | 0);
    const h = new Float32Array(N), water = new Uint8Array(N), has = new Uint8Array(N); let missing = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = C.tiles[y][x], i = y * W + x; water[i] = isWaterTile(t) ? 1 : 0; if (t && typeof t._h === 'number') { h[i] = t._h; has[i] = 1; } else if (!water[i]) missing++; }
    if (missing) {   // pseudo-height for tiles without `_h` (older snapshots, mountain fill): relief steps plus distance from water
      const dist = new Float32Array(N).fill(1e9), q = []; for (let i = 0; i < N; i++) if (water[i]) { dist[i] = 0; q.push(i); }
      for (let qi = 0; qi < q.length; qi++) { const c = q[qi], x = c % W, y = (c - x) / W; for (const [dx, dy] of N4) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (dist[n] > dist[c] + 1) { dist[n] = dist[c] + 1; q.push(n); } } }
      for (let i = 0; i < N; i++) if (!has[i] && !water[i]) { let r = 0; try { r = rel(C.tiles[(i / W) | 0][i % W]) | 0; } catch (e) {} h[i] = 0.08 + 0.004 * Math.min(dist[i], 30) + 0.06 * r; }
    }
    const rivT = new Set(); const addR = m => { if (m) for (const [key] of m) { const p = String(key).split(','); rivT.add((+p[0]) * W + (+p[1])); } }; addR(C.rivers.nof); addR(C.rivers.wof);
    const avoid = new Uint8Array(N); for (const it of comp.genItems || []) if (it.cells && it.W === W) for (const c of it.cells) avoid[c] = 1;
    return {
      C, W, H, k: 1, GW: W, GH: H, h, water, missing,
      kc: i => { const t = C.tiles[(i / W) | 0][i % W]; return (t && t.kc) | 0; },
      riverTile: i => rivT.has(i), riverCorners: cornersOf(C.rivers),
      cellOf: (tx, ty) => { const x = Math.floor(tx), y = Math.floor(ty); return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x; },
      avoid: () => avoid,
      kmPerTile: composeKm()
    };
  }
  function composeAdd(kind, opts) {
    opts = opts || {};
    if (!comp.genItems) comp.genItems = [];
    if (!comp.genNext) comp.genNext = 1;
    const A = composeAnalysis(), id = (kind === 'river' ? 'river-' : kind === 'lake' ? 'lake-' : 'pan-') + (comp.genNext++), items = [];
    const edgesOf = (line, d, rid) => { const rr = reachesOf(line, d, rid, p => [p[0], A.H - p[1]]); const E = reachesToEdges(rr, { lonL: 0, lonR: A.W, latT: A.H, latB: 0 }, A.W, A.H, null); return { n: Array.from(E.nof), w: Array.from(E.wof) }; };
    if (kind === 'river') {
      const r = makeRiver(A, opts), rid = 3e9 + comp.genNext; r.info.rid = rid;
      items.push({ id, kind, name: opts.name || null, info: r.info, edges: edgesOf(r.line, r.info.discharge, rid), W: A.W, H: A.H });
    } else {
      const f = makeBasinFeature(A, kind, opts), cells = []; for (let i = 0; i < f.mask.length; i++) if (f.mask[i]) cells.push(i);
      items.push({ id, kind, name: opts.name || null, info: f.info, cells, W: A.W, H: A.H });
      if (f.fringe) { const fc = []; for (let i = 0; i < f.fringe.length; i++) if (f.fringe[i]) fc.push(i); if (fc.length) items.push({ id: id + '-salt', kind: 'salt_pan', parent: id, info: { kind: 'salt_pan', tiles: fc.length, notes: ['salt fringe of ' + id] }, cells: fc, W: A.W, H: A.H }); }
      if (f.outletPath) {
        const rid = 3e9 + (comp.genNext++), line = riverLine(f.outletPath.cells, A.W, opts.meander != null ? +opts.meander : 0.4, rid & 0xffff);
        const d = dischargeFor(A, f.outletPath.cells, f.info.tiles || 1);
        items.push({ id: id + '-outlet', kind: 'river', parent: id, info: { kind: 'river', from: f.info.at, to: f.outletPath.to, lengthTiles: f.info.outlet.lengthTiles, discharge: d, notes: ['outlet of ' + id] }, edges: edgesOf(line, d, rid), W: A.W, H: A.H });
        f.info.outlet.river = id + '-outlet';
      }
    }
    if (A.missing) items[0].info.notes.push(`${A.missing} land tiles had no height (older snapshots or fill); a pseudo-height from relief and distance to water was used there`);
    for (const it of items) comp.genItems.push(it);
    comp.genGen = (comp.genGen | 0) + 1; composeDirty();
    return Object.assign({ id, target: 'compose', also: items.slice(1).map(i => i.id) }, items[0].info);
  }
  /* compositeCompose hook: paint lakes and pans, add river edges (after patches and erasures, before finalize) */
  window.genApplyCompose = function (tiles, nof, wof, W, H) {
    const items = comp.genItems; if (!items || !items.length) return;
    const g = activeGame();
    let nearestLand = null;   // for 'lowland' fill: the nearest original land tile of every canvas tile (BFS over the composite as stamped)
    if (items.some(it => it.kind === 'lowland')) {
      nearestLand = new Int32Array(W * H).fill(-1); const q = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isWaterTile(tiles[y][x])) { nearestLand[y * W + x] = y * W + x; q.push(y * W + x); }
      for (let qi = 0; qi < q.length; qi++) { const c = q[qi], x = c % W, y = (c - x) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (nearestLand[n] < 0) { nearestLand[n] = nearestLand[c]; q.push(n); } } }
    }
    const paint = (t, kind) => { if (g.paint) { const r = g.paint(t, kind); if (r) return r; } if (kind === 'lake') { const w = g.blankTile('water'); if (t && t._h != null) w._h = t._h; return w; } return Object.assign({}, t, { _salt: 1 }); };
    let estuary = null;   // lowland fill must not bury a river mouth: keep a channel of sea from each buried mouth to the open water
    if (nearestLand) {
      const F = new Uint8Array(W * H);
      for (const it of items) if (it.kind === 'lowland') for (const c of it.cells) { const x = c % it.W, y = (c - x) / it.W; if (x < W && y < H && isWaterTile(tiles[y][x])) F[y * W + x] = 1; }
      const deg = new Map(), flow = (a, b) => { const ka = a[1] * (W + 1) + a[0], kb = b[1] * (W + 1) + b[0]; deg.set(ka, (deg.get(ka) || 0) | 2); deg.set(kb, (deg.get(kb) || 0) | 1); };   // bit 1 inflow, bit 2 outflow
      for (const [key, v] of nof) { const c = key.split(','), gy = +c[0], gx = +c[1], w = [gx, gy + 1], e = [gx + 1, gy + 1]; if (v.dir === 3) flow(e, w); else flow(w, e); }
      for (const [key, v] of wof) { const c = key.split(','), gy = +c[0], gx = +c[1], n = [gx + 1, gy], s = [gx + 1, gy + 1]; if (v.dir === 0) flow(s, n); else flow(n, s); }
      const touch = (cx, cy) => [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]].filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H);
      const openWater = i => { const x = i % W, y = (i - x) / W; return isWaterTile(tiles[y][x]) && !F[i]; };
      estuary = new Uint8Array(W * H);
      for (const [k, d] of deg) {
        if (d !== 1) continue; const cx = k % (W + 1), cy = (k - cx) / (W + 1), ts = touch(cx, cy).map(([x, y]) => y * W + x);
        if (!ts.some(i => F[i] || estuary[i]) || ts.some(i => openWater(i) || estuary[i])) continue;   // not a mouth the fill buries
        const prev = new Int32Array(W * H).fill(-2), q = []; for (const i of ts) if (F[i]) { prev[i] = -1; q.push(i); }
        let hit = -1;
        for (let qi = 0; qi < q.length && hit < 0; qi++) { const c = q[qi], x = c % W, y = (c - x) / W;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx;
            if (openWater(n) || estuary[n]) { hit = c; break; } if (F[n] && prev[n] === -2) { prev[n] = c; q.push(n); } } }
        if (hit < 0) { for (const i of ts) if (F[i]) estuary[i] = 1; continue; }   // no way out through the fill: the mouth keeps its water as a lake
        for (let c = hit; c >= 0; c = prev[c]) estuary[c] = 1;
      }
    }
    for (const it of items) if (it.cells) for (const c of it.cells) {
      const x = c % it.W, y = (c - x) / it.W; if (x >= W || y >= H) continue;
      const t = tiles[y][x]; if (it.kind === 'salt_pan' && isWaterTile(t)) continue;
      if (it.kind === 'lowland') { if (!isWaterTile(t) || !nearestLand || nearestLand[y * W + x] < 0 || estuary[y * W + x]) continue; const n = nearestLand[y * W + x], src = tiles[(n / W) | 0][n % W]; const r = g.paint && g.paint(src, 'lowland'); tiles[y][x] = r || Object.assign({}, src, { _h: 0.09 }); continue; }
      tiles[y][x] = paint(t, it.kind);
    }
    for (const it of items) if (it.edges) for (const [kind, list] of [['n', it.edges.n], ['w', it.edges.w]]) for (const [key, v] of list) {
      const c = key.split(','), gy = +c[0], gx = +c[1]; if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
      (kind === 'w' ? wof : nof).set(key, { dir: v.dir, d: v.d, rid: v.rid });
    }
  };
  window.genComposeSig = function () { return 'G' + (comp.genGen | 0); };

  /* ---------- the API core/bridge.js drives ---------- */
  const summary = it => Object.assign({ id: it.id, kind: it.kind, name: it.name || undefined, parent: it.parent || undefined }, it.info);
  function api() {
    return {
      frame: {
        add: frameAdd,
        list(b) {   // b = frame bounds {W,S,E,N}: only the features that reach into it (they are world-pinned; others live elsewhere on the globe)
          if (b && b.E < b.W) b = Object.assign({}, b, { E: b.E + 360 });   // a frame across the antimeridian
          const L = !b ? GEN.items : GEN.items.filter(it => { if (!it.bbox) return true; const c = (b.W + b.E) / 2, sh = Math.round((c - (it.bbox[0] + it.bbox[2]) / 2) / 360) * 360; return !(it.bbox[2] + sh < b.W || it.bbox[0] + sh > b.E || it.bbox[3] < b.S || it.bbox[1] > b.N); });
          return L.map(summary);
        },
        remove(id) { const before = GEN.items.length; GEN.items = GEN.items.filter(i => i.id !== id && i.parent !== id); if (GEN.items.length === before) throw new Error('no generated feature ' + id + ' on the frame'); GEN.gen++; lastTiles = null; return before - GEN.items.length; },
        clear() { const n = GEN.items.length; GEN.items = []; GEN.gen++; lastTiles = null; return n; }
      },
      compose: {
        add: composeAdd,
        /* close the canvas' land mask by `width` tiles: sea narrower than that between land becomes lowland */
        fill(o) {
          o = o || {}; const C = compositeCompose(), W = C.W, H = C.H, r = Math.max(1, o.width | 0 || 3), land = new Uint8Array(W * H);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) land[y * W + x] = isWaterTile(C.tiles[y][x]) ? 0 : 1;
          const dil = new Uint8Array(W * H), ero = new Uint8Array(W * H);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let dy = -r; dy <= r && !v; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue; const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && land[ny * W + nx]) { v = 1; break; } } dil[y * W + x] = v; }
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 1; for (let dy = -r; dy <= r && v; dy++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H || !dil[ny * W + nx]) { v = 0; break; } } ero[y * W + x] = v; }
          const rc = o.rect, inR = i => { if (!rc) return true; const x = i % W, y = (i - x) / W; return x >= Math.min(rc[0], rc[2]) && x <= Math.max(rc[0], rc[2]) && y >= Math.min(rc[1], rc[3]) && y <= Math.max(rc[1], rc[3]); };
          // only the sea closes: water bodies that reach the canvas edge or are bigger than a lake (the snapshots' lakes stay)
          const comp4 = new Int32Array(W * H).fill(-1), sea = []; let nc = 0;
          for (let s0 = 0; s0 < W * H; s0++) { if (land[s0] || comp4[s0] >= 0) continue; const q = [s0]; comp4[s0] = nc; let edge = false;
            for (let qi = 0; qi < q.length; qi++) { const c = q[qi], x = c % W, y = (c - x) / W; if (!x || !y || x === W - 1 || y === H - 1) edge = true;
              for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (!land[n] && comp4[n] < 0) { comp4[n] = nc; q.push(n); } } }
            sea[nc++] = edge || q.length > 60; }
          const cells = []; for (let i = 0; i < W * H; i++) if (ero[i] && !land[i] && sea[comp4[i]] && inR(i)) cells.push(i);   // rect: fill only there (keep fjords and wanted straits elsewhere)
          if (!cells.length) throw new Error('nothing to fill at width ' + r + ': no sea gap that narrow between land');
          if (!comp.genItems) comp.genItems = []; if (!comp.genNext) comp.genNext = 1;
          const id = 'fill-' + (comp.genNext++), info = { kind: 'lowland', tiles: cells.length, width: r, notes: ['sea gaps up to ' + (2 * r) + ' tiles wide closed into lowland; run reclimate to give it its climate'] };
          comp.genItems.push({ id, kind: 'lowland', info, cells, W, H }); comp.genGen = (comp.genGen | 0) + 1; composeDirty();
          return Object.assign({ id, target: 'compose' }, info);
        },
        list: () => (comp.genItems || []).map(summary),
        remove(id) { const L = comp.genItems || [], before = L.length; comp.genItems = L.filter(i => i.id !== id && i.parent !== id); if (comp.genItems.length === before) throw new Error('no generated feature ' + id + ' on the canvas'); comp.genGen = (comp.genGen | 0) + 1; composeDirty(); return before - comp.genItems.length; },
        clear() { const n = (comp.genItems || []).length; comp.genItems = []; comp.genGen = (comp.genGen | 0) + 1; composeDirty(); return n; }
      }
    };
  }
  const attach = () => { if (T.api) T.api.gen = api(); else setTimeout(attach, 50); };
  attach();
  T.hydro = { priorityFlood, pathLengths, basinOf, descend, fillBasin, maskRings, chaikin, riverLine, Heap };
})();
