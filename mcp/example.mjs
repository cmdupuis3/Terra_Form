#!/usr/bin/env node
/* mcp/example.mjs -- the README's worked example, run as a real MCP client.
 *
 * Spawns server.mjs over stdio (exactly as Claude Code would) and plays the transcript: frame Oman, capture it
 * with a lasso, frame Morocco, capture, compose both on one canvas, view, export. The Terra Form page must be
 * open (python serve.py -> http://localhost:8000/). Each tool's text block is printed as it comes back.
 *
 *   node example.mjs [--out <dir>] [--game civ4]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('--out', path.join(here, 'out')), GAME = opt('--game', 'civ4');

const client = new Client({ name: 'terra-form-example', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'server.mjs')], stderr: 'inherit', env: { ...process.env } }));   // env: the SDK passes only a minimal environment by default; TERRAFORM_WS_PORT must reach the server

async function tool(name, args) {
  console.log(`\n>>> ${name} ${JSON.stringify(args || {})}`);
  const r = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: 600000 });
  const t = r.content.map(c => c.text).join('\n');
  console.log(t);
  if (r.isError) throw new Error(t);
  return t;
}
const snapId = t => (t.match(/^snapshot (\S+)/m) || [])[1];

// wait for the page: status errors until core/bridge.js has connected
for (let i = 0; ; i++) {
  try { await tool('status'); break; }
  catch (e) { if (i >= 20) throw e; console.log('(waiting for the Terra Form page to connect...)'); await new Promise(r => setTimeout(r, 1500)); }
}

await tool('set_game', { id: GAME });
await tool('set_frame', { bounds: [51.5, 16.5, 60.5, 26.5], W: 40, H: 28 });                 // Oman + the Gulf coast
const oman = snapId(await tool('snapshot', { name: 'Oman', lasso: [[51.8, 24.4], [56.4, 26.6], [59.9, 22.8], [59.5, 16.6], [52.6, 16.6], [52.0, 19.5]] }));
await tool('set_frame', { bounds: [-13.5, 27.5, -0.5, 36.0], W: 40, H: 28 });                 // Morocco
const morocco = snapId(await tool('snapshot', { name: 'Morocco', rect: [-13.5, 27.6, -1.0, 35.9] }));
await tool('list_snapshots');
await tool('compose_new', { W: 80, H: 44, fill: 'water' });
await tool('place', { snapshot: morocco, x: 2, y: 4, grid: false });
await tool('place', { snapshot: oman, x: 40, y: 10, grid: false });
await tool('move_patch', { patch: 2, dx: -4, dy: 2, grid: false });
await tool('compose_view', {});
await tool('export', { name: 'oman_morocco', dir: OUT });

await client.close();
