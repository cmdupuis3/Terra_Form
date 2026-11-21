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
import type { WebSocket as PageSocket } from 'ws';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = +(process.env.TERRAFORM_WS_PORT || 8765);
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = +(process.env.TERRAFORM_CALL_TIMEOUT_MS || 180000);
const log = (...a: unknown[]) => console.error('[terra-form-mcp]', ...a);

/** The page's JSON reply to one bridge command; its shape is per command (core/bridge.ts CMDS). */
type PageReply = any;
/** A command sent to the page and not answered yet. */
type Pending = { resolve: (result: PageReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; ws: PageSocket };
/* ---------- the WebSocket side: one page at a time ---------- */
let page: PageSocket | null = null, pageInfo: BridgeHello['hello'] | null = null, seq = 0;
const pending = new Map<number, Pending>();   // id -> {resolve, reject, timer}
const wss = new WebSocketServer({
  host: HOST, port: PORT, path: '/terraform',
  verifyClient: ({ origin }: { origin: string }) => !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)   // the app served locally, or TerraForm.exe (file://)
});
wss.on('listening', () => log(`listening on ws://${HOST}:${PORT}/terraform — open the Terra Form app and it will connect`));
wss.on('error', e => { log('WebSocket server error:', e.message); if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') { log(`port ${PORT} is busy: is another terra-form-mcp running? Set TERRAFORM_WS_PORT=<port> for this server and open the app as http://localhost:8000/?mcp=<port>`); process.exit(1); } });
wss.on('connection', (ws, req) => {
  if (page && page !== ws) { log('a second page connected; the previous one is dropped'); try { page.close(); } catch (e) {} }
  page = ws; pageInfo = null;
  log('page connected from', req.socket.remoteAddress);
  ws.on('message', data => {
    let m: BridgeMessage; try { m = JSON.parse(String(data)); } catch (e) { return; }
    if (m.hello) { pageInfo = m.hello; log('page says hello:', JSON.stringify(m.hello)); return; }
    const p = pending.get(m.id!); if (!p) return;
    pending.delete(m.id!); clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'the page reported an error'));
  });
  ws.on('close', () => {
    if (page === ws) { page = null; pageInfo = null; log('page disconnected'); }
    for (const [id, p] of pending) { if (p.ws === ws) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('the page disconnected while the command was running')); } }
  });
  ws.on('error', e => log('page socket error:', e.message));
});

