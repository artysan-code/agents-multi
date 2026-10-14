// A stdio MCP server for the gateway's integration tests (gateway_server_test.ts). Its behaviour comes from
// the environment: FAKE_LOG (a file it appends to: start, call and exit lines), FAKE_DELAY (ms before it
// answers the handshake), FAKE_FAIL (exits at once), FAKE_LINGER (stays up when its stdin closes).
import process from "node:process";
import { Server } from "npm:@modelcontextprotocol/sdk@1.32.1/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "npm:@modelcontextprotocol/sdk@1.32.1/types.js";

const log = (s: string) => {
  const f = Deno.env.get("FAKE_LOG");
  if (f) Deno.writeTextFileSync(f, `${s}\n`, { append: true });
};
if (Deno.env.get("FAKE_FAIL")) Deno.exit(3);
log(`start ${Deno.pid}`);
const gone = () => {
  log(`exit ${Deno.pid}`);
  Deno.exit(0);
};
Deno.addSignalListener("SIGTERM", gone);
const delay = Number(Deno.env.get("FAKE_DELAY") ?? 0);
if (delay) await new Promise((r) => setTimeout(r, delay));

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
const server = new Server({ name: "fake", version: "1" }, {
  capabilities: { tools: {} },
  instructions: "fake backend",
});
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool("echo"), tool("slow"), tool("danger")] }));
server.setRequestHandler(
  CallToolRequestSchema,
  async (req: { params: { name: string; arguments?: { text?: string } } }) => {
    log(`call ${req.params.name} ${Deno.pid}`);
    if (req.params.name === "slow") await new Promise((r) => setTimeout(r, 300));
    return { content: [{ type: "text", text: `${req.params.name}:${req.params.arguments?.text ?? ""}` }] };
  },
);
await server.connect(new StdioServerTransport());
// the gateway went: so does this — unless FAKE_LINGER, a server that does not notice (the reaper's case)
if (Deno.env.get("FAKE_LINGER")) setInterval(() => {}, 60_000);
else process.stdin.on("end", gone);
