#!/usr/bin/env node
/* mcp/server.mjs -- Terra Form MCP server.
 *
 * A stdio MCP server (for Claude Code, Claude Desktop, or any MCP client) that drives the RUNNING Terra Form
 * page. It does no map work itself: it listens on a local WebSocket (ws://127.0.0.1:8765/terraform), the page's
 * core/bridge.js connects to it, and every tool call is forwarded to the page as {id, cmd, args} and answered
 * with the page's reply. Replies are rendered here as a compact text block (stats + optional glyph grid) so an
 * agent can iterate on a map with little bandwidth. See README.md for the tool list, the legend and an example.
 *
 * Only stderr is used for logging: stdout is the MCP transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = +(process.env.TERRAFORM_WS_PORT || 8765);
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = +(process.env.TERRAFORM_CALL_TIMEOUT_MS || 180000);
const log = (...a) => console.error('[terra-form-mcp]', ...a);

/* ---------- the WebSocket side: one page at a time ---------- */
let page = null, pageInfo = null, seq = 0;
const pending = new Map();   // id -> {resolve, reject, timer}
const wss = new WebSocketServer({
  host: HOST, port: PORT, path: '/terraform',
  verifyClient: ({ origin }) => !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)   // the app served locally, or TerraForm.exe (file://)
});
wss.on('listening', () => log(`listening on ws://${HOST}:${PORT}/terraform — open the Terra Form app and it will connect`));
wss.on('error', e => { log('WebSocket server error:', e.message); if (e.code === 'EADDRINUSE') { log(`port ${PORT} is busy: is another terra-form-mcp running? Set TERRAFORM_WS_PORT=<port> for this server and open the app as http://localhost:8000/?mcp=<port>`); process.exit(1); } });
wss.on('connection', (ws, req) => {
  if (page && page !== ws) { log('a second page connected; the previous one is dropped'); try { page.close(); } catch (e) {} }
  page = ws; pageInfo = null;
  log('page connected from', req.socket.remoteAddress);
  ws.on('message', data => {
    let m; try { m = JSON.parse(String(data)); } catch (e) { return; }
    if (m.hello) { pageInfo = m.hello; log('page says hello:', JSON.stringify(m.hello)); return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'the page reported an error'));
  });
  ws.on('close', () => {
    if (page === ws) { page = null; pageInfo = null; log('page disconnected'); }
    for (const [id, p] of pending) { if (p.ws === ws) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('the page disconnected while the command was running')); } }
  });
  ws.on('error', e => log('page socket error:', e.message));
});