const NO_PAGE = `No Terra Form page is connected. Open the app — run "python serve.py" in the project folder and open http://localhost:8000/ (or start TerraForm.exe) — and leave it open; it connects to ws://${HOST}:${PORT} by itself (a green "MCP connected" badge appears bottom-right). Then retry.`;
function call(cmd: string, args?: Record<string, any>): Promise<PageReply> {
  if (!page || page.readyState !== 1) return Promise.reject(new Error(NO_PAGE));
  const id = ++seq, ws = page;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the page did not answer "${cmd}" within ${CALL_TIMEOUT_MS / 1000}s`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, ws });
    ws.send(JSON.stringify({ id, cmd, args } satisfies BridgeRequest));
  });
}

/* ---------- rendering a page reply as the feedback block ---------- */
const f1 = (v: number) => (Math.round(v * 100) / 100).toString();
const pct = (a: number, b: number) => b ? Math.round(a / b * 100) : 0;
function fmtGrid(g: PageReply): string[] {
  const L: string[] = [];
  L.push(`grid step ${g.step}: x ${g.x0}..${g.x1}, y ${g.y0}..${g.y1} (row 0 = north, col 0 = west; ruler = x of every 10th column)`);
  const cols = Math.floor((g.x1 - g.x0) / g.step) + 1, ruler = new Array(cols).fill(' ');
  for (let i = 0; i < cols; i++) { const x = g.x0 + i * g.step; if (x % 10 === 0) { const s = String(x); for (let k = 0; k < s.length && i + k < cols; k++) ruler[i + k] = s[k]; } }
  L.push('    ' + ruler.join(''));
  for (const r of g.rows) L.push(String(r.y).padStart(3, ' ') + '|' + r.s);
  return L;
}
function fmtReport(r: PageReply): string {
  const L = [];
  if (r.kind === 'frame') L.push(`frame ${r.W}x${r.H} ${r.game}${r.hex ? ' (hex)' : ''} | bounds W ${f1(r.bounds.W)} S ${f1(r.bounds.S)} E ${f1(r.bounds.E)} N ${f1(r.bounds.N)}${r.rot ? ` | rot ${f1(r.rot)}°` : ''}${r.pending ? ` | ${r.pending} tile loads still pending` : ''}`);
  else if (r.kind === 'compose') L.push(`compose canvas ${r.W}x${r.H} ${r.game}${r.hex ? ' (hex)' : ''} | ${r.patches.length} patch${r.patches.length === 1 ? '' : 'es'} | ${r.erased} erased tile${r.erased === 1 ? '' : 's'}${r.latitudes ? ` | latitudes ${f1(r.latitudes.top)}..${f1(r.latitudes.bottom)}` : ''}`);
  else if (r.kind === 'snapshot') L.push(`snapshot ${r.id} "${r.name}" ${r.W}x${r.H} ${r.game}${r.hex ? ' (hex)' : ''} | lat ${f1(r.botLat)}..${f1(r.topLat)}${r.degPerTile ? ` | ${(+r.degPerTile).toFixed(3)}°/tile` : ''}${r.cut ? ` | cut: ${r.cut} mask-fill tiles${r.cutLand != null ? ` (${r.cutLand} through land, the rest trimmed sea)` : ''}` : ''}`);
  const tot = r.W * r.H, rl = r.relief.labels, rc = r.relief.counts;
  L.push(`land ${r.land} (${pct(r.land, tot)}%)  water ${r.water} | ${rl[1]} ${rc[1]}  ${rl[2]} ${rc[2]} | river edges ${r.riverEdges}`);
  L.push('terrain: ' + r.classes.map((c: any) => `${c.ch}=${c.label} ${c.n}`).join('  '));
  if (r.landmasses) {
    const lm = r.landmasses, more = lm.count - lm.top.length;
    L.push(`landmasses ${lm.count}` + (lm.top.length ? ': ' + lm.top.map((m: any, i: number) => `#${i + 1} ${m.size}t x${m.bbox[0]}-${m.bbox[2]} y${m.bbox[1]}-${m.bbox[3]}`).join('; ') : '') + (more > 0 ? ` (+${more} smaller)` : ''));
  }
  if (r.patches) L.push(r.patches.length ? 'patches (bottom to top): ' + r.patches.map((p: any) => `[${p.id}] "${p.name}" ${p.W}x${p.H} @${p.x},${p.y}${p.landOnly ? '' : ' full-rect'}${p.foreign ? ' ⚠' + p.foreign : ''}`).join('; ') : 'patches: none');
  if (r.landforms) L.push('landforms: ' + r.landforms);
  if (r.connectors) L.push('edges: ' + ['N', 'E', 'S', 'W'].map(k => { const c = r.connectors[k]; if (!c) return `${k} ?`; const an = []; if (c.reliefAt != null) an.push('relief@' + c.reliefAt); if (c.coastAt != null) an.push('land@' + c.coastAt + (c.landRuns && c.landRuns.length ? ' (' + c.landRuns.slice(0, 2).map((q: string[]) => q[0] + '..' + q[1]).join(', ') + ')' : '')); return `${k} ${c.label}${an.length ? ' [' + an.join(', ') + ']' : ''}`; }).join(' | '));
  if (r.codes) L.push('codes: ' + fmtCodes(r.codes));
  if (r.collisions) L.push(r.collisions.length ? 'collisions: ' + r.collisions.slice(0, 6).map((c: any) => `[${c.a}]x[${c.b}] ${c.tiles} land tiles`).join('; ') + (r.collisions.length > 6 ? ` ; +${r.collisions.length - 6} more` : '') : 'collisions: none');
  if (r.budget) { const b = r.budget; L.push(`budget: land ${(b.share * 100).toFixed(1)}% of target ${Math.round(b.target[0] * 100)}-${Math.round(b.target[1] * 100)}%` + (b.within ? ' (within target)' : b.needMax < 0 ? ` (remove ${-b.needMax}..${-b.needMin} land tiles)` : ` (add ${b.needMin}..${b.needMax} land tiles)`)); }
  if (r.warnings) L.push(r.warnings.length ? `warnings (${r.warnings.length}): ` + r.warnings.slice(0, 8).map((w: any) => `[${w.rule}] ${w.msg}`).join(' ; ') + (r.warnings.length > 8 ? ` ; +${r.warnings.length - 8} more` : '') : 'warnings: none');
  if (r.notes && r.notes.length) L.push(`notes (${r.notes.length}): ` + r.notes.slice(0, 6).map((w: any) => `[${w.rule}] ${w.msg}`).join(' ; ') + (r.notes.length > 6 ? ` ; +${r.notes.length - 6} more` : ''));
  const clip = (c: any) => c ? ` | clipped: ${c.landTiles} land tiles off the canvas (${['north', 'south', 'east', 'west'].filter(k => c[k]).map(k => c[k] + ' ' + (k === 'north' || k === 'south' ? 'rows' : 'cols') + ' ' + k).join(', ')})` : '';
  if (r.lassoFrom) L.push(`lasso from frame (${r.lassoFrom.mode}): ${r.lassoFrom.what}, ${r.lassoFrom.vertices} vertices: ${JSON.stringify(r.lassoFrom.polygon)}`);
  if (r.placed) { const p = r.placed; L.push(`${p.preview ? 'PREVIEW (not kept): would place' : 'placed'} patch ${p.patch} at ${p.x},${p.y}${p.landOnly ? ' (land only)' : ' (full rectangle)'}` + (p.shifted ? ` | avoidLand shifted it by ${p.shifted.dx},${p.shifted.dy}` : '') + (p.skipped ? ` | ragged: ${p.skipped} edge tiles feathered` : '') + clip(p.clipped)); }
  if (r.attached && r.attached.fused) { const f = r.attached.fused; L.push(`fused: overlap ${f.overlap} tiles, shift ${f.shift}, seam cost ${f.seamCostPerRow} per row (interest-weighted min-cut)`); }
  if (r.edgeInterest) L.push('edge interest (mean | quietest stretch): ' + ['N', 'E', 'S', 'W'].map(k => { const e = r.edgeInterest[k]; return e ? `${k} ${e.mean}${e.quietAt != null ? ` | ${e.quiet}@${e.quietAt}` : ''}` : `${k} sea`; }).join('  '));
  if (r.realized) { const z = r.realized; L.push(`realized "${z.name}" as snapshot ${z.snapshot}: ${z.rivers} river systems, ${z.lakes.length} closed basins${z.lakes.length ? ' (' + z.lakes.map((l: any) => (l.saltFlat ? l.saltFlat + 't salt flat' + (l.tiles ? ' + ' + l.tiles + 't lake' : '') : l.tiles + 't lake')).join(', ') + ')' : ''}`); L.push('climate: ' + z.climate.overall + ' | by latitude: ' + z.climate.byBand.map((b: any) => b.band + '° ' + b.mix).join(' ; ')); }
  if (r.reclimated) { const z = r.reclimated; L.push(`reclimated: ${z.changedGroups} of ${z.landTiles} land tiles changed climate group | climate: ${z.climate.overall}`); L.push('by latitude: ' + z.climate.byBand.map((b: any) => b.band + '° ' + b.mix).join(' ; ')); }
  if (r.attached) { const t = r.attached, b = t.bestShift; L.push(`attached patch ${t.b} to patch ${t.a} along ${t.seam} at ${t.x},${t.y}` + (t.connectorA ? ` (A ${t.connectorA.label} meets B ${t.connectorB ? t.connectorB.label : '?'})` : '') + (t.aligned ? (t.aligned.error ? ` | align: ${t.aligned.error}` : ` | aligned ${t.aligned.kind}: A@${t.aligned.anchorA} to B@${t.aligned.anchorB} (shift ${t.aligned.shift})`) : '') + (t.seamCost ? ` | seam cost ${t.seamCost.cost} over ${t.seamCost.tiles} tiles (water ${t.seamCost.water}, climate ${t.seamCost.climate}, relief ${t.seamCost.relief}${t.seamCost.ignored ? `, ${t.seamCost.ignored} cut-edge pairs ignored` : ''})` : '') + (b ? ` | best shift ${b.shift} (cost ${b.cost}, window ±${b.window}${b.atWindowEdge ? ', ON THE WINDOW EDGE: widen searchShift' : ''})` : '') + (t.clamped ? ` | clamped ${t.clamped > 0 ? '+' : ''}${t.clamped} along the seam to stay on the canvas` : '') + clip(t.clipped) + (t.ragged ? ` | ragged: ${t.ragged.skipped} tiles of B${t.ragged.skippedA ? ' and ' + t.ragged.skippedA + ' of A' : ''} skipped` + (typeof t.ragged.seam === 'object' ? `, min-cut seam ${t.ragged.seam.length} long through a ${t.ragged.seam.width}-wide strip (cost/tile ${t.ragged.seam.costPerTile})` : `, ${t.ragged.seam}`) : '')); }
  if (r.connectors && r.connectors.corners) L.push('corners: ' + ['NW', 'NE', 'SE', 'SW'].map(k => `${k} ${r.connectors.corners[k]}`).join(' | '));
  if (r.scattered) L.push(`scattered ${r.scattered.length}: ` + r.scattered.map((p: any) => `[${p.patch}] ${p.snapshot} @${p.x},${p.y}${p.shifted ? (p.shifted.error ? ' (' + p.shifted.error + ')' : ` (shifted ${p.shifted.dx},${p.shifted.dy})`) : ''}`).join('; '));
  if (r.trimmed) L.push(`trimmed ${r.trimmed.systems.length} river system${r.trimmed.systems.length === 1 ? '' : 's'}${r.trimmed.branchEdges ? ` and ${r.trimmed.branchEdges} edge(s) of cut side branches` : ''} (${r.trimmed.edges} edges): ${r.trimmed.systems.join(', ') || 'none'}` + (r.trimmed.keptEndorheic.length ? ` | kept ${r.trimmed.keptEndorheic.length} endorheic (source) system(s): ${r.trimmed.keptEndorheic.join(', ')}` : ''));
  if (r.extended) L.push('extended: ' + r.extended.map((e: any) => e.error ? `river ${e.rid} from corner ${e.from.join(',')}: ${e.error}` : `river ${e.rid} from corner ${e.from.join(',')} to ${e.to} at ${e.at.join(',')} (+${e.edges} edges)`).join('; '));
  if (r.erasedNow != null) L.push(`erased now: ${r.erasedNow} tiles`);
  if (r.generated) L.push('generated: ' + fmtFeature(r.generated) + (r.generated.also && r.generated.also.length ? ` | also ${r.generated.also.join(', ')}` : ''));
  if (r.features && r.features.length) L.push(`features (${r.features.length}): ` + r.features.map((f: any) => `${f.id} ${f.kind.replace('_', ' ')}${f.tiles != null ? ' ' + f.tiles + 't' : ''}${f.at ? ' @' + f.at.join(',') : ''}${f.to ? ' -> ' + f.to : ''}`).join('; '));
  if (r.params) L.push('params: ' + Object.entries(r.params).map(([k, v]) => `${k}=${typeof v === 'number' ? f1(v) : v}`).join(' '));
  if (r.gameParams) L.push('game params: ' + Object.entries(r.gameParams).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${typeof v === 'number' ? f1(v) : v}`).join(' '));
  if (r.grid) L.push(...fmtGrid(r.grid));
  return L.join('\n');
}
function fmtSculpt(r: PageReply): string {
  const L = [`sculpt ${r.W}x${r.H} | latitudes ${r.latitudes.top}..${r.latitudes.bottom} | ${r.degPerTile}°/tile | sea level ${r.sea} m | ${r.ops} ops${r.post ? ` + ${r.post} sea-relative features` : ''} | ${r.msg}`];
  L.push(`land ${r.land} (${r.landPct}%) | elevation: ` + Object.entries(r.bands).map(([k, v]) => `${k} ${v}`).join('  '));
  L.push(`landmasses ${r.landmasses.count}${r.landmasses.top.length ? ': ' + r.landmasses.top.join(', ') + ' tiles' : ''}`);
  if (r.recent && r.recent.length) L.push('recent ops: ' + r.recent.join(' ; '));
  if (r.grid) { L.push('glyphs: ' + r.grid.legend); L.push(...fmtGrid(r.grid)); }
  return L.join('\n');
}
function fmtFeature(f: PageReply): string {
  const kind = f.kind.replace('_', ' '), n = f.notes && f.notes.length ? ` | ${f.notes.join('; ')}` : '';
  if (f.kind === 'river') return `${f.id || ''} river from ${f.from ? f.from.join(',') : '?'} to ${f.to}, ${f.lengthTiles} tiles long, ${f.discharge} m3/s` + (f.target ? ` (${f.target})` : '') + n;
  if (!f.at) return `${f.id || ''} ${kind}${f.tiles != null ? ' ' + f.tiles + ' tiles' : ''}` + n;
  return `${f.id || ''} ${kind} ${f.tiles} tiles at ${f.at.join(',')}` + (f.level != null ? `, surface ${f.level} m` : '') + (f.basinTiles ? `, natural basin ${f.basinTiles} tiles` : ', no closed basin here') + (f.climate ? `, ${f.climate} shore` : '')
    + (f.outlet ? ` | outlet: ${f.outlet.to}${f.outlet.river ? ' via ' + f.outlet.river : ''}${f.outlet.lengthTiles ? ' (' + f.outlet.lengthTiles + ' tiles)' : ''}${f.outlet.note ? ' (' + f.outlet.note + ')' : ''}` : '') + (f.target ? ` (${f.target})` : '') + n;
}
function fmtCodes(c: PageReply): string {
  if (!c) return ''; if (c.error) return c.error;
  const f = (t: any) => (t || []).map((e: any) => `${e.caption} ${e.share}%`).join(', ');
  return `band ${c.band} (${c.bandDegPerTile}°/tile for ${c.degPerTile}°/tile; ${c.coded} tiles coded, ${c.captioned} codes captioned)` + (c.landmasses && c.landmasses.length ? ' | ' + c.landmasses.map((l: any) => `#${l.id} ${f(l.top) || 'uncoded'}`).join(' | ') : ' | ' + f(c.top));
}
function fmtStatus(s: PageReply): string {
  const kv = (o: any) => Object.entries(o || {}).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${typeof v === 'number' ? f1(v) : v}`).join(' ');
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
/** A tool's implementation: the validated arguments in, the MCP result out. run() wraps it so a throw becomes an isError result. */
type ToolFn = (args: any) => CallToolResult | Promise<CallToolResult>;
const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const asError = (e: any): CallToolResult => ({ isError: true, content: [{ type: 'text', text: 'Error: ' + (e && e.message || e) }] });
const run = (fn: ToolFn) => async (args: any): Promise<CallToolResult> => { try { return await fn(args || {}); } catch (e) { return asError(e); } };
const report = (cmd: string, extra?: Record<string, any>) => run(async (args: any) => text(fmtReport(await call(cmd, Object.assign({}, args, extra || {})))));

/* ---------- tools ---------- */
const server = new McpServer({ name: 'terra-form', version: '0.1.0' }, { instructions:
`Drives the Terra Form app (real-world terrain -> game maps) that is open in a browser. Typical loop: set_game, set_frame (a lon/lat box on the Earth), read the stats + glyph grid, tune, snapshot (optionally cropped by a lasso), repeat for other regions, then compose_new / place / move_patch to splice the snapshots onto one canvas, compose_view to check it, export to write the map file. Tile coordinates are x east, y south, row 0 = north. The app must be open (python serve.py -> http://localhost:8000/, or TerraForm.exe).` });

const raggedOpt = z.union([z.boolean(), z.object({ feather: z.boolean().optional(), minCut: z.boolean().optional(), preserveCoast: z.boolean().optional().describe('default true: land tiles touching real water (not mask fill) are never feathered, so the real coastline survives'), preserve: z.array(z.array(z.number()).length(4)).optional().describe('snapshot-tile rects [x0,y0,x1,y1] never feathered or min-cut: pin a coastline you like'), preserveSides: z.array(z.enum(['N', 'E', 'S', 'W'])).optional().describe('rectangle borders left unfeathered'), preserveA: z.array(z.array(z.number()).length(4)).optional(), preserveSidesA: z.array(z.enum(['N', 'E', 'S', 'W'])).optional() })]).optional().describe("true, or options: feather / minCut on-off, preserveCoast (default true), preserve rects and preserveSides (B, or the placed snapshot), preserveA / preserveSidesA (A in attach)");
const viewOpts = {
  grid: z.boolean().optional().describe('include the glyph grid (default true)'),
  bbox: z.array(z.number()).length(4).optional().describe('crop the grid to tile rect [x0,y0,x1,y1], inclusive'),
  step: z.number().int().min(1).optional().describe('subsample: one glyph per step tiles (default: auto, keeps the grid within ~120x80)'),
  overlay: z.enum(['rivers', 'codes', 'interest']).optional().describe("'interest': 0..9 per land tile, how much the tile matters (peaks, ridge edges, rivers, real coast, climate boundaries, oases); seams should run through low digits. 'rivers': print '=' on every tile a river edge touches, over the terrain glyph; 'codes': one glyph per landform-codebook class on land and shore tiles (legend in the README; needs a known tile size)")
};
const LEGEND = `Glyph legend (one char per tile, row 0 = north). Civ4/Civ5: ~ ocean  , coast  g grass  p plains  d desert  t tundra  s snow  f forest  j jungle  r flood plains  o oasis  ^ peak; an UPPERCASE letter is that terrain on hills. OpenFront: ~ water, digits 0-9 plains magnitude, a-j highland 10-19, A-K mountain 20-30. Other games: ~ water . flat n hills ^ peak.`;

server.registerTool('status', { title: 'Status', description: 'Current app state: game, mode, frame size and bounds, compose canvas, shelf count, all tunable parameters (core and game-module) and the glyph legend of the active game. Also the cheapest way to check the page is connected.' },
  run(async () => text(fmtStatus(await call('status')))));

server.registerTool('set_game', { title: 'Set game', description: 'Select the game module (civ4, civ5 (hex)). Changes the lattice, grid limits and classifier; the frame is re-evaluated.', inputSchema: { id: z.string() } },
  run(async (a: any) => text(fmtStatus(await call('set_game', a)))));

server.registerTool('set_frame', { title: 'Set frame', description: `Frame a region of the Earth on the output grid and return the feedback block (stats + glyph grid). Give bounds [W,S,E,N] in degrees (the frame keeps the grid's W:H aspect, so it covers the box and may extend beyond it on one axis; the block reports the actual bounds), or center [lon,lat] with spanX (frame width in degrees). W/H set the output grid (snapped to the game's limits); rot rotates the frame (degrees, clockwise). Switches the page to the Civ preview. ${LEGEND}`,
  inputSchema: { bounds: z.array(z.number()).length(4).optional(), center: z.array(z.number()).length(2).optional(), spanX: z.number().optional(), W: z.number().int().optional(), H: z.number().int().optional(), rot: z.number().optional(), game: z.string().optional().describe('switch game first'), ...viewOpts } },
  report('set_frame'));

server.registerTool('tune', { title: 'Tune parameters', description: `Set slider parameters by name and return the feedback block for the current frame. Core: islandBias seawayBias islandExpand expandSteep expandMaxMult roughHalo mtnPass flatSpots coastThr nudgeX nudgeY riverN riverEstuaries(bool) hill peak blendHill blendPeak fill('water'|'barrier'). Game-module controls go by their control id (Civ4: alpine clim fpAmt forestDens jungleDens oasisDens fpKoppen(bool) feat(bool) np; OpenFront: ofPlains ofHighland ofMountain ofDesert(bool) ofDesertMag ofName). Values are clamped to the slider's range. status shows the current values. Call with an empty params object to just read them.`,
  inputSchema: { params: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}), reset: z.boolean().optional().describe('first put every control back to its default (settings persist on the page between sessions and agents)'), report: z.boolean().optional().describe('false: return only the parameter values'), ...viewOpts } },
  run(async (a: any) => { const r = await call('tune', a); return text(a.report === false ? JSON.stringify(r, null, 1) : fmtReport(r)); }));

