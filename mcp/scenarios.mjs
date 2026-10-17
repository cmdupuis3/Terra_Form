#!/usr/bin/env node
/* mcp/scenarios.mjs -- the four acceptance scenarios of SCENARIOS.md, run through the MCP tools.
 *
 * Each scenario is the tool-call sequence an agent would make for its prompt, followed by machine-checkable
 * assertions over the `describe` JSON and the glyph grid. Results (transcript, assertion table, describe
 * paragraph) go to scenarios/RESULTS.md, thumbnails to scenarios/s<N>.png, exports to out/.
 *
 *   node scenarios.mjs [1 2 3 4]        (the page must be open; TERRAFORM_WS_PORT as usual)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), OUT = path.join(here, 'scenarios'), EXPORT = path.join(here, 'out');
const want = process.argv.slice(2).map(Number).filter(Boolean);
const client = new Client({ name: 'terra-form-scenarios', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'server.mjs')], stderr: 'inherit', env: { ...process.env } }));
await fs.mkdir(OUT, { recursive: true });

const md = [];
let transcript = [];
async function tool(name, args) {
  let r, t;
  for (let i = 0; ; i++) {
    r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 600000 }); t = r.content.map(c => c.text).join('\n');
    if (!(r.isError && /No Terra Form page is connected/.test(t) && i < 15)) break;
    await new Promise(res => setTimeout(res, 1000));
  }
  transcript.push({ name, args, text: t, error: !!r.isError });
  if (r.isError) throw new Error(`${name} failed: ${t}`);
  return t;
}
const lastJson = t => JSON.parse(t.trim().split('\n').pop());
const gridOf = t => { const rows = []; for (const line of t.split('\n')) { const m = line.match(/^\s*(\d+)\|(.*)$/); if (m) rows[+m[1]] = m[2]; } return rows; };
const count = (rows, re) => rows.reduce((n, r) => n + (r ? (r.match(re) || []).length : 0), 0);
const LAND = /[^~,]/g;
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
const A = (name, pass, detail) => ({ name, pass: !!pass, detail });

/* ---------- geometry helpers for the assertions ---------- */
function circleFit(pts) {   // Kasa algebraic fit -> {cx, cy, r, meanResidual}
  const n = pts.length; if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], v = [sxz, syz, sz];
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M); if (Math.abs(D) < 1e-9) return null;
  const col = (i) => M.map((row, r) => row.map((c, j) => j === i ? v[r] : c));
  const a = det(col(0)) / D, b = det(col(1)) / D, c = det(col(2)) / D, cx = a / 2, cy = b / 2, r = Math.sqrt(Math.max(0, c + cx * cx + cy * cy));
  const res = pts.reduce((s, [x, y]) => s + Math.abs(Math.hypot(x - cx, y - cy) - r), 0) / n;
  return { cx, cy, r, meanResidual: res };
}
function pearson(xs, ys) { const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0; }
const AXIS = { 'N-S': [0, 1], 'E-W': [1, 0], 'NE-SW': [1, -1], 'NW-SE': [1, 1] };
function sideOf(spine, x, y) { const [ax, ay] = AXIS[spine.orientation] || [1, 0]; return ((x - spine.at[0]) * ay - (y - spine.at[1]) * ax) >= 0 ? 1 : -1; }   // which side of the spine's principal axis a tile lies on
function chebyshevNear(rows, re, marks, d) { let near = 0, tot = 0; for (let y = 0; y < rows.length; y++) { const r = rows[y]; if (!r) continue; for (let x = 0; x < r.length; x++) { if (!re.test(r[x])) continue; tot++; let ok = false; for (let yy = y - d; yy <= y + d && !ok; yy++) for (let xx = x - d; xx <= x + d; xx++) if (marks.has(xx + ',' + yy)) { ok = true; break; } if (ok) near++; } } return { near, tot }; }