const NO_PAGE = `No Terra Form page is connected. Open the app — run "python serve.py" in the project folder and open http://localhost:8000/ (or start TerraForm.exe) — and leave it open; it connects to ws://${HOST}:${PORT} by itself (a green "MCP connected" badge appears bottom-right). Then retry.`;
function call(cmd, args) {
  if (!page || page.readyState !== 1) return Promise.reject(new Error(NO_PAGE));
  const id = ++seq, ws = page;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the page did not answer "${cmd}" within ${CALL_TIMEOUT_MS / 1000}s`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, ws });
    ws.send(JSON.stringify({ id, cmd, args }));
  });
}

/* ---------- rendering a page reply as the feedback block ---------- */
const f1 = v => (Math.round(v * 100) / 100).toString();
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
function fmtGrid(g) {
  const L = [];
  L.push(`grid step ${g.step}: x ${g.x0}..${g.x1}, y ${g.y0}..${g.y1} (row 0 = north, col 0 = west; ruler = x of every 10th column)`);
  const cols = Math.floor((g.x1 - g.x0) / g.step) + 1, ruler = new Array(cols).fill(' ');
  for (let i = 0; i < cols; i++) { const x = g.x0 + i * g.step; if (x % 10 === 0) { const s = String(x); for (let k = 0; k < s.length && i + k < cols; k++) ruler[i + k] = s[k]; } }
  L.push('    ' + ruler.join(''));
  for (const r of g.rows) L.push(String(r.y).padStart(3, ' ') + '|' + r.s);
  return L;
}
function fmtReport(r) {
  const L = [];
  if (r.kind === 'frame') L.push(`frame ${r.W}x${r.H} ${r.game}${r.hex ? ' (hex)' : ''} | bounds W ${f1(r.bounds.W)} S ${f1(r.bounds.S)} E ${f1(r.bounds.E)} N ${f1(r.bounds.N)}${r.rot ? ` | rot ${f1(r.rot)}°` : ''}${r.pending ? ` | ${r.pending} tile loads still pending` : ''}`);
  else if (r.kind === 'compose') L.push(`compose canvas ${r.W}x${r.H} ${r.game}${r.hex ? ' (hex)' : ''} | ${r.patches.length} patch${r.patches.length === 1 ? '' : 'es'} | ${r.erased} erased tile${r.erased === 1 ? '' : 's'}${r.latitudes ? ` | latitudes ${f1(r.latitudes.top)}..${f1(r.latitudes.bottom)}` : ''}`);
  else if (r.kind === 'snapshot') L.push(`snapshot ${r.id} "${r.name}" ${r.W}x${r.H} ${r.game}${r.hex ? ' (hex)' : ''} | lat ${f1(r.botLat)}..${f1(r.topLat)}`);
  const tot = r.W * r.H, rl = r.relief.labels, rc = r.relief.counts;
  L.push(`land ${r.land} (${pct(r.land, tot)}%)  water ${r.water} | ${rl[1]} ${rc[1]}  ${rl[2]} ${rc[2]} | river edges ${r.riverEdges}`);
  L.push('terrain: ' + r.classes.map(c => `${c.ch}=${c.label} ${c.n}`).join('  '));
  if (r.landmasses) {
    const lm = r.landmasses, more = lm.count - lm.top.length;
    L.push(`landmasses ${lm.count}` + (lm.top.length ? ': ' + lm.top.map((m, i) => `#${i + 1} ${m.size}t x${m.bbox[0]}-${m.bbox[2]} y${m.bbox[1]}-${m.bbox[3]}`).join('; ') : '') + (more > 0 ? ` (+${more} smaller)` : ''));
  }
  if (r.patches) L.push(r.patches.length ? 'patches (bottom to top): ' + r.patches.map(p => `[${p.id}] "${p.name}" ${p.W}x${p.H} @${p.x},${p.y}${p.landOnly ? '' : ' full-rect'}${p.foreign ? ' ⚠' + p.foreign : ''}`).join('; ') : 'patches: none');
  if (r.landforms) L.push('landforms: ' + r.landforms);
  if (r.connectors) L.push('edges: ' + ['N', 'E', 'S', 'W'].map(k => `${k} ${r.connectors[k] ? r.connectors[k].label : '?'}`).join(' | '));
  if (r.warnings) L.push(r.warnings.length ? `warnings (${r.warnings.length}): ` + r.warnings.slice(0, 8).map(w => `[${w.rule}] ${w.msg}`).join(' ; ') + (r.warnings.length > 8 ? ` ; +${r.warnings.length - 8} more` : '') : 'warnings: none');
  if (r.placed) L.push(`placed patch ${r.placed.patch} at ${r.placed.x},${r.placed.y}${r.placed.landOnly ? ' (land only)' : ' (full rectangle)'}`);
  if (r.attached) { const t = r.attached; L.push(`attached patch ${t.b} to patch ${t.a} along ${t.seam} at ${t.x},${t.y}` + (t.connectorA ? ` (A ${t.connectorA.label} meets B ${t.connectorB ? t.connectorB.label : '?'})` : '') + (t.seamCost ? ` | seam cost ${t.seamCost.cost} over ${t.seamCost.tiles} tiles (water ${t.seamCost.water}, climate ${t.seamCost.climate}, relief ${t.seamCost.relief})` : '') + (t.bestShift ? ` | best shift ${t.bestShift.shift} (cost ${t.bestShift.cost})` : '')); }
  if (r.connectors && r.connectors.corners) L.push('corners: ' + ['NW', 'NE', 'SE', 'SW'].map(k => `${k} ${r.connectors.corners[k]}`).join(' | '));
  if (r.scattered) L.push(`scattered ${r.scattered.length}: ` + r.scattered.map(p => `[${p.patch}] ${p.snapshot} @${p.x},${p.y}`).join('; '));
  if (r.erasedNow != null) L.push(`erased now: ${r.erasedNow} tiles`);
  if (r.params) L.push('params: ' + Object.entries(r.params).map(([k, v]) => `${k}=${typeof v === 'number' ? f1(v) : v}`).join(' '));
  if (r.gameParams) L.push('game params: ' + Object.entries(r.gameParams).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${typeof v === 'number' ? f1(v) : v}`).join(' '));
  if (r.grid) L.push(...fmtGrid(r.grid));
  return L.join('\n');
}
function fmtStatus(s) {
  const kv = o => Object.entries(o || {}).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${typeof v === 'number' ? f1(v) : v}`).join(' ');
  const g = s.grids || {};
  return [
    `game ${s.game}${s.hex ? ' (hex)' : ''} | mode ${s.mode} | frame ${s.W}x${s.H} | bounds W ${f1(s.bounds.W)} S ${f1(s.bounds.S)} E ${f1(s.bounds.E)} N ${f1(s.bounds.N)}${s.view.rot ? ` rot ${f1(s.view.rot)}°` : ''}`,
    `compose canvas ${s.compose.W}x${s.compose.H}: ${s.compose.patches} patches, ${s.compose.erased} erased | shelf ${s.shelf} snapshot(s) | fill ${s.fill} | mask ${s.selection || 'none'}${s.pending ? ` | ${s.pending} tile loads pending` : ''}`,
    'games: ' + Object.keys(g).map(id => `${id} (${g[id].kind} ${g[id].min.W}x${g[id].min.H}..${g[id].max.W}x${g[id].max.H}${g[id].step > 1 ? ' step ' + g[id].step : ''})`).join(', '),
    'params: ' + kv(s.params),
    'game params: ' + kv(s.gameParams),
    'legend: ' + Object.entries(s.legend || {}).map(([k, v]) => `${k} ${v}`).join('  ') + ` | relief: ${(s.reliefLabels || []).join(' / ')}`
  ].join('\n');
}
const text = s => ({ content: [{ type: 'text', text: s }] });
const asError = e => ({ isError: true, content: [{ type: 'text', text: 'Error: ' + (e && e.message || e) }] });
const run = fn => async args => { try { return await fn(args || {}); } catch (e) { return asError(e); } };
const report = (cmd, extra) => run(async args => text(fmtReport(await call(cmd, Object.assign({}, args, extra || {})))));