server.registerTool('frame_view', { title: 'View frame', description: `The feedback block for the current frame without changing anything (re-evaluates it). ${LEGEND}`, inputSchema: viewOpts }, report('frame_view'));

server.registerTool('snapshot', { title: 'Capture snapshot', description: 'Capture the current frame as a snapshot on the shelf and return its id plus its feedback block. lasso: a lon/lat polygon [[lon,lat],...] — the capture is cropped to its tile bounding box and tiles outside the shape become the default fill (water, or mountain when fill=barrier); rect: a lon/lat box [W,S,E,N] doing the same. lassoFrom: build the lasso from the frame itself (a landmass outline with a sea margin, or one side of a mountain ridge with the crest; see suggest_lasso) so the cut is not a ruler line. Without any, a mask drawn in the app applies if there is one, else the whole frame. The lasso is applied for this capture only.',
  inputSchema: { name: z.string().optional(), lasso: z.array(z.array(z.number()).length(2)).optional(), rect: z.array(z.number()).length(4).optional(),
    lassoFrom: z.union([z.enum(['land', 'coast', 'ridge']), z.object({ mode: z.enum(['land', 'coast', 'ridge']).optional(), landmass: z.number().int().optional(), at: z.array(z.number()).length(2).optional(), side: z.enum(['N', 'E', 'S', 'W']).optional(), margin: z.number().int().optional(), tolerance: z.number().optional(), maxVertices: z.number().int().optional() })]).optional().describe('build the lasso from the frame (see suggest_lasso) and capture with it in one call'), ...viewOpts } },
  report('snapshot'));