/* ---------- the scenarios ---------- */
const SCENARIOS = [
  {
    n: 1, title: 'Earthlike alien world', game: 'civ4', W: 160, H: 100,
    prompt: 'Build an Earthlike world that is not recognisable as Earth: 4-6 continents of varied size, polar caps top and bottom, tropics in the middle, at least two inland seas and one large archipelago.',
    async run() {
      await tool('set_game', { id: 'civ4' });
      await tool('tune', { params: {}, reset: true, report: false });   // settings persist on the page: start every scenario from the defaults
      await tool('tune', { params: { feat: true, alpine: 0.2 }, report: false });
      await tool('snapshot_from_catalog', { entry: 'Antarctic coast', W: 160, H: 14, grid: false });
      await tool('flip_snapshot', { id: 'Antarctic coast', axis: 'y', name: 'North cap', grid: false });
      await tool('snapshot_from_catalog', { entry: 'Anatolia', W: 84, H: 35, grid: false });   // sizes chosen against the budget line (target 28-38% land)
      await tool('snapshot_from_catalog', { entry: 'Korea', W: 46, H: 59, grid: false });
      await tool('flip_snapshot', { id: 'Korea', axis: 'x', name: 'Korea mirrored', grid: false });
      await tool('snapshot_from_catalog', { entry: 'New Guinea', W: 76, H: 38, grid: false });
      await tool('snapshot_from_catalog', { entry: 'Iberia', W: 60, H: 38, grid: false });
      await tool('flip_snapshot', { id: 'Iberia', axis: 'y', name: 'Iberia mirrored', grid: false });
      await tool('snapshot_from_catalog', { entry: 'Society Islands', W: 32, H: 16, grid: false });
      for (const e of ['Tahiti', 'Upolu', 'Funafuti', 'Tarawa']) await tool('snapshot_from_catalog', { entry: e, grid: false });
      await tool('compose_new', { W: 160, H: 100, fill: 'water', latitudes: { top: 80, bottom: -80 }, targetLand: [0.28, 0.38], grid: false });
      await tool('place', { snapshot: 'North cap', x: 0, y: -8, grid: false });
      await tool('place', { snapshot: 'Antarctic coast', x: 0, y: 94, grid: false });
      await tool('place', { snapshot: 'New Guinea', x: 44, y: 31, ragged: true, grid: false });   // rows 31-68: inside the tropical band; placed first, the others keep clear of it
      await tool('place', { snapshot: 'Anatolia', x: 2, y: 8, ragged: true, avoidLand: true, gap: 2, grid: false });   // ragged: the frame-border cuts through land are feathered; avoidLand: no merging into one super-continent
      await tool('place', { snapshot: 'Korea mirrored', x: 114, y: 8, ragged: true, avoidLand: true, gap: 2, grid: false });
      await tool('place', { snapshot: 'Iberia mirrored', x: 4, y: 60, ragged: true, avoidLand: true, gap: 2, grid: false });
      await tool('place', { snapshot: 'Society Islands', x: 4, y: 44, avoidLand: true, grid: false });   // the archipelago stays inside the tropical band (rows 30-70)
      await tool('scatter', { snapshots: ['Tahiti', 'Funafuti', 'Upolu', 'Tarawa'], along: [[8, 52], [40, 54]], spacing: 6, avoidLand: true, grid: false });
      /* inland seas: punch a lake into the two largest continents, at a land tile near each centroid (describe tells us where the continents are) */
      const D0 = lastJson(await tool('describe', { target: 'compose', rows: true })), rows = gridOf(await tool('compose_view', { step: 1 }));
      const isLand = (x, y) => rows[y] && rows[y][x] && !/[~,]/.test(rows[y][x]);
      for (const c of D0.landmasses.filter(l => l.size >= 300).slice(0, 2)) {
        let [x, y] = c.at, found = null;
        for (let r = 0; r <= 10 && !found; r++) for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) { const xx = x + dx, yy = y + dy; let ok = true; for (let j = -2; j <= 2 && ok; j++) for (let i = -3; i <= 3 && ok; i++) if (!isLand(xx + i, yy + j)) ok = false; if (ok) found = [xx, yy]; }
        if (found) await tool('erase', { rect: [found[0] - 2, found[1] - 1, found[0] + 2, found[1] + 1], grid: false });
      }
      await tool('trim_rivers', { grid: false });   // rivers cut by the seams and the erasures are dropped; endorheic ones stay
    },
    assert(D, rows) {
      const H = rows.length, land = count(rows, LAND), tot = D.W * D.H, out = [];
      out.push(A('land 28-38%', land / tot >= 0.28 && land / tot <= 0.38, pct(land, tot) + '% land'));
      const cont = D.landmasses.filter(c => c.size >= 60 && c.at[1] > 0.1 * H && c.at[1] < 0.9 * H), big = cont.length, small = D.landmassCount - D.landmasses.filter(c => c.size >= 20).length;   // continents: outside the cap rows (the cap strips are landmasses too)
      out.push(A('4-6 continents (landmasses >= 60 tiles outside the top/bottom 10% rows)', big >= 4 && big <= 6, big + ' continents (' + cont.map(c => c.size).join(', ') + ')'));
      out.push(A('>= 8 small landmasses (archipelago)', small >= 8, small + ' landmasses under 20 tiles'));
      const polarRow = y => y < 0.15 * H || y > 0.85 * H; let coldBad = 0, coldAll = 0;
      rows.forEach((r, y) => { const n = (r.match(/[stST]/g) || []).length; coldAll += n; if (!polarRow(y)) coldBad += n; });
      out.push(A('snow/tundra only in the top and bottom 15% of rows', coldBad === 0, coldBad + ' of ' + coldAll + ' snow/tundra tiles outside the caps'));
      let tropBad = 0, tropAll = 0; for (const r of D.rows || []) { if (!r.groups) continue; const t = r.groups[3]; tropAll += t; if (r.y < 0.3 * H || r.y > 0.7 * H) tropBad += t; }
      out.push(A('tropical groups only in the middle 40% of rows', tropBad === 0, tropBad + ' of ' + tropAll + ' tropical tiles outside rows ' + Math.ceil(0.3 * H) + '-' + Math.floor(0.7 * H)));
      out.push(A('>= 2 inland seas', (D.seas || []).filter(s => s.inland).length >= 2, (D.seas || []).filter(s => s.inland).map(s => s.size + 't at ' + s.at.join(',')).join('; ') || 'none'));
      out.push(A('zero seam-lint warnings', (D.warnings || []).length === 0, (D.warnings || []).length + ' warnings: ' + summarizeWarnings(D.warnings)));
      out.push(A('>= 80% of river systems reach water', D.rivers.systems && D.rivers.reachWater / D.rivers.systems >= 0.8, D.rivers.reachWater + '/' + D.rivers.systems + ' reach water'));
      return out;
    }
  },
  {
    n: 2, title: 'A desert', game: 'civ4', W: 72, H: 48, frame: true,
    prompt: 'A desert map with a Nile-like exotic river running from a mountain rim to the sea, an oasis belt along the river, a salt pan basin, and a semi-arid steppe fringe on one edge.',
    async run() {
      await tool('set_game', { id: 'civ4' });
      await tool('tune', { params: {}, reset: true, report: false });   // settings persist on the page: start every scenario from the defaults
      await tool('tune', { params: { feat: true, fpAmt: 0.9, oasisDens: 0.3, riverN: 5, hill: 0.8, peak: 0.94, alpine: 0.3 }, report: false });
      await tool('set_frame', { bounds: [24, 22, 37, 32], W: 72, H: 48, grid: false });
      await tool('frame_view', { overlay: 'rivers' });
    },
    extra: 'frame_view',
    assert(D, rows, rowsRiver) {
      const land = count(rows, LAND), out = [];
      const desert = count(rows, /[dDro]/g), openGreen = count(rows, /[gpGPfF]/g), flood = count(rows, /r/g);
      out.push(A('desert >= 55% of land', desert / land >= 0.55, pct(desert, land) + '% desert (flood plains and oases counted as desert)'));
      out.push(A('plains/grass <= 25% of land', openGreen / land <= 0.25, pct(openGreen, land) + '% plains/grass/forest'));
      const marks = new Set(); rowsRiver.forEach((r, y) => { if (r) for (let x = 0; x < r.length; x++) if (r[x] === '=') marks.add(x + ',' + y); });
      for (let y = 0; y <= 5; y++) for (let x = 0; x < D.W; x++) marks.add(x + ',' + y);   // the steppe fringe: the north edge rows (the Mediterranean coast strip) count as "on the edge"
      const nr = chebyshevNear(rows, /[gpGP]/, marks, 3);
      out.push(A('plains/grass within 3 tiles of the river or on the steppe edge', nr.tot && nr.near / nr.tot >= 0.8, nr.near + '/' + nr.tot + ' green tiles near the river or the north edge'));
      const bigRiver = (D.rivers.systemsTop || []).find(s => s.edges >= 15 && s.reaches === 'water');
      out.push(A('>= 1 river with >= 15 edges reaching the coast', !!bigRiver, bigRiver ? 'river ' + bigRiver.rid + ' ' + bigRiver.edges + ' edges' : (D.rivers.systemsTop || []).map(s => s.edges + 'e ' + s.reaches).join(', ')));
      const hp = D.landmasses.reduce((s, c) => s + (c.hills || 0) + (c.peaks || 0), 0), sp = D.spines[0];
      const oneSide = sp && (sp.bbox[0] <= 1 || sp.bbox[2] >= D.W - 2 || sp.bbox[1] <= 1 || sp.bbox[3] >= D.H - 2);
      out.push(A('hills+peaks 10-25% of land', hp / land >= 0.10 && hp / land <= 0.25, pct(hp, land) + '% relief'));
      out.push(A('relief forms a connected ridge along one side', sp && sp.size >= 0.5 * hp && oneSide, sp ? `largest spine ${sp.size}t of ${hp} relief tiles, ${sp.orientation}, bbox ${sp.bbox.join(',')}` : 'no spine'));
      out.push(A('flood plains present along the river', flood > 0, flood + ' flood-plain tiles'));
      return out;
    }
  },
  {
    n: 3, title: 'A tropical island chain', game: 'civ4', W: 80, H: 50,
    prompt: 'An ocean map with a curving chain of atolls and a few larger volcanic islands, spaced so none touch, a size gradient from big in the southwest to tiny in the northeast.',
    async run() {
      await tool('set_game', { id: 'civ4' });
      await tool('tune', { params: {}, reset: true, report: false });   // settings persist on the page: start every scenario from the defaults
      await tool('tune', { params: { feat: true, alpine: 0.1 }, report: false });
      await tool('snapshot_from_catalog', { entry: 'Savaii', W: 24, H: 15, grid: false });
      await tool('snapshot_from_catalog', { entry: 'Tahiti', W: 24, H: 22, grid: false });
      await tool('snapshot_from_catalog', { entry: 'Upolu', W: 20, H: 9, grid: false });
      for (const [e, x] of [['Funafuti', 0.9], ['Tarawa', 0.3], ['Majuro', 0.5], ['Addu Atoll', 0.5]]) await tool('snapshot_from_catalog', { entry: e, params: { islandExpand: x }, grid: false });   // default 8x8 captures; the island expander sets the islet size (1-6 tiles)
      await tool('compose_new', { W: 80, H: 50, fill: 'water', latitudes: { top: 12, bottom: -12 }, grid: false });
      /* points on one circle (centre 70,60 r 52), big in the south-west, tiny in the north-east */
      await tool('scatter', { snapshots: ['Savaii'], along: [[23, 38]], grid: false });
      await tool('scatter', { snapshots: ['Tahiti', 'Upolu'], along: [[28, 30], [34, 23]], spacing: 9, avoidLand: true, gap: 2, grid: false });
      await tool('scatter', { snapshots: ['Tarawa', 'Funafuti'], along: [[39, 18.5], [48, 12.9], [56.5, 9.8]], spacing: 3.5, avoidLand: true, gap: 2, grid: false });   // the size gradient continues along the atoll arc: mid-size islets first ...
      await tool('scatter', { snapshots: ['Majuro', 'Addu Atoll'], along: [[60, 9], [65.5, 8.2], [76, 8.5]], spacing: 3, avoidLand: true, gap: 2, grid: false });   // ... one-tile ones at the north-east end
    },
    assert(D, rows) {
      const land = count(rows, LAND), tot = D.W * D.H, out = [], L = D.landmasses;
      out.push(A('land 6-14%', land / tot >= 0.06 && land / tot <= 0.14, pct(land, tot) + '% land'));
      out.push(A('12-30 landmasses', D.landmassCount >= 12 && D.landmassCount <= 30, D.landmassCount + ' landmasses'));
      const gap = minGap(rows, 5);
      out.push(A('minimum gap between islands of 5+ tiles >= 2 water tiles', gap >= 2, `closest pair of 5+ tile islands has ${gap} water tile${gap === 1 ? '' : 's'} between them`));
      const big = L.filter(c => c.size >= 20).length, mid = L.filter(c => c.size > 6 && c.size < 20).length;
      out.push(A('2-4 landmasses >= 20 tiles, the rest <= 6', big >= 2 && big <= 4 && mid === 0, `${big} >= 20t, ${mid} between 7 and 19t, sizes ${L.map(c => c.size).join(' ')}`));
      const fit = circleFit(L.map(c => c.at));
      out.push(A('centroids fit a circle (mean residual <= 2 tiles)', fit && fit.meanResidual <= 2, fit ? `r ${fit.r.toFixed(1)} centre ${fit.cx.toFixed(0)},${fit.cy.toFixed(0)} mean residual ${fit.meanResidual.toFixed(2)}` : 'no fit'));
      const mono = monotoneAlongArc(L);
      out.push(A('size falls monotonically along the arc SW -> NE (3 bins, non-increasing, first > last)', mono.ok, 'mean log size per bin SW->NE: ' + mono.bins.map(b => b.toFixed(2)).join(' >= ') + (mono.ok ? '' : ' (not monotone)')));
      const bad = L.filter(c => c.climate && !['tropical', 'arid'].includes(c.climate[0].group));
      out.push(A('all land tropical (A) or arid-coastal', bad.length === 0, bad.length ? bad.map(c => `#${c.id} ${c.size}t ${c.climate[0].group}`).join('; ') : 'all tropical/arid'));
      return out;
    }
  },
  {
    n: 4, title: 'A temperate region with mountain chains', game: 'civ4', W: 112, H: 70,
    prompt: 'A temperate land with two mountain chains meeting at a knot, forested windward slopes, drier basins in the lee, rivers draining from the ranges to two different coasts.',
    async run() {
      await tool('set_game', { id: 'civ4' });
      await tool('tune', { params: {}, reset: true, report: false });   // settings persist on the page: start every scenario from the defaults
      await tool('tune', { params: { feat: true, forestDens: 0.7, hill: 0.68, peak: 0.88, riverN: 14, alpine: 0.3 }, report: false });
      await tool('snapshot_from_catalog', { entry: 'Caucasus isthmus', bounds: [40, 36.5, 55, 47.2], W: 60, H: 44, grid: false });
      await tool('snapshot_from_catalog', { entry: 'Cascades and Sierra', grid: false });
      await tool('compose_new', { W: 112, H: 70, fill: 'water', latitudes: { top: 52, bottom: 32 }, grid: false });
      await tool('place', { snapshot: 'Caucasus isthmus', x: 46, y: 14, landOnly: false, grid: false });
      await tool('attach', { a: 'Caucasus isthmus', edgeA: 'W', b: 'Cascades and Sierra', edgeB: 'E', overlap: 22, align: 'relief', ragged: true, grid: false });   // deep overlap so the N-S range runs into the E-W one; align:'relief' puts the ranges' edge anchors on one row; ragged cuts a min-cost seam
      await tool('trim_rivers', { grid: false });
    },
    assert(D, rows) {
      const land = count(rows, LAND), out = [];
      let temp = 0, allg = 0; for (const r of D.rows || []) if (r.groups) { temp += r.groups[4] + r.groups[5]; allg += r.groups.reduce((a, b) => a + b, 0); }
      out.push(A('temperate/continental >= 70% of land', allg && temp / allg >= 0.7, pct(temp, allg) + '% temperate+continental'));
      const hp = D.landmasses.reduce((s, c) => s + (c.hills || 0) + (c.peaks || 0), 0);
      out.push(A('hills+peaks 18-35% of land', hp / land >= 0.18 && hp / land <= 0.35, pct(hp, land) + '% relief'));
      const chains = D.spines.filter(s => s.size >= 25);
      const knots = chains.reduce((s, c) => s + ((c.knots || []).length), 0);
      out.push(A('1-2 chains >= 25 tiles with a junction', chains.length >= 1 && chains.length <= 2 && knots >= 1, chains.length + ' chains >= 25t: ' + chains.map(s => `${s.orientation} ${s.size}t chain ${s.chain || '?'} ${(s.knots || []).length} knots`).join(', ')));
      const sp = D.spines[0]; let fA = 0, fB = 0, gA = 0, pA = 0, gB = 0, pB = 0;
      if (sp) rows.forEach((r, y) => { if (!r) return; for (let x = 0; x < r.length; x++) { const c = r[x], s = sideOf(sp, x, y); if (/[fF]/.test(c)) { if (s > 0) fA++; else fB++; } if (/[gG]/.test(c)) { if (s > 0) gA++; else gB++; } if (/[pP]/.test(c)) { if (s > 0) pA++; else pB++; } } });
      const fr = Math.max(fA, fB) / Math.max(1, Math.min(fA, fB));
      out.push(A('forest density one side of the main chain >= 1.5x the other', sp && fr >= 1.5, `forest ${fA} vs ${fB} tiles across the ${sp ? sp.orientation : '?'} spine (ratio ${fr.toFixed(2)})`));
      const rA = gA / Math.max(1, gA + pA), rB = gB / Math.max(1, gB + pB);
      out.push(A('grass/plains ratio flips across the chain', sp && ((rA > 0.5) !== (rB > 0.5)), `grass share ${(rA * 100).toFixed(0)}% vs ${(rB * 100).toFixed(0)}%`));
      out.push(A('zero truncated-wall warnings', !(D.warnings || []).some(w => w.rule === 'truncated-wall'), summarizeWarnings(D.warnings)));
      out.push(A('>= 2 rivers reaching distinct coasts (water bodies)', (D.rivers.seasReached || []).length >= 2, `rivers reach water bodies ${JSON.stringify(D.rivers.seasReached || [])}; ${D.rivers.reachWater}/${D.rivers.systems} reach water`));
      return out;
    }
  }
];
/* minimum number of water tiles between any two landmasses (8-connected components of land glyphs), capped at 3 */
function minGap(rows, minSize) {
  const H = rows.length, W = Math.max(...rows.map(r => r ? r.length : 0)), lab = new Int32Array(W * H); let n = 0; const sizes = [0];
  const land = (x, y) => y >= 0 && y < H && rows[y] && x >= 0 && x < rows[y].length && !/[~,]/.test(rows[y][x]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!land(x, y) || lab[y * W + x]) continue; n++; sizes.push(0); const st = [[x, y]]; lab[y * W + x] = n; while (st.length) { const [cx, cy] = st.pop(); sizes[n]++; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx + dx, ny = cy + dy; if (land(nx, ny) && !lab[ny * W + nx]) { lab[ny * W + nx] = n; st.push([nx, ny]); } } } }
  let best = 3; const ok = l => sizes[l] >= (minSize || 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const l = lab[y * W + x]; if (!l || !ok(l)) continue; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const m = lab[ny * W + nx]; if (m && m !== l && ok(m)) best = Math.min(best, Math.max(Math.abs(dx), Math.abs(dy)) - 1); } }
  return best;
}
/* sizes binned along the SW -> NE direction (t = x - y) must fall bin to bin */
function monotoneAlongArc(L) {
  const pts = L.map(c => ({ t: c.at[0] - c.at[1], s: Math.log(c.size) })).sort((a, b) => a.t - b.t), k = 3, bins = [];
  for (let i = 0; i < k; i++) { const sl = pts.slice(Math.floor(i * pts.length / k), Math.floor((i + 1) * pts.length / k)); bins.push(sl.length ? sl.reduce((a, p) => a + p.s, 0) / sl.length : NaN); }
  let ok = pts.length >= k && bins[k - 1] < bins[0]; for (let i = 1; i < k; i++) if (!(bins[i] <= bins[i - 1])) ok = false;
  return { ok, bins };
}
function summarizeWarnings(ws) { const m = new Map(); for (const w of ws || []) m.set(w.rule, (m.get(w.rule) || 0) + 1); return [...m.entries()].map(([k, v]) => `${k} x${v}`).join(', ') || 'none'; }

