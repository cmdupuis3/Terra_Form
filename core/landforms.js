/* core/landforms.js -- landform vocabulary over a tile grid, for the MCP bridge (core/bridge.js, mcp/README.md).
 *
 * Three pure services over tiles[y][x] + river edge maps, game-agnostic through a small ctx the caller
 * builds from the game module:
 *   describe(tiles, W, H, ctx, opts)  morphology in geographer's nouns: landmasses, isthmuses (necks found by
 *                                      erosion), straits (thin water between two landmasses), bays (convex-hull
 *                                      deficit), peninsulas (morphological opening), mountain spines (ridge
 *                                      components with a PCA orientation), per-landmass climate, river systems
 *                                      that reach water vs dead-end. Returns a JSON object plus a paragraph.
 *   lint(tiles, W, H, ctx)            seam checks for a collage: every rule is a small pure function over the
 *                                      composite plus the per-tile patch owner map; add a rule by appending to RULES.
 *   connectors(tiles, W, H, ctx)      what each edge (N/E/S/W) of a snapshot offers to a neighbour: land fraction,
 *                                      relief, climate, river exits -> a label such as "coast" or "mountain wall".
 *
 * ctx: { isWater(t), relief(t) -> 0|1|2, kc(t) -> Koppen class 1..30 or 0/null, group(kc) -> 0 EF 1 ET 2 arid 3 tropical
 *        4 temperate 5 continental, ring(y) -> neighbour offsets of the active lattice, rivers: {nof, wof} (Maps or
 *        [key,value] arrays keyed 'gy,gx'), owner?: Int32Array W*H (patch id per tile, 0 = canvas fill), height?(t) -> m }
 * Anything missing degrades: no kc -> no climate lines; no relief -> no spines or wall lint.
 */
