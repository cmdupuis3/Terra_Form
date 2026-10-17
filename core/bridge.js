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
    const ascii = pv.ascii || (t => isWater(t) ? '~' : relief(t) === 2 ? '^' : relief(t) === 1 ? 'n' : '.');
    return { ascii, legend: pv.asciiLegend ? pv.asciiLegend() : GENERIC_LEGEND, relief, labels: pv.reliefLabels || ['flat', 'hills', 'peaks'], isWater };
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
  function lfCtx(g, rivers, owner, H, latOfRow) {
    const F = glyphFns(g), U = T.util;
    return { isWater: F.isWater, relief: F.relief, kc: t => (typeof t.kc === 'number' ? t.kc : 0), group: k => U.classGroup(k), ring: y => api().gridRing(y, H), rivers, owner: owner || null,
      height: t => (typeof t.m === 'number' ? t.m : null), latOfRow: latOfRow || null, climateAdjacency: CLIMATE_ADJ, hex: !!(g && g.grid && g.grid.kind === 'hex') };
  }
  /* seam cost (Zhou et al. 2007 in tile form): over the strip where A and B overlap (or the two facing columns/rows when
     they only touch), the share of tile pairs that disagree on water, climate group or relief */
  function seamCost(A, ax, ay, B, bx, by, edgeA) {
    const FA = glyphFns(T.games[A.game] || T.game), FB = glyphFns(T.games[B.game] || T.game), U = T.util;
    let x0 = Math.max(ax, bx), x1 = Math.min(ax + A.W, bx + B.W) - 1, y0 = Math.max(ay, by), y1 = Math.min(ay + A.H, by + B.H) - 1;
    if (x1 < x0 || y1 < y0) { if (edgeA === 'E') bx--; else if (edgeA === 'W') bx++; else if (edgeA === 'S') by--; else by++; x0 = Math.max(ax, bx); x1 = Math.min(ax + A.W, bx + B.W) - 1; y0 = Math.max(ay, by); y1 = Math.min(ay + A.H, by + B.H) - 1; }
    let n = 0, water = 0, climate = 0, relief = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const ta = A.tiles[(y - ay) * A.W + (x - ax)], tb = B.tiles[(y - by) * B.W + (x - bx)]; if (!ta || !tb) continue; n++;
      const wa = FA.isWater(ta), wb = FB.isWater(tb); if (wa !== wb) { water++; continue; } if (wa) continue;
      const ka = typeof ta.kc === 'number' ? ta.kc : 0, kb = typeof tb.kc === 'number' ? tb.kc : 0; if (ka && kb && U.classGroup(ka) !== U.classGroup(kb)) climate++;
      if ((FA.relief(ta) | 0) !== (FB.relief(tb) | 0)) relief++;
    }
    return { tiles: n, cost: n ? +((water + climate + relief) / n).toFixed(3) : 0, water, climate, relief };
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
          let w = false; try { w = !!g.isWater(t); } catch (e) {} if (p.landOnly && w) continue; own[dy * W + dx] = p.id; } }
    }
    for (const k of c.erased) { const q = k.split(','), y = +q[0], x = +q[1]; if (x >= 0 && x < W && y >= 0 && y < H) own[y * W + x] = 0; }
    return own;
  }
  function report(tiles, W, H, rivers, g, opts, head, owner, latOfRow) {
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
    if (opts.landforms !== false && T.landforms) {   // the short landform line, and the seam lint when the tiles are a collage (owner map given)
      const ctx = lfCtx(g, rivers, owner, H, latOfRow);
      try { res.landforms = T.landforms.brief(T.landforms.describe(tiles, W, H, ctx)); } catch (e) { res.landforms = 'describe failed: ' + e.message; }
      if (owner) { try { res.warnings = T.landforms.lint(tiles, W, H, ctx); } catch (e) { res.warnings = [{ rule: 'lint', at: [0, 0], n: 0, msg: 'lint failed: ' + e.message }]; } }
    }
    if (opts.grid !== false) {
      let [x0, y0, x1, y1] = opts.bbox || [0, 0, W - 1, H - 1];
      x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0); x1 = Math.min(W - 1, x1 | 0); y1 = Math.min(H - 1, y1 | 0);
      const step = Math.max(1, (opts.step | 0) || Math.max(Math.ceil((x1 - x0 + 1) / 120), Math.ceil((y1 - y0 + 1) / 80)));
      const hex = !!(g && g.grid && g.grid.kind === 'hex'), rows = [], rv = opts.overlay === 'rivers' ? riverTileSet(rivers) : null;   // overlay 'rivers': '=' on every tile a river edge touches (its north or west side)
      for (let y = y0; y <= y1; y += step) {
        let s = (hex && step === 1 && api().hexShiftX(y, H)) ? ' ' : '';   // hex: the half-tile-east rows lean right, as on screen
        for (let x = x0; x <= x1; x += step) { const t = tiles[y][x]; s += rv && rv.has(x + ',' + y) ? '=' : t ? String(F.ascii(t) || '?')[0] : ' '; }
        rows.push({ y, s });
      }
      res.grid = { x0, y0, x1, y1, step, rows, overlay: rv ? 'rivers' : null };
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
    const a = api(), ev = a.evaluate(), st = a.state();
    return report(ev.tiles, ev.W, ev.H, ev.rivers, T.game, opts, { kind: 'frame', game: st.game, hex: st.hex, bounds: st.bounds, rot: st.view.rot, mode: st.mode, pending: st.pending });
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
    const a = api(), g = T.games[s.game] || T.game;
    return report(a.tiles2D(s), s.W, s.H, s.rivers, g, opts, { kind: 'snapshot', id: s.id, name: s.name, game: s.game, hex: !!s.hex, topLat: s.topLat, botLat: s.botLat, connectors: s.connectors || null, catalog: s.catalog || null });
  }
  function snapConnectors(s) { const a = api(), g = T.games[s.game] || T.game; try { return T.landforms ? T.landforms.connectors(a.tiles2D(s), s.W, s.H, lfCtx(g, s.rivers, null, s.H)) : null; } catch (e) { return null; } }
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
    const a = api(), C = a.compose.composite(), c = a.compose.state(), st = a.state();
    return report(C.tiles, C.W, C.H, C.rivers, T.game, opts, { kind: 'compose', game: st.game, hex: st.hex, erased: c.erased.size, latitudes: c.latTop != null ? { top: c.latTop, bottom: c.latBot } : null,
      patches: c.patches.map(p => ({ id: p.id, snapshot: p.snap.id, name: p.snap.name, x: p.x, y: p.y, W: p.snap.W, H: p.snap.H, landOnly: !!p.landOnly, foreign: p.snap.game !== st.game ? p.snap.game : null })) }, ownerMap(), composeLat());
  }
  const flatten = t2 => { const out = []; for (const row of t2) for (const t of row) out.push(t); return out; };
  function patchForSnapshot(s) { const ps = api().compose.state().patches.filter(p => p.snap && p.snap.id === s.id); return ps.length ? ps[ps.length - 1] : null; }
  const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
  function patchOf(ref) { const p = api().compose.patchById(ref | 0); if (!p) throw new Error('no patch ' + ref + ' on the canvas'); return p; }
  async function patchOp(args, fn) { const a = api(); a.setMode('compose'); const p = patchOf(args.patch); fn(a, p); a.render(); return composeReport(args); }
  const blobToBase64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(b); });

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
    async frame_view(args) { const a = api(); if (a.state().mode === 'compose') a.setMode('civ'); await settle(); return frameReport(args); },
    async snapshot(args) {
      const a = api(); if (a.state().mode === 'compose') a.setMode('civ');
      const prev = a.getWorldSelection(); let sel = null;
      if (args.lasso) { if (args.lasso.length < 3) throw new Error('lasso needs at least 3 [lon,lat] points'); sel = { kind: 'lasso', pts: args.lasso.map(llToPx) }; }
      else if (args.rect) { const [W0, S, E0, N] = args.rect.map(Number); sel = { kind: 'rect', pts: [llToPx([W0, N]), llToPx([E0, S])], frame: true }; }
      if (sel) a.setWorldSelection(sel);
      await settle();
      let snap; try { snap = a.capture(args.name); } finally { if (sel) a.setWorldSelection(prev); }
      snap.connectors = snapConnectors(snap); if (args.catalog) snap.catalog = args.catalog; if (args.tags) snap.tags = args.tags;
      try { await a.shelf.save(snap); } catch (e) { console.warn('[bridge] shelf save failed (snapshot kept in memory):', e); }
      return Object.assign(snapReport(snap, args), { masked: !!(sel || prev) });
    },
    async capture_region(args) { await CMDS.set_frame(Object.assign({}, args, { grid: false, landforms: false })); return CMDS.snapshot(args); },   // frame + capture in one: what snapshot_from_catalog uses
    async describe(args) {
      const a = api(), tgt = args.target || (a.state().mode === 'compose' ? 'compose' : 'frame');
      let tiles, W, H, rivers, g, owner = null, head;
      const latOfRow = tgt === 'compose' ? composeLat() : null;
      if (tgt === 'compose') { const C = a.compose.composite(); tiles = C.tiles; W = C.W; H = C.H; rivers = C.rivers; g = T.game; owner = ownerMap(); head = { kind: 'compose' }; }
      else if (tgt === 'frame') { if (a.state().mode === 'compose') a.setMode('civ'); await settle(); const ev = a.evaluate(); tiles = ev.tiles; W = ev.W; H = ev.H; rivers = ev.rivers; g = T.game; head = { kind: 'frame', bounds: a.state().bounds }; }
      else { const s = findSnapshot(tgt); tiles = a.tiles2D(s); W = s.W; H = s.H; rivers = s.rivers; g = T.games[s.game] || T.game; head = { kind: 'snapshot', id: s.id, name: s.name, connectors: s.connectors || null }; }
      const ctx = lfCtx(g, rivers, owner, H, latOfRow), D = T.landforms.describe(tiles, W, H, ctx, { full: true });
      return Object.assign(head, { W, H }, D, owner ? { warnings: T.landforms.lint(tiles, W, H, ctx) } : {});
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
      for (const [k, v] of s.rivers.nof) { const p = k.split(','); let gy = +p[0], gx = +p[1], dir = v.dir; if (fx) { gx = W - 1 - gx; dir = dir === 1 ? 3 : dir === 3 ? 1 : dir; } if (fy) gy = H - gy; if (gy >= 0 && gy < H && gx >= 0 && gx < W) nof.push([gy + ',' + gx, Object.assign({}, v, { dir })]); }
      for (const [k, v] of s.rivers.wof) { const p = k.split(','); let gy = +p[0], gx = +p[1], dir = v.dir; if (fy) { gy = H - 1 - gy; dir = dir === 0 ? 2 : dir === 2 ? 0 : dir; } if (fx) gx = W - gx; if (gy >= 0 && gy < H && gx >= 0 && gx < W) wof.push([gy + ',' + gx, Object.assign({}, v, { dir })]); }
      const snap = Object.assign({}, s, { id: a.newId(), name: args.name || (s.name + (ax === 'xy' ? ' (rotated 180)' : ax === 'x' ? ' (mirrored E-W)' : ' (mirrored N-S)')), tiles, rivers: { nof, wof }, createdAt: Date.now(), flipped: ax, thumb: null });
      snap.thumb = a.thumb(snap); snap.connectors = snapConnectors(snap);
      await a.shelf.save(snap);
      return Object.assign(snapReport(snap, args), { note: s.hex ? 'hex snapshot: mirroring N-S changes which rows lean east; check the coast after placing' : null });
    },
    /* thumbnail: the app's own tile renderer on the canvas / frame / a snapshot, as a PNG data URL */
    async thumbnail(args) {
      const a = api(), tgt = args.target || (a.state().mode === 'compose' ? 'compose' : 'frame'); let fake;
      if (tgt === 'compose') { const C = a.compose.composite(); fake = { W: C.W, H: C.H, hex: a.state().hex, tiles: flatten(C.tiles) }; }
      else if (tgt === 'frame') { if (a.state().mode === 'compose') a.setMode('civ'); await settle(); const ev = a.evaluate(); fake = { W: ev.W, H: ev.H, hex: ev.hex, tiles: flatten(ev.tiles) }; }
      else fake = findSnapshot(tgt);
      return { target: tgt, W: fake.W, H: fake.H, dataUrl: a.thumb(fake, Math.max(32, Math.min(2048, args.maxPx | 0 || 480))) };
    },
    /* attach: put B against A so that A's edgeA meets B's edgeB (opposite edges), centred along the seam. A is its
       existing patch, or is placed at the canvas centre first. overlap pulls B that many tiles into A; shift slides
       it along the seam. Expands into place/move; the report carries the seam lint. */
    async attach(args) {
      const a = api(); a.setMode('compose');
      const A = findSnapshot(args.a), B = findSnapshot(args.b), eA = String(args.edgeA || 'E').toUpperCase(), eB = String(args.edgeB || OPP[eA]).toUpperCase();
      if (!OPP[eA] || OPP[eA] !== eB) throw new Error('edges must be opposite sides (A ' + eA + ' needs B ' + OPP[eA] + ')');
      const c = a.compose.state(); let pa = patchForSnapshot(A);
      if (!pa) pa = a.compose.add(A, Math.round((c.W - A.W) / 2), Math.round((c.H - A.H) / 2), args.landOnly !== false);
      const ov = args.overlap | 0, sh = args.shift | 0; let x, y;
      if (eA === 'E') { x = pa.x + A.W - ov; y = pa.y + Math.round((A.H - B.H) / 2) + sh; }
      else if (eA === 'W') { x = pa.x - B.W + ov; y = pa.y + Math.round((A.H - B.H) / 2) + sh; }
      else if (eA === 'S') { y = pa.y + A.H - ov; x = pa.x + Math.round((A.W - B.W) / 2) + sh; }
      else { y = pa.y - B.H + ov; x = pa.x + Math.round((A.W - B.W) / 2) + sh; }
      /* seam cost at the requested position, and the best shift along the seam within ±8 (applied only with autoShift) */
      const along = (eA === 'E' || eA === 'W') ? 'y' : 'x', cost = seamCost(A, pa.x, pa.y, B, x, y, eA); let best = { shift: sh, cost: cost.cost };
      for (let d = -8; d <= 8; d++) { const c = seamCost(A, pa.x, pa.y, B, along === 'y' ? x : x + d, along === 'y' ? y + d : y, eA); if (c.tiles && c.cost < best.cost) best = { shift: sh + d, cost: c.cost }; }
      if (args.autoShift && best.shift !== sh) { if (along === 'y') y += best.shift - sh; else x += best.shift - sh; }
      let pb = patchForSnapshot(B); if (pb) a.compose.move(pb.id, x, y); else pb = a.compose.add(B, x, y, args.landOnly !== false);
      a.render();
      return Object.assign(composeReport(args), { attached: { a: pa.id, b: pb.id, x: pb.x, y: pb.y, seam: eA + '/' + eB, connectorA: A.connectors ? A.connectors[eA] : null, connectorB: B.connectors ? B.connectors[eB] : null, seamCost: args.autoShift && best.shift !== sh ? seamCost(A, pa.x, pa.y, B, x, y, eA) : cost, bestShift: best } });
    },
    /* scatter: stamp snapshots (cycling the list) centred on points every `spacing` tiles along the polyline `along` */
    async scatter(args) {
      const a = api(); a.setMode('compose');
      const snaps = (args.snapshots || []).map(findSnapshot); if (!snaps.length) throw new Error('snapshots: list of snapshot ids or names required');
      const pts = args.along || []; if (pts.length < 1) throw new Error('along: [[x,y],...] polyline required');
      const spacing = Math.max(1, +args.spacing || 8), placed = [], samples = [];
      if (pts.length === 1) samples.push(pts[0]);
      else { let carry = 0; for (let i = 0; i + 1 < pts.length; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], L = Math.hypot(x1 - x0, y1 - y0); let d = carry; if (i === 0) samples.push([x0, y0]); while (d + spacing <= L + 1e-9) { d += spacing; samples.push([x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L]); } carry = d - L; } }
      /* centre each stamp on its LAND (bbox centre), not on its rectangle: an atoll capture is mostly sea around a few tiles */
      const landCentre = s => { const g = T.games[s.game] || T.game, F = glyphFns(g); let x0 = s.W, y0 = s.H, x1 = -1, y1 = -1; for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) { const t = s.tiles[y * s.W + x]; if (t && !F.isWater(t)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return x1 < 0 ? [s.W / 2, s.H / 2] : [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2]; };
      samples.forEach((pt, i) => { const s = snaps[(i + (args.start | 0)) % snaps.length], c = landCentre(s); const p = a.compose.add(s, Math.round(pt[0] - c[0]), Math.round(pt[1] - c[1]), args.landOnly !== false); placed.push({ patch: p.id, snapshot: s.name, x: p.x, y: p.y }); });
      a.render();
      return Object.assign(composeReport(args), { scattered: placed });
    },
    async list_snapshots() { return { snapshots: api().shelf.list().map(snapSummary) }; },
    async snapshot_info(args) { return snapReport(findSnapshot(args.id), args); },
    async delete_snapshot(args) { const s = findSnapshot(args.id); await api().shelf.remove(s.id); return { deleted: s.id, snapshots: api().shelf.list().map(snapSummary) }; },
    async compose_new(args) {
      const a = api(); a.setMode('compose');
      if (args.fill) a.setFill(args.fill);
      if (args.clear !== false) a.compose.clear();
      if (args.latitudes !== undefined) { const L = args.latitudes; a.compose.setLatitudes(L ? L.top : null, L ? L.bottom : null); }   // {top,bottom} degrees for row 0 / row H: a virtual span for the export header and the latitude lint; null clears it
      const c = a.compose.state(); if (args.W != null || args.H != null) a.compose.setSize(args.W != null ? args.W : c.W, args.H != null ? args.H : c.H);
      a.render(); return composeReport(args);
    },
    async place(args) {
      const a = api(); a.setMode('compose'); const s = findSnapshot(args.snapshot);
      const p = a.compose.add(s, args.x | 0, args.y | 0, args.landOnly !== false); a.render();
      return Object.assign(composeReport(args), { placed: { patch: p.id, x: p.x, y: p.y, landOnly: !!p.landOnly } });
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
      const a = api(); a.setMode('compose'); const r = args.rect; if (!r || r.length !== 4) throw new Error('rect [x0,y0,x1,y1] (inclusive tile coords) required');
      const n = a.compose.eraseRect(Math.min(r[0], r[2]) | 0, Math.min(r[1], r[3]) | 0, Math.max(r[0], r[2]) | 0, Math.max(r[1], r[3]) | 0); a.render();
      return Object.assign(composeReport(args), { erasedNow: n });
    },
    async unerase(args) { const a = api(); a.setMode('compose'); a.compose.unerase(); a.render(); return composeReport(args); },
    async compose_view(args) { const a = api(); a.setMode('compose'); a.render(); return composeReport(args); },
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