/* ---------- run ---------- */
for (const S of SCENARIOS) {
  if (want.length && !want.includes(S.n)) continue;
  transcript = []; console.log(`\n=== Scenario ${S.n}: ${S.title}`);
  let D, rows, rowsRiver = [], asserts = [], err = null;
  try {
    await S.run();
    const target = S.frame ? 'frame' : 'compose';
    const dText = await tool('describe', { target, rows: true }); D = lastJson(dText); D.summary = dText.split('\n')[1]; D.warnings = D.warnings || []; D.notes = D.notes || [];
    const viewTool = S.frame ? 'frame_view' : 'compose_view';
    rows = gridOf(await tool(viewTool, { step: 1 }));
    if (S.frame) rowsRiver = gridOf(await tool(viewTool, { step: 1, overlay: 'rivers' }));
    asserts = S.assert(D, rows, rowsRiver);
    await tool('thumbnail', { target, path: path.join(OUT, `s${S.n}.png`), maxPx: 720 });
    await tool('export', { name: `scenario${S.n}`, dir: EXPORT });
  } catch (e) { err = e.message; console.error('scenario failed:', e.message); }
  const passed = asserts.filter(a => a.pass).length;
  console.log(asserts.map(a => `${a.pass ? 'PASS' : 'FAIL'} ${a.name} — ${a.detail}`).join('\n'));
  md.push(`## Scenario ${S.n}: ${S.title}\n\n**Prompt.** ${S.prompt}\n\n**Result: ${passed}/${asserts.length} assertions pass.**${err ? ` Run error: ${err}` : ''}\n`);
  md.push('| assertion | result | detail |\n|---|---|---|\n' + asserts.map(a => `| ${a.name} | ${a.pass ? 'pass' : 'FAIL'} | ${a.detail.replace(/\|/g, '/')} |`).join('\n') + '\n');
  if (D) md.push(`**describe.** ${D.summary}\n\n${D.warnings ? (D.warnings.length ? 'Warnings: ' + D.warnings.map(w => `[${w.rule}] ${w.msg}`).join('; ') : 'Warnings: none') : ''}\n\n![scenario ${S.n}](s${S.n}.png)\n`);
  md.push('<details><summary>Tool-call sequence and feedback</summary>\n\n' + transcript.filter(t => !['describe', 'thumbnail'].includes(t.name) || t.error).map(t => `\`\`\`\n>>> ${t.name} ${JSON.stringify(t.args)}\n${t.text.split('\n').slice(0, S.n === 2 ? 60 : 14).join('\n')}${t.text.split('\n').length > (S.n === 2 ? 60 : 14) ? '\n...' : ''}\n\`\`\``).join('\n') + '\n\n</details>\n');
  await fs.writeFile(path.join(OUT, `s${S.n}.md`), md.join('\n') + '\n'); md.length = 0;   // one file per scenario, so a single scenario can be re-run
}
const parts = []; for (const n of [1, 2, 3, 4]) { try { parts.push(await fs.readFile(path.join(OUT, `s${n}.md`), 'utf8')); } catch (e) {} }
await fs.writeFile(path.join(OUT, 'RESULTS.md'), `# Scenario results\n\nGenerated by \`node mcp/scenarios.mjs\` (last run ${new Date().toISOString().slice(0, 10)}).\n\n` + parts.join('\n'));
console.log(`\nwrote ${path.join(OUT, 'RESULTS.md')}`);
await client.close();