/* ---------- tools ---------- */
const server = new McpServer({ name: 'terra-form', version: '0.1.0' }, { instructions:
`Drives the Terra Form app (real-world terrain -> game maps) that is open in a browser. Typical loop: set_game, set_frame (a lon/lat box on the Earth), read the stats + glyph grid, tune, snapshot (optionally cropped by a lasso), repeat for other regions, then compose_new / place / move_patch to splice the snapshots onto one canvas, compose_view to check it, export to write the map file. Tile coordinates are x east, y south, row 0 = north. The app must be open (python serve.py -> http://localhost:8000/, or TerraForm.exe).` });

const viewOpts = {
  grid: z.boolean().optional().describe('include the glyph grid (default true)'),
  bbox: z.array(z.number()).length(4).optional().describe('crop the grid to tile rect [x0,y0,x1,y1], inclusive'),
  step: z.number().int().min(1).optional().describe('subsample: one glyph per step tiles (default: auto, keeps the grid within ~120x80)'),
  overlay: z.enum(['rivers']).optional().describe("'rivers': print '=' on every tile a river edge touches, over the terrain glyph")
};
const LEGEND = `Glyph legend (one char per tile, row 0 = north). Civ4/Civ5: ~ ocean  , coast  g grass  p plains  d desert  t tundra  s snow  f forest  j jungle  r flood plains  o oasis  ^ peak; an UPPERCASE letter is that terrain on hills. OpenFront: ~ water, digits 0-9 plains magnitude, a-j highland 10-19, A-K mountain 20-30. Other games: ~ water . flat n hills ^ peak.`;

server.registerTool('status', { title: 'Status', description: 'Current app state: game, mode, frame size and bounds, compose canvas, shelf count, all tunable parameters (core and game-module) and the glyph legend of the active game. Also the cheapest way to check the page is connected.' },
  run(async () => text(fmtStatus(await call('status')))));

