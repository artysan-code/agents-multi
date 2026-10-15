// gateway.ts (console) — keeps the lazy MCP gateway (docs/adr/0008) running. The gateway is a process of its
// own, not a thread of the console: a console that stops or updates leaves it up, and a new one takes it
// over. It logs to its own file (`<runtime>/gateway/gateway.log`) and holds none of the console's pipes.
// Each tick: wanted and not answering → start it (backing off when it keeps failing); answering with
// older gateway code → stop it (it finishes the calls in flight first), the next tick starts the new one;
// not wanted any more (the kill switch) → stop it. No systemd: the console is the supervisor, and it is
// always up in app mode.

import { procCmdline } from "../../../shared/mcp/lib/platform.ts";
import { gatewayCodeVersion } from "../codeversion.ts";
import { cacheState, gatewayCommand, gatewayConfig, serverVersion, syncGateway } from "../mcp/gateway.ts";
import { backendsPath, gatewayDir, type GatewaySettings, loadGatewaySettings } from "../mcp/gateway-settings.ts";
import { denoFor, loadRegistry } from "../mcp/registry.ts";
import { installation } from "../lib/mode.ts";
import { readJson } from "../lib/fs.ts";
import { HOME } from "../lib/paths.ts";

/** What the running gateway wrote about itself (`state.json`). */
export interface GatewayState {
  pid: number;
  code: string;
  port: number;
}

/** Whether something of ours answers on `port`. It says nothing more to a caller without a token. */
export async function gatewayAnswers(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    return h?.gateway === true;
  } catch {
    return false;
  }
}

/** Pure: whether a command line (a /proc/<pid>/cmdline, NUL-separated) is the gateway's. */
export const isGatewayCmdline = (cmdline: string) =>
  cmdline.split("\0").some((a) => a.endsWith("mcp/gateway/server.ts"));

/** The gateway running for these settings: it answers, and its state file names a live process that is the
 *  gateway. Null: not running. A gateway that answers with no state file (an older one) is `{pid: 0}`. */
export async function gatewayRunning(g: GatewaySettings): Promise<GatewayState | null> {
  if (!await gatewayAnswers(g.port)) return null;
  const st = await readJson<GatewayState>(`${gatewayDir(g.runtime)}/state.json`);
  if (!st || st.port !== g.port) return { pid: 0, code: "", port: g.port };
  const cmd = procCmdline(st.pid);
  return isGatewayCmdline(cmd) ? st : { pid: 0, code: "", port: g.port };
}

/** What a gateway with a profile's token says about its backends (`/status`); null when it will not say. */
export async function gatewayBackends(g: GatewaySettings, tokenFile: string): Promise<string[] | null> {
  try {
    const token = (await Deno.readTextFile(tokenFile)).trim();
    const r = await fetch(`http://127.0.0.1:${g.port}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return r.ok ? (await r.json()).backends as string[] : null;
  } catch {
    return null;
  }
}

/** Stops the gateway of pid `pid` (SIGTERM: it drains first), after making sure that is what it is. */
// deno-lint-ignore require-await
export async function stopGateway(pid: number): Promise<boolean> {
  if (!pid) return false;
  const cmd = procCmdline(pid);
  if (!isGatewayCmdline(cmd)) return false;
  try {
    Deno.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Starts the gateway as a process of its own; its stdio is nothing, it logs to its file. */
async function spawnGateway(g: GatewaySettings, code: string): Promise<Deno.ChildProcess> {
  if (!await Deno.stat(backendsPath(g.runtime)).catch(() => null)) await syncGateway(await loadRegistry());
  const [cmd, ...args] = gatewayCommand(g, denoFor((await installation()).mode), HOME);
  return new Deno.Command(cmd, {
    args,
    env: { ...Deno.env.toObject(), AGENTS_MULTI_GATEWAY_CODE: code },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

/** Runs the gateway until it ends (`agents gateway run`, for a machine with no console). */
export async function runGateway(): Promise<number> {
  const g = await loadGatewaySettings((await installation()).mode);
  console.log(`gateway: logging to ${gatewayDir(g.runtime)}/gateway.log`);
  return (await (await spawnGateway(g, await gatewayCodeVersion())).status).code;
}

/** Starts supervising; stops when `signal` aborts (the gateway itself is left running). */
export function superviseGateway(signal: AbortSignal, log: (s: string) => void = console.log, every = 5000) {
  let child: Deno.ChildProcess | null = null;
  let startedAt = 0, failures = 0, nextTry = 0;
  const code = gatewayCodeVersion();
  const tick = async () => {
    try {
      const g = await loadGatewaySettings((await installation()).mode);
      const run = await gatewayRunning(g);
      if (!g.enabled) {
        if (run && await stopGateway(run.pid)) log(`gateway: switched off, stopped pid ${run.pid}`);
        return;
      }
      if (run) {
        failures = 0;
        if (run.pid && run.code !== await code && await stopGateway(run.pid)) {
          log(`gateway: pid ${run.pid} runs older code, restarting`);
        }
        return;
      }
      if ((child && Date.now() - startedAt < 15_000) || Date.now() < nextTry) return;
      const c = await spawnGateway(g, await code);
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
  if (sub === "run") return await runGateway();
  if (sub !== "status") {
    console.error(`gateway: unknown subcommand "${sub}" (status|run)`);
    return 2;
  }
  const reg = await loadRegistry();
  const g = reg.gateway!;
  const run = await gatewayRunning(g);
  console.log(`gateway ${g.enabled ? "on" : "off"} · 127.0.0.1:${g.port} · idle stop ${g.idleMs / 60_000} min`);
  if (!run) console.log("  not running");
  else {
    const cfg = await gatewayConfig(reg, serverVersion);
    const first = Object.values(cfg.profiles)[0]?.tokenFile;
    const up = first ? await gatewayBackends(g, first) : null;
    console.log(
      `  running${run.pid ? `, pid ${run.pid}` : ""}${up ? `, backends up: ${up.join(", ") || "none"}` : ""}`,
    );
  }
  console.log(`  log: ${gatewayDir(g.runtime)}/gateway.log`);
  if (g.enabled) {
    for (const c of await cacheState(await gatewayConfig(reg, serverVersion), g.runtime)) {
      console.log(`  ${c.profile}/${c.name}: ${c.cached ? "tool list cached" : "no cached tool list"}`);
    }
  }
  return 0;
}
