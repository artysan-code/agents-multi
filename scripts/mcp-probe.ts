#!/usr/bin/env -S deno run --allow-read --allow-run=deno --allow-env
/**
 * mcp-probe.ts — starts each stdio MCP server of this repository and asks it for `initialize` and
 * `tools/list`, so a dependency upgrade that breaks tool registration fails here and not in a
 * Claude session. No tool is called; servers that need a secret only need it when a tool runs.
 *
 *   deno run --allow-read --allow-run=deno --allow-env scripts/mcp-probe.ts [server …]
 *
 * Exits non-zero when a server does not answer, answers with an error, or lists no tools.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const SERVERS = ["coolify", "google", "syncthing-status", "tasks"];

/** One JSON-RPC request line as MCP's stdio transport frames it. */
function frame(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

/** The tool names a server lists, or the reason it could not list them. */
export async function probe(name: string, timeoutMs = 20_000): Promise<{ tools: string[] } | { error: string }> {
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--quiet",
      "-A",
      "--no-config",
      `--lock=${ROOT}shared/mcp/${name}/deno.lock`,
      `${ROOT}shared/mcp/${name}/server.ts`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { CLAUDE_MULTI_PROFILE: "probe" },
  }).spawn();
  // read stderr alongside, so a server that exits early can say why
  const stderr = new Response(child.stderr).text();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(
    frame(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-probe", version: "1" },
    }) + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + frame(2, "tools/list"),
  ));
  const timer = setTimeout(() => child.kill(), timeoutMs);
  let buf = "";
  try {
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let msg: { id?: number; error?: { message: string }; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          if (msg.error) return { error: msg.error.message };
          return { tools: (msg.result?.tools ?? []).map((t) => t.name) };
        }
        if (msg.id === 1 && msg.error) return { error: `initialize: ${msg.error.message}` };
      }
    }
    const err = (await stderr).trim().split("\n").slice(-3).join(" | ");
    return { error: err || `exited with ${(await child.status).code} without answering` };
  } finally {
    clearTimeout(timer);
    await w.close().catch(() => {});
    try {
      child.kill();
    } catch {
      // already exited
    }
  }
}

if (import.meta.main) {
  let failed = 0;
  for (const name of Deno.args.length ? Deno.args : SERVERS) {
    const r = await probe(name);
    if ("error" in r || r.tools.length === 0) {
      failed++;
      console.log(`✗ ${name}: ${"error" in r ? r.error : "no tools"}`);
    } else console.log(`✓ ${name}: ${r.tools.length} tools (${r.tools.join(", ")})`);
  }
  Deno.exit(failed ? 1 : 0);
}