server.registerTool('set_game', { title: 'Set game', description: 'Select the game module (civ4, civ5 (hex), openfront, culture_wars). Changes the lattice, grid limits and classifier; the frame is re-evaluated.', inputSchema: { id: z.string() } },
  run(async a => text(fmtStatus(await call('set_game', a)))));

server.registerTool('set_frame', { title: 'Set frame', description: `Frame a region of the Earth on the output grid and return the feedback block (stats + glyph grid). Give bounds [W,S,E,N] in degrees (the frame keeps the grid's W:H aspect, so it covers the box and may extend beyond it on one axis; the block reports the actual bounds), or center [lon,lat] with spanX (frame width in degrees). W/H set the output grid (snapped to the game's limits); rot rotates the frame (degrees, clockwise). Switches the page to the Civ preview. ${LEGEND}`,
  inputSchema: { bounds: z.array(z.number()).length(4).optional(), center: z.array(z.number()).length(2).optional(), spanX: z.number().optional(), W: z.number().int().optional(), H: z.number().int().optional(), rot: z.number().optional(), game: z.string().optional().describe('switch game first'), ...viewOpts } },
  report('set_frame'));

server.registerTool('tune', { title: 'Tune parameters', description: `Set slider parameters by name and return the feedback block for the current frame. Core: islandBias seawayBias islandExpand expandSteep expandMaxMult roughHalo mtnPass flatSpots coastThr nudgeX nudgeY riverN riverEstuaries(bool) hill peak blendHill blendPeak fill('water'|'barrier'). Game-module controls go by their control id (Civ4: alpine clim fpAmt forestDens jungleDens oasisDens fpKoppen(bool) feat(bool) np; OpenFront: ofPlains ofHighland ofMountain ofDesert(bool) ofDesertMag ofName). Values are clamped to the slider's range. status shows the current values. Call with an empty params object to just read them.`,
  inputSchema: { params: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}), reset: z.boolean().optional().describe('first put every control back to its default (settings persist on the page between sessions and agents)'), report: z.boolean().optional().describe('false: return only the parameter values'), ...viewOpts } },
  run(async a => { const r = await call('tune', a); return text(a.report === false ? JSON.stringify(r, null, 1) : fmtReport(r)); }));

server.registerTool('frame_view', { title: 'View frame', description: `The feedback block for the current frame without changing anything (re-evaluates it). ${LEGEND}`, inputSchema: viewOpts }, report('frame_view'));

server.registerTool('snapshot', { title: 'Capture snapshot', description: 'Capture the current frame as a snapshot on the shelf and return its id plus its feedback block. lasso: a lon/lat polygon [[lon,lat],...] — the capture is cropped to its tile bounding box and tiles outside the shape become the default fill (water, or mountain when fill=barrier); rect: a lon/lat box [W,S,E,N] doing the same. Without either, a mask drawn in the app applies if there is one, else the whole frame. The lasso is applied for this capture only.',
  inputSchema: { name: z.string().optional(), lasso: z.array(z.array(z.number()).length(2)).optional(), rect: z.array(z.number()).length(4).optional(), ...viewOpts } },
  report('snapshot'));

server.registerTool('list_snapshots', { title: 'List snapshots', description: 'The shelf: id, name, size, game, centre lon/lat of every captured snapshot.' },
  run(async () => { const r = await call('list_snapshots'); return text(r.snapshots.length ? r.snapshots.map(s => `${s.id}  "${s.name}"  ${s.W}x${s.H} ${s.game}${s.hex ? ' hex' : ''}  centre ${s.center[0]},${s.center[1]}`).join('\n') : 'shelf is empty'); }));

server.registerTool('snapshot_info', { title: 'Snapshot info', description: `Feedback block (stats + glyph grid) of one snapshot, by id or exact name. ${LEGEND}`, inputSchema: { id: z.string(), ...viewOpts } }, report('snapshot_info'));

server.registerTool('delete_snapshot', { title: 'Delete snapshot', description: 'Remove a snapshot from the shelf (patches placed from it stay on the canvas until the page reloads).', inputSchema: { id: z.string() } },
  run(async a => text(JSON.stringify(await call('delete_snapshot', a), null, 1))));

