#!/usr/bin/env node
/* mcp/call.mjs -- one-shot tool calls from a shell, for trying the bridge without an MCP client.
 *
 *   node call.mjs status
 *   node call.mjs set_game '{"id":"openfront"}' set_frame '{"bounds":[51,16,61,27],"W":96,"H":64,"step":2}'
 *
 * Each run spawns server.mjs over stdio, waits for the page to (re)connect, plays the calls in order and
 * exits. All state lives in the page, so successive runs continue where the last one left off.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), argv = process.argv.slice(2);
if (!argv.length) {
    console.error('usage: node call.mjs <tool> [json-args] [<tool> [json-args] ...]');
    process.exit(2);
}
const calls = [];
for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    let args = {};
    if (argv[i + 1] && /^[\[{]/.test(argv[i + 1]))
        args = JSON.parse(argv[++i]);
    calls.push([name, args]);
}
const client = new Client({ name: 'terra-form-call', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'server.mjs')], stderr: 'inherit', env: { ...process.env } }));
let failed = false;
for (const [name, args] of calls) {
    let r;
    for (let i = 0;; i++) { // the page reconnects within ~5 s of the server starting
        r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
        const t = r.content.map(c => c.text).join('\n');
        if (!(r.isError && /No Terra Form page is connected/.test(t) && i < 10)) {
            console.log(`>>> ${name} ${JSON.stringify(args)}\n${t}\n`);
            break;
        }
        await new Promise(res => setTimeout(res, 1000));
    }
    if (r.isError) {
        failed = true;
        break;
    }
}
await client.close();
process.exit(failed ? 1 : 0);
