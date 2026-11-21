/* core/bridge-protocol.d.ts -- the MCP bridge's wire protocol: JSON messages over a local WebSocket between
 * the page (core/bridge.ts, the client) and the MCP server (mcp/server.mts, which listens on 127.0.0.1).
 * Ambient and dependency-free, so both TypeScript projects include it (the browser one and the Node one).
 */
/** server -> page: run command `cmd` (a key of the bridge's command table) with `args`. */
interface BridgeRequest { id: number; cmd: string; args?: Record<string, any> }
/** page -> server: the outcome of request `id`. */
type BridgeResponse = { id: number; ok: true; result: any } | { id: number; ok: false; error: string };
/** page -> server, once per connection. */
interface BridgeHello { hello: { app: string; game: string | null; url: string } }
/** Anything the page sends, as the server reads it before telling a hello from a response. */
type BridgeMessage = Partial<BridgeHello> & { id?: number; ok?: boolean; result?: any; error?: string };