server.registerTool('compose_new', { title: 'New compose canvas', description: 'Switch to Compose, clear the canvas (unless clear=false) and size it W x H tiles (snapped to the game grid limits). fill: what empty canvas and erased tiles are — water (default) or barrier (impassable mountain). Returns the feedback block for the (empty) canvas.',
  inputSchema: { W: z.number().int().optional(), H: z.number().int().optional(), fill: z.enum(['water', 'barrier']).optional(), clear: z.boolean().optional(),
    latitudes: z.object({ top: z.number(), bottom: z.number() }).nullable().optional().describe('declared virtual latitudes of row 0 and the bottom edge (e.g. {top:80,bottom:-80}); written to the export header and used by the latitude-mismatch lint; null clears'), ...viewOpts } },
  report('compose_new'));

server.registerTool('flip_snapshot', { title: 'Flip snapshot', description: "Make a mirrored copy of a snapshot on the shelf: axis 'x' mirrors east-west, 'y' north-south, 'xy' rotates 180°. Tiles, river edges and their flow directions are flipped together. Use it to disguise recognisable real pieces (Italy, Florida). Returns the new snapshot's block. (A rotated capture is set_frame/snapshot_from_catalog with rot.)",
  inputSchema: { id: z.string(), axis: z.enum(['x', 'y', 'xy']).optional(), name: z.string().optional(), ...viewOpts } },
  report('flip_snapshot'));

server.registerTool('thumbnail', { title: 'Thumbnail', description: 'Render the compose canvas, the current frame, or a snapshot with the app\'s own tile renderer and write it as a PNG to `path` (long edge maxPx, default 480).',
  inputSchema: { target: z.string().optional(), path: z.string(), maxPx: z.number().int().optional() } },
  run(async a => { const r = await call('thumbnail', a); const b64 = String(r.dataUrl).split(',')[1]; await fs.mkdir(path.dirname(path.resolve(a.path)), { recursive: true }); await fs.writeFile(path.resolve(a.path), Buffer.from(b64, 'base64')); return text(`wrote ${path.resolve(a.path)} (${r.target} ${r.W}x${r.H})`); }));

server.registerTool('place', { title: 'Place snapshot', description: 'Stamp a snapshot (by id or exact name) on the compose canvas with its top-left tile at x,y (may be negative or run off the canvas; the overhang is clipped). landOnly (default true) stamps only its land tiles, so coastlines can be nudged together; false stamps the whole rectangle including its sea. Later patches draw over earlier ones. Returns the new patch id and the canvas feedback block.',
  inputSchema: { snapshot: z.string(), x: z.number().int(), y: z.number().int(), landOnly: z.boolean().optional(), ...viewOpts } },
  report('place'));

server.registerTool('move_patch', { title: 'Move patch', description: 'Move a patch to absolute x,y, or by dx,dy. Hex games snap y to even rows.', inputSchema: { patch: z.number().int(), x: z.number().int().optional(), y: z.number().int().optional(), dx: z.number().int().optional(), dy: z.number().int().optional(), ...viewOpts } }, report('move_patch'));
server.registerTool('remove_patch', { title: 'Remove patch', description: 'Take a patch off the canvas.', inputSchema: { patch: z.number().int(), ...viewOpts } }, report('remove_patch'));
server.registerTool('raise_patch', { title: 'Raise patch', description: 'Move a patch one step up the z-order (drawn over the next one).', inputSchema: { patch: z.number().int(), ...viewOpts } }, report('raise_patch'));
server.registerTool('lower_patch', { title: 'Lower patch', description: 'Move a patch one step down the z-order.', inputSchema: { patch: z.number().int(), ...viewOpts } }, report('lower_patch'));
server.registerTool('set_land_only', { title: 'Set land-only', description: 'Toggle whether a patch stamps only its land (true) or its full rectangle including sea (false).', inputSchema: { patch: z.number().int(), landOnly: z.boolean(), ...viewOpts } }, report('set_land_only'));

server.registerTool('erase', { title: 'Erase', description: 'Fill a tile rectangle [x0,y0,x1,y1] (inclusive) of the compose canvas with the default fill (water, or mountain if fill=barrier) and drop the river edges there. Erasures are holes in the finished collage: they stay put when patches move. unerase clears all of them.', inputSchema: { rect: z.array(z.number().int()).length(4), ...viewOpts } }, report('erase'));
server.registerTool('unerase', { title: 'Unerase', description: 'Remove every erasure from the compose canvas.', inputSchema: viewOpts }, report('unerase'));