server.registerTool('suggest_lasso', { title: 'Suggest a lasso', description: "Build an irregular lasso from the current frame's own geography instead of typing a few straight segments (whose cut edges read as ruler lines). mode 'land' (default): the outline of a landmass (the largest, #landmass from describe, or the one at tile at:[x,y]) with `margin` tiles of sea kept around the real coast (default 1; 0 trims every empty tile, larger keeps more sea); mode 'ridge': one side of a mountain spine (the largest, or the one at `at`) with the crest included, so the cut runs along the far foot of the ridge and the cut edge is a mountain wall (side N/E/S/W picks which side of the spine to keep). The outline is simplified to `tolerance` tiles (default 0.75) and at most maxVertices (default 40). Returns the lon/lat polygon to pass to snapshot {lasso}, or pass the same options as snapshot {lassoFrom:{...}} to capture in one call.",
  inputSchema: { mode: z.enum(['land', 'coast', 'ridge']).optional(), landmass: z.number().int().optional(), at: z.array(z.number()).length(2).optional(), side: z.enum(['N', 'E', 'S', 'W']).optional(), margin: z.number().int().optional(), tolerance: z.number().optional(), maxVertices: z.number().int().optional() } },
  run(async (a: any) => { const r = await call('suggest_lasso', a); return text(`lasso (${r.mode}, margin ${r.margin}): ${r.what} | ${r.vertices} vertices (tolerance ${r.tolerance} tiles) | ${r.tilesInside} tiles inside, land ${r.landInside} of ${r.landInFrame} in the frame | tile bbox x${r.bbox[0]}-${r.bbox[2]} y${r.bbox[1]}-${r.bbox[3]}\nlasso: ${JSON.stringify(r.polygon)}`); }));

server.registerTool('list_snapshots', { title: 'List snapshots', description: 'The shelf: id, name, size, game, centre lon/lat of every captured snapshot.' },
  run(async () => { const r = await call('list_snapshots'); return text(r.snapshots.length ? r.snapshots.map((s: any) => `${s.id}  "${s.name}"  ${s.W}x${s.H} ${s.game}${s.hex ? ' hex' : ''}  centre ${s.center[0]},${s.center[1]}`).join('\n') : 'shelf is empty'); }));

server.registerTool('snapshot_info', { title: 'Snapshot info', description: `Feedback block (stats + glyph grid) of one snapshot, by id or exact name. ${LEGEND}`, inputSchema: { id: z.string(), ...viewOpts } }, report('snapshot_info'));

server.registerTool('delete_snapshot', { title: 'Delete snapshot', description: 'Remove a snapshot from the shelf (patches placed from it stay on the canvas until the page reloads).', inputSchema: { id: z.string() } },
  run(async (a: any) => text(JSON.stringify(await call('delete_snapshot', a), null, 1))));

server.registerTool('compose_new', { title: 'New compose canvas', description: 'Switch to Compose, clear the canvas (unless clear=false) and size it W x H tiles (snapped to the game grid limits). fill: what empty canvas and erased tiles are — water (default) or barrier (impassable mountain). Returns the feedback block for the (empty) canvas.',
  inputSchema: { W: z.number().int().optional(), H: z.number().int().optional(), fill: z.enum(['water', 'barrier']).optional(), clear: z.boolean().optional(),
    latitudes: z.object({ top: z.number(), bottom: z.number() }).nullable().optional().describe('declared virtual latitudes of row 0 and the bottom edge (e.g. {top:80,bottom:-80}); written to the export header and used by the latitude-mismatch lint; null clears'),
    targetLand: z.union([z.number(), z.array(z.number()).length(2)]).nullable().optional().describe('land-share target for the budget line in every compose block: a fraction or percent (±5 points), or [lo, hi]; null clears'),
    degPerTile: z.number().nullable().optional().describe('the canvas\' nominal tile size in degrees, for the landform codebook band (default: the median of the placed patches)'), ...viewOpts } },
  report('compose_new'));

server.registerTool('flip_snapshot', { title: 'Flip snapshot', description: "Make a mirrored copy of a snapshot on the shelf: axis 'x' mirrors east-west, 'y' north-south, 'xy' rotates 180°. Tiles, river edges and their flow directions are flipped together. Use it to disguise recognisable real pieces (Italy, Florida). Returns the new snapshot's block. (A rotated capture is set_frame/snapshot_from_catalog with rot.)",
  inputSchema: { id: z.string(), axis: z.enum(['x', 'y', 'xy']).optional(), name: z.string().optional(), ...viewOpts } },
  report('flip_snapshot'));

server.registerTool('thumbnail', { title: 'Thumbnail', description: 'Render the compose canvas, the current frame, or a snapshot with the app\'s own tile renderer, river edges drawn on top (rivers:false to omit), and write it as a PNG to `path` (long edge maxPx, default 480).',
  inputSchema: { target: z.string().optional(), path: z.string(), maxPx: z.number().int().optional(), rivers: z.boolean().optional().describe('default true: draw the river edges (thicker for more discharge) over the tiles') } },
  run(async (a: any) => { const r = await call('thumbnail', a); const b64 = String(r.dataUrl).split(',')[1]; await fs.mkdir(path.dirname(path.resolve(a.path)), { recursive: true }); await fs.writeFile(path.resolve(a.path), Buffer.from(b64, 'base64')); return text(`wrote ${path.resolve(a.path)} (${r.target} ${r.W}x${r.H})`); }));