(function () {
  'use strict';
  const T = window.TerraForm;
  const GROUP = ['ice cap', 'tundra', 'arid', 'tropical', 'temperate', 'continental'];
  const RING4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  /* ---------- grid primitives ---------- */
  /* connected components of mask (Uint8Array) on the lattice ring; labels 1..n ordered by size desc */
  function components(mask, W, H, ring, minSize) {
    const lab = new Int32Array(W * H), list = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || lab[i]) continue;
      const st = [i], tiles = []; lab[i] = -1;
      let x0 = W, y0 = H, x1 = -1, y1 = -1, sx = 0, sy = 0;
      while (st.length) {
        const j = st.pop(), x = j % W, y = (j - x) / W; tiles.push(j); sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const k = ny * W + nx; if (mask[k] && !lab[k]) { lab[k] = -1; st.push(k); } }
      }
      list.push({ size: tiles.length, bbox: [x0, y0, x1, y1], cx: sx / tiles.length, cy: sy / tiles.length, tiles });
    }
    list.sort((a, b) => b.size - a.size);
    const kept = [];
    list.forEach((c, i) => { const id = i + 1; c.id = id; if (c.size >= (minSize || 1)) kept.push(c); for (const j of c.tiles) lab[j] = id; });
    return { labels: lab, list: kept, all: list };
  }
  /* multi-source BFS: distance (in lattice steps) from every tile where src[i] != 0, carrying the source label */
  function distanceFrom(src, W, H, ring, limit) {
    const dist = new Int32Array(W * H).fill(-1), near = new Int32Array(W * H); let q = [];
    for (let i = 0; i < W * H; i++) if (src[i]) { dist[i] = 0; near[i] = src[i]; q.push(i); }
    while (q.length) {
      const nq = [];
      for (const j of q) {
        const d = dist[j] + 1; if (limit != null && d > limit) continue;
        const x = j % W, y = (j - x) / W;
        for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const k = ny * W + nx; if (dist[k] < 0) { dist[k] = d; near[k] = near[j]; nq.push(k); } }
      }
      q = nq;
    }
    return { dist, near };
  }
  const cxy = c => [Math.round(c.cx), Math.round(c.cy)];
  function compass(dx, dy) { const a = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360; return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8]; }
  function axisLabel(dx, dy) { const a = ((Math.atan2(dx, -dy) * 180 / Math.PI) % 180 + 180) % 180; return a < 22.5 || a >= 157.5 ? 'N-S' : a < 67.5 ? 'NE-SW' : a < 112.5 ? 'E-W' : 'NW-SE'; }
  function pca(tiles, W) {   // principal axis of a tile set -> {dx,dy,length,cx,cy}
    let n = tiles.length, sx = 0, sy = 0; for (const j of tiles) { sx += j % W; sy += (j - j % W) / W; }
    const cx = sx / n, cy = sy / n; let xx = 0, yy = 0, xy = 0;
    for (const j of tiles) { const x = j % W - cx, y = (j - j % W) / W - cy; xx += x * x; yy += y * y; xy += x * y; }
    const th = 0.5 * Math.atan2(2 * xy, xx - yy), dx = Math.cos(th), dy = Math.sin(th);
    let lo = Infinity, hi = -Infinity; for (const j of tiles) { const p = (j % W - cx) * dx + ((j - j % W) / W - cy) * dy; if (p < lo) lo = p; if (p > hi) hi = p; }
    return { dx, dy, length: Math.round(hi - lo + 1), cx, cy };
  }
  /* Zhang-Suen thinning of a mask on the square lattice -> one-tile-wide skeleton; then its graph: endpoints
     (degree 1), junctions (degree >= 3, merged when adjacent) and the longest end-to-end path. A mountain
     spine read this way is a chain with branches and knots rather than a blob with an axis. */
  function thin(mask, W, H) {
    const img = Uint8Array.from(mask), P = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : img[y * W + x];
    for (let changed = true; changed;) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        const del = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if (!img[y * W + x]) continue;
          const p2 = P(x, y - 1), p3 = P(x + 1, y - 1), p4 = P(x + 1, y), p5 = P(x + 1, y + 1), p6 = P(x, y + 1), p7 = P(x - 1, y + 1), p8 = P(x - 1, y), p9 = P(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
          const s = [p2, p3, p4, p5, p6, p7, p8, p9, p2]; let A = 0; for (let i = 0; i < 8; i++) if (s[i] === 0 && s[i + 1] === 1) A++; if (A !== 1) continue;
          if (pass === 0 ? (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) : (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0)) continue;
          del.push(y * W + x);
        }
        if (del.length) { changed = true; for (const j of del) img[j] = 0; }
      }
    }
    return img;
  }
  function skeletonGraph(mask, W, H) {
    const sk = thin(mask, W, H), nb = i => { const x = i % W, y = (i - x) / W, out = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; if (sk[ny * W + nx]) out.push(ny * W + nx); } return out; };
    const pts = []; for (let i = 0; i < W * H; i++) if (sk[i]) pts.push(i);
    if (!pts.length) return { length: 0, endpoints: [], junctions: [], tiles: 0 };
    const deg = new Map(pts.map(i => [i, nb(i).length])), ends = pts.filter(i => deg.get(i) <= 1), jmask = new Uint8Array(W * H); for (const i of pts) if (deg.get(i) >= 3) jmask[i] = 1;
    const J = components(jmask, W, H, () => [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]], 1).list.map(c => ({ at: cxy(c), arms: 0 }));
    const bfs = s => { const d = new Map([[s, 0]]); let q = [s], far = s; while (q.length) { const nq = []; for (const u of q) for (const v of nb(u)) if (!d.has(v)) { d.set(v, d.get(u) + 1); if (d.get(v) > d.get(far)) far = v; nq.push(v); } q = nq; } return { far, d }; };
    const a = bfs(ends[0] != null ? ends[0] : pts[0]), b = bfs(a.far);
    for (const j of J) { const x = j.at[0], y = j.at[1]; let arms = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && sk[ny * W + nx] && !jmask[ny * W + nx]) arms++; } j.arms = arms; }
    return { length: b.d.get(b.far) + 1, endpoints: ends.map(i => [i % W, (i - i % W) / W]), junctions: J, tiles: pts.length };
  }
  function hullOf(pts) {   // Andrew's monotone chain on [x,y] points
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  function inPoly(poly, x, y) { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins; } return ins; }

  /* ---------- river edges ---------- */
  /* nof 'gy,gx' = north edge of tile (gx,gy), dir 1 E / 3 W; wof = west edge, dir 0 N / 2 S. Corner (cx,cy) = the
     top-left corner of tile (cx,cy). An edge's downstream corner follows its dir; it continues if another edge
     meets that corner, reaches water if a tile around the corner is water, exits if the corner is off-grid. */
  function riverEdges(rivers) {
    const out = [], add = (m, kind) => { if (!m) return; const ents = typeof m.forEach === 'function' && typeof m.set === 'function' ? Array.from(m) : m; for (const [k, v] of ents) { const p = String(k).split(','); out.push({ kind, x: +p[1], y: +p[0], dir: v.dir, rid: v.rid, d: v.d }); } };
    add(rivers && rivers.nof, 'n'); add(rivers && rivers.wof, 'w'); return out;
  }
  /* The rasterised channels step diagonally, so consecutive edges need not share a corner: an edge continues at a
     corner when another edge has a corner within one step of it (not counting this edge's own far corner). */
  function riverAnalysis(tiles, W, H, ctx) {
    const edges = riverEdges(ctx.rivers);
    for (const e of edges) { e.c1 = [e.x, e.y]; e.c2 = e.kind === 'n' ? [e.x + 1, e.y] : [e.x, e.y + 1]; e.down = e.kind === 'n' ? (e.dir === 1 ? e.c2 : e.c1) : (e.dir === 2 ? e.c2 : e.c1); e.up = e.down === e.c1 ? e.c2 : e.c1; }
    const byCell = new Map(); for (const e of edges) for (const c of [e.c1, e.c2]) { const k = c[0] + ',' + c[1]; (byCell.get(k) || byCell.set(k, []).get(k)).push(e); }
    const waterAt = (x, y) => x < 0 || x >= W || y < 0 || y >= H ? null : ctx.isWater(tiles[y][x]);
    let lastSea = 0;   // the water body id of the last corner found wet (ctx.waterLabel optional)
    const cornerWater = (cx, cy) => { let off = false; for (const [x, y] of [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]]) { const w = waterAt(x, y); if (w === null) off = true; else if (w) { lastSea = ctx.waterLabel ? ctx.waterLabel(x, y) : 0; return 'water'; } } return off ? 'edge' : null; };
    const continues = (e, c, far) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const cx = c[0] + dx, cy = c[1] + dy; if (cx === far[0] && cy === far[1]) continue; const L = byCell.get(cx + ',' + cy); if (L && L.some(o => o !== e)) return true; } return false; };
    const systems = new Map(); let deadEnd = [];
    for (const e of edges) {
      const w = cornerWater(e.down[0], e.down[1]), cont = continues(e, e.down, e.up), wUp = cornerWater(e.up[0], e.up[1]);
      const s = systems.get(e.rid) || { rid: e.rid, edges: 0, reaches: null, dead: 0, sea: 0, at: [e.x, e.y] }; s.edges++;
      if (s.reaches !== 'water') { if (w === 'water' || wUp === 'water') { s.reaches = 'water'; s.sea = lastSea; } else if (!s.reaches) s.reaches = w || wUp || null; }
      systems.set(e.rid, s);
      if (!w && !cont) { s.dead++; deadEnd.push({ x: e.x, y: e.y, rid: e.rid, kind: e.kind }); }
    }
    const sys = [...systems.values()].sort((a, b) => b.edges - a.edges);
    return { edges: edges.length, systems: sys.length, reachWater: sys.filter(s => s.reaches === 'water').length, exitMap: sys.filter(s => s.reaches === 'edge').length, landlocked: sys.filter(s => !s.reaches).length, deadEndEdges: deadEnd,
      seasReached: [...new Set(sys.filter(s => s.sea).map(s => s.sea))], systemsTop: sys.slice(0, 8).map(s => ({ rid: s.rid, edges: s.edges, reaches: s.reaches || 'none', sea: s.sea || null, deadEnds: s.dead, at: s.at })) };
  }

  /* ---------- describe ---------- */
  function describe(tiles, W, H, ctx, opts) {
    opts = opts || {};
    const N = W * H, ring = ctx.ring, land = new Uint8Array(N), water = new Uint8Array(N), relief = new Uint8Array(N), kc = ctx.kc ? new Int16Array(N) : null;
    let hasRelief = false, hasKc = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[y][x], i = y * W + x; if (!t) continue;
      if (ctx.isWater(t)) water[i] = 1; else { land[i] = 1; const r = ctx.relief ? ctx.relief(t) | 0 : 0; relief[i] = r; if (r) hasRelief = true; if (kc) { const k = ctx.kc(t) | 0; kc[i] = k; if (k) hasKc = true; } }
    }
    const LM = components(land, W, H, ring, 1), R = {};
    const big = LM.list.filter(c => c.size >= 4);
    R.landmasses = LM.list.slice(0, opts.full ? 48 : 12).map(c => { const o = { id: c.id, size: c.size, bbox: c.bbox, at: cxy(c) }; if (hasKc) o.climate = climateOf(c.tiles, kc, ctx); if (hasRelief) { let h = 0, p = 0; for (const j of c.tiles) { if (relief[j] === 1) h++; else if (relief[j] === 2) p++; } o.hills = h; o.peaks = p; } return o; });
    R.landmassCount = LM.list.length;
    /* isthmuses: erode each landmass by r; the smallest r that splits it into two real parts marks a neck */
    R.isthmuses = [];
    const dw = distanceFrom(water, W, H, ring).dist;   // land tiles: steps to the nearest water (0 on water; grid edge is not water)
    for (const c of LM.list.slice(0, 8)) {
      if (c.size < 12) continue;
      const inL = new Uint8Array(N); for (const j of c.tiles) inL[j] = 1;
      for (let r = 1; r <= 3; r++) {
        const core = new Uint8Array(N); for (const j of c.tiles) if (dw[j] > r) core[j] = 1;
        const CC = components(core, W, H, ring, Math.max(4, Math.round(c.size * 0.06)));
        if (CC.list.length < 2) continue;
        const bigIds = new Set(CC.list.map(k => k.id)), neck = new Uint8Array(N);
        for (const j of c.tiles) {   // a rim tile whose (r+1)-neighbourhood touches two different cores
          if (dw[j] > r) continue; const seen = new Set(); let q = [j], depth = 0; const vis = new Set([j]);
          while (q.length && depth <= r + 1) { const nq = []; for (const u of q) { const l = CC.labels[u]; if (l > 0 && bigIds.has(l)) seen.add(l); const x = u % W, y = (u - x) / W; for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const k = ny * W + nx; if (inL[k] && !vis.has(k)) { vis.add(k); nq.push(k); } } } q = nq; depth++; }
          if (seen.size >= 2) neck[j] = 1;
        }
        const NK = components(neck, W, H, ring, 1);
        for (const k of NK.list.slice(0, 3)) {
          const parts = new Set(); for (const j of k.tiles) { const x = j % W, y = (j - x) / W; for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const l = CC.labels[ny * W + nx]; if (l > 0 && bigIds.has(l)) parts.add(l); } }
          R.isthmuses.push({ landmass: c.id, at: cxy(k), width: 2 * r, tiles: k.size, joins: [...parts].slice(0, 2).map(l => CC.list.find(z => z.id === l).size) });
        }
        break;
      }
    }
    /* straits: water on the border between two landmasses' nearest-land regions, close to both */
    R.straits = [];
    if (big.length >= 2) {
      const src = new Int32Array(N); for (const c of big) for (const j of c.tiles) src[j] = c.id;
      const D = distanceFrom(src, W, H, ring, 5), edgeT = new Uint8Array(N), widthAt = new Int32Array(N).fill(99), pairAt = new Map();
      for (let i = 0; i < N; i++) {
        if (!water[i] || D.dist[i] < 0) continue; const x = i % W, y = (i - x) / W;
        for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const k = ny * W + nx; if (D.dist[k] < 0 || D.near[k] === D.near[i]) continue; const w = D.dist[i] + D.dist[k]; if (w > 8) continue; edgeT[i] = 1; if (w < widthAt[i]) { widthAt[i] = w; pairAt.set(i, [D.near[i], D.near[k]].sort((a, b) => a - b)); } }
      }
      const SC = components(edgeT, W, H, ring, 1);
      for (const s of SC.list.slice(0, 12)) {
        let best = null; for (const j of s.tiles) if (!best || widthAt[j] < widthAt[best]) best = j;
        const pr = pairAt.get(best); R.straits.push({ between: pr, width: widthAt[best], at: [best % W, (best - best % W) / W], length: s.size });
      }
      R.straits.sort((a, b) => a.width - b.width || b.length - a.length); R.straits = R.straits.slice(0, 6);
    }
    /* bays: water inside a landmass's convex hull; peninsulas: land the morphological opening (erode 2, dilate 2) drops */
    R.bays = []; R.peninsulas = [];
    for (const c of LM.list.slice(0, 6)) {
      if (c.size < 20) continue;
      const hull = hullOf(c.tiles.map(j => [j % W + 0.5, (j - j % W) / W + 0.5])), inL = new Uint8Array(N); for (const j of c.tiles) inL[j] = 1;
      const [bx0, by0, bx1, by1] = c.bbox, deficit = new Uint8Array(N);
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { const i = y * W + x; if (water[i] && inPoly(hull, x + 0.5, y + 0.5)) deficit[i] = 1; }
      const BC = components(deficit, W, H, ring, 4);
      for (const b of BC.list.slice(0, 3)) { let touch = 0; for (const j of b.tiles) { const x = j % W, y = (j - x) / W; for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx >= 0 && nx < W && ny >= 0 && ny < H && inL[ny * W + nx]) { touch++; break; } } } if (touch >= 2) R.bays.push({ landmass: c.id, size: b.size, at: cxy(b), bbox: b.bbox, opensTo: compass(b.cx - c.cx, b.cy - c.cy) }); }
      const core = new Uint8Array(N); let nc = 0; for (const j of c.tiles) if (dw[j] > 2) { core[j] = 1; nc++; }
      if (!nc) continue;
      const open = distanceFrom(core, W, H, ring, 2).dist, spur = new Uint8Array(N); for (const j of c.tiles) if (open[j] < 0) spur[j] = 1;
      const PC = components(spur, W, H, ring, 4);
      for (const p of PC.list.slice(0, 3)) R.peninsulas.push({ landmass: c.id, size: p.size, at: cxy(p), bbox: p.bbox, pointing: compass(p.cx - c.cx, p.cy - c.cy) });
    }
    R.bays.sort((a, b) => b.size - a.size); R.bays = R.bays.slice(0, 6); R.peninsulas.sort((a, b) => b.size - a.size); R.peninsulas = R.peninsulas.slice(0, 6);
    /* mountain spines: components of hills+peaks, oriented by their principal axis */
    R.spines = [];
    if (hasRelief) {
      const rm = new Uint8Array(N); for (let i = 0; i < N; i++) if (relief[i]) rm[i] = 1;
      const SP = components(rm, W, H, ring, 6);
      for (const s of SP.list.slice(0, 5)) {
        const a = pca(s.tiles, W); let p = 0; for (const j of s.tiles) if (relief[j] === 2) p++;
        const sp = { size: s.size, peaks: p, orientation: axisLabel(a.dx, a.dy), length: a.length, at: cxy(s), bbox: s.bbox, landmass: LM.labels[s.tiles[0]] };
        if (!ctx.hex) {   // skeleton (square lattice only): chain length, branch ends, knots where chains meet
          const m = new Uint8Array(N); for (const j of s.tiles) m[j] = 1; const G = skeletonGraph(m, W, H);
          sp.chain = G.length; sp.branches = G.endpoints.length; sp.knots = G.junctions.filter(j => j.arms >= 3).slice(0, 6);
        }
        R.spines.push(sp);
      }
    }
    /* water bodies: components of water; inland = none of its tiles on the grid border */
    const WC = components(water, W, H, ring, 4);
    R.seas = WC.list.slice(0, 8).map(c => { let border = false; for (const j of c.tiles) { const x = j % W, y = (j - x) / W; if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { border = true; break; } } return { id: c.id, size: c.size, at: cxy(c), bbox: c.bbox, inland: !border }; });
    R.seaCount = WC.list.length;
    R.rivers = riverAnalysis(tiles, W, H, Object.assign({}, ctx, { waterLabel: (x, y) => WC.labels[y * W + x] }));
    delete R.rivers.deadEndEdges;
    if (opts.full) {   // per-row land and Köppen-group counts, for latitude-band checks
      R.rows = [];
      for (let y = 0; y < H; y++) { const g = [0, 0, 0, 0, 0, 0]; let n = 0, rel = [0, 0, 0]; for (let x = 0; x < W; x++) { const i = y * W + x; if (!land[i]) continue; n++; rel[relief[i]]++; if (kc && kc[i]) g[ctx.group(kc[i])]++; } R.rows.push({ y, land: n, groups: hasKc ? g : null, relief: rel }); }
    }
    R.summary = summarize(R, W, H, hasKc, hasRelief);
    if (!opts.full) for (const c of R.landmasses) delete c.bbox;
    return R;
  }
  function climateOf(tilesIdx, kc, ctx) {
    const cnt = [0, 0, 0, 0, 0, 0]; let n = 0; for (const j of tilesIdx) { const k = kc[j]; if (!k) continue; cnt[ctx.group(k)]++; n++; }
    if (!n) return null; const order = cnt.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).filter(e => e[0] > 0).slice(0, 3);
    return order.map(([v, i]) => ({ group: GROUP[i], pct: Math.round(v / n * 100) }));
  }
  function summarize(R, W, H, hasKc, hasRelief) {
    const L = [], lm = R.landmasses;
    if (!lm.length) L.push('No land.');
    else {
      L.push(`${R.landmassCount} landmass${R.landmassCount === 1 ? '' : 'es'}` + (lm.length ? ': ' + lm.slice(0, 5).map(c => `#${c.id} ${c.size}t at ${c.at.join(',')}` + (c.climate ? ` (${c.climate.slice(0, 2).map(g => g.group + ' ' + g.pct + '%').join(', ')})` : '')).join('; ') : '') + (R.landmassCount > 5 ? ` and ${R.landmassCount - 5} smaller` : '') + '.');
      if (R.isthmuses.length) L.push(R.isthmuses.slice(0, 4).map(i => `Isthmus on #${i.landmass} at ${i.at.join(',')}, about ${i.width} wide, joining ${i.joins.join('t and ')}t`).join('; ') + '.');
      if (R.straits.length) L.push(R.straits.slice(0, 4).map(s => `Strait ${s.width} wide between #${s.between[0]} and #${s.between[1]} at ${s.at.join(',')}`).join('; ') + '.');
      if (R.bays.length) L.push(R.bays.slice(0, 4).map(b => `Bay of ${b.size}t on #${b.landmass} at ${b.at.join(',')} opening ${b.opensTo}`).join('; ') + '.');
      if (R.peninsulas.length) L.push(R.peninsulas.slice(0, 4).map(p => `Peninsula of ${p.size}t on #${p.landmass} at ${p.at.join(',')} pointing ${p.pointing}`).join('; ') + '.');
      if (hasRelief) L.push(R.spines.length ? R.spines.slice(0, 3).map(s => `Mountain spine ${s.orientation} ${s.length} long (${s.size}t, ${s.peaks} peaks${s.chain ? `, chain ${s.chain}, ${s.branches} ends, ${s.knots.length} knot${s.knots.length === 1 ? '' : 's'}` + (s.knots.length ? ' at ' + s.knots.slice(0, 3).map(k => k.at.join(',')).join(' ') : '') : ''}) on #${s.landmass} at ${s.at.join(',')}`).join('; ') + '.' : 'No mountain spine of 6+ tiles.');
    }
    const inland = (R.seas || []).filter(s => s.inland); if (inland.length) L.push(`${inland.length} inland sea${inland.length === 1 ? '' : 's'}: ` + inland.slice(0, 4).map(s => `${s.size}t at ${s.at.join(',')}`).join('; ') + '.');
    const rv = R.rivers; if (rv.systems) L.push(`${rv.systems} river system${rv.systems === 1 ? '' : 's'} (${rv.edges} edges): ${rv.reachWater} reach water${rv.seasReached && rv.seasReached.length > 1 ? ' (' + rv.seasReached.length + ' different water bodies)' : ''}, ${rv.exitMap} leave the map, ${rv.landlocked} dead-end.`); else L.push('No rivers.');
    return L.join(' ');
  }
  /* the one-line form every mutation's feedback carries */
  function brief(R) {
    const p = [];
    p.push(`${R.landmassCount} landmass${R.landmassCount === 1 ? '' : 'es'}`);
    if (R.isthmuses.length) p.push(`${R.isthmuses.length} isthmus${R.isthmuses.length === 1 ? '' : 'es'} (${R.isthmuses.slice(0, 2).map(i => i.at.join(',') + ' w' + i.width).join(' ')})`);
    if (R.straits.length) p.push(`${R.straits.length} strait${R.straits.length === 1 ? '' : 's'} (${R.straits.slice(0, 2).map(s => '#' + s.between[0] + '/#' + s.between[1] + ' w' + s.width + ' at ' + s.at.join(',')).join(' ')})`);
    if (R.bays.length) p.push(`${R.bays.length} bay${R.bays.length === 1 ? '' : 's'}`);
    if (R.peninsulas.length) p.push(`${R.peninsulas.length} peninsula${R.peninsulas.length === 1 ? '' : 's'}`);
    if (R.spines.length) p.push(`spine${R.spines.length === 1 ? '' : 's'} ${R.spines.slice(0, 2).map(s => s.orientation + ' ' + s.length + 'L at ' + s.at.join(',')).join(', ')}`);
    const inland = (R.seas || []).filter(s => s.inland).length; if (inland) p.push(`${inland} inland sea${inland === 1 ? '' : 's'}`);
    if (R.rivers.systems) p.push(`rivers ${R.rivers.reachWater}/${R.rivers.systems} reach water`);
    return p.join(' | ');
  }

  /* ---------- seam lint ---------- */
  /* Each rule: (G) -> [{rule, at:[x,y], n, patches:[a,b], msg}], where G is the prepared grid below. */
  const ALLOWED = new Set(['4,5', '0,1']);   // fallback when no mined adjacency table is loaded: temperate|continental and ice cap|tundra sit side by side in nature
  const JUMP_SHARE = 0.001;   // a group pair under 0.1% of real land adjacencies (mcp/koppen_adjacency.json, Karth & Smith framing) is a contradiction
  /* -> null when the pair is legitimate, else a label for the contradiction */
  function climateContradiction(k1, k2, g1, g2, ADJ) {
    if (g1 !== g2) {
      if (ADJ && ADJ.groups) { const s = ADJ.groups[g1][g2]; if (s < JUMP_SHARE) return `${[GROUP[g1], GROUP[g2]].sort().join(' meets ')} (${(s * 100).toFixed(2)}% of real adjacencies)`; }
      else if (!ALLOWED.has([g1, g2].sort().join(','))) return [GROUP[g1], GROUP[g2]].sort().join(' meets ');
    }
    if (ADJ && ADJ.classes && k1 !== k2 && ADJ.classes[k1] && ADJ.classes[k1][k2] === 0) return `${ADJ.classKeys[k1]} next to ${ADJ.classKeys[k2]} (never adjacent in the Köppen raster)`;
    return null;
  }
  const RULES = [
    function climateJump(G) {
      if (!G.hasKc || !G.owner) return [];
      const flag = new Uint8Array(G.N), pairs = new Map();
      for (let i = 0; i < G.N; i++) {
        if (!G.land[i] || !G.owner[i] || !G.kc[i] || G.relief[i]) continue; const x = i % G.W, y = (i - x) / G.W, g1 = G.group(G.kc[i]);
        for (const o of G.ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= G.W || ny < 0 || ny >= G.H) continue; const k = ny * G.W + nx;
          if (!G.land[k] || !G.owner[k] || G.owner[k] === G.owner[i] || !G.kc[k] || G.relief[k]) continue; const g2 = G.group(G.kc[k]);
          const why = climateContradiction(G.kc[i], G.kc[k], g1, g2, G.climateAdjacency); if (!why) continue;
          flag[i] = 1; flag[k] = 1; const key = [G.owner[i], G.owner[k]].sort((a, b) => a - b).join('/'); const e = pairs.get(key) || { n: 0, g: new Map() }; e.n++; e.g.set(why, (e.g.get(why) || 0) + 1); pairs.set(key, e); }
      }
      const C = components(flag, G.W, G.H, G.ring, 1);
      return C.list.slice(0, 8).map(c => { const a = c.tiles[0], owners = new Set(c.tiles.map(j => G.owner[j])); const key = [...owners].sort((x, y) => x - y).slice(0, 2).join('/'); const e = pairs.get(key); const top = e ? [...e.g.entries()].sort((x, y) => y[1] - x[1])[0][0] : 'climate groups differ';
        return { rule: 'climate-jump', at: cxy(c), n: c.size, patches: [...owners], msg: `${top} across the seam between patches ${[...owners].join(' and ')} (${c.size} tiles) near ${cxy(c).join(',')}` }; });
    },
    function truncatedWall(G) {
      if (!G.hasRelief || !G.owner) return [];
      const rm = new Uint8Array(G.N); for (let i = 0; i < G.N; i++) if (G.relief[i]) rm[i] = 1;
      const C = components(rm, G.W, G.H, G.ring, 3), out = [];
      for (const c of C.list) {
        let n = 0, at = null; const others = new Set(), mine = new Set();
        for (const j of c.tiles) { const x = j % G.W, y = (j - x) / G.W, o1 = G.owner[j]; if (!o1) continue;
          for (const o of RING4) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= G.W || ny < 0 || ny >= G.H) continue; const k = ny * G.W + nx; if (G.land[k] && !G.relief[k] && G.owner[k] && G.owner[k] !== o1) { n++; if (!at) at = [x, y]; others.add(G.owner[k]); mine.add(o1); } } }
        if (n >= 2) out.push({ rule: 'truncated-wall', at, n, patches: [...mine, ...others], msg: `mountain run of ${c.size} tiles from patch ${[...mine].join('/')} stops against flat land of patch ${[...others].join('/')} along ${n} tiles near ${at.join(',')}` });
      }
      return out.sort((a, b) => b.n - a.n).slice(0, 8);
    },
    function latitudeMismatch(G) {   // only when the caller declared a latitude per row (a collage with virtual latitudes)
      if (!G.hasKc || !G.latOfRow) return [];
      const flag = new Uint8Array(G.N), why = new Map();
      for (let i = 0; i < G.N; i++) {
        if (!G.land[i] || !G.kc[i]) continue; const y = (i - i % G.W) / G.W, lat = Math.abs(G.latOfRow(y)), g = G.group(G.kc[i]);
        let m = null; if ((g === 0 || g === 1) && lat < 35) m = 'polar tile at ' + Math.round(lat) + '° latitude'; else if (g === 3 && lat > 45) m = 'tropical tile at ' + Math.round(lat) + '° latitude'; else if (g === 2 && lat > 62) m = 'desert tile at ' + Math.round(lat) + '° latitude';
        if (m) { flag[i] = 1; why.set(i, m); }
      }
      const C = components(flag, G.W, G.H, G.ring, 1);
      return C.list.slice(0, 8).map(c => ({ rule: 'latitude-mismatch', at: cxy(c), n: c.size, patches: G.owner ? [...new Set(c.tiles.map(j => G.owner[j]))] : [], msg: `${why.get(c.tiles[0])} (${c.size} tiles) near ${cxy(c).join(',')}` }));
    },
    function riverDeadEnd(G) {
      const byRid = new Map();
      for (const e of G.rivers.deadEndEdges) { const r = byRid.get(e.rid) || { n: 0, at: [e.x, e.y] }; r.n++; byRid.set(e.rid, r); }
      return [...byRid.entries()].slice(0, 8).map(([rid, r]) => ({ rule: 'river-dead-end', at: r.at, n: r.n, patches: G.owner ? [G.owner[r.at[1] * G.W + r.at[0]]] : [], msg: `river ${rid} has ${r.n} edge${r.n === 1 ? '' : 's'} ending on land with no continuation, first at ${r.at.join(',')}` }));
    }
  ];
  function prepare(tiles, W, H, ctx) {
    const N = W * H, land = new Uint8Array(N), relief = new Uint8Array(N), kc = new Int16Array(N); let hasKc = false, hasRelief = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x], i = y * W + x; if (!t || ctx.isWater(t)) continue; land[i] = 1; if (ctx.relief) { relief[i] = ctx.relief(t) | 0; if (relief[i]) hasRelief = true; } if (ctx.kc) { kc[i] = ctx.kc(t) | 0; if (kc[i]) hasKc = true; } }
    return { W, H, N, land, relief, kc, hasKc, hasRelief, owner: ctx.owner || null, ring: ctx.ring, group: ctx.group, latOfRow: ctx.latOfRow || null, climateAdjacency: ctx.climateAdjacency || null, rivers: riverAnalysis(tiles, W, H, ctx) };
  }
  function lint(tiles, W, H, ctx) { const G = prepare(tiles, W, H, ctx); let out = []; for (const rule of RULES) { try { out = out.concat(rule(G)); } catch (e) { out.push({ rule: rule.name, at: [0, 0], n: 0, msg: 'rule failed: ' + e.message }); } } return out; }

  /* ---------- edge connectors ---------- */
  function connectors(tiles, W, H, ctx) {
    const edges = riverEdges(ctx.rivers), out = {};
    const sides = { N: { cells: Array.from({ length: W }, (_, x) => [x, 0]), river: e => (e.kind === 'n' && e.y === 0) || (e.kind === 'w' && e.y === 0) },
                    S: { cells: Array.from({ length: W }, (_, x) => [x, H - 1]), river: e => e.kind === 'w' && e.y === H - 1 },
                    W: { cells: Array.from({ length: H }, (_, y) => [0, y]), river: e => (e.kind === 'w' && e.x === 0) || (e.kind === 'n' && e.x === 0) },
                    E: { cells: Array.from({ length: H }, (_, y) => [W - 1, y]), river: e => e.kind === 'n' && e.x === W - 1 } };
    const summarise = (cells, river) => {
      let land = 0, rel = 0, hm = 0, hn = 0; const g = [0, 0, 0, 0, 0, 0]; let gn = 0;
      for (const [x, y] of cells) { const t = tiles[y][x]; if (!t || ctx.isWater(t)) continue; land++; if (ctx.relief && ctx.relief(t)) rel++; if (ctx.kc) { const k = ctx.kc(t) | 0; if (k) { g[ctx.group(k)]++; gn++; } } if (ctx.height) { const m = ctx.height(t); if (m != null) { hm += m; hn++; } } }
      const n = cells.length, lf = land / n, rf = land ? rel / land : 0;
      let gi = -1, gb = 0; g.forEach((v, i) => { if (v > gb) { gb = v; gi = i; } });
      const climate = gn ? GROUP[gi] : null, height = hn ? Math.round(hm / hn) : null;
      let label = lf < 0.1 ? 'open sea' : lf < 0.5 ? 'coast' : rf >= 0.5 ? 'mountain wall' : climate === 'arid' ? 'desert' : climate === 'tropical' ? 'tropical land' : climate === 'ice cap' || climate === 'tundra' ? 'ice' : climate ? climate + ' land' : 'land';
      if (river) label += ' + river exit';
      return { land: +lf.toFixed(2), relief: +rf.toFixed(2), climate, height, river, label };
    };
    for (const s in sides) out[s] = summarise(sides[s].cells, edges.some(sides[s].river));
    /* corner connectors (Lagae): the 3x3 around each corner tile, so four pieces meeting at a point can be matched too */
    const corner = (cx, cy) => { const cells = []; for (let y = Math.max(0, cy - 1); y <= Math.min(H - 1, cy + 1); y++) for (let x = Math.max(0, cx - 1); x <= Math.min(W - 1, cx + 1); x++) cells.push([x, y]); return summarise(cells, false).label; };
    out.corners = { NW: corner(0, 0), NE: corner(W - 1, 0), SE: corner(W - 1, H - 1), SW: corner(0, H - 1) };
    return out;
  }

  T.landforms = { describe, brief, lint, connectors, rules: RULES, GROUP, components, distanceFrom };
})();