server.registerTool('compose_view', { title: 'View compose canvas', description: `Feedback block (stats + glyph grid) of the composed canvas as it will export: patches stamped in order, erasures applied, coast ring and river edges re-derived. ${LEGEND}`, inputSchema: viewOpts }, report('compose_view'));
server.registerTool('compose_stats', { title: 'Compose stats', description: 'Stats only (no grid) for the compose canvas: land/water, terrain counts, landmasses, patches.', inputSchema: {} }, report('compose_stats', { grid: false }));

server.registerTool('export', { title: 'Export', description: 'Build the map with the active game module (the compose canvas when the page is in Compose, else the framed region) and write it. name: the file base name (the game adds its extension). Without dir the APP writes it where it would on Generate (the folder chosen in the app, else a browser download; a Save As dialog cannot open without a click, so choose a folder in the app first or pass dir). With dir the files are sent to this server and written into that directory (created if missing; OpenFront\'s image.png + info.json go in a subfolder named after the map). Returns the validation rows and where the files went.',
  inputSchema: { name: z.string().optional(), dir: z.string().optional() } },
  run(async a => {
    const r = await call('export', { name: a.name, transfer: !!a.dir });
    const L = [`export ${r.mode} ${r.game} ${r.W}x${r.H}`];
    if (a.dir) {
      const base = path.resolve(a.dir, r.dir || ''); await fs.mkdir(base, { recursive: true });
      for (const f of r.files) { const p = path.join(base, f.name); await fs.writeFile(p, f.encoding === 'base64' ? Buffer.from(f.data, 'base64') : f.data); L.push(`wrote ${p} (${f.size} bytes)`); }
    } else { L.push('files: ' + r.files.map(f => `${f.name} (${f.size} bytes)`).join(', ')); L.push('app says: ' + (r.dest || '(no destination hint)')); }
    for (const v of r.validation) L.push(`${v.ok ? 'ok  ' : 'WARN'} ${v.label} · ${v.detail}`);
    if (r.note) L.push(r.note);
    return text(L.join('\n'));
  }));

