/* core/bridge.js -- the page end of the MCP bridge (see mcp/README.md).
 *
 * A local MCP server (mcp/server.mjs) listens on ws://127.0.0.1:8765. This script connects to it, with
 * reconnect, and turns each JSON command {id, cmd, args} into calls on TerraForm.api (the entry points
 * core/app.js exposes) and on the active game module, replying {id, ok, result | error}. Every command that
 * changes something answers with the same compact report the agent iterates on: counts, per-terrain
 * classes, landmasses, river edges and (optionally) a one-character-per-tile grid, row 0 north. The grid's
 * characters come from the game module's preview.ascii(t) (games/README.md); a module without one gets a
 * generic water / flat / hills / peak alphabet.
 *
 * Nothing here holds state of its own: the page is the single source of truth, so what the agent is told
 * is what the user sees on screen. If no server is running the socket fails quietly and retries.
 */
(function () {
  'use strict';
  const T = window.TerraForm;
  const PORT = (new URLSearchParams(location.search).get('mcp')) || 8765;   // ?mcp=<port> pairs the page with a server started with TERRAFORM_WS_PORT=<port>
  const URL_ = window.TERRAFORM_BRIDGE_URL || ('ws://127.0.0.1:' + PORT + '/terraform');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const api = () => { if (!T || !T.api) throw new Error('TerraForm.api is not available: core/app.js did not finish loading'); return T.api; };

  /* ---------- connection ---------- */
  let ws = null, retry = 500, badge = null;
  function setBadge(on) {
    if (!badge) {
      badge = document.createElement('div'); badge.id = 'mcpBadge'; badge.title = 'An MCP server is driving this page (mcp/README.md)';
      badge.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:9000;padding:3px 8px;border-radius:10px;font:11px ui-monospace,monospace;color:#fff;background:#2a9d6a;opacity:.9;pointer-events:none';
      badge.textContent = 'MCP connected'; document.body.appendChild(badge);
    }
    badge.hidden = !on;
  }
  function connect() {
    let s; try { s = new WebSocket(URL_); } catch (e) { scheduleReconnect(); return; }
    ws = s;
    s.onopen = () => { retry = 500; setBadge(true); let game = null; try { game = api().state().game; if (!DEFAULT_PARAMS) { const p = api().params(); DEFAULT_PARAMS = { hill: p.hill, peak: p.peak, blendHill: p.blendHill, blendPeak: p.blendPeak }; } } catch (e) {} send({ hello: { app: 'terra-form', game, url: location.href } }); };
    s.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m && m.id != null && m.cmd) handle(m); };
    s.onclose = () => { if (ws === s) { ws = null; setBadge(false); scheduleReconnect(); } };
    s.onerror = () => {};   // onclose follows; the retry lives there
  }
  function scheduleReconnect() { setTimeout(connect, retry); retry = Math.min(5000, Math.round(retry * 1.6)); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  let chain = Promise.resolve();   // commands run one at a time, in order: a frame change must finish settling before the next capture reads it
  function handle(m) {
    chain = chain.then(async () => {
      let res;
      try { const fn = CMDS[m.cmd]; if (!fn) throw new Error('unknown command "' + m.cmd + '"'); res = { id: m.id, ok: true, result: await fn(m.args || {}) }; }
      catch (e) { console.error('[bridge] ' + m.cmd + ' failed:', e); res = { id: m.id, ok: false, error: (e && e.message) || String(e) }; }
      send(res);
    });
  }

  /* ---------- glyphs & report ---------- */
  const GENERIC_LEGEND = { '~': 'water', '.': 'flat land', 'n': 'hills', '^': 'peak' };
  function glyphFns(g) {
    const pv = (g && g.preview) || {};
    const relief = pv.relief || (t => (t.relief === 1 || t.relief === 2) ? t.relief : 0);
    const isWater = t => { try { const gg = (t._g && T.games[t._g]) || g; return !!gg.isWater(t); } catch (e) { return false; } };
    const base = pv.ascii || (t => isWater(t) ? '~' : relief(t) === 2 ? '^' : relief(t) === 1 ? 'n' : '.');
    const ascii = t => t && t._salt && !isWater(t) ? '_' : base(t);   // salt pan (real playa or generated), whatever the game's alphabet
    return { ascii, legend: Object.assign({}, pv.asciiLegend ? pv.asciiLegend() : GENERIC_LEGEND, { '_': 'salt pan' }), relief, labels: pv.reliefLabels || ['flat', 'hills', 'peaks'], isWater };
  }
  function legendClass(legend, ch) {   // -> {key,label}: exact key, then a range key such as a-z, then the lowercase letter (hills are uppercase in the Civ alphabet)
    if (legend[ch] != null) return { key: ch, label: legend[ch] };
    for (const k in legend) if (k.length === 3 && k[1] === '-' && ch >= k[0] && ch <= k[2]) return { key: k, label: legend[k] };
    const lc = ch.toLowerCase(); if (lc !== ch && legend[lc] != null) return { key: lc, label: legend[lc] };
    return { key: ch, label: '?' };
  }
  const mapSize = m => !m ? 0 : (typeof m.size === 'number' ? m.size : (m.length || 0));
  function landmasses(mask, W, H, top) {
    const seen = new Uint8Array(W * H), out = []; const ring = y => api().gridRing(y, H);
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || seen[i]) continue;
      let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0; const st = [i]; seen[i] = 1;
      while (st.length) {
        const j = st.pop(), x = j % W, y = (j - x) / W; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const o of ring(y)) { const nx = x + o[0], ny = y + o[1]; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const k = ny * W + nx; if (mask[k] && !seen[k]) { seen[k] = 1; st.push(k); } }
      }
      out.push({ size: n, bbox: [x0, y0, x1, y1] });
    }
    out.sort((a, b) => b.size - a.size);
    return { count: out.length, top: out.slice(0, top || 10) };
  }
  /* tiles[y][x], rivers {nof,wof} (Maps or entry arrays), g the game whose vocabulary the tiles use.
     opts: grid (false to omit), bbox [x0,y0,x1,y1] (inclusive tile coords), step (subsample; auto keeps the grid within ~120x80) */
  /* the ctx core/landforms.js works through: the game's water test, the module's relief and the tile fields that exist (Civ4 kc; OpenFront m) */
  let CLIMATE_ADJ = null;   // mcp/koppen_adjacency.json (mined from data/koppen_2048.png by mcp/mine_koppen_adjacency.py); optional
  fetch('mcp/koppen_adjacency.json').then(r => r.ok ? r.json() : null).then(j => { if (j && j.groups) CLIMATE_ADJ = j; }).catch(() => {});
  function lfCtx(g, rivers, owner, H, latOfRow, extra) {
    const F = glyphFns(g), U = T.util;
    return Object.assign({ isWater: F.isWater, relief: F.relief, kc: t => (typeof t.kc === 'number' ? t.kc : 0), group: k => U.classGroup(k), ring: y => api().gridRing(y, H), rivers, owner: owner || null,
      height: t => (typeof t.m === 'number' ? t.m : null), latOfRow: latOfRow || null, climateAdjacency: CLIMATE_ADJ, hex: !!(g && g.grid && g.grid.kind === 'hex'), riverTiles: riverTileSet(rivers) }, extra || {});
  }
  /* ---------- cut edges: the mask boundary of a capture is not coastline ----------
     maskFrame records the tiles a lasso/rect replaced with fill (snapshot.cut, flat indices). From it: cutMask (1 on fill),
     cutEdgeMask (1 on land tiles that touch fill: the artificial shore), and the same on the canvas per patch. */
  function cutMask(s) { const m = new Uint8Array(s.W * s.H); if (s.cut) for (const i of s.cut) if (i >= 0 && i < m.length) m[i] = 1; return s.cut ? m : null; }
  /* the artificial part of the cut: fill tiles that were land in the source (snapshot.cutLand). Fill that was sea leaves the real
     coast beside it real. Snapshots captured before cutLand existed fall back to the whole cut. */
  function artificialMask(s) { if (!s.cut) return null; if (!s.cutLand) return cutMask(s); const m = new Uint8Array(s.W * s.H); for (const i of s.cutLand) if (i >= 0 && i < m.length) m[i] = 1; return m; }
  function cutEdgeMaskSnap(s) {
    const cm = artificialMask(s); if (!cm) return null; const F = glyphFns(T.games[s.game] || T.game), at = snapTile(s), out = new Uint8Array(s.W * s.H);
    for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) { const i = y * s.W + x; if (cm[i]) continue; const t = at(x, y); if (!t || F.isWater(t)) continue;
      if ((x > 0 && cm[i - 1]) || (x < s.W - 1 && cm[i + 1]) || (y > 0 && cm[i - s.W]) || (y < s.H - 1 && cm[i + s.W])) out[i] = 1; }
    return out;
  }
  function snapTile(s) { const two = Array.isArray(s.tiles[0]); return two ? (x, y) => s.tiles[y][x] : (x, y) => s.tiles[y * s.W + x]; }
  function composeCutEdge(owner) {   // canvas mask: 1 where a stamped tile is on its own snapshot's cut boundary
    const c = api().compose.state(), W = c.W, H = c.H, out = new Uint8Array(W * H); let any = false;
    for (const p of c.patches) { const s = p.snap; if (!s || !s.cut) continue; const ce = cutEdgeMaskSnap(s); if (!ce) continue;
      for (let sy = 0; sy < s.H; sy++) { const dy = p.y + sy; if (dy < 0 || dy >= H) continue; for (let sx = 0; sx < s.W; sx++) { const dx = p.x + sx; if (dx < 0 || dx >= W) continue; if (ce[sy * s.W + sx] && owner[dy * W + dx] === p.id) { out[dy * W + dx] = 1; any = true; } } } }
    return any ? out : null;
  }
  /* degrees per tile of a snapshot: the frame samples square source px per tile, so the row latitudes of the (possibly
     cropped) capture give it directly; of the canvas: the declared scale (compose_new degPerTile), else the patches' median */
  function snapDeg(s) { const d = Math.abs((+s.topLat) - (+s.botLat)) / Math.max(1, s.H); return isFinite(d) && d > 0 ? d : null; }
  function composeDeg() { const c = api().compose.state(); if (c.degPerTile) return c.degPerTile; const ds = c.patches.map(p => p.snap && snapDeg(p.snap)).filter(Boolean).sort((a, b) => a - b); return ds.length ? ds[ds.length >> 1] : null; }
  function patchRects() { const m = new Map(); for (const p of api().compose.state().patches) if (p.snap) m.set(p.id, { x: p.x, y: p.y, W: p.snap.W, H: p.snap.H }); return m; }
  function patchBands(cb) { const c = api().compose.state(), m = new Map(); if (!cb) return null; for (const p of c.patches) { const d = p.snap && snapDeg(p.snap); if (d) m.set(p.id, { band: T.landforms.bandFor(cb, d), deg: d }); } return m.size ? m : null; }
  /* dead ends each snapshot has on its own (cached per snapshot id), so the composite's dead ends can be told apart:
     one the source already had is endorheic; one it did not have was cut here */
  const DEAD = new Map();
  function snapDeadEnds(s) {
    if (DEAD.has(s.id)) return DEAD.get(s.id);
    const S = new Set();
    try { const ctx = lfCtx(T.games[s.game] || T.game, s.rivers, null, s.H), R = T.landforms.riverAnalysis(api().tiles2D(s), s.W, s.H, ctx); for (const e of R.deadEndEdges) S.add(e.kind + ':' + e.x + ',' + e.y); } catch (e) {}
    DEAD.set(s.id, S); return S;
  }
  /* which patch an edge of the composite came from (the topmost patch holding that local key), and the local key */
  function edgeOwner(kind, gx, gy) {
    const c = api().compose.state();
    for (let i = c.patches.length - 1; i >= 0; i--) { const p = c.patches[i], s = p.snap; if (!s) continue; const lx = gx - p.x, ly = gy - p.y; if (lx < 0 || ly < 0 || lx >= s.W || ly >= s.H) continue; const k = kind + ':' + ly + ',' + lx; if (snapEdgeKeys(s).has(k) && !(p.riverSkip && p.riverSkip.has(k))) return { patch: p, lx, ly }; }
    return null;
  }
  /* ---------- placement helpers ---------- */
  function hash01(x, y, s) { let h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul((s | 0) + 1, 1274126177)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; h ^= h >>> 16; return h / 4294967296; }
  const RING4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /* nearest top-left (spiral by Chebyshev radius) at which the snapshot's land stays on the canvas and comes no closer
     than `gap` tiles to existing land (gap 1 = at least one water tile between, so landmasses do not merge) */
  function freeSpot(s, x, y, gap) {
    const a = api(), c = a.compose.state(), W = c.W, H = c.H, C = a.compose.composite(), F = glyphFns(T.game), g = Math.max(0, gap | 0);
    const land = new Uint8Array(W * H); for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (!F.isWater(C.tiles[yy][xx])) land[yy * W + xx] = 1;
    const near = g ? T.landforms.distanceFrom(land, W, H, () => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], g).dist : null;
    const blocked = i => near ? near[i] >= 0 : !!land[i];
    const FS = glyphFns(T.games[s.game] || T.game), at = snapTile(s), mine = [];
    for (let sy = 0; sy < s.H; sy++) for (let sx = 0; sx < s.W; sx++) { const t = at(sx, sy); if (t && !FS.isWater(t)) mine.push([sx, sy]); }
    if (!mine.length) return { x, y, dx: 0, dy: 0 };
    const ok = (px, py) => { for (const [sx, sy] of mine) { const dx = px + sx, dy = py + sy; if (dx < 0 || dx >= W || dy < 0 || dy >= H || blocked(dy * W + dx)) return false; } return true; };
    if (ok(x, y)) return { x, y, dx: 0, dy: 0 };
    for (let r = 1; r <= Math.max(W, H); r++) { let best = null; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; if (ok(x + dx, y + dy)) { const d = dx * dx + dy * dy; if (!best || d < best.d) best = { x: x + dx, y: y + dy, dx, dy, d }; } } if (best) { delete best.d; return best; } }
    return null;
  }
  /* feathered cut edge: land tiles within 3 of the mask boundary (or of the frame rectangle's own land border, except the
     seam side `exceptSide`) are dropped with a probability that falls off with distance, deterministic per tile, so the
     cut reads as a ragged shore instead of a ruler line */
  /* opts (the `ragged` object): preserveSides ['N',..] rectangle borders left alone; preserve [[x0,y0,x1,y1],..] snapshot-tile
     rects never feathered; preserveCoast (default true) keeps every land tile that touches real water (not mask fill that was
     land), so a distinctive shoreline survives even where the lasso ran right beside it. */
  function featherSkip(s, p, exceptSide, opts) {
    opts = opts || {};
    const F = glyphFns(T.games[s.game] || T.game), at = snapTile(s), W = s.W, H = s.H, cm = artificialMask(s), land = new Uint8Array(W * H), dist = new Int8Array(W * H).fill(-1); let q = [];
    const keepSide = new Set((opts.preserveSides || []).map(k => String(k).toUpperCase())), rects = (opts.preserve || []).map(r => r.map(v => v | 0));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = at(x, y), i = y * W + x; if (!t || F.isWater(t)) continue; land[i] = 1; }
    const realWater = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return false; const t = at(x, y); return !!t && F.isWater(t) && !(cm && cm[y * W + x]); };
    const pinned = i => { const x = i % W, y = (i - x) / W; if (rects.some(r => x >= Math.min(r[0], r[2]) && x <= Math.max(r[0], r[2]) && y >= Math.min(r[1], r[3]) && y <= Math.max(r[1], r[3]))) return true;
      if (opts.preserveCoast !== false) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && realWater(x + dx, y + dy)) return true; return false; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!land[i]) continue;
      const border = (x === 0 && exceptSide !== 'W' && !keepSide.has('W')) || (x === W - 1 && exceptSide !== 'E' && !keepSide.has('E')) || (y === 0 && exceptSide !== 'N' && !keepSide.has('N')) || (y === H - 1 && exceptSide !== 'S' && !keepSide.has('S'));
      const nearCut = cm && ((x > 0 && cm[i - 1]) || (x < W - 1 && cm[i + 1]) || (y > 0 && cm[i - W]) || (y < H - 1 && cm[i + W]));
      if (border || nearCut) { dist[i] = 0; q.push(i); } }
    for (let d = 1; d <= 3 && q.length; d++) { const nq = []; for (const i of q) { const x = i % W, y = (i - x) / W; for (const [ox, oy] of RING4) { const nx = x + ox, ny = y + oy; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const k = ny * W + nx; if (land[k] && dist[k] < 0) { dist[k] = d; nq.push(k); } } } q = nq; }
    const P = [0.7, 0.45, 0.2, 0.05], skip = new Set();
    for (let i = 0; i < W * H; i++) { const d = dist[i]; if (d >= 0 && !pinned(i) && hash01(i % W, (i - i % W) / W, p.id) < P[d]) skip.add(i); }
    /* no specks: a scrap of 1-3 tiles the feathering cut off from the rest of the land goes too (unless pinned) */
    const rest = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) if (land[i] && !skip.has(i)) rest[i] = 1;
    const RC = T.landforms.components(rest, W, H, () => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], 1);
    for (const c of RC.list) if (c.size <= 3 && c.tiles.every(i => dist[i] >= 0 && !pinned(i))) for (const i of c.tiles) skip.add(i);
    return [...skip];
  }
  const raggedOpts = r => (r && typeof r === 'object') ? r : {};
  function unpin(skip, s, rects) { if (!rects || !rects.length) return skip; const W = s.W; return skip.filter(i => { const x = i % W, y = (i - x) / W; return !rects.some(r => x >= Math.min(r[0], r[2]) && x <= Math.max(r[0], r[2]) && y >= Math.min(r[1], r[3]) && y <= Math.max(r[1], r[3])); }); }
  /* min-cut seam (Zhou et al. 2007): over the strip where A (below) and B (above) overlap, the cheapest path from one end
     of the seam to the other through per-tile disagreement (water vs land 1; both land: 0.25 + climate 0.5 + relief 0.5;
     both water 0; mask fill counts as water). B's tiles on A's side of the path are skipped, so the join is ragged. */
  /* ---------- interest: how much each tile matters, 0..9 ----------
     High where a seam would destroy something: peaks and ridge edges, rivers (by discharge), real coastline (more
     at capes and bay heads), climate boundaries, oases / flood plains / salt, lake shores. Low in uniform interior.
     Mask fill (lasso cuts) and open water are 0. The min-cut seam in attach routes through low interest, so two
     pieces can overlap deeply over land and fuse where neither has anything worth keeping. */
  const INTEREST = new WeakMap();
  function interestGrid(tiles2, W, H, rivers, g, cut) {
    const F = glyphFns(g || T.game), U = T.util, raw = new Float32Array(W * H), water = new Uint8Array(W * H);
    const at = (x, y) => tiles2[y] && tiles2[y][x];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = at(x, y); water[y * W + x] = !t || F.isWater(t) || (cut && cut[y * W + x]) ? 1 : 0; }
    const rivD = new Float32Array(W * H), ents = m => !m ? [] : (typeof m.forEach === 'function' && typeof m.set === 'function' ? Array.from(m) : m);
    const addR = (x, y, d) => { if (x >= 0 && y >= 0 && x < W && y < H) rivD[y * W + x] = Math.max(rivD[y * W + x], d || 10); };
    for (const [k, v] of ents(rivers && rivers.nof)) { const q = String(k).split(','), gy = +q[0], gx = +q[1]; addR(gx, gy, v && v.d); addR(gx, gy + 1, v && v.d); }
    for (const [k, v] of ents(rivers && rivers.wof)) { const q = String(k).split(','), gy = +q[0], gx = +q[1]; addR(gx, gy, v && v.d); addR(gx + 1, gy, v && v.d); }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (water[i]) continue; const t = at(x, y), r = F.relief(t) | 0; let v = r * 2;
      let wn = 0, realW = 0, relDiff = 0, kDiff = 0, lakeN = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx, tn = at(nx, ny);
        if (water[j]) { wn++; if (!(cut && cut[j])) realW++; continue; }
        if ((F.relief(tn) | 0) !== r) relDiff++;
        if (t.kc && tn && tn.kc && U.classGroup(t.kc) !== U.classGroup(tn.kc)) kDiff++; }
      if (realW) v += 2 + (realW >= 4 && realW <= 6 ? 1.5 : 0);   // coast; capes and bay heads more
      if (relDiff >= 2) v += 1; if (kDiff >= 2) v += 2;
      if (rivD[i]) v += 2 + Math.min(2.5, Math.log10(1 + rivD[i]) * 0.8);
      const f = t.feature; if (f === 'FEATURE_OASIS') v += 4; else if (f === 'FEATURE_FLOOD_PLAINS') v += 2;
      if (t._salt) v += 1;
      raw[i] = v;
    }
    const out = new Uint8Array(W * H);   // a little spread, so a feature protects its immediate surroundings
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (water[i]) continue; let m = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; m = Math.max(m, raw[ny * W + nx] * (dx || dy ? 0.6 : 1)); } out[i] = Math.min(9, Math.round(m * 0.9)); }
    return out;
  }
  function interestOf(s) { let m = INTEREST.get(s); if (!m) { m = interestGrid(api().tiles2D(s), s.W, s.H, s.rivers, T.games[s.game] || T.game, artificialMask(s)); INTEREST.set(s, m); } return m; }
  function edgeInterest(s) {   // per edge: mean interest of the land within 3 tiles of it, and the quietest stretch along it (a good seam anchor)
    const m = interestOf(s), F = glyphFns(T.games[s.game] || T.game), at = snapTile(s), out = {};
    for (const e of ['N', 'E', 'S', 'W']) {
      const len = e === 'N' || e === 'S' ? s.W : s.H, col = []; let sum = 0, n = 0;
      for (let a = 0; a < len; a++) { let cs = 0, cn = 0; for (let d = 0; d < 3; d++) { const x = e === 'E' ? s.W - 1 - d : e === 'W' ? d : a, y = e === 'S' ? s.H - 1 - d : e === 'N' ? d : a; if (x < 0 || y < 0 || x >= s.W || y >= s.H) continue; const t = at(x, y); if (!t || F.isWater(t)) continue; cs += m[y * s.W + x]; cn++; } col.push(cn ? cs / cn : null); if (cn) { sum += cs / cn; n++; } }
      let best = null, bv = Infinity; for (let a = 0; a + 4 < len; a++) { const win = col.slice(a, a + 5).filter(v => v != null); if (win.length < 4) continue; const v = win.reduce((p, q) => p + q, 0) / win.length; if (v < bv) { bv = v; best = a + 2; } }
      out[e] = n ? { mean: +(sum / n).toFixed(1), quietAt: best, quiet: best != null ? +bv.toFixed(1) : null, landTiles: n } : null;
    }
    return out;
  }
  function uniquePaste(s, allow) {   // every snapshot (lasso chunk) goes on the canvas once: repeats read as copy-paste
    if (allow) return; const p = patchForSnapshot(s); if (p) throw new Error('"' + s.name + '" is already on the canvas as patch ' + p.id + ': each snapshot is pasted once (move_patch to reposition it, or allowRepeat:true to override)');
  }
  function minCutSkip(A, pa, B, pb, eA) {
    const c = api().compose.state(), FA = glyphFns(T.games[A.game] || T.game), FB = glyphFns(T.games[B.game] || T.game), U = T.util, cA = cutMask(A), cB = cutMask(B), atA = snapTile(A), atB = snapTile(B), IA = interestOf(A), IB = interestOf(B);   // any fill counts as water here: the path should run through it
    const x0 = Math.max(pa.x, pb.x, 0), x1 = Math.min(pa.x + A.W, pb.x + B.W, c.W) - 1, y0 = Math.max(pa.y, pb.y, 0), y1 = Math.min(pa.y + A.H, pb.y + B.H, c.H) - 1;
    if (x1 < x0 || y1 < y0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, cost = new Float32Array(w * h); let landBoth = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const ax = x - pa.x, ay = y - pa.y, bx = x - pb.x, by = y - pb.y, ta = atA(ax, ay), tb = atB(bx, by); let v = 0.5;
      if (ta && tb) { const wa = FA.isWater(ta) || !!(cA && cA[ay * A.W + ax]), wb = FB.isWater(tb) || !!(cB && cB[by * B.W + bx]);
        if (wa && wb) v = 0; else if (wa !== wb) v = 1; else { const ka = ta.kc | 0, kb = tb.kc | 0; v = 0.25 + (ka && kb && U.classGroup(ka) !== U.classGroup(kb) ? 0.5 : 0) + ((FA.relief(ta) | 0) !== (FB.relief(tb) | 0) ? 0.5 : 0); }
        v += 0.18 * ((wa ? 0 : IA[ay * A.W + ax]) + (wb ? 0 : IB[by * B.W + bx])); if (!wa && !wb) landBoth++; }   // interest: a seam through a peak, a river or a coast costs what it destroys
      cost[(y - y0) * w + (x - x0)] = v;
    }
    const vertical = eA === 'E' || eA === 'W', L = vertical ? h : w, M = vertical ? w : h, Cst = (i, j) => vertical ? cost[i * w + j] : cost[j * w + i];   // i along the seam, j across it
    const D = new Float32Array(L * M), P = new Int16Array(L * M);
    for (let j = 0; j < M; j++) D[j] = Cst(0, j);
    for (let i = 1; i < L; i++) for (let j = 0; j < M; j++) { let best = D[(i - 1) * M + j], bj = j; for (const dj of [-1, 1]) { const jj = j + dj; if (jj >= 0 && jj < M && D[(i - 1) * M + jj] < best) { best = D[(i - 1) * M + jj]; bj = jj; } } D[i * M + j] = best + Cst(i, j); P[i * M + j] = bj; }
    let j = 0; for (let k = 1; k < M; k++) if (D[(L - 1) * M + k] < D[(L - 1) * M + j]) j = k;
    const path = new Int16Array(L); for (let i = L - 1; i >= 0; i--) { path[i] = j; j = P[i * M + j]; }
    const skip = [], aSideLow = eA === 'E' || eA === 'S';   // A west of B (E) or north of B (S): A's side is the low index across the strip
    for (let i = 0; i < L; i++) for (let jj = 0; jj < M; jj++) { if (!(aSideLow ? jj < path[i] : jj > path[i])) continue; const x = vertical ? x0 + jj : x0 + i, y = vertical ? y0 + i : y0 + jj; skip.push((y - pb.y) * B.W + (x - pb.x)); }
    return { skip, length: L, width: M, landBoth, cost: +(D[(L - 1) * M + path[L - 1]] / L).toFixed(3) };
  }
  function landBounds(s) { const F = glyphFns(T.games[s.game] || T.game), at = snapTile(s); let x0 = s.W, y0 = s.H, x1 = -1, y1 = -1; for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) { const t = at(x, y); if (t && !F.isWater(t)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return x1 < 0 ? null : { x0, y0, x1, y1 }; }
  const EDGEKEYS = new Map();
  function snapEdgeKeys(s) { let S = EDGEKEYS.get(s.id); if (S) return S; S = new Set(); const add = (m, k) => { if (!m) return; const ents = typeof m.forEach === 'function' && typeof m.set === 'function' ? Array.from(m) : m; for (const [key] of ents) S.add(k + ':' + key); }; add(s.rivers && s.rivers.nof, 'n'); add(s.rivers && s.rivers.wof, 'w'); EDGEKEYS.set(s.id, S); return S; }
  function sourceDeadEndFn() { return e => { const o = edgeOwner(e.kind, e.x, e.y); if (!o) return false; return snapDeadEnds(o.patch.snap).has(e.kind + ':' + o.lx + ',' + o.ly); }; }
  /* seam cost (Zhou et al. 2007 in tile form): over the strip where A and B overlap (or the two facing columns/rows when
     they only touch), the share of tile pairs that disagree on water, climate group or relief. Pairs where either tile is
     mask fill (a cut edge) are artificial water and are left out of the count (`ignored`). */
  function seamCost(A, ax, ay, B, bx, by, edgeA) {
    const FA = glyphFns(T.games[A.game] || T.game), FB = glyphFns(T.games[B.game] || T.game), U = T.util, cA = artificialMask(A), cB = artificialMask(B);
    let x0 = Math.max(ax, bx), x1 = Math.min(ax + A.W, bx + B.W) - 1, y0 = Math.max(ay, by), y1 = Math.min(ay + A.H, by + B.H) - 1;
    if (x1 < x0 || y1 < y0) { if (edgeA === 'E') bx--; else if (edgeA === 'W') bx++; else if (edgeA === 'S') by--; else by++; x0 = Math.max(ax, bx); x1 = Math.min(ax + A.W, bx + B.W) - 1; y0 = Math.max(ay, by); y1 = Math.min(ay + A.H, by + B.H) - 1; }
    let n = 0, water = 0, climate = 0, relief = 0, ignored = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const ia = (y - ay) * A.W + (x - ax), ib = (y - by) * B.W + (x - bx), ta = A.tiles[ia], tb = B.tiles[ib]; if (!ta || !tb) continue;
      if ((cA && cA[ia]) || (cB && cB[ib])) { ignored++; continue; }
      n++;
      const wa = FA.isWater(ta), wb = FB.isWater(tb); if (wa !== wb) { water++; continue; } if (wa) continue;
      const ka = typeof ta.kc === 'number' ? ta.kc : 0, kb = typeof tb.kc === 'number' ? tb.kc : 0; if (ka && kb && U.classGroup(ka) !== U.classGroup(kb)) climate++;
      if ((FA.relief(ta) | 0) !== (FB.relief(tb) | 0)) relief++;
    }
    return { tiles: n, cost: n ? +((water + climate + relief) / n).toFixed(3) : 0, water, climate, relief, ignored };
  }
  /* the collage's declared virtual latitudes (compose_new latitudes:{top,bottom}) as a per-row function, or null */
  function composeLat() { const c = api().compose.state(); if (c.latTop == null || c.latBot == null) return null; return y => c.latTop + (c.latBot - c.latTop) * (y + 0.5) / c.H; }
  function riverTileSet(rivers) { const S = new Set(), add = m => { if (!m) return; const ents = typeof m.forEach === 'function' && typeof m.set === 'function' ? Array.from(m) : m; for (const [k] of ents) { const p = String(k).split(','); S.add(p[1] + ',' + p[0]); } }; add(rivers && rivers.nof); add(rivers && rivers.wof); return S; }
  /* patch id per composite tile (0 = canvas fill or erased), replaying the stamping order the way compositeCompose does */
  function ownerMap() {
    const a = api(), c = a.compose.state(), W = c.W, H = c.H, own = new Int32Array(W * H);
    for (const p of c.patches) {
      const s = p.snap; if (!s || !s.tiles) continue; const g = T.games[s.game] || T.game, two = Array.isArray(s.tiles[0]);
      for (let sy = 0; sy < s.H; sy++) { const dy = p.y + sy; if (dy < 0 || dy >= H) continue;
        for (let sx = 0; sx < s.W; sx++) { const dx = p.x + sx; if (dx < 0 || dx >= W) continue; const t = two ? s.tiles[sy][sx] : s.tiles[sy * s.W + sx]; if (!t) continue;
          let w = false; try { w = !!g.isWater(t); } catch (e) {} if (p.landOnly && w) continue; if (p.skip && p.skip.has(sy * s.W + sx)) continue; own[dy * W + dx] = p.id; } }
    }
    for (const k of c.erased) { const q = k.split(','), y = +q[0], x = +q[1]; if (x >= 0 && x < W && y >= 0 && y < H) own[y * W + x] = 0; }
    return own;
  }
  /* land footprint of a patch on the canvas (indices), honouring landOnly and skip; and the pairs of patches whose land overlaps */
  function patchLand(p, W, H) {
    const s = p.snap, F = glyphFns(T.games[s.game] || T.game), at = snapTile(s), out = [];
    for (let sy = 0; sy < s.H; sy++) { const dy = p.y + sy; if (dy < 0 || dy >= H) continue; for (let sx = 0; sx < s.W; sx++) { const dx = p.x + sx; if (dx < 0 || dx >= W) continue; const t = at(sx, sy); if (!t || F.isWater(t)) continue; if (p.skip && p.skip.has(sy * s.W + sx)) continue; out.push(dy * W + dx); } }
    return out;
  }
  function collisions() {
    const c = api().compose.state(), W = c.W, H = c.H; if (c.patches.length < 2) return null;
    const first = new Int32Array(W * H), pairs = new Map();
    for (const p of c.patches) { if (!p.snap) continue; for (const i of patchLand(p, W, H)) { if (first[i] && first[i] !== p.id) { const k = first[i] + '/' + p.id, e = pairs.get(k) || { a: first[i], b: p.id, tiles: 0 }; e.tiles++; pairs.set(k, e); } else first[i] = p.id; } }
    return [...pairs.values()].sort((x, y) => y.tiles - x.tiles);
  }
  /* the compose block's budget line: land share against the target declared with compose_new {targetLand} */
  function budget(land, W, H) {
    const c = api().compose.state(); if (!c.targetLand) return null; const [lo, hi] = c.targetLand, share = land / (W * H);
    return { share: +share.toFixed(3), target: [lo, hi], within: share >= lo && share <= hi, needMin: Math.round(Math.max(0, lo * W * H - land)), needMax: Math.round(hi * W * H - land) };
  }
  /* how much of a patch's LAND falls outside the canvas, per side */
  function clipped(p, W, H) {
    const s = p.snap, F = glyphFns(T.games[s.game] || T.game), at = snapTile(s); let n = 0, N = 0, S = 0, E = 0, Wst = 0;
    for (let sy = 0; sy < s.H; sy++) for (let sx = 0; sx < s.W; sx++) { const t = at(sx, sy); if (!t || F.isWater(t)) continue; const dx = p.x + sx, dy = p.y + sy; if (dx >= 0 && dx < W && dy >= 0 && dy < H) continue; n++; if (dy < 0) N = Math.max(N, -dy); if (dy >= H) S = Math.max(S, dy - H + 1); if (dx < 0) Wst = Math.max(Wst, -dx); if (dx >= W) E = Math.max(E, dx - W + 1); }
    return n ? { landTiles: n, north: N, south: S, east: E, west: Wst } : null;
  }
  function report(tiles, W, H, rivers, g, opts, head, owner, latOfRow, extra) {
    opts = opts || {};
    const F = glyphFns(g), rel = [0, 0, 0], cls = new Map(), mask = new Uint8Array(W * H);
    let land = 0, water = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[y][x]; if (!t) continue;
      if (F.isWater(t)) water++; else { land++; mask[y * W + x] = 1; const r = F.relief(t) | 0; rel[r >= 0 && r <= 2 ? r : 0]++; }
      const c = legendClass(F.legend, String(F.ascii(t) || '?')[0]); const e = cls.get(c.key); if (e) e.n++; else cls.set(c.key, { ch: c.key, label: c.label, n: 1 });
    }
    const res = Object.assign({ W, H, land, water, relief: { labels: F.labels, counts: rel },
      classes: [...cls.values()].sort((a, b) => b.n - a.n), riverEdges: mapSize(rivers && rivers.nof) + mapSize(rivers && rivers.wof),
      landmasses: landmasses(mask, W, H) }, head || {});
    let codeTiles = null;
    if (opts.landforms !== false && T.landforms) {   // the short landform line, and the seam lint when the tiles are a collage (owner map given)
      const ctx = lfCtx(g, rivers, owner, H, latOfRow, extra);
      try { const D = T.landforms.describe(tiles, W, H, ctx, opts.overlay === 'codes' && T.landforms.codebook() && extra && extra.degPerTile ? { codes: { cb: T.landforms.codebook(), degPerTile: extra.degPerTile, tiles: true } } : undefined); res.landforms = T.landforms.brief(D); if (D.codeTiles) { codeTiles = D.codeTiles; res.codes = D.codes; } } catch (e) { res.landforms = 'describe failed: ' + e.message; }
      if (owner) { try { const L = T.landforms.lint(tiles, W, H, ctx); res.warnings = L.filter(w => w.level !== 'info'); res.notes = L.filter(w => w.level === 'info'); } catch (e) { res.warnings = [{ rule: 'lint', at: [0, 0], n: 0, msg: 'lint failed: ' + e.message }]; } }
      else if (extra && extra.cut) { try { res.warnings = T.landforms.lint(tiles, W, H, ctx, ['straightEdgeCoast']); } catch (e) {} }   // a snapshot: only the cut-edge rule applies
    }
    if (opts.grid !== false) {
      let [x0, y0, x1, y1] = opts.bbox || [0, 0, W - 1, H - 1];
      x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0); x1 = Math.min(W - 1, x1 | 0); y1 = Math.min(H - 1, y1 | 0);
      const step = Math.max(1, (opts.step | 0) || Math.max(Math.ceil((x1 - x0 + 1) / 120), Math.ceil((y1 - y0 + 1) / 80)));
      const hex = !!(g && g.grid && g.grid.kind === 'hex'), rows = [], rv = opts.overlay === 'rivers' ? riverTileSet(rivers) : null;   // overlay 'rivers': '=' on every tile a river edge touches (its north or west side)
      const IM = opts.overlay === 'interest' ? interestGrid(tiles, W, H, rivers, g, extra && extra.cut) : null;   // overlay 'interest': 0..9 per land tile
      const CB = codeTiles ? T.landforms.codebook().bands[codeTiles.band].codes : null;   // overlay 'codes': one glyph per code class (landforms.CODE_GLYPHS), water left as '~'
      for (let y = y0; y <= y1; y += step) {
        let s = (hex && step === 1 && api().hexShiftX(y, H)) ? ' ' : '';   // hex: the half-tile-east rows lean right, as on screen
        for (let x = x0; x <= x1; x += step) { const t = tiles[y][x]; if (IM) { s += t && !F.isWater(t) ? String(IM[y * W + x]) : '~'; continue; } if (CB) { const c = codeTiles.codes[y * W + x]; s += c >= 0 ? T.landforms.codeGlyph(CB[c]) : (t && F.isWater(t) ? '~' : ' '); } else s += rv && rv.has(x + ',' + y) ? '=' : t ? String(F.ascii(t) || '?')[0] : ' '; }
        rows.push({ y, s });
      }
      res.grid = { x0, y0, x1, y1, step, rows, overlay: IM ? 'interest' : CB ? 'codes' : rv ? 'rivers' : null };
    }
    return res;
  }

  /* ---------- helpers ---------- */
  async function settle(timeout) {   // base layers loaded, then draw (which requests the view's tiles) and wait until nothing is in flight and a redraw asks for nothing more
    const a = api(), t0 = Date.now(); timeout = timeout || 20000;
    while (!a.ready()) { if (Date.now() - t0 > 90000) throw new Error('the page has not finished loading its base layers (elevation, climate, coast)'); await sleep(200); }
    for (;;) {
      if (a.loadsPending() > 0) { if (Date.now() - t0 > timeout) break; await sleep(100); continue; }
      a.render(); if (a.loadsPending() === 0) break;
    }
  }
  function frameReport(opts) {
    const a = api(), ev = a.evaluate(), st = a.state(), deg = Math.abs(st.bounds.N - st.bounds.S) / ev.H;
    return report(ev.tiles, ev.W, ev.H, ev.rivers, T.game, opts, { kind: 'frame', game: st.game, hex: st.hex, bounds: st.bounds, rot: st.view.rot, mode: st.mode, pending: st.pending, degPerTile: deg, features: genList('frame') }, null, null, { degPerTile: deg, sourceDeadEnd: () => true });
  }
  /* the river edges over a thumbnail: each edge is a tile side (nof = the north side of tile (gx,gr), wof = the west
     side of tile (gx,gy)), stroked thicker for more discharge, so the PNG shows what the export writes; generated
     rivers (core/generate.js, rid >= 2e9) are orange, real ones blue */
  function drawRivers(url, rivers, W, H) {
    return new Promise(res => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
        const sx = c.width / W, sy = c.height / H, ents = m => !m ? [] : (typeof m.forEach === 'function' && typeof m.set === 'function' ? Array.from(m) : m);
        g.lineCap = 'round';
        const seg = (x0, y0, x1, y1, d, rid) => { g.strokeStyle = rid >= 2e9 ? 'rgb(240,120,30)' : 'rgb(40,110,220)'; g.lineWidth = Math.max(1.2, Math.min(sx, sy) * (0.12 + 0.06 * Math.log10(1 + Math.max(0, d || 0)))); g.beginPath(); g.moveTo(x0 * sx, y0 * sy); g.lineTo(x1 * sx, y1 * sy); g.stroke(); };
        for (const [k, v] of ents(rivers.nof)) { const p = String(k).split(','), gr = +p[0], gx = +p[1]; seg(gx, gr + 1, gx + 1, gr + 1, v && v.d, v && +v.rid); }   // north side of the tile below = the boundary between rows gr and gr+1
        for (const [k, v] of ents(rivers.wof)) { const p = String(k).split(','), gy = +p[0], gx = +p[1]; seg(gx + 1, gy, gx + 1, gy + 1, v && v.d, v && +v.rid); }   // likewise the boundary between columns gx and gx+1
        res(c.toDataURL('image/png'));
      };
      im.onerror = () => res(url); im.src = url;
    });
  }
  /* generated lakes / salt pans / rivers (core/generate.js): the frame's are world-pinned, the canvas' tile-pinned */
  function genList(target) { const G = api().gen; if (!G) return null; const L = target === 'frame' ? G.frame.list(api().state().bounds) : G[target].list(); return L.length ? L.map(f => ({ id: f.id, kind: f.kind, at: f.at || f.from, tiles: f.tiles, to: f.to, parent: f.parent })) : null; }
  async function genCmd(kind, args) {
    const a = api(); if (!a.gen) throw new Error('core/generate.js is not loaded (index.html)');
    const target = args.target || (a.state().mode === 'compose' ? 'compose' : 'frame');
    if (target !== 'frame' && target !== 'compose') throw new Error("target must be 'frame' or 'compose'");
    await prepOverlay(args);
    if (target === 'compose') { a.setMode('compose'); const g = a.gen.compose.add(kind, args); a.render(); return Object.assign(composeReport(args), { generated: g }); }
    if (a.state().mode === 'compose' || a.state().mode === 'color') a.setMode('civ');
    await settle(); const g = a.gen.frame.add(kind, args); await settle();
    return Object.assign(frameReport(args), { generated: g });
  }
  function llToPx(ll) {   // lon/lat -> source px, on the world copy nearest the view centre (frames may straddle the antimeridian)
    const a = api(), cx = a.state().view.cx; let sx = (a.wrapLon(+ll[0]) + 180) / 360 * a.WSRC; sx += Math.round((cx - sx) / a.WSRC) * a.WSRC;
    return [sx, (90 - (+ll[1])) / 180 * a.HSRC];
  }
  function setControl(id, val) {   // drive a page control the way the user would, so the core's own handler runs and the readout follows
    const el = document.getElementById(id); if (!el) return false;
    if (el.tagName === 'BUTTON') { const on = el.getAttribute('aria-pressed') === 'true'; if (!!val !== on) el.click(); return true; }
    if (el.type === 'checkbox') { el.checked = !!val; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;
  }
  const RELIEF_KEYS = new Set(['hill', 'peak', 'blendHill', 'blendPeak']);
  const RESET_IDS = ['islandBias', 'seawayBias', 'islandExpand', 'expandSteep', 'expandMaxMult', 'roughHalo', 'mtnPass', 'flatSpots', 'coastThr', 'nudgeX', 'nudgeY', 'riverN', 'riverEstuaries',
    'alpine', 'clim', 'fpAmt', 'forestDens', 'jungleDens', 'oasisDens', 'fpKoppen', 'feat', 'np', 'ofPlains', 'ofHighland', 'ofMountain', 'ofDesert', 'ofDesertMag'];
  let DEFAULT_PARAMS = null;   // relief thresholds as they were when the page connected (the HTML has no default for the multi-sliders)
  function snapReport(s, opts) {
    const a = api(), g = T.games[s.game] || T.game, cut = artificialMask(s);
    return report(a.tiles2D(s), s.W, s.H, s.rivers, g, opts, { kind: 'snapshot', id: s.id, name: s.name, game: s.game, hex: !!s.hex, topLat: s.topLat, botLat: s.botLat, connectors: s.connectors || null, catalog: s.catalog || null,
      cut: s.cut ? s.cut.length : 0, cutLand: s.cutLand ? s.cutLand.length : (s.cut ? s.cut.length : 0), degPerTile: snapDeg(s), edgeInterest: edgeInterest(s) }, null, null, { cut: artificialMask(s), cutEdge: cutEdgeMaskSnap(s), degPerTile: snapDeg(s), sourceDeadEnd: () => true });
  }
  function snapConnectors(s) { const a = api(), g = T.games[s.game] || T.game; try { return T.landforms ? T.landforms.connectors(a.tiles2D(s), s.W, s.H, lfCtx(g, s.rivers, null, s.H, null, { cut: artificialMask(s) })) : null; } catch (e) { return null; } }
  async function prepOverlay(args) { if (args && args.overlay === 'codes' && T.landforms) await T.landforms.loadCodebook(); }   // the codebook is fetched on first use
  function snapSummary(s) {
    const a = api();
    return { id: s.id, name: s.name, W: s.W, H: s.H, game: s.game, hex: !!s.hex, createdAt: s.createdAt, center: [+a.wrapLon(a.lonOf(s.frame.cx)).toFixed(2), +((s.topLat + s.botLat) / 2).toFixed(2)] };
  }
  function findSnapshot(ref) {
    const a = api(); if (ref == null) throw new Error('snapshot id (or name) required');
    const s = a.shelf.get(ref) || a.shelf.list().find(x => x.name === ref); if (!s) throw new Error('no snapshot "' + ref + '" on the shelf (list_snapshots shows what is there)');
    return s;
  }
  function composeReport(opts) {
    const a = api(), C = a.compose.composite(), c = a.compose.state(), st = a.state(), owner = ownerMap(), cb = T.landforms && T.landforms.codebook();
    const r = report(C.tiles, C.W, C.H, C.rivers, T.game, opts, { kind: 'compose', game: st.game, hex: st.hex, erased: c.erased.size, latitudes: c.latTop != null ? { top: c.latTop, bottom: c.latBot } : null, degPerTile: composeDeg(),
      patches: c.patches.map(p => ({ id: p.id, snapshot: p.snap.id, name: p.snap.name, x: p.x, y: p.y, W: p.snap.W, H: p.snap.H, landOnly: !!p.landOnly, foreign: p.snap.game !== st.game ? p.snap.game : null, skipped: p.skip ? p.skip.size : 0, riverSkip: p.riverSkip ? p.riverSkip.size : 0 })) },
      owner, composeLat(), { cutEdge: composeCutEdge(owner), sourceDeadEnd: sourceDeadEndFn(), patchBand: patchBands(cb), patchRect: patchRects(), degPerTile: composeDeg() });
    r.collisions = collisions(); r.budget = budget(r.land, C.W, C.H); r.features = genList('compose');
    return r;
  }
  const flatten = t2 => { const out = []; for (const row of t2) for (const t of row) out.push(t); return out; };
  function patchForSnapshot(s) { const ps = api().compose.state().patches.filter(p => p.snap && p.snap.id === s.id); return ps.length ? ps[ps.length - 1] : null; }
  const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
  function patchOf(ref) { const p = api().compose.patchById(ref | 0); if (!p) throw new Error('no patch ' + ref + ' on the canvas'); return p; }
  async function patchOp(args, fn) { const a = api(); a.setMode('compose'); await prepOverlay(args); const p = patchOf(args.patch); fn(a, p); a.render(); return composeReport(args); }
  const blobToBase64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(b); });


  /* ---------- lasso suggestions: a polygon that follows the frame's own geography ----------
     A hand-typed lasso is a few straight segments, so its cut edges are ruler lines. suggestLasso builds the polygon from
     the evaluated frame instead: the outline of a landmass (dilated by `margin` tiles of sea, so the real coast is kept
     and the empty sea trimmed), or one side of a mountain spine with the crest included (so the cut edge is a mountain
     wall, the best connector there is). The outline is the outer boundary of the tile mask, simplified (Douglas-Peucker)
     to a tolerance in tiles and capped at maxVertices, then mapped from tile corners to lon/lat through the frame. */
  function dilate(mask, W, H, r) { if (r <= 0) return mask; const out = Uint8Array.from(mask); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!mask[y * W + x]) continue; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && nx < W && ny >= 0 && ny < H) out[ny * W + nx] = 1; } } return out; }
  function outerLoop(mask, W, H) {   // the longest closed boundary loop of the mask, clockwise, as tile-corner points
    const m = (x, y) => x >= 0 && x < W && y >= 0 && y < H && mask[y * W + x], next = new Map(), key = (x, y) => x + ',' + y;
    const add = (a, b) => { const k = key(a[0], a[1]); (next.get(k) || next.set(k, []).get(k)).push(b); };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m(x, y)) continue;
      if (!m(x, y - 1)) add([x, y], [x + 1, y]); if (!m(x + 1, y)) add([x + 1, y], [x + 1, y + 1]); if (!m(x, y + 1)) add([x + 1, y + 1], [x, y + 1]); if (!m(x - 1, y)) add([x, y + 1], [x, y]); }
    const used = new Set(); let best = [];
    for (const [k0, outs] of next) { for (let i = 0; i < outs.length; i++) { const ek = k0 + '>' + key(outs[i][0], outs[i][1]); if (used.has(ek)) continue;
      const loop = []; let cur = k0.split(',').map(Number), prev = null, guard = 0;
      while (guard++ < W * H * 4) { const L = next.get(key(cur[0], cur[1])) || []; let nx = null; for (const c of L) { const ekk = key(cur[0], cur[1]) + '>' + key(c[0], c[1]); if (!used.has(ekk) && (!prev || c[0] !== prev[0] || c[1] !== prev[1])) { nx = c; used.add(ekk); break; } } if (!nx) break; loop.push(cur); prev = cur; cur = nx; if (cur[0] === +k0.split(',')[0] && cur[1] === +k0.split(',')[1]) break; }
      if (loop.length > best.length) best = loop; } }
    return best;
  }
  function simplify(pts, tol) {   // Douglas-Peucker on a closed ring
    if (pts.length < 4) return pts;
    const dp = (a, b) => { const A = pts[a], B = pts[b]; let far = -1, fd = 0; for (let i = a + 1; i < b; i++) { const P = pts[i], dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L)) : 0, d = Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy)); if (d > fd) { fd = d; far = i; } } if (fd > tol && far > 0) return dp(a, far).concat(dp(far, b).slice(1)); return [A, B]; };
    let piv = 0; for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) > Math.hypot(pts[piv][0] - pts[0][0], pts[piv][1] - pts[0][1])) piv = i;   // split the ring at the point farthest from the start
    const a = dp(0, piv), b = dp(piv, pts.length - 1); return a.concat(b.slice(1)).filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
  }
  function suggestLasso(args) {
    const a = api(), ev = a.evaluate(), W = ev.W, H = ev.H, N = W * H, F = glyphFns(T.game), ring = y => a.gridRing(y, H), mode = args.mode || 'land';
    const land = new Uint8Array(N), relief = new Uint8Array(N); let landN = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = ev.tiles[y][x]; if (!t || F.isWater(t)) continue; land[y * W + x] = 1; landN++; if (F.relief(t)) relief[y * W + x] = 1; }
    const LM = T.landforms.components(land, W, H, ring, 1);
    const pick = (list, labels) => { if (args.at) { const l = labels[(args.at[1] | 0) * W + (args.at[0] | 0)]; const c = list.find(z => z.id === l); if (!c) throw new Error('no ' + (mode === 'ridge' ? 'relief' : 'land') + ' at tile ' + args.at.join(',')); return c; } if (args.landmass != null && mode !== 'ridge') { const c = list.find(z => z.id === (args.landmass | 0)); if (!c) throw new Error('no landmass #' + args.landmass + ' (describe lists them)'); return c; } if (!list.length) throw new Error('nothing to lasso in this frame'); return list[0]; };
    let mask = new Uint8Array(N), what;
    if (mode === 'land' || mode === 'coast') { const c = pick(LM.list, LM.labels); for (const j of c.tiles) mask[j] = 1; what = `landmass #${c.id} (${c.size}t)`; }
    else if (mode === 'ridge') {
      const SP = T.landforms.components(relief, W, H, ring, 6); if (!SP.list.length) throw new Error('no mountain spine of 6+ tiles in this frame');
      const sp = pick(SP.list, SP.labels), rest = new Uint8Array(N); for (let i = 0; i < N; i++) if (land[i] && SP.labels[i] !== sp.id) rest[i] = 1;
      const RC = T.landforms.components(rest, W, H, ring, 1), side = String(args.side || '').toUpperCase();
      const onSide = c => !side || (side === 'N' ? c.cy < sp.cy : side === 'S' ? c.cy > sp.cy : side === 'E' ? c.cx > sp.cx : c.cx < sp.cx);
      const keep = RC.list.filter(onSide); if (!keep.length) throw new Error('no land on the ' + side + ' side of the spine at ' + Math.round(sp.cx) + ',' + Math.round(sp.cy));
      const part = keep[0]; for (const j of part.tiles) mask[j] = 1; for (const j of sp.tiles) mask[j] = 1;   // one side plus the crest: the cut runs along the far foot of the ridge
      what = `the ${side ? side + ' side' : 'largest side'} (${part.size}t) of the ${sp.size}t spine at ${Math.round(sp.cx)},${Math.round(sp.cy)}, crest included`;
    } else throw new Error("mode must be 'land' (a landmass with a sea margin), 'coast' (same) or 'ridge' (one side of a mountain spine, crest included)");
    const margin = args.margin == null ? 1 : Math.max(0, args.margin | 0); mask = dilate(mask, W, H, margin);
    let inside = 0, landIn = 0; for (let i = 0; i < N; i++) if (mask[i]) { inside++; if (land[i]) landIn++; }
    const loop = outerLoop(mask, W, H); if (loop.length < 4) throw new Error('could not trace an outline');
    let tol = args.tolerance == null ? 0.75 : +args.tolerance, poly = simplify(loop, tol); const maxV = Math.max(4, (args.maxVertices | 0) || 40);
    while (poly.length > maxV && tol < 8) { tol *= 1.5; poly = simplify(loop, tol); }
    const R = a.frameRect(), nX = R.nudgeX * R.w / W, nY = R.nudgeY * R.h / H;   // tile corner -> frame px (as maskFrame tests tile centres) -> world px -> lon/lat
    const ll = poly.map(([x, y]) => { const w = a.frameToWorld(R.x + x / W * R.w + nX, R.y + y / H * R.h + nY); return [+a.wrapLon(a.lonOf(w[0])).toFixed(3), +a.latOf(w[1]).toFixed(3)]; });
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1; for (let i = 0; i < N; i++) if (mask[i]) { const x = i % W, y = (i - x) / W; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    return { mode, what, margin, vertices: ll.length, tolerance: +tol.toFixed(2), tilesInside: inside, landInside: landIn, landInFrame: landN, bbox: [bx0, by0, bx1, by1], polygon: ll, polygonTiles: poly };
  }
  /* ---------- commands ---------- */
  const CMDS = {
    async status() {
      const a = api(), st = a.state(), F = glyphFns(T.game);
      return Object.assign(st, { params: a.params(), gameParams: T.game.P || null, legend: F.legend, reliefLabels: F.labels, grids: Object.fromEntries(T.order.map(id => [id, T.games[id].grid])) });
    },
    async set_game(args) { const a = api(); a.setGame(args.id); await settle(); return CMDS.status(); },
    async set_frame(args) {
      const a = api();
      if (args.game) a.setGame(args.game);
      if (args.W != null || args.H != null) a.setSize(args.W, args.H);
      a.setMode('civ');
      const s = a.state(), v = {};
      if (args.rot != null) v.rot = +args.rot;
      if (args.bounds) {
        const [W0, S, E0, N] = args.bounds.map(Number); let span = E0 - W0; if (span <= 0) span += 360;
        v.cx = (a.wrapLon(W0 + span / 2) + 180) / 360 * a.WSRC; v.cy = (90 - (S + N) / 2) / 180 * a.HSRC;
        v.spanX = Math.max(span / 360 * a.WSRC, (N - S) / 180 * a.HSRC * (s.W / s.effH));   // the frame's aspect is W:H, so cover the box in both axes
      } else if (args.center) { v.cx = (a.wrapLon(+args.center[0]) + 180) / 360 * a.WSRC; v.cy = (90 - (+args.center[1])) / 180 * a.HSRC; }
      if (args.spanX != null) v.spanX = +args.spanX / 360 * a.WSRC;
      a.setView(v);
      await settle();
      return frameReport(args);
    },
    async tune(args) {
      const a = api(), p = args.params || {}, relief = {}, unknown = [];
      if (args.reset) {   // back to the page's defaults: every known control to its HTML default, relief to the values seen at connect, fill to water
        for (const id of RESET_IDS) { const el = document.getElementById(id); if (!el) continue; if (el.tagName === 'BUTTON') setControl(id, false); else if (el.type === 'checkbox') setControl(id, el.defaultChecked); else setControl(id, el.defaultValue); }
        if (DEFAULT_PARAMS) a.setRelief(DEFAULT_PARAMS); a.setFill('water');
      }
      for (const k in p) {
        const v = p[k];
        if (RELIEF_KEYS.has(k)) relief[k] = v;
        else if (k === 'fill') a.setFill(v);
        else if (k === 'roughHalo') { const h = Math.max(0, +v), m = a.HALO_LOG_MIN; setControl('roughHalo', h <= 0 ? 0 : Math.min(1, Math.log(h / m) / Math.log(1 / m))); }   // the slider is logarithmic; the readout value is what the agent sees
        else if (!setControl(k, v)) unknown.push(k);
      }
      if (Object.keys(relief).length) a.setRelief(relief);
      if (unknown.length) throw new Error('unknown parameter(s): ' + unknown.join(', ') + ' (status lists params and gameParams)');
      if (a.state().mode !== 'compose') a.setMode('civ');
      await settle();
      const out = { params: a.params(), gameParams: T.game.P || null };
      return args.report === false ? out : Object.assign(frameReport(args), out);
    },
    async frame_view(args) { const a = api(); if (a.state().mode === 'compose') a.setMode('civ'); await prepOverlay(args); await settle(); return frameReport(args); },
    async snapshot(args) {
      const a = api(); if (a.state().mode === 'compose') a.setMode('civ'); await prepOverlay(args);
      const prev = a.getWorldSelection(); let sel = null, suggested = null;
      if (args.lassoFrom && !args.lasso) { await settle(); suggested = suggestLasso(typeof args.lassoFrom === 'object' ? args.lassoFrom : { mode: args.lassoFrom }); args = Object.assign({}, args, { lasso: suggested.polygon }); }
      if (args.lasso) { if (args.lasso.length < 3) throw new Error('lasso needs at least 3 [lon,lat] points'); sel = { kind: 'lasso', pts: args.lasso.map(llToPx) }; }
      else if (args.rect) { const [W0, S, E0, N] = args.rect.map(Number); sel = { kind: 'rect', pts: [llToPx([W0, N]), llToPx([E0, S])], frame: true }; }
      if (sel) a.setWorldSelection(sel);
      await settle();
      let snap; try { snap = a.capture(args.name); } finally { if (sel) a.setWorldSelection(prev); }
      snap.connectors = snapConnectors(snap); if (args.catalog) snap.catalog = args.catalog; if (args.tags) snap.tags = args.tags;
      try { await a.shelf.save(snap); } catch (e) { console.warn('[bridge] shelf save failed (snapshot kept in memory):', e); }
      return Object.assign(snapReport(snap, args), { masked: !!(sel || prev), lassoFrom: suggested ? { mode: suggested.mode, what: suggested.what, vertices: suggested.vertices, polygon: suggested.polygon } : null });
    },
    async suggest_lasso(args) { const a = api(); if (a.state().mode === 'compose') a.setMode('civ'); await settle(); return suggestLasso(args); },
    async capture_region(args) { await CMDS.set_frame(Object.assign({}, args, { grid: false, landforms: false })); return CMDS.snapshot(args); },   // frame + capture in one: what snapshot_from_catalog uses
    /* describe: paragraph + warnings + compact JSON. rows:true adds the per-row table (half the payload); codes:true the
       codebook summary (top captions per landmass; codesRaw:true also returns the per-tile grids and codes for checking the
       port against Python). Snapshots get the cut-edge rule; frames and snapshots treat every river dead end as endorheic. */
    async describe(args) {
      const a = api(), tgt = args.target || (a.state().mode === 'compose' ? 'compose' : 'frame');
      let tiles, W, H, rivers, g, owner = null, head, extra = {}, deg = null;
      const latOfRow = tgt === 'compose' ? composeLat() : null, cb = args.codes ? await T.landforms.loadCodebook() : null;
      if (tgt === 'compose') { const C = a.compose.composite(); tiles = C.tiles; W = C.W; H = C.H; rivers = C.rivers; g = T.game; owner = ownerMap(); head = { kind: 'compose' }; deg = composeDeg(); extra = { cutEdge: composeCutEdge(owner), sourceDeadEnd: sourceDeadEndFn(), patchBand: patchBands(cb || (T.landforms.codebook())), patchRect: patchRects() }; }
      else if (tgt === 'frame') { if (a.state().mode === 'compose') a.setMode('civ'); await settle(); const ev = a.evaluate(); tiles = ev.tiles; W = ev.W; H = ev.H; rivers = ev.rivers; g = T.game; const b = a.state().bounds; head = { kind: 'frame', bounds: b }; deg = Math.abs(b.N - b.S) / H; extra = { sourceDeadEnd: () => true }; }
      else { const s = findSnapshot(tgt); tiles = a.tiles2D(s); W = s.W; H = s.H; rivers = s.rivers; g = T.games[s.game] || T.game; head = { kind: 'snapshot', id: s.id, name: s.name, connectors: s.connectors || null, cut: s.cut ? s.cut.length : 0, cutLand: s.cutLand ? s.cutLand.length : (s.cut ? s.cut.length : 0) }; deg = snapDeg(s); extra = { cut: artificialMask(s), cutEdge: cutEdgeMaskSnap(s), sourceDeadEnd: () => true }; }
      if (args.degPerTile) deg = +args.degPerTile;
      const ctx = lfCtx(g, rivers, owner, H, latOfRow, extra);
      const D = T.landforms.describe(tiles, W, H, ctx, { full: true, rows: !!args.rows, codes: cb && deg ? { cb, degPerTile: deg, tiles: !!args.codesRaw } : null });
      if (args.codes && !cb) D.codes = { error: 'codebook not loaded (data/landform/codebook.json)' }; else if (args.codes && !deg) D.codes = { error: 'no tile size known: pass degPerTile, or declare it with compose_new {degPerTile}' };
      if (D.codeTiles) {   // the raw grids the Python assign takes, for a port check (terraform/landform_codebook.py)
        const F = glyphFns(g), A = D.codeTiles, land = [], relief = [], kop = [], river = [], rv = ctx.riverTiles;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x], w = !t || F.isWater(t); land.push(w ? 0 : 1); relief.push(w ? 0 : Math.min(2, F.relief(t) | 0)); const k = w ? 0 : (ctx.kc(t) | 0); kop.push(w || !k ? 0 : ctx.group(k)); river.push(!w && rv.has(x + ',' + y) ? 1 : 0); }
        D.codesRaw = { W, H, band: A.band, degPerTile: deg, land, relief, koppen: kop, river, codes: Array.from(A.codes) }; delete D.codeTiles;
      }
      let L = owner ? T.landforms.lint(tiles, W, H, ctx) : T.landforms.lint(tiles, W, H, ctx, ['straightEdgeCoast', 'riverDeadEnd']);
      head.degPerTile = deg;
      return Object.assign(head, { W, H }, D, { warnings: L.filter(w => w.level !== 'info'), notes: L.filter(w => w.level === 'info') });
    },
    /* flip_snapshot: a mirrored copy on the shelf. Tiles are re-indexed; river edges are re-keyed (a north edge of tile
       (gx,gy) mirrored N-S is the north edge of (gx, H-gy); a west edge mirrored E-W is the west edge of (W-gx, gy)) and
       their absolute flow directions swapped on the mirrored axis. Edges that land on the far border are dropped. */
    async flip_snapshot(args) {
      const a = api(), s = findSnapshot(args.id), ax = String(args.axis || 'x').toLowerCase(), W = s.W, H = s.H;
      if (ax !== 'x' && ax !== 'y' && ax !== 'xy') throw new Error("axis must be 'x' (mirror east-west), 'y' (mirror north-south) or 'xy' (rotate 180)");
      const fx = ax !== 'y', fy = ax !== 'x', tiles = new Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = s.tiles[(fy ? H - 1 - y : y) * W + (fx ? W - 1 - x : x)]; tiles[y * W + x] = t && typeof t === 'object' ? Object.assign({}, t) : t; }
      const nof = [], wof = [];
      for (const [k, v] of s.rivers.nof) { const p = k.split(','); let gy = +p[0], gx = +p[1], dir = v.dir; if (fx) { gx = W - 1 - gx; dir = dir === 1 ? 3 : dir === 3 ? 1 : dir; } if (fy) gy = H - 2 - gy; if (gy >= 0 && gy <= H - 2 && gx >= 0 && gx < W) nof.push([gy + ',' + gx, Object.assign({}, v, { dir })]); }
      for (const [k, v] of s.rivers.wof) { const p = k.split(','); let gy = +p[0], gx = +p[1], dir = v.dir; if (fy) { gy = H - 1 - gy; dir = dir === 0 ? 2 : dir === 2 ? 0 : dir; } if (fx) gx = W - 2 - gx; if (gy >= 0 && gy < H && gx >= 0 && gx <= W - 2) wof.push([gy + ',' + gx, Object.assign({}, v, { dir })]); }
      const flipIdx = L => L ? L.map(i => { const x = i % W, y = (i - x) / W; return (fy ? H - 1 - y : y) * W + (fx ? W - 1 - x : x); }).sort((p, q) => p - q) : null;   // the mask-fill flags flip with the tiles
      const snap = Object.assign({}, s, { id: a.newId(), name: args.name || (s.name + (ax === 'xy' ? ' (rotated 180)' : ax === 'x' ? ' (mirrored E-W)' : ' (mirrored N-S)')), tiles, rivers: { nof, wof }, cut: flipIdx(s.cut), cutLand: flipIdx(s.cutLand), createdAt: Date.now(), flipped: ax, thumb: null });
      snap.thumb = a.thumb(snap); snap.connectors = snapConnectors(snap);
      await a.shelf.save(snap);
      return Object.assign(snapReport(snap, args), { note: s.hex ? 'hex snapshot: mirroring N-S changes which rows lean east; check the coast after placing' : null });
    },
    /* thumbnail: the app's own tile renderer on the canvas / frame / a snapshot, as a PNG data URL */
    async thumbnail(args) {
      const a = api(), tgt = args.target || (a.state().mode === 'compose' ? 'compose' : 'frame'); let fake, rivers;
      if (tgt === 'compose') { const C = a.compose.composite(); fake = { W: C.W, H: C.H, hex: a.state().hex, tiles: flatten(C.tiles) }; rivers = C.rivers; }
      else if (tgt === 'frame') { if (a.state().mode === 'compose') a.setMode('civ'); await settle(); const ev = a.evaluate(); fake = { W: ev.W, H: ev.H, hex: ev.hex, tiles: flatten(ev.tiles) }; rivers = ev.rivers; }
      else { fake = findSnapshot(tgt); rivers = fake.rivers; }
      let url = a.thumb(fake, Math.max(32, Math.min(2048, args.maxPx | 0 || 480)));
      if (args.rivers !== false && rivers) url = await drawRivers(url, rivers, fake.W, fake.H);
      return { target: tgt, W: fake.W, H: fake.H, dataUrl: url };
    },
    /* attach: put B against A so that A's edgeA meets B's edgeB (opposite edges), centred along the seam. A is its
       existing patch, or is placed at the canvas centre first. overlap pulls B that many tiles into A; shift slides
       it along the seam. Expands into place/move; the report carries the seam lint. */
    async attach(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args);
      const A = findSnapshot(args.a), B = findSnapshot(args.b), eA = String(args.edgeA || 'E').toUpperCase(), eB = String(args.edgeB || OPP[eA]).toUpperCase();
      if (!OPP[eA] || OPP[eA] !== eB) throw new Error('edges must be opposite sides (A ' + eA + ' needs B ' + OPP[eA] + ')');
      const c = a.compose.state(); let pa = patchForSnapshot(A);
      if (!pa) pa = a.compose.add(A, Math.round((c.W - A.W) / 2), Math.round((c.H - A.H) / 2), args.landOnly !== false);
      const RO = raggedOpts(args.ragged);
      if (args.ragged && !pa.skip && RO.feather !== false) a.compose.setSkip(pa.id, featherSkip(A, pa, eA, { preserve: RO.preserveA, preserveSides: RO.preserveSidesA, preserveCoast: RO.preserveCoast }));   // A's own cut edges and frame border, except the seam side (the min-cut below handles that)
      const along = (eA === 'E' || eA === 'W') ? 'y' : 'x', centre = along === 'y' ? Math.round((A.H - B.H) / 2) : Math.round((A.W - B.W) / 2);
      let sh = args.shift | 0, aligned = null, ov = args.overlap === 'auto' ? null : args.overlap | 0, fused = null;
      /* overlap 'auto' (fuse): search overlap depth and slide together for the cheapest interest-weighted seam, so two
         pieces merge over land where neither has anything worth keeping (the min-cut then decides each overlap tile) */
      if (ov === null) {
        const win2 = Math.max(1, (args.searchShift | 0) || 12), maxOv = Math.max(2, Math.min((args.maxOverlap | 0) || 14, Math.floor(Math.min(A.W, B.W, A.H, B.H) * 0.6)));
        const posAt = (o2, s2) => eA === 'E' ? { x: pa.x + A.W - o2, y: pa.y + centre + s2 } : eA === 'W' ? { x: pa.x - B.W + o2, y: pa.y + centre + s2 } : eA === 'S' ? { x: pa.x + centre + s2, y: pa.y + A.H - o2 } : { x: pa.x + centre + s2, y: pa.y - B.H + o2 };
        for (let o2 = 2; o2 <= maxOv; o2++) for (let d = -win2; d <= win2; d += 2) { const q = posAt(o2, sh + d), mc = minCutSkip(A, pa, B, q, eA); if (!mc) continue; const contact = Math.min(1, mc.landBoth / (1.5 * mc.length)), score = mc.cost - 0.015 * o2 + 0.9 * (1 - contact); /* fusing means land meets land: an overlap of open sea scores badly however cheap its seam */ if (!fused || score < fused.score) fused = { score, overlap: o2, shift: sh + d, seamCostPerRow: mc.cost }; }
        ov = fused ? fused.overlap : 2; if (fused) { sh = fused.shift; fused.score = +fused.score.toFixed(3); }
      }
      const ragAuto = args.ragged || args.overlap === 'auto';
      /* align: line the two edges' anchors up (centre of the relief run within 4 tiles of the edge, or of the longest land run
         along it) instead of the rectangle centres, so a range meets a range (Mawhorter & Mateas anchors) */
      if (args.align) {
        const cA = A.connectors && A.connectors[eA], cB = B.connectors && B.connectors[eB], key = args.align === 'relief' ? 'reliefAt' : 'coastAt';
        if (cA && cB && cA[key] != null && cB[key] != null) { sh += (cA[key] - cB[key]) - centre; aligned = { kind: args.align, anchorA: cA[key], anchorB: cB[key], shift: sh }; }
        else aligned = { kind: args.align, error: 'no ' + args.align + ' anchor on A\'s ' + eA + ' or B\'s ' + eB + ' edge (snapshot_info shows anchors; re-capture to compute them)' };
      }
      let x, y;
      if (eA === 'E') { x = pa.x + A.W - ov; y = pa.y + centre + sh; }
      else if (eA === 'W') { x = pa.x - B.W + ov; y = pa.y + centre + sh; }
      else if (eA === 'S') { y = pa.y + A.H - ov; x = pa.x + centre + sh; }
      else { y = pa.y - B.H + ov; x = pa.x + centre + sh; }
      /* seam cost at the requested position, and the best shift along the seam within ±searchShift (applied only with autoShift);
         a best shift on the window's edge means the optimum may lie further out */
      const win = Math.max(1, (args.searchShift | 0) || 16), cost = seamCost(A, pa.x, pa.y, B, x, y, eA); let best = { shift: sh, cost: cost.cost };
      for (let d = -win; d <= win; d++) { const sc = seamCost(A, pa.x, pa.y, B, along === 'y' ? x : x + d, along === 'y' ? y + d : y, eA); if (sc.tiles && sc.cost < best.cost) best = { shift: sh + d, cost: sc.cost }; }
      best.window = win; best.atWindowEdge = Math.abs(best.shift - sh) === win;
      if (args.autoShift && best.shift !== sh) { if (along === 'y') y += best.shift - sh; else x += best.shift - sh; }
      /* clamp (default): slide B along the seam so its land stays on the canvas when it fits; what still overhangs is reported */
      let clamped = 0;
      if (args.clamp !== false) { const lb = landBounds(B); if (lb) { if (along === 'y') { const top = y + lb.y0, bot = y + lb.y1; clamped = top < 0 ? -top : bot > c.H - 1 ? (c.H - 1) - bot : 0; y += clamped; } else { const lft = x + lb.x0, rgt = x + lb.x1; clamped = lft < 0 ? -lft : rgt > c.W - 1 ? (c.W - 1) - rgt : 0; x += clamped; } } }
      let pb = patchForSnapshot(B); if (pb) a.compose.move(pb.id, x, y); else pb = a.compose.add(B, x, y, args.landOnly !== false);
      /* ragged: feather B's cut edges and frame border (not the seam side), and cut a min-cost path through the overlap strip */
      let ragged = null;
      if (ragAuto) { const skip = new Set(RO.feather === false ? [] : featherSkip(B, pb, eB, { preserve: RO.preserve, preserveSides: RO.preserveSides, preserveCoast: RO.preserveCoast })); const mc = ov >= 2 && RO.minCut !== false ? minCutSkip(A, pa, B, pb, eA) : null; if (mc) for (const i of mc.skip) skip.add(i); a.compose.setSkip(pb.id, unpin([...skip], B, RO.preserve)); ragged = { skipped: pb.skip ? pb.skip.size : 0, skippedA: pa.skip ? pa.skip.size : 0, seam: mc ? { length: mc.length, width: mc.width, costPerTile: mc.cost } : RO.minCut === false ? 'feathered only' : 'feathered only (overlap < 2: no strip for a min-cut path)' }; }
      else if (pb.skip) a.compose.setSkip(pb.id, null);
      a.render();
      return Object.assign(composeReport(args), { attached: { a: pa.id, b: pb.id, x: pb.x, y: pb.y, seam: eA + '/' + eB, fused, connectorA: A.connectors ? A.connectors[eA] : null, connectorB: B.connectors ? B.connectors[eB] : null, seamCost: (args.autoShift && best.shift !== sh) || clamped ? seamCost(A, pa.x, pa.y, B, pb.x, pb.y, eA) : cost, bestShift: best, aligned, clamped, clipped: clipped(pb, c.W, c.H), ragged } });
    },
    /* trim_rivers: drop the collage's river systems that end on land. By default only those the source snapshots did not
       have (cut by a seam, an erase or an overlapping stamp); endorheic:'trim' drops every landlocked system; rids picks
       systems by id. Implemented as per-patch edge drops (TerraForm.api.compose.setRiverSkip), so the snapshots are untouched. */
    async trim_rivers(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args);
      const C = a.compose.composite(), c = a.compose.state(), ctx = lfCtx(T.game, C.rivers, null, C.H), R = T.landforms.riverAnalysis(C.tiles, C.W, C.H, ctx), srcDead = sourceDeadEndFn();
      const want = new Set((args.rids || []).map(String)), keepEndorheic = args.endorheic !== 'trim', deadByRid = new Map();
      for (const e of R.deadEndEdges) { const l = deadByRid.get(String(e.rid)) || []; l.push(e); deadByRid.set(String(e.rid), l); }
      const drop = new Set(), kept = [];
      for (const s of R.systemsAll) {
        const rid = String(s.rid); if (want.size) { if (want.has(rid)) drop.add(rid); continue; }
        if (s.edges < (args.minEdges == null ? 3 : args.minEdges | 0) && !s.into) { drop.add(rid); continue; }   // a stub of one or two edges is no river (seam and lasso leftovers)
        if (s.reaches === 'water' || s.reaches === 'edge') continue;
        const de = deadByRid.get(rid) || []; if (keepEndorheic && de.length && de.every(srcDead)) { kept.push(rid); continue; }
        drop.add(rid);
      }
      const perPatch = new Map(); let n = 0, branches = 0;
      const dropEdge = (kind, gx, gy) => { const o = edgeOwner(kind, gx, gy); if (!o) return false; const S = perPatch.get(o.patch.id) || new Set(o.patch.riverSkip || []); S.add(kind + ':' + o.ly + ',' + o.lx); perPatch.set(o.patch.id, S); n++; return true; };
      const walk = (m, kind) => { for (const [k, v] of m) { if (!drop.has(String(v.rid))) continue; const p = k.split(','); dropEdge(kind, +p[1], +p[0]); } };
      walk(C.rivers.nof, 'n'); walk(C.rivers.wof, 'w');
      /* a system that does reach water but carries a cut dead end on a side branch: walk the branch upstream from the dead end
         to the first junction (or to water) and drop just those edges */
      if (!want.size) {
        const E = []; const addE = (m, kind) => { for (const [k, v] of m) { const p = k.split(','), x = +p[1], y = +p[0]; const c1 = kind === 'n' ? [x, y + 1] : [x + 1, y], c2 = kind === 'n' ? [x + 1, y + 1] : [x + 1, y + 1], down = kind === 'n' ? (v.dir === 1 ? c2 : c1) : (v.dir === 2 ? c2 : c1); E.push({ kind, x, y, rid: v.rid, c1, c2, down, up: down === c1 ? c2 : c1, gone: false }); } }; addE(C.rivers.nof, 'n'); addE(C.rivers.wof, 'w');
        const near = (e, c) => E.filter(o => o !== e && !o.gone && o.rid === e.rid && [o.c1, o.c2].some(q => q[0] === c[0] && q[1] === c[1]));   // edges sharing this exact corner
        const Fw = glyphFns(T.game), wet = c => [[c[0] - 1, c[1] - 1], [c[0], c[1] - 1], [c[0] - 1, c[1]], [c[0], c[1]]].some(([x, y]) => x >= 0 && x < W && y >= 0 && y < H && Fw.isWater(C.tiles[y][x]));
        const W = C.W, H = C.H;
        for (const d of R.deadEndEdges) {
          if (drop.has(String(d.rid)) || (keepEndorheic && srcDead(d))) continue;
          let e = E.find(o => o.kind === d.kind && o.x === d.x && o.y === d.y && !o.gone); let steps = 0;
          while (e && steps++ < 80) { e.gone = true; dropEdge(e.kind, e.x, e.y); branches++; if (wet(e.up)) break; const up = near(e, e.up); if (up.length !== 1) break; e = up[0]; }
        }
      }
      for (const [id, S] of perPatch) a.compose.setRiverSkip(id, [...S]);
      if (c.riverAdd && c.riverAdd.length) { const keep = c.riverAdd.filter(e => !drop.has(String(e[2].rid))); if (keep.length !== c.riverAdd.length) { a.compose.clearAddedRivers(); a.compose.addRivers(keep); } }
      a.render();
      return Object.assign(composeReport(args), { trimmed: { systems: [...drop], edges: n, branchEdges: branches, keptEndorheic: kept } });
    },
    /* extend_river: carry a river that dead-ends on land (rid, or the dead end nearest `at`, else every dead end) on to the
       nearest water, or into another river, by breadth-first search over tile corners along edges whose both flanks are
       land; the new edges are canvas-level (TerraForm.api.compose.addRivers) and flow toward the water. */
    async extend_river(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args);
      const C = a.compose.composite(), W = C.W, H = C.H, F = glyphFns(T.game), ctx = lfCtx(T.game, C.rivers, null, H), R = T.landforms.riverAnalysis(C.tiles, W, H, ctx);
      let dead = R.deadEndEdges.slice();
      if (args.rid != null) dead = dead.filter(e => String(e.rid) === String(args.rid));
      else if (args.at) { const [ax, ay] = args.at; dead.sort((p, q) => Math.hypot(p.x - ax, p.y - ay) - Math.hypot(q.x - ax, q.y - ay)); dead = dead.slice(0, 1); }
      if (!dead.length) throw new Error('no river dead end to extend' + (args.rid != null ? ' for river ' + args.rid : ''));
      const land = (x, y) => x >= 0 && x < W && y >= 0 && y < H && !F.isWater(C.tiles[y][x]), water = (x, y) => x >= 0 && x < W && y >= 0 && y < H && F.isWater(C.tiles[y][x]);
      const cornerWet = (cx, cy) => water(cx - 1, cy - 1) || water(cx, cy - 1) || water(cx - 1, cy) || water(cx, cy);
      /* a corner where another river flows on (an edge of a different river leaves it): joining a river at its own dead end, or the river itself, is no join */
      const outOf = new Map(), leave = (cx, cy, rid) => { const k = cx + ',' + cy; (outOf.get(k) || outOf.set(k, new Set()).get(k)).add(String(rid)); };
      for (const [k, v] of C.rivers.nof) { const p = k.split(','), gy = +p[0], gx = +p[1]; if (v.dir === 3) leave(gx + 1, gy + 1, v.rid); else leave(gx, gy + 1, v.rid); }
      for (const [k, v] of C.rivers.wof) { const p = k.split(','), gy = +p[0], gx = +p[1]; if (v.dir === 0) leave(gx + 1, gy + 1, v.rid); else leave(gx + 1, gy, v.rid); }
      const drains = new Set(R.systemsAll.filter(s => s.reaches === 'water' || s.reaches === 'edge').map(s => String(s.rid)));   // and that river reaches the sea: two dead ends joined to each other drain nowhere
      const cornerRiver = (cx, cy, rid) => { const S = outOf.get(cx + ',' + cy); return !!S && [...S].some(r => r !== String(rid) && drains.has(r)); };   // nof (cy-1, cx|cx-1) and wof (cy|cy-1, cx-1) touch corner (cx,cy)
      /* from corner (cx,cy) (top-left of tile (cx,cy)): E = the boundary above tile (cx,cy) = nof (cy-1,cx); W = nof (cy-1,cx-1); S = the boundary left of tile (cx,cy) = wof (cy,cx-1); N = wof (cy-1,cx-1) */
      const MOVES = [{ dx: 1, dy: 0, kind: 'n', key: (cx, cy) => (cy - 1) + ',' + cx, dir: 1, fl: (cx, cy) => [[cx, cy - 1], [cx, cy]] }, { dx: -1, dy: 0, kind: 'n', key: (cx, cy) => (cy - 1) + ',' + (cx - 1), dir: 3, fl: (cx, cy) => [[cx - 1, cy - 1], [cx - 1, cy]] },
                     { dx: 0, dy: 1, kind: 'w', key: (cx, cy) => cy + ',' + (cx - 1), dir: 2, fl: (cx, cy) => [[cx - 1, cy], [cx, cy]] }, { dx: 0, dy: -1, kind: 'w', key: (cx, cy) => (cy - 1) + ',' + (cx - 1), dir: 0, fl: (cx, cy) => [[cx - 1, cy - 1], [cx, cy - 1]] }];
      const results = [], ents = [], maxLen = Math.max(4, (args.maxLength | 0) || 60), seenRid = new Set();
      for (const e of dead) {
        if (seenRid.has(e.rid) && args.rid == null && !args.at) continue; seenRid.add(e.rid);
        const start = e.down, prev = new Map([[start.join(','), null]]); let q = [start], found = null, depth = 0;
        while (q.length && !found && depth < maxLen) {
          const nq = [];
          for (const [cx, cy] of q) { for (const m of MOVES) { const nx = cx + m.dx, ny = cy + m.dy, k = nx + ',' + ny; if (prev.has(k)) continue; const [f1, f2] = m.fl(cx, cy); if (!land(f1[0], f1[1]) || !land(f2[0], f2[1])) continue; prev.set(k, [cx, cy, m]); if (cornerWet(nx, ny)) { found = { c: [nx, ny], to: 'water' }; break; } if (cornerRiver(nx, ny, e.rid)) { found = { c: [nx, ny], to: 'another river' }; break; } nq.push([nx, ny]); } if (found) break; }
          q = nq; depth++;
        }
        if (!found) { results.push({ rid: e.rid, from: start, error: 'no land path to water within ' + maxLen + ' edges' }); continue; }
        const path = []; let k = found.c.join(','); while (prev.get(k)) { const [cx, cy, m] = prev.get(k); path.push([m.kind, m.key(cx, cy), { dir: m.dir, d: e.d || 1, rid: e.rid }]); k = cx + ',' + cy; }
        path.reverse(); ents.push(...path); results.push({ rid: e.rid, from: start, to: found.to, at: found.c, edges: path.length });
      }
      if (ents.length) a.compose.addRivers(ents);
      a.render();
      return Object.assign(composeReport(args), { extended: results });
    },
    /* scatter: stamp snapshots (cycling the list) centred on points every `spacing` tiles along the polyline `along` */
    async scatter(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args);
      const snaps = (args.snapshots || []).map(findSnapshot); if (!snaps.length) throw new Error('snapshots: list of snapshot ids or names required');
      if (!args.allowRepeat) { const ids = new Set(); for (const sn of snaps) { if (ids.has(sn.id)) throw new Error('"' + sn.name + '" is listed twice: every snapshot is pasted once (allowRepeat:true to override)'); ids.add(sn.id); uniquePaste(sn, false); } }
      const pts = args.along || []; if (pts.length < 1) throw new Error('along: [[x,y],...] polyline required');
      const spacing = Math.max(1, +args.spacing || 8), placed = [], samples = [];
      if (pts.length === 1) samples.push(pts[0]);
      else { let carry = 0; for (let i = 0; i + 1 < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], L = Math.hypot(x1 - x0, y1 - y0); let d = carry; if (i === 0) samples.push([x0, y0]); while (d + spacing <= L + 1e-9) { d += spacing; samples.push([x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L]); } carry = d - L; } }
      /* centre each stamp on its LAND (bbox centre), not on its rectangle: an atoll capture is mostly sea around a few tiles */
      const landCentre = s => { const g = T.games[s.game] || T.game, F = glyphFns(g); let x0 = s.W, y0 = s.H, x1 = -1, y1 = -1; for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) { const t = s.tiles[y * s.W + x]; if (t && !F.isWater(t)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return x1 < 0 ? [s.W / 2, s.H / 2] : [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2]; };
      if (!args.allowRepeat && samples.length > snaps.length) throw new Error(`the path has room for ${samples.length} stamps but only ${snaps.length} distinct snapshots were given: every snapshot is pasted once (give more snapshots, a larger spacing, or allowRepeat:true)`);
      samples.forEach((pt, i) => { const s = snaps[(i + (args.start | 0)) % snaps.length], c = landCentre(s); let px = Math.round(pt[0] - c[0]), py = Math.round(pt[1] - c[1]), shifted = null;
        if (args.avoidLand) { const f = freeSpot(s, px, py, args.gap == null ? 1 : args.gap | 0); if (f) { shifted = (f.dx || f.dy) ? { dx: f.dx, dy: f.dy } : null; px = f.x; py = f.y; } else shifted = { error: 'no free spot' }; }
        const p = a.compose.add(s, px, py, args.landOnly !== false); placed.push({ patch: p.id, snapshot: s.name, x: p.x, y: p.y, shifted }); });
      a.render();
      return Object.assign(composeReport(args), { scattered: placed });
    },
    async list_snapshots() { return { snapshots: api().shelf.list().map(snapSummary) }; },
    async snapshot_info(args) { await prepOverlay(args); return snapReport(findSnapshot(args.id), args); },
    async delete_snapshot(args) { const s = findSnapshot(args.id); await api().shelf.remove(s.id); return { deleted: s.id, snapshots: api().shelf.list().map(snapSummary) }; },
    async compose_new(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args);
      if (args.fill) a.setFill(args.fill);
      if (args.clear !== false) a.compose.clear();
      if (args.latitudes !== undefined) { const L = args.latitudes; a.compose.setLatitudes(L ? L.top : null, L ? L.bottom : null); }   // {top,bottom} degrees for row 0 / row H: a virtual span for the export header and the latitude lint; null clears it
      const c = a.compose.state(); if (args.W != null || args.H != null) a.compose.setSize(args.W != null ? args.W : c.W, args.H != null ? args.H : c.H);
      if (args.targetLand !== undefined) {   // a land-share target for the budget line: a fraction or percent, or [lo, hi]
        let t = args.targetLand; if (t == null) a.compose.setBudget(null, null); else { let lo, hi; if (Array.isArray(t)) [lo, hi] = t; else { lo = +t - 0.05 * (+t > 1 ? 100 : 1); hi = +t + 0.05 * (+t > 1 ? 100 : 1); } if (lo > 1 || hi > 1) { lo /= 100; hi /= 100; } a.compose.setBudget(lo, hi); }
      }
      if (args.degPerTile !== undefined) a.compose.setScale(args.degPerTile);   // the canvas' nominal tile size for the landform codebook (else the patches' median)
      a.render(); return composeReport(args);
    },
    /* place: stamp a snapshot. avoidLand shifts it to the nearest spot where its land touches no existing land (gap tiles of
       water between, default 1); ragged feathers its cut edges; preview reports the result without keeping the patch. */
    async place(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args); const s = findSnapshot(args.snapshot), c = a.compose.state();
      uniquePaste(s, args.allowRepeat);
      let x = args.x | 0, y = args.y | 0, shifted = null;
      if (args.avoidLand) { const f = freeSpot(s, x, y, args.gap == null ? 1 : args.gap | 0); if (!f) throw new Error('avoidLand: no free spot on the canvas for "' + s.name + '"'); shifted = (f.dx || f.dy) ? { dx: f.dx, dy: f.dy } : null; x = f.x; y = f.y; }
      const p = a.compose.add(s, x, y, args.landOnly !== false);
      if (args.ragged) { const RO = raggedOpts(args.ragged); a.compose.setSkip(p.id, featherSkip(s, p, null, { preserve: RO.preserve, preserveSides: RO.preserveSides, preserveCoast: RO.preserveCoast })); }
      a.render();
      const r = Object.assign(composeReport(args), { placed: { patch: p.id, x: p.x, y: p.y, landOnly: !!p.landOnly, shifted, clipped: clipped(p, c.W, c.H), skipped: p.skip ? p.skip.size : 0, preview: !!args.preview } });
      if (args.preview) { a.compose.remove(p.id); a.render(); }
      return r;
    },
    move_patch: args => patchOp(args, (a, p) => {
      const rel = args.dx != null || args.dy != null;
      a.compose.move(p.id, rel ? p.x + (args.dx | 0) : (args.x | 0), rel ? p.y + (args.dy | 0) : (args.y | 0));
    }),
    remove_patch: args => patchOp(args, (a, p) => a.compose.remove(p.id)),
    raise_patch: args => patchOp(args, (a, p) => a.compose.raise(p.id)),
    lower_patch: args => patchOp(args, (a, p) => a.compose.lower(p.id)),
    set_land_only: args => patchOp(args, (a, p) => a.compose.setLandOnly(p.id, args.landOnly !== false)),
    async erase(args) {
      const a = api(); a.setMode('compose'); await prepOverlay(args); const r = args.rect; if (!r || r.length !== 4) throw new Error('rect [x0,y0,x1,y1] (inclusive tile coords) required');
      const n = a.compose.eraseRect(Math.min(r[0], r[2]) | 0, Math.min(r[1], r[3]) | 0, Math.max(r[0], r[2]) | 0, Math.max(r[1], r[3]) | 0); a.render();
      return Object.assign(composeReport(args), { erasedNow: n });
    },
    async unerase(args) { const a = api(); a.setMode('compose'); await prepOverlay(args); a.compose.unerase(); a.render(); return composeReport(args); },
    async add_lake(args) { return genCmd('lake', args); },
    async fill_gaps(args) { const a = api(); a.setMode('compose'); const g = a.gen.compose.fill(args); a.render(); return Object.assign(composeReport(args), { generated: g }); },
    /* the sculpt pathway (core/sculpt.js): a height field built from real fragments and primitives, then realized */
    async sculpt_new(args) { const a = api(); if (!a.sculpt) throw new Error('core/sculpt.js is not loaded'); await settle(); const r = a.sculpt.new(args); return a.sculpt.view(Object.assign({}, args, { msg: r.msg })); },
    async sculpt_stamp(args) { const a = api(); await settle(); const r = a.sculpt.stamp(args); return a.sculpt.view(Object.assign({}, args, { msg: r.msg })); },
    async sculpt_shape(args) { const a = api(); const r = a.sculpt.shape(args); return a.sculpt.view(Object.assign({}, args, { msg: r.msg })); },
    async sculpt_sea(args) { const a = api(); const r = a.sculpt.sea(args); return a.sculpt.view(Object.assign({}, args, { msg: r.msg })); },
    async sculpt_view(args) { return api().sculpt.view(args); },
    async sculpt_realize(args) { const a = api(); await settle(); const r = await a.sculpt.realize(args); return Object.assign(composeReport(args), { realized: r }); },
    async reclimate(args) { const a = api(); a.setMode('compose'); const r = await a.sculpt.reclimate(args); a.render(); return Object.assign(composeReport(args), { reclimated: r }); },
    async add_salt_pan(args) { return genCmd('salt_pan', args); },
    async add_river(args) { return genCmd('river', args); },
    async features(args) {
      const a = api(); if (!a.gen) throw new Error('core/generate.js is not loaded (index.html)');
      const target = args.target || (a.state().mode === 'compose' ? 'compose' : 'frame'), G = a.gen[target]; if (!G) throw new Error("target must be 'frame' or 'compose'");
      const act = args.action || 'list'; let removed = 0;
      if (act === 'remove') { if (!args.id) throw new Error('id required to remove'); removed = G.remove(args.id); }
      else if (act === 'clear') removed = G.clear();
      else if (act !== 'list') throw new Error("action must be 'list', 'remove' or 'clear'");
      a.render(); return { target, action: act, removed, features: G.list() };
    },
    async compose_view(args) { const a = api(); a.setMode('compose'); await prepOverlay(args); a.render(); return composeReport(args); },
    async compose_stats(args) { const a = api(); a.setMode('compose'); return Object.assign(composeReport(Object.assign({}, args, { grid: false })), a.compose.stats()); },
    async export(args) {
      const a = api(); if (a.state().mode !== 'compose') await settle();
      const r = await a.export(args.name), files = [];
      for (const f of r.built.files) {
        const blob = f.data instanceof Blob, e = { name: f.name, mime: f.mime || null, size: blob ? f.data.size : String(f.data).length };
        if (args.transfer) { e.encoding = blob ? 'base64' : 'utf8'; e.data = blob ? await blobToBase64(f.data) : String(f.data); }
        files.push(e);
      }
      let dest = null; if (!args.transfer) { await a.writeFiles(r.built); dest = a.destHint(); }
      return { mode: r.ctx.mode, game: r.g.id, W: r.region.W, H: r.region.H, dir: r.built.dir || null, files, validation: r.rows.map(x => ({ label: x[0], ok: !!x[1], detail: x[2] })), note: r.note || null, dest };
    }
  };

  if (document.readyState === 'complete') connect(); else window.addEventListener('load', connect);
  T.bridge = { url: URL_, connected: () => !!(ws && ws.readyState === 1), commands: CMDS };
})();
