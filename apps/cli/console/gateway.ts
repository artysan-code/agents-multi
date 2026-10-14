// gateway.ts (console) — keeps the lazy MCP gateway (docs/adr/0008) running. The gateway is a process of its
// own, not a thread of the console: a console that stops or updates leaves it up, and a new one takes it
// over. Each tick: gateway wanted and not answering → start it (backing off when it keeps failing); answering
// with the code of an older console → stop it, the next tick starts the new one; not wanted any more
// (the kill switch) → stop it. No systemd: the console is the supervisor, and it is always up in app mode.

import { cacheState, gatewayCommand, gatewayConfig, syncGateway } from "../mcp/gateway.ts";
import { backendsPath, type GatewaySettings, loadGatewaySettings } from "../mcp/gateway-settings.ts";
import { denoFor, loadRegistry } from "../mcp/registry.ts";
import { codeVersion } from "../codeversion.ts";
import { installation } from "../lib/mode.ts";
import { HOME } from "../lib/paths.ts";

export interface Health {
  pid: number;
  code: string;
  backends: number;
}

/** What the gateway at `port` says about itself, or null when nothing of ours answers. */
export async function gatewayHealth(port: number): Promise<Health | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    return h?.gateway === true ? h as Health : null;
  } catch {
    return null;
  }
}

/** Pure: whether a command line (a /proc/<pid>/cmdline, NUL-separated) is the gateway's. */
export const isGatewayCmdline = (cmdline: string) =>
  cmdline.split("\0").some((a) => a.endsWith("mcp/gateway/server.ts"));

/** Stops the gateway of pid `pid`, after making sure that is what the process is. */
export async function stopGateway(pid: number): Promise<boolean> {
  const cmd = await Deno.readTextFile(`/proc/${pid}/cmdline`).catch(() => "");
  if (!isGatewayCmdline(cmd)) return false;
  try {
    Deno.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function command(g: GatewaySettings) {
  return gatewayCommand(g, denoFor((await installation()).mode), HOME);
}

/** Runs the gateway in the foreground (`agents gateway run`, for a machine with no console), until it ends. */
export async function runGateway(code: string): Promise<number> {
  const mode = (await installation()).mode;
  const g = await loadGatewaySettings(mode);
  if (!await Deno.stat(backendsPath(g.runtime)).catch(() => null)) await syncGateway(await loadRegistry(), code);
  const [cmd, ...args] = await command(g);
  const p = new Deno.Command(cmd, {
    args,
    env: { ...Deno.env.toObject(), AGENTS_MULTI_GATEWAY_CODE: code },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  return (await p.status).code;
}

/** Starts supervising; stops when `signal` aborts (the gateway itself is left running). */
export function superviseGateway(
  signal: AbortSignal,
  code: string,
  log: (s: string) => void = console.log,
  every = 5000,
) {
  let child: Deno.ChildProcess | null = null;
  let startedAt = 0, failures = 0, nextTry = 0;
  const spawn = async (g: GatewaySettings) => {
    if (!await Deno.stat(backendsPath(g.runtime)).catch(() => null)) await syncGateway(await loadRegistry(), code);
    const [cmd, ...args] = await command(g);
    const c = new Deno.Command(cmd, {
      args,
      env: { ...Deno.env.toObject(), AGENTS_MULTI_GATEWAY_CODE: code },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    child = c;
    startedAt = Date.now();
    c.unref();
    void c.status.then((st) => {
      if (child === c) child = null;
      // quick exits (a port taken by something else, a broken config) back off; a long run resets
      failures = Date.now() - startedAt < 5000 ? failures + 1 : 0;
      nextTry = Date.now() + Math.min(60_000, 2000 * 2 ** failures);
      log(`gateway: exited with ${st.code}${st.signal ? ` (${st.signal})` : ""}`);
    });
    log(`gateway: started pid ${c.pid}`);
  };
  const tick = async () => {
    try {
      const g = await loadGatewaySettings((await installation()).mode);
      const h = await gatewayHealth(g.port);
      if (!g.enabled) {
        if (h && await stopGateway(h.pid)) log(`gateway: switched off, stopped pid ${h.pid}`);
        return;
      }
      if (h) {
        failures = 0;
        if (h.code !== code && await stopGateway(h.pid)) log(`gateway: pid ${h.pid} runs older code, restarting`);
        return;
      }
      if ((child && Date.now() - startedAt < 15_000) || Date.now() < nextTry) return;
      await spawn(g);
    } catch (e) {
      log(`gateway: ${(e as Error).message}`);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), every);
  signal.addEventListener("abort", () => clearInterval(timer));
}

/** `agents gateway [status|run]`: what the gateway is doing, or run it here in the foreground. */
export async function gatewayCli(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  const code = await codeVersion();
  if (sub === "run") return await runGateway(code);
  if (sub !== "status") {
    console.error(`gateway: unknown subcommand "${sub}" (status|run)`);
    return 2;
  }
  const reg = await loadRegistry();
  const g = reg.gateway!;
  const h = await gatewayHealth(g.port);
  console.log(`gateway ${g.enabled ? "on" : "off"} · 127.0.0.1:${g.port} · idle stop ${g.idleMs / 60_000} min`);
  console.log(h ? `  running, pid ${h.pid}, ${h.backends} backend(s) started` : "  not running");
  if (g.enabled) {
    const cfg = await gatewayConfig(reg, code);
    for (const c of await cacheState(cfg, g.runtime)) {
      console.log(`  ${c.profile}/${c.name}: ${c.cached ? "tool list cached" : "no cached tool list"}`);
    }
  }
  return 0;
}