server.registerTool('place', { title: 'Place snapshot', description: 'Stamp a snapshot (by id or exact name) on the compose canvas with its top-left tile at x,y (may be negative or run off the canvas; the overhang is clipped and the block says how much land was lost). landOnly (default true) stamps only its land tiles, so coastlines can be nudged together; false stamps the whole rectangle including its sea. avoidLand:true shifts the stamp to the nearest spot where its land touches no existing land (gap water tiles between, default 1) and reports the shift; ragged:true feathers its cut edges (where the lasso/rect mask or the frame border cut through LAND; real coastline is kept, and ragged:{preserve:[rects], preserveSides:[...]} pins more) so they do not read as ruler lines; preview:true returns the block as if placed but keeps nothing. Later patches draw over earlier ones. The block carries a collisions line (patches whose land overlaps) and, when compose_new had targetLand, a budget line.',
  inputSchema: { snapshot: z.string(), x: z.number().int(), y: z.number().int(), allowRepeat: z.boolean().optional().describe('a snapshot goes on the canvas once (repeats read as copy-paste); true overrides'), landOnly: z.boolean().optional(), avoidLand: z.boolean().optional(), gap: z.number().int().optional(), ragged: raggedOpt, preview: z.boolean().optional(), ...viewOpts } },
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
  run(async (a: any) => {
    const r = await call('export', { name: a.name, transfer: !!a.dir });
    const L = [`export ${r.mode} ${r.game} ${r.W}x${r.H}`];
    if (a.dir) {
      const base = path.resolve(a.dir, r.dir || ''); await fs.mkdir(base, { recursive: true });
      for (const f of r.files) { const p = path.join(base, f.name); await fs.writeFile(p, f.encoding === 'base64' ? Buffer.from(f.data, 'base64') : f.data); L.push(`wrote ${p} (${f.size} bytes)`); }
    } else { L.push('files: ' + r.files.map((f: any) => `${f.name} (${f.size} bytes)`).join(', ')); L.push('app says: ' + (r.dest || '(no destination hint)')); }
    for (const v of r.validation) L.push(`${v.ok ? 'ok  ' : 'WARN'} ${v.label} · ${v.detail}`);
    if (r.note) L.push(r.note);
    return text(L.join('\n'));
  }));