/* ---------- landform layer: describe, catalog, composite operators ---------- */
const CATALOG_PATH = new URL('./landforms.json', import.meta.url);
let CATALOG = { entries: [] };
try { CATALOG = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8')); } catch (e) { log('catalog not loaded:', e.message); }
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function catalogFind(name) { const n = norm(name); return CATALOG.entries.find(e => norm(e.name) === n) || CATALOG.entries.find(e => norm(e.name).includes(n) || n.includes(norm(e.name))) || null; }
const fmtEntry = e => `${e.name} — bounds [${e.bounds.join(', ')}] size ${e.size[0]}x${e.size[1]} | ${e.tags.join(', ')} | ${e.climate}${e.lasso ? ' | lasso' : e.rect ? ' | rect crop' : ''}${e.params ? ' | params ' + JSON.stringify(e.params) : ''}\n    ${e.notes}`;

function fmtDescribe(D) {
  const L = [];
  L.push(D.kind === 'snapshot' ? `describe snapshot ${D.id} "${D.name}" ${D.W}x${D.H}` : D.kind === 'frame' ? `describe frame ${D.W}x${D.H} | bounds W ${f1(D.bounds.W)} S ${f1(D.bounds.S)} E ${f1(D.bounds.E)} N ${f1(D.bounds.N)}` : `describe compose canvas ${D.W}x${D.H}`);
  L.push(D.summary);
  if (D.connectors) L.push('edges: ' + ['N', 'E', 'S', 'W'].map(k => `${k} ${D.connectors[k] ? D.connectors[k].label : '?'}`).join(' | '));
  if (D.warnings) L.push(D.warnings.length ? `warnings (${D.warnings.length}): ` + D.warnings.map(w => `[${w.rule}] ${w.msg}`).join(' ; ') : 'warnings: none');
  const J = Object.assign({}, D); delete J.summary; delete J.kind;
  L.push(JSON.stringify(J));
  return L.join('\n');
}

server.registerTool('describe', { title: 'Describe landforms', description: 'Morphology of the compose canvas, the current frame, or a snapshot (by id or name), in landform vocabulary: landmasses (size, position, climate mix, hills/peaks), isthmuses (necks found by erosion, with width), straits (thin water between two landmasses, width in tiles), bays (convex-hull deficit) and peninsulas (morphological opening) with the direction they open or point, mountain spines (ridge components with orientation and length), river systems that reach water / leave the map / dead-end. Returns a paragraph, the seam warnings for a collage, and the full JSON. Coordinates are tile x,y (row 0 north).',
  inputSchema: { target: z.string().optional().describe("'compose' | 'frame' | a snapshot id or name (default: whatever the page shows)") } },
  run(async a => text(fmtDescribe(await call('describe', a)))));

server.registerTool('catalog_search', { title: 'Search the landform catalog', description: `Find real pieces to splice: entries of mcp/landforms.json matched by tag (peninsula, isthmus, strait, archipelago, atoll, delta, rift, mountain-spine, mountain-wall, rain-shadow, desert, fjords, volcanic, basin, inland-sea, ...) or free text over name/notes/climate. No arguments lists everything (${CATALOG.entries.length} entries).`,
  inputSchema: { tags: z.array(z.string()).optional(), text: z.string().optional(), climate: z.string().optional() } },
  run(async a => {
    const tags = (a.tags || []).map(norm), txt = norm(a.text), cl = norm(a.climate);
    const hits = CATALOG.entries.filter(e => (!tags.length || tags.some(t => e.tags.some(x => norm(x).includes(t)))) && (!txt || norm(e.name + ' ' + e.notes + ' ' + e.tags.join(' ') + ' ' + e.climate).includes(txt)) && (!cl || norm(e.climate).includes(cl)));
    return text(hits.length ? hits.map(fmtEntry).join('\n') : 'no catalog entry matches');
  }));

server.registerTool('snapshot_from_catalog', { title: 'Snapshot from catalog', description: 'Frame a catalog entry (its bounds, at its default size unless W/H are given), apply its lasso or rect crop, apply its suggested params (unless params:false) plus any params you pass, capture it to the shelf under its name (or `name`) and return the snapshot feedback block with its edge connectors. rot rotates the frame first (degrees); game switches game first.',
  inputSchema: { entry: z.string().describe('catalog entry name (case-insensitive, partial ok)'), name: z.string().optional(), W: z.number().int().optional(), H: z.number().int().optional(), rot: z.number().optional(), game: z.string().optional(), params: z.union([z.record(z.union([z.number(), z.boolean(), z.string()])), z.boolean()]).optional().describe('extra tune params, or false to skip the entry\'s own'),
    bounds: z.array(z.number()).length(4).optional().describe('override the entry\'s bounds [W,S,E,N] (its lasso/rect crop is then skipped)'), crop: z.boolean().optional().describe('false: capture the whole frame, ignoring the entry\'s lasso/rect'), ...viewOpts } },
  run(async a => {
    const e = catalogFind(a.entry); if (!e) throw new Error(`no catalog entry like "${a.entry}" (catalog_search lists them)`);
    const params = Object.assign({}, a.params === false ? {} : (e.params || {}), typeof a.params === 'object' ? a.params : {});
    if (Object.keys(params).length) await call('tune', { params, report: false });
    const crop = a.crop !== false && !a.bounds;
    const r = await call('capture_region', { bounds: a.bounds || e.bounds, W: a.W || e.size[0], H: a.H || e.size[1], rot: a.rot, game: a.game, lasso: crop ? e.lasso : undefined, rect: crop && !e.lasso ? e.rect : undefined, name: a.name || e.name, catalog: e.name, tags: e.tags, grid: a.grid, bbox: a.bbox, step: a.step, overlay: a.overlay });
    return text(fmtReport(r));
  }));

server.registerTool('attach', { title: 'Attach two snapshots', description: 'Composite operator: place snapshot B against snapshot A so that A\'s edge (N/E/S/W) meets B\'s opposite edge, centred along the seam. A keeps its patch if already placed, else it is placed at the canvas centre; B is moved if already placed, else placed. overlap pulls B that many tiles into A (land-only stamping lets coastlines interleave); shift slides B along the seam (+ = south or east). The block reports the seam lint and both edges\' connectors (snapshot_info shows connectors so you can pick matching edges: coast to coast, mountain wall to mountain wall).',
  inputSchema: { a: z.string(), edgeA: z.enum(['N', 'E', 'S', 'W']), b: z.string(), edgeB: z.enum(['N', 'E', 'S', 'W']).optional(), overlap: z.number().int().optional(), shift: z.number().int().optional(), landOnly: z.boolean().optional(),
    autoShift: z.boolean().optional().describe('slide B along the seam (within ±8) to the position with the lowest seam cost; the block reports the cost either way'), ...viewOpts } },
  report('attach'));

server.registerTool('catalog_index', { title: 'Index catalog connectors', description: 'Capture catalog entries (all, or the named ones) once to record their edge and corner connector labels in mcp/landforms.json, so catalog_lint and catalog_search can reason about which pieces fit together. Slow: a few seconds per entry.',
  inputSchema: { entries: z.array(z.string()).optional(), game: z.string().optional() } },
  run(async a => {
    const list = a.entries && a.entries.length ? a.entries.map(catalogFind).filter(Boolean) : CATALOG.entries; const done = [];
    if (a.game) await call('set_game', { id: a.game });
    for (const e of list) {
      if (e.params) await call('tune', { params: e.params, report: false });
      const r = await call('capture_region', { bounds: e.bounds, W: e.size[0], H: e.size[1], lasso: e.lasso, rect: e.lasso ? undefined : e.rect, name: e.name, catalog: e.name, grid: false, landforms: false });
      if (r.connectors) { e.connectors = { N: r.connectors.N.label, E: r.connectors.E.label, S: r.connectors.S.label, W: r.connectors.W.label, corners: r.connectors.corners || null }; done.push(`${e.name}: N ${e.connectors.N} | E ${e.connectors.E} | S ${e.connectors.S} | W ${e.connectors.W}`); }
      await call('delete_snapshot', { id: r.id }).catch(() => {});
    }
    await fs.writeFile(CATALOG_PATH, JSON.stringify(CATALOG, null, 1) + '\n');
    return text(`indexed ${done.length} entries\n` + done.join('\n'));
  }));

server.registerTool('catalog_lint', { title: 'Lint the catalog', description: 'Wang-tile view of the catalog (Cohen et al. 2003): count supply of each connector label per side across indexed entries and flag labels with no partner on the opposite side (a piece whose east edge is a mountain wall needs some piece whose west edge is one). Run catalog_index first for entries without connectors.',
  inputSchema: {} },
  run(async () => {
    const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' }, base = l => String(l).replace(' + river exit', ''), supply = {};
    const indexed = CATALOG.entries.filter(e => e.connectors);
    for (const e of indexed) for (const s of ['N', 'E', 'S', 'W']) { const b = base(e.connectors[s]); (supply[b] = supply[b] || { N: [], E: [], S: [], W: [] })[s].push(e.name); }
    const L = [`${indexed.length} of ${CATALOG.entries.length} entries indexed`];
    for (const [label, bySide] of Object.entries(supply).sort()) {
      L.push(`${label}: ` + ['N', 'E', 'S', 'W'].map(s => `${s} ${bySide[s].length}`).join('  '));
      for (const s of ['N', 'E', 'S', 'W']) if (bySide[s].length && !bySide[OPPOSITE[s]].length) L.push(`  no partner: ${bySide[s].length} piece(s) offer "${label}" on ${s} (${bySide[s].slice(0, 4).join(', ')}) but no piece offers it on ${OPPOSITE[s]}`);
    }
    return text(L.join('\n'));
  }));

server.registerTool('scatter', { title: 'Scatter snapshots along a line', description: 'Composite operator for island chains: stamp the listed snapshots (cycling through them, from index `start`) centred on points every `spacing` tiles along the polyline `along` ([[x,y],...] in canvas tiles, the first point included). Land-only stamping by default, so islets drop onto the ocean without their sea rectangles. The block reports landmass count and adjacency via the lint and landform lines.',
  inputSchema: { snapshots: z.array(z.string()), along: z.array(z.array(z.number()).length(2)), spacing: z.number().optional(), start: z.number().int().optional(), landOnly: z.boolean().optional(), ...viewOpts } },
  report('scatter'));

/* ---------- go ---------- */
const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP server ready on stdio');
process.stdin.on('end', () => { log('stdin closed; exiting'); wss.close(); process.exit(0); });
