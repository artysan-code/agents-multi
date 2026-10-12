#!/usr/bin/env -S deno run --allow-read --allow-run=deno --allow-env
/**
 * mcp-probe.ts — starts each stdio MCP server of this repository and asks it for `initialize` and
 * `tools/list`, so a dependency upgrade that breaks tool registration fails here and not in a
 * Claude session. No tool is called; servers that need a secret only need it when a tool runs.
 *
 *   deno run --allow-read --allow-run=deno --allow-env scripts/mcp-probe.ts [server …]
 *
 * Exits non-zero when a server does not answer, answers with an error, lists no tools, or when the
 * registry's `_allow`, `_deny` or `_ask` for it names a tool it does not have (a renamed tool would
 * otherwise drop out of its rule without a word). The servers are probed at once.
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
    env: { AGENTS_MULTI_PROFILE: "probe" },
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

/** The registry's rule names for `server` that `tools` lacks. */
export function strayRules(cfg: Record<string, unknown> | undefined, tools: string[]): string[] {
  const names = ["_allow", "_deny", "_ask"].flatMap((k) => (cfg?.[k] as string[] | undefined) ?? []);
  return names.filter((n) => !tools.includes(n));
}

if (import.meta.main) {
  const reg = JSON.parse(await Deno.readTextFile(`${ROOT}shared/mcp/servers.json`)).servers;
  const names = Deno.args.length ? Deno.args : SERVERS;
  const results = await Promise.all(names.map((n) => probe(n)));
  let failed = 0;
  names.forEach((name, i) => {
    const r = results[i];
    if ("error" in r || r.tools.length === 0) {
      failed++;
      console.log(`✗ ${name}: ${"error" in r ? r.error : "no tools"}`);
      return;
    }
    const stray = strayRules(reg[name], r.tools);
    if (stray.length) {
      failed++;
      console.log(`✗ ${name}: servers.json names tools it does not have: ${stray.join(", ")}`);
    } else console.log(`✓ ${name}: ${r.tools.length} tools (${r.tools.join(", ")})`);
  });
  Deno.exit(failed ? 1 : 0);
}