/* ---------- landform layer: describe, catalog, composite operators ---------- */
const CATALOG_PATH = new URL('./landforms.json', import.meta.url);
/** One mcp/landforms.json entry (a named real-world frame with its tags, climate and measured connectors). */
type CatalogEntry = { name: string; bounds: number[]; size: number[]; tags: string[]; climate: string; notes: string; [field: string]: any };
let CATALOG: { entries: CatalogEntry[]; [field: string]: any } = { entries: [] };
try { CATALOG = JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8')); } catch (e) { log('catalog not loaded:', (e as Error).message); }
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function catalogFind(name: string): CatalogEntry | null { const n = norm(name); return CATALOG.entries.find(e => norm(e.name) === n) || CATALOG.entries.find(e => norm(e.name).includes(n) || n.includes(norm(e.name))) || null; }
const fmtEntry = (e: CatalogEntry) => `${e.name} — bounds [${e.bounds.join(', ')}] size ${e.size[0]}x${e.size[1]} | ${e.tags.join(', ')} | ${e.climate}${e.climateMeasured ? ' (measured: ' + e.climateMeasured.map((g: any) => g.group + ' ' + g.pct + '%').join(', ') + ')' : ''}${e.lasso ? ' | lasso' : e.rect ? ' | rect crop' : ''}${e.params ? ' | params ' + JSON.stringify(e.params) : ''}${e.connectors ? ' | edges N ' + e.connectors.N + ' / E ' + e.connectors.E + ' / S ' + e.connectors.S + ' / W ' + e.connectors.W : ''}\n    ${e.notes}`;

function fmtDescribe(D: PageReply): string {
  const L = [];
  L.push(D.kind === 'snapshot' ? `describe snapshot ${D.id} "${D.name}" ${D.W}x${D.H}` : D.kind === 'frame' ? `describe frame ${D.W}x${D.H} | bounds W ${f1(D.bounds.W)} S ${f1(D.bounds.S)} E ${f1(D.bounds.E)} N ${f1(D.bounds.N)}` : `describe compose canvas ${D.W}x${D.H}`);
  L.push(D.summary);
  if (D.connectors) L.push('edges: ' + ['N', 'E', 'S', 'W'].map(k => `${k} ${D.connectors[k] ? D.connectors[k].label : '?'}`).join(' | '));
  if (D.cut) L.push(`cut: ${D.cut} mask-fill tiles${D.cutLand != null ? ` (${D.cutLand} through land: artificial shore; the rest trimmed sea, the coast beside it is real)` : ''}`);
  if (D.codes) L.push('codes: ' + fmtCodes(D.codes));
  if (D.warnings) L.push(D.warnings.length ? `warnings (${D.warnings.length}): ` + D.warnings.map((w: any) => `[${w.rule}] ${w.msg}`).join(' ; ') : 'warnings: none');
  if (D.notes && D.notes.length) L.push(`notes (${D.notes.length}): ` + D.notes.map((w: any) => `[${w.rule}] ${w.msg}`).join(' ; '));
  const J = Object.assign({}, D); delete J.summary; delete J.kind; delete J.connectors; delete J.warnings; delete J.notes;
  L.push(JSON.stringify(J));
  return L.join('\n');
}

server.registerTool('describe', { title: 'Describe landforms', description: 'Morphology of the compose canvas, the current frame, or a snapshot (by id or name), in landform vocabulary: landmasses (size, position, climate mix, hills/peaks), isthmuses (necks found by erosion, with width), straits (thin water between two landmasses, width in tiles), bays (convex-hull deficit) and peninsulas (morphological opening) with the direction they open or point, mountain spines (ridge components with orientation and length, chain/knots), seas (inland or not), river systems that reach water / leave the map / dead-end. Returns a paragraph, the seam warnings (and notes) for a collage, and a compact JSON. rows:true adds the per-row land / Köppen-group table (doubles the payload); codes:true adds the landform-codebook summary (top Earth captions per landmass at the map\'s scale band). Coordinates are tile x,y (row 0 north).',
  inputSchema: { target: z.string().optional().describe("'compose' | 'frame' | a snapshot id or name (default: whatever the page shows)"), rows: z.boolean().optional().describe('include the per-row table (land, Köppen groups, relief per row)'), codes: z.boolean().optional().describe('include the landform-codebook summary'), degPerTile: z.number().optional().describe('tile size in degrees for the codebook band (default: from the frame / snapshot latitudes, or the canvas declaration)'), codesRaw: z.boolean().optional().describe('with codes: also return the per-tile grids and codes (large; for checking the port)') } },
  run(async (a: any) => text(fmtDescribe(await call('describe', a)))));

server.registerTool('catalog_search', { title: 'Search the landform catalog', description: `Find real pieces to splice: entries of mcp/landforms.json matched by tag (peninsula, isthmus, strait, archipelago, atoll, delta, rift, mountain-spine, mountain-wall, rain-shadow, desert, fjords, volcanic, basin, inland-sea, ...) or free text over name/notes/climate (several words match ANY of them, ranked by how many match), or climate (the hand-written field plus the mix measured by catalog_index). No arguments lists everything (${CATALOG.entries.length} entries).`,
  inputSchema: { tags: z.array(z.string()).optional(), text: z.string().optional(), climate: z.string().optional() } },
  run(async (a: any) => {
    const tags = (a.tags || []).map(norm), words = norm(a.text).split(' ').filter(Boolean), cl = norm(a.climate);
    const climOf = (e: any) => norm(e.climate + ' ' + (e.climateMeasured || []).filter((g: any) => g.pct >= 20).map((g: any) => g.group).join(' '));   // the hand-written field plus what catalog_index measured
    const scored = CATALOG.entries.map(e => {
      const hay = norm(e.name + ' ' + e.notes + ' ' + e.tags.join(' ') + ' ' + e.climate), nameN = norm(e.name);
      const tagHits = tags.filter((t: string) => e.tags.some((x: any) => norm(x).includes(t))).length, wordHits = words.filter(w => hay.includes(w)).length, nameHits = words.filter(w => nameN.includes(w)).length;
      const ok = (!tags.length || tagHits > 0) && (!words.length || wordHits > 0) && (!cl || climOf(e).includes(cl));
      return { e, ok, score: tagHits * 2 + wordHits + nameHits };
    }).filter(s => s.ok).sort((p, q) => q.score - p.score || p.e.name.localeCompare(q.e.name));
    return text(scored.length ? (words.length > 1 ? `${scored.length} entries match any of: ${words.join(', ')} (best matches first)\n` : '') + scored.map(s => fmtEntry(s.e)).join('\n') : 'no catalog entry matches');
  }));

server.registerTool('snapshot_from_catalog', { title: 'Snapshot from catalog', description: 'Frame a catalog entry (its bounds, at its default size unless W/H are given), apply its lasso or rect crop, apply its suggested params (unless params:false) plus any params you pass, capture it to the shelf under its name (or `name`) and return the snapshot feedback block with its edge connectors. rot rotates the frame first (degrees); game switches game first.',
  inputSchema: { entry: z.string().describe('catalog entry name (case-insensitive, partial ok)'), name: z.string().optional(), W: z.number().int().optional(), H: z.number().int().optional(), rot: z.number().optional(), game: z.string().optional(), params: z.union([z.record(z.union([z.number(), z.boolean(), z.string()])), z.boolean()]).optional().describe('extra tune params, or false to skip the entry\'s own'),
    bounds: z.array(z.number()).length(4).optional().describe('override the entry\'s bounds [W,S,E,N] (its lasso/rect crop is then skipped)'), crop: z.boolean().optional().describe('false: capture the whole frame, ignoring the entry\'s lasso/rect'), ...viewOpts } },
  run(async (a: any) => {
    const e = catalogFind(a.entry); if (!e) throw new Error(`no catalog entry like "${a.entry}" (catalog_search lists them)`);
    const params = Object.assign({}, a.params === false ? {} : (e.params || {}), typeof a.params === 'object' ? a.params : {});
    if (Object.keys(params).length) await call('tune', { params, report: false });
    const crop = a.crop !== false && !a.bounds;
    const r = await call('capture_region', { bounds: a.bounds || e.bounds, W: a.W || e.size[0], H: a.H || e.size[1], rot: a.rot, game: a.game, lasso: crop ? e.lasso : undefined, rect: crop && !e.lasso ? e.rect : undefined, name: a.name || e.name, catalog: e.name, tags: e.tags, grid: a.grid, bbox: a.bbox, step: a.step, overlay: a.overlay });
    return text(fmtReport(r));
  }));

server.registerTool('attach', { title: 'Attach two snapshots', description: 'Composite operator: place snapshot B against snapshot A so that A\'s edge (N/E/S/W) meets B\'s opposite edge, centred along the seam (or anchor-aligned with align). A keeps its patch if already placed, else it is placed at the canvas centre; B is moved if already placed, else placed. overlap pulls B that many tiles into A (land-only stamping lets coastlines interleave); shift slides B along the seam (+ = south or east). align:\'relief\' lines up the two edges\' mountain anchors (the relief run nearest each edge) so two ranges meet; align:\'coast\' lines up their longest land runs. B is clamped along the seam to keep its land on the canvas (clamp:false to allow overhang); any land still off-canvas is reported. ragged:true cuts a min-cost seam through the overlap strip (Zhou et al.) and feathers B\'s cut edges, so the join is not a straight line. The block reports the seam cost (mask-cut water ignored), the best shift within ±searchShift (flagged when it sits on the window edge), the seam lint and both edges\' connectors with anchors.',
  inputSchema: { a: z.string(), edgeA: z.enum(['N', 'E', 'S', 'W']), b: z.string(), edgeB: z.enum(['N', 'E', 'S', 'W']).optional(), overlap: z.union([z.number().int(), z.literal('auto')]).optional().describe("tiles of B pulled into A; 'auto' fuses: searches overlap depth (up to maxOverlap) and slide for the cheapest interest-weighted seam, so the pieces merge over land where neither has anything worth keeping"), maxOverlap: z.number().int().optional(), shift: z.number().int().optional(), landOnly: z.boolean().optional(),
    autoShift: z.boolean().optional().describe('slide B along the seam (within ±searchShift) to the position with the lowest seam cost; the block reports the cost either way'), searchShift: z.number().int().optional().describe('half-width of the best-shift search along the seam (default 16)'),
    align: z.enum(['relief', 'coast']).optional(), clamp: z.boolean().optional(), ragged: raggedOpt, ...viewOpts } },
  report('attach'));

server.registerTool('catalog_index', { title: 'Index catalog connectors', description: 'Capture catalog entries (all, or the named ones) once to record their edge and corner connector labels and their measured climate mix in mcp/landforms.json, so catalog_lint and catalog_search {climate} can reason about which pieces fit together. Slow: a few seconds per entry (call it with 3-4 entries at a time under a 60 s client timeout).',
  inputSchema: { entries: z.array(z.string()).optional(), game: z.string().optional() } },
  run(async (a: any) => {
    const list = a.entries && a.entries.length ? a.entries.map(catalogFind).filter(Boolean) : CATALOG.entries; const done = [];
    if (a.game) await call('set_game', { id: a.game });
    for (const e of list) {
      if (e.params) await call('tune', { params: e.params, report: false });
      const r = await call('capture_region', { bounds: e.bounds, W: e.size[0], H: e.size[1], lasso: e.lasso, rect: e.lasso ? undefined : e.rect, name: e.name, catalog: e.name, grid: false, landforms: false });
      if (r.connectors) e.connectors = { N: r.connectors.N.label, E: r.connectors.E.label, S: r.connectors.S.label, W: r.connectors.W.label, corners: r.connectors.corners || null };
      try {   // the climate mix of the piece's land, so catalog_search {climate} can be trusted (finding 4)
        const D = await call('describe', { target: r.id }), acc = [0, 0, 0, 0, 0, 0], names = ['ice cap', 'tundra', 'arid', 'tropical', 'temperate', 'continental']; let tot = 0;
        for (const lm of D.landmasses || []) for (const g of lm.climate || []) { const i = names.indexOf(g.group); if (i >= 0) { acc[i] += g.pct * lm.size / 100; tot += g.pct * lm.size / 100; } }
        e.climateMeasured = tot ? acc.map((v, i) => ({ group: names[i], pct: Math.round(v / tot * 100) })).filter(g => g.pct > 0).sort((p, q) => q.pct - p.pct).slice(0, 3) : null;
        e.cutTiles = D.cut || 0;
      } catch (err) { log('catalog_index: describe failed for', e.name, (err as Error).message); }
      done.push(`${e.name}: N ${e.connectors ? e.connectors.N : '?'} | E ${e.connectors ? e.connectors.E : '?'} | S ${e.connectors ? e.connectors.S : '?'} | W ${e.connectors ? e.connectors.W : '?'}` + (e.climateMeasured ? ' | ' + e.climateMeasured.map((g: any) => g.group + ' ' + g.pct + '%').join(', ') : ''));
      await call('delete_snapshot', { id: r.id }).catch(() => {});
    }
    await fs.writeFile(CATALOG_PATH, JSON.stringify(CATALOG, null, 1) + '\n');
    return text(`indexed ${done.length} entries\n` + done.join('\n'));
  }));

server.registerTool('catalog_lint', { title: 'Lint the catalog', description: 'Wang-tile view of the catalog (Cohen et al. 2003): count supply of each connector label per side across indexed entries and flag labels with no partner on the opposite side (a piece whose east edge is a mountain wall needs some piece whose west edge is one). Run catalog_index first for entries without connectors.',
  inputSchema: {} },
  run(async () => {
    const OPPOSITE: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' }, base = (l: any) => String(l).replace(' + river exit', ''), supply: Record<string, Record<string, string[]>> = {};
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
  inputSchema: { snapshots: z.array(z.string()), along: z.array(z.array(z.number()).length(2)), spacing: z.number().optional(), allowRepeat: z.boolean().optional().describe('each snapshot is stamped once: give at least as many distinct snapshots as the path has room for, or true to cycle'), start: z.number().int().optional(), landOnly: z.boolean().optional(), avoidLand: z.boolean().optional().describe('shift each stamp to the nearest spot whose land touches no existing land (gap water tiles between, default 1)'), gap: z.number().int().optional(), ...viewOpts } },
  report('scatter'));

server.registerTool('trim_rivers', { title: 'Trim rivers', description: 'River repair: drop the collage\'s river systems that end on land. By default only the ones the source snapshots did not already have (cut by a patch boundary, an erase or an overlapping stamp); endorheic:\'trim\' also drops the real endorheic ones; rids names systems explicitly (the warnings and describe.rivers.systemsTop give the ids). Snapshots are untouched: the drops are per-patch edits of the collage.',
  inputSchema: { rids: z.array(z.union([z.number(), z.string()])).optional(), endorheic: z.enum(['keep', 'trim']).optional(), minEdges: z.number().int().optional().describe('also drop stub systems shorter than this many edges that join no river (default 3; 0 keeps every stub)'), ...viewOpts } }, report('trim_rivers'));
server.registerTool('extend_river', { title: 'Extend river', description: 'River repair: carry a river that dead-ends on land on to the nearest water (or into another river) along tile edges with land on both sides, adding the edges to the collage with the flow pointing downstream. rid picks the system; at:[x,y] picks the dead end nearest a tile; neither extends every dead end. A join counts only where the other river flows on, not at its dead end; run it after trim_rivers to carry seam-cut remnants to the sea. maxLength caps the search (default 60 edges).',
  inputSchema: { rid: z.union([z.number(), z.string()]).optional(), at: z.array(z.number()).length(2).optional(), maxLength: z.number().int().optional(), ...viewOpts } }, report('extend_river'));

/* ---------- the sculpt pathway (core/sculpt.js, core/climate.js): original terrain on a height field ---------- */
const sculptRun = (cmd: string) => run(async (args: any) => text(fmtSculpt(await call(cmd, args))));
const sView = { grid: z.boolean().optional(), bbox: z.array(z.number()).length(4).optional(), step: z.number().int().min(1).optional() };
const pt = z.array(z.number()).length(2), zPath = z.array(pt).min(2);
server.registerTool('sculpt_new', { title: 'New sculpt canvas', description: "Start the sculpt pathway: a height field (2x2 cells per tile, metres) for terrain that is not Earth's. It starts as ocean floor (base, default -3500 m); build land with sculpt_shape and sculpt_stamp, set the sea with sculpt_sea, check with sculpt_view (cheap elevation glyphs), then sculpt_realize derives land, relief, climate (a physical model from latitude, elevation, prevailing winds, rain shadow and distance from the sea — not copied from Earth), lakes and rivers, and puts the result on the compose canvas. latitudes: the virtual span of row 0 and the bottom edge, which drives the climate; degPerTile sets the physical scale (default from the latitude span).",
  inputSchema: { W: z.number().int(), H: z.number().int(), latitudes: z.object({ top: z.number(), bottom: z.number() }), degPerTile: z.number().optional(), base: z.number().optional(), seed: z.number().int().optional(), ...sView } }, sculptRun('sculpt_new'));
server.registerTool('sculpt_stamp', { title: 'Stamp real terrain', description: "Stamp a fragment of real elevation (source [W,S,E,N] lon/lat — keep it small: a range, a basin, a coast) onto the sculpt canvas at `at` (tile centre), `size` [w,h] tiles (h defaults to the source's shape), rotated `rot` degrees and optionally mirrored (flip 'x'/'y'/'xy'), feathered over `feather` tiles. mode: max (default; raise to it), blend (replace), add, min. gain scales its relief, offset shifts it. landOnly (default) skips the source's sea. Each source box can be stamped once (allowRepeat to override), so no piece of the real world is pasted twice. Rotating and mixing many small fragments gives real-feeling relief in an original arrangement.",
  inputSchema: { source: z.array(z.number()).length(4), at: pt.optional(), size: z.array(z.number()).min(1).max(2).optional(), rot: z.number().optional(), flip: z.enum(['x', 'y', 'xy']).optional(), feather: z.number().optional(), mode: z.enum(['max', 'blend', 'add', 'min']).optional(), gain: z.number().optional(), offset: z.number().optional(), landOnly: z.boolean().optional(), allowRepeat: z.boolean().optional(), ...sView } }, sculptRun('sculpt_stamp'));
server.registerTool('sculpt_shape', { title: 'Sculpt a landform', description: "Add a primitive landform to the sculpt canvas (tile coordinates). kind: blob {at, radius, height (default 250 m), irregular 0..1, falloff, stretch, angle} — a land mass, use several to build continents and fill the space between pieces; ridge {path, width (tiles), height (m), jag} — a mountain chain along a path; rift {path, width, depth} — a trough with raised shoulders (a rift valley or, below sea level, a narrow sea); plateau {at, radius, height, edge, irregular}; basin {at, radius, depth}; chain {path, count, height:[young, old] m, radius:[young, old] tiles, atolls (how many at the old end), jitter, atollRadius:[min,max] tiles (default [1.2,3.4], capped by the spacing), atollLand 0..1 (share of the rim that is islets; default varies per atoll), barrier (default true)} — a hotspot track: the path runs from the young end (tall volcanic islands, elongated along their rift zones) to the old end (the oldest high islands inside barrier reefs, then atolls: one-tile rings of reef and islets around a shallow lagoon, more islets on the windward east side), each island generated individually; fjords {path along a mountainous coast, count, length (tiles), width, depth, side} — narrow glacial troughs cut inland below sea level (applied after the sea level); noise {amplitude, scale, at?, radius?}; smooth {radius}.",
  inputSchema: { kind: z.enum(['blob', 'ridge', 'rift', 'plateau', 'basin', 'chain', 'fjords', 'noise', 'smooth']), at: pt.optional(), path: zPath.optional(), radius: z.union([z.number(), z.array(z.number()).length(2)]).optional(), height: z.union([z.number(), z.array(z.number()).length(2)]).optional(),
    width: z.number().optional(), depth: z.number().optional(), jag: z.number().optional(), irregular: z.number().optional(), falloff: z.number().optional(), edge: z.number().optional(), stretch: z.number().optional(), angle: z.number().optional(),
    count: z.number().int().optional(), atolls: z.number().int().optional(), jitter: z.number().optional(), atollRadius: z.array(z.number()).length(2).optional(), atollLand: z.number().optional(), barrier: z.boolean().optional(), length: z.number().optional(), side: z.enum(['auto', 'left', 'right']).optional(), amplitude: z.number().optional(), scale: z.number().optional(), ...sView } }, sculptRun('sculpt_shape'));
server.registerTool('sculpt_sea', { title: 'Set sea level', description: 'Set the sculpt canvas sea level by target land share (land: 0..1 — the gaps between pieces fill with lowland or shelf to reach it, and later shapes keep the share) or by level (metres).',
  inputSchema: { land: z.number().optional(), level: z.number().optional(), ...sView } }, sculptRun('sculpt_sea'));
server.registerTool('sculpt_view', { title: 'View sculpt canvas', description: 'The sculpt canvas as elevation glyphs (~ deep sea, - shelf, . 0-200 m, : 200-600, + 600-1200, n 1200-2400, ^ 2400+) with land share, elevation bands and landmass sizes. Cheap: use it after every few operations.',
  inputSchema: { ...sView } }, sculptRun('sculpt_view'));
server.registerTool('sculpt_realize', { title: 'Realize sculpt canvas', description: "Turn the sculpt canvas into the active game's map: land and relief from absolute heights (relief:{hill, peak} metres, defaults 900/2600, plus local range), climate from the physical model (wetness scales rainfall), lakes in closed basins (lakes: max count or false; salt-fringed when arid), rivers from rainfall-weighted flow accumulation (riverDensity: share of land tiles on a channel, default 0.06; minDischarge m³/s), the game's own classifier and features. The result replaces the compose canvas as one patch (a snapshot on the shelf), with the canvas latitudes set, so describe, lint, add_lake/add_river and export apply. The block reports the climate mix overall and by latitude band — check it is sane for the brief.",
  inputSchema: { name: z.string().optional(), relief: z.object({ hill: z.number().optional(), peak: z.number().optional(), hillRange: z.number().optional(), peakRange: z.number().optional() }).optional(), wetness: z.number().optional(), lakes: z.union([z.number().int(), z.boolean()]).optional(), lakeDepth: z.number().optional(), riverDensity: z.number().optional(), minDischarge: z.number().optional(), meander: z.number().optional().describe('river meander 0..1 (default 0.6)'), edgeOutlets: z.boolean().optional().describe('default true: water may drain off the map edge (the world goes on); false for an enclosed region, so rivers reach its seas or end in basins'), ...viewOpts } }, report('sculpt_realize'));
server.registerTool('reclimate', { title: 'Reclimate the collage', description: "Climate sanity for a collage: recompute every land tile's climate for where it now sits (the canvas latitudes from compose_new, its height and its distance from the sea, prevailing winds and rain shadows), re-run the game's classifier and features, and replace the canvas with the result as one patch. Use it after moving real pieces to new latitudes or mirroring them, so a piece does not keep the climate of where it came from. The block reports how many tiles changed climate group and the mix by latitude band.",
  inputSchema: { name: z.string().optional(), wetness: z.number().optional(), ...viewOpts } }, report('reclimate'));

/* ---------- generated lakes, salt pans and rivers (core/generate.js), on either pathway ---------- */
const genTarget = z.enum(['frame', 'compose']).optional().describe("'frame': a world-pinned feature on the framed region (it follows the real terrain, survives re-framing that part of the world, and is baked into snapshots); 'compose': a tile-pinned feature on the collage. Default: whichever the page shows");
const PATHWAYS = 'Works on both pathways: on a FRAME the feature is computed on the real elevation and stored in lon/lat, so the classifier, the river pass and every snapshot of that area see it like real data; on the COMPOSE canvas it is computed on the collage tiles\' own heights and painted after every patch and erasure.';
server.registerTool('add_lake', { title: 'Add a lake', description: `Generate a lake by filling a basin: from the seed the water walks downhill to the local low point, then floods lowest ground first (compact keeps it round) until it covers \`area\` tiles. It never touches existing water, so it cannot turn into a bay. The block reports the surface height, the natural basin size (a lake bigger than its basin would overflow) and the shore climate. outlet: 'auto' (default) gives a humid lake an outflow river from its lowest rim to the sea and leaves an arid one endorheic; 'river' always; 'none' never. saltFringe: a ring of salt pan that many tiles wide around the water (an endorheic desert lake). Without at, the deepest closed depression is used. ${PATHWAYS}`,
  inputSchema: { at: z.array(z.number()).length(2).optional().describe('seed tile [x,y] in the grid the block shows'), lonlat: z.array(z.number()).length(2).optional().describe('frame only: seed as [lon,lat]'), area: z.number().optional().describe('tiles (default 6)'), compact: z.number().optional().describe('distance penalty per tile, in height units (default 0.004); 0 follows contours freely'), outlet: z.enum(['auto', 'river', 'none']).optional(), saltFringe: z.number().int().optional(), descend: z.boolean().optional().describe('default true: move the seed downhill first'), name: z.string().optional(), target: genTarget, ...viewOpts } }, report('add_lake'));
server.registerTool('add_salt_pan', { title: 'Add a salt pan', description: `Generate a salt pan (playa, salt flat) by filling a basin like add_lake, but as dry flat salt ground: Civ4/Civ5 write it as flat desert with no feature (what the classifier makes of a real playa) and the glyph grid shows it as '_'. Games without salt terrain (OpenFront) only mark it. Without at, the lowest closed basin in arid (Köppen B) country is used. ${PATHWAYS}`,
  inputSchema: { at: z.array(z.number()).length(2).optional(), lonlat: z.array(z.number()).length(2).optional(), area: z.number().optional().describe('tiles (default 5)'), compact: z.number().optional(), descend: z.boolean().optional(), name: z.string().optional(), target: genTarget, ...viewOpts } }, report('add_salt_pan'));
server.registerTool('add_river', { title: 'Add a river', description: `Generate a river: from the source it follows the steepest way down a depression-free version of the terrain (priority flood) until it reaches water or joins an existing river, then it is smoothed, given a gentle meander and rasterised onto tile edges like a real river. Discharge rises downstream (default from its length; Civ4 flood plains read it). Without from, the source is the high, humid ground with the longest way to the sea that is not already near a river. ${PATHWAYS}`,
  inputSchema: { path: z.array(z.array(z.number()).length(2)).optional().describe('compose only: hand-draw the channel along these tile points, source first, mouth last (it is meandered a little and rasterised onto tile edges); from/lonlat are then ignored'), from: z.array(z.number()).length(2).optional().describe('source tile [x,y]'), lonlat: z.array(z.number()).length(2).optional().describe('frame only: source as [lon,lat]'), discharge: z.number().optional().describe('m3/s at the mouth'), meander: z.number().optional().describe('0 straight .. 1 strong (default 0.5)'), join: z.boolean().optional().describe('default true: stop where it meets an existing river'), name: z.string().optional(), target: genTarget, ...viewOpts } }, report('add_river'));
server.registerTool('paint', { title: 'Paint a feature or terrain', description: "Stamp a feature or terrain over the land inside a polygon (or rect) of tile coordinates on the collage, on a share `density` of its tiles (default 1): jungle (grassland under it), forest (desert under it becomes plains), oasis and flood_plains (flat desert only), grass / plains / desert / tundra (the terrain; a forest or jungle that cannot stand on the new terrain is dropped), clear (removes features). For the pockets a climate model cannot know: a swamp in a desert, a gallery forest, an oasis belt. Paint AFTER reclimate (it reclassifies everything under it). Remove with features {action:'remove', id}.",
  inputSchema: { kind: z.enum(['jungle', 'forest', 'oasis', 'flood_plains', 'grass', 'plains', 'desert', 'tundra', 'clear']), polygon: z.array(z.array(z.number()).length(2)).optional(), rect: z.array(z.number()).length(4).optional(), density: z.number().optional(), seed: z.number().int().optional(), ...viewOpts } }, report('paint'));
server.registerTool('add_island', { title: 'Add a barrier island', description: "Raise a low island, sandbar, spit or key along a polyline on the collage (tile coordinates), `width` tiles wide (default 1). gaps (0..1) leaves that share of the line as passes, so a barrier chain reads as islets. Thin real islands (barrier islands, keys) vanish at coarse tile scales; trace them back with this. The ground borrows its nearest land's, flat; run reclimate after. Remove with features {action:'remove', id}.",
  inputSchema: { path: z.array(z.array(z.number()).length(2)).describe('[[x,y],...] tile coordinates'), width: z.number().optional(), gaps: z.number().optional(), seed: z.number().int().optional(), ...viewOpts } }, report('add_island'));
server.registerTool('fill_gaps', { title: 'Fill gaps between land', description: "Fill the interstitial sea between the collage's pieces: the land mask is closed by `width` tiles (morphological closing), so straits, inlets and gaps up to about 2*width tiles wide between land become lowland. Each new tile borrows its nearest land tile's ground, flat and featureless; run reclimate afterwards so it gets the climate of where it is. Undo with features {action:'remove', id}.",
  inputSchema: { width: z.number().int().optional().describe('closing radius in tiles (default 3)'), rect: z.array(z.number()).length(4).optional().describe('fill only inside this tile rect [x0,y0,x1,y1] (keep fjords and straits elsewhere)'), ...viewOpts } }, report('fill_gaps'));
server.registerTool('features', { title: 'Generated features', description: 'List, remove (by id, with anything generated with it such as a lake\'s outlet river or salt fringe) or clear the generated lakes, salt pans and rivers of the frame or the compose canvas.',
  inputSchema: { action: z.enum(['list', 'remove', 'clear']).optional(), id: z.string().optional(), target: genTarget } },
  run(async (args: any) => { const r = await call('features', args); return text(`${r.target}: ${r.action}${r.removed ? ` (removed ${r.removed})` : ''}\n` + (r.features.length ? r.features.map((f: any) => fmtFeature(f)).join('\n') : 'no generated features')); }));

/* ---------- go ---------- */
const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP server ready on stdio');
process.stdin.on('end', () => { log('stdin closed; exiting'); wss.close(); process.exit(0); });
