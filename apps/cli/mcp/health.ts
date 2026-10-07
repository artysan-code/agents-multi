// health.ts — static and live checks of the servers the registry places: the program, the files
// it points at, and (on request) a real `initialize` round trip.

import { type Check } from "../lib/output.ts";
import { REPO } from "../lib/paths.ts";
import { stat } from "../lib/fs.ts";
import { has } from "../lib/proc.ts";
import { reachOf, servers } from "./placement.ts";
import { loadRegistry, type Registry } from "./registry.ts";

/** Live probe: start the stdio server with its own config, send `initialize`, wait for the reply.
 *  Catches what static checks cannot see (native modules built for the wrong ABI, missing env,
 *  cold-start crashes). It costs a real process spawn. */
export async function probe(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 20000,
): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  let child: Deno.ChildProcess | null = null;
  try {
    child = new Deno.Command(cmd, {
      args,
      env: { ...Deno.env.toObject(), ...env },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "agents-multi", version: "probe" },
          },
        }) + "\n",
      ),
    );
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const errChunks: string[] = [];
    const errReader = child.stderr.getReader();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await errReader.read();
          if (done) break;
          errChunks.push(dec.decode(value));
        }
      } catch { /* closed */ }
    })();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((r) =>
          setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now()))
        ),
      ]);
      if ("timeout" in race) break;
      if (race.done) break;
      buf += dec.decode(race.value);
      if (buf.includes('"result"') && buf.includes("serverInfo")) {
        return {
          ok: true,
          ms: Date.now() - t0,
          detail: (buf.match(/"name":"([^"]+)","version":"([^"]+)"/) ?? []).slice(1).join(" "),
        };
      }
      if (buf.includes('"error"')) break;
    }
    const err = errChunks.join("").split("\n").filter((l) => /error|Error|mismatch|ENOENT|not found/.test(l)).slice(
      0,
      2,
    ).join(" | ");
    return {
      ok: false,
      ms: Date.now() - t0,
      detail: err || (buf ? `unexpected reply: ${buf.slice(0, 120)}` : "no reply"),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message };
  } finally {
    try {
      child?.kill("SIGTERM");
    } catch { /* already gone */ }
  }
}

/** Why the program a server runs is not here (an absolute path that does not exist, a command not
 *  on PATH), or null. */
async function commandProblem(cmd: string): Promise<string | null> {
  if (!cmd) return null;
  if (cmd.startsWith("/")) return (await stat(cmd)) ? null : `missing binary: ${cmd}`;
  return (await has(cmd)) ? null : `command not on PATH: ${cmd}`;
}

/** The servers of a service whose program is not installed on this machine, with how to install
 *  it: what the Connections page says when an account of that service is added. */
export async function missingPrograms(
  service: string,
  reg?: Registry,
): Promise<{ server: string; problem: string; install?: string }[]> {
  const r = reg ?? await loadRegistry();
  const out = [];
  for (const [name, cfg] of Object.entries(r.servers)) {
    if (cfg._service !== service) continue;
    const problem = await commandProblem(String(cfg.command ?? ""));
    if (problem) {
      out.push({
        server: name,
        problem,
        ...(cfg._install ? { install: cfg._install.replaceAll("{repo}", REPO) } : {}),
      });
    }
  }
  return out;
}

/** Cheap static checks per server the person uses (it reaches a profile): binary, files,
 *  dependencies. With `live`, also the initialize probe. */
export async function health(opts: { live?: boolean } = {}): Promise<Check[]> {
  const reg = await loadRegistry();
  const out: Check[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    // a template nobody turned on (no profile, no account) is not this person's: nothing to check
    if (!reachOf(reg, cfg).length) continue;
    const cmd = String(cfg.command ?? "");
    const args = (cfg.args ?? []) as string[];
    const env = (cfg.env ?? {}) as Record<string, string>;
    const problems: string[] = [];
    if (env.PATH) {
      for (const dir of env.PATH.split(":").slice(0, 2)) {
        if (!(await stat(dir))) problems.push(`pinned PATH: missing directory ${dir}`);
      }
    }
    const missing = await commandProblem(cmd);
    if (missing) {
      problems.push(cfg._install ? `${missing} (install: ${cfg._install.replaceAll("{repo}", REPO)})` : missing);
    }
    for (const a of args) {
      if (a.startsWith("/") && /\.(ts|js|py|lock)$/.test(a) && !(await stat(a))) problems.push(`missing file: ${a}`);
      const lock = a.match(/^--lock=(.+)$/);
      if (lock && !(await stat(lock[1]))) problems.push(`missing lock file: ${lock[1]}`);
    }
    if (cfg._guard && !(await stat(`${REPO}/shared/hooks/${cfg._guard.hook}`))) {
      problems.push(`missing guard hook: shared/hooks/${cfg._guard.hook}`);
    }
    const envFile = args.join(" ").match(/\. "?\$HOME\/([^"\s;]+)/); // the `. "$HOME/.config/x/.env"` pattern
    if (envFile && !(await stat(`${Deno.env.get("HOME")}/${envFile[1]}`))) {
      problems.push(`missing env file: ~/${envFile[1]}`);
    }
    const surfaces = (cfg._surfaces ?? ["cli"]).join("+");
    const profiles = reachOf(reg, cfg).join("+");
    let live = "";
    if (opts.live && !problems.length && cmd) {
      // an account-backed entry is probed as the profile gets it ({hosts} filled in, its profile set),
      // and a per-account one as each of its servers, through launch.ts with the account's secret
      const profile = reachOf(reg, cfg)[0];
      const runs: [string, string, string[], Record<string, string>][] = cfg._service
        ? (profile ? servers(reg, { profile, surface: "cli" }).filter((s) => s.entry === name && s.cfg.command) : [])
          .map((
            s,
          ) => [s.name, String(s.cfg.command), s.cfg.args as string[] ?? [], s.cfg.env as Record<string, string> ?? {}])
        : [[name, cmd, args, env]];
      const oks: string[] = [];
      for (const [n, c, a, e] of runs) {
        const r = await probe(c, a, e);
        if (r.ok) {
          oks.push(
            `${runs.length > 1 ? `${n} ` : ""}initialize ok in ${(r.ms / 1000).toFixed(1)}s${
              r.detail ? ` (${r.detail})` : ""
            }`,
          );
        } else problems.push(`${runs.length > 1 ? `${n}: ` : ""}no answer to initialize: ${r.detail}`);
      }
      if (oks.length) live = ` · ${oks.join(", ")}`;
    }
    if (problems.length) {
      const fix = problems.some((x) => x.includes("ABI") || x.includes("NODE_MODULE_VERSION"))
        ? "native module built for a different Node: rebuild it with the Node on the pinned PATH (prebuild-install)"
        : "install the dependency, or correct shared/mcp/servers.json";
      out.push({ id: `mcp.${name}`, status: "fail", msg: `MCP ${name}: ${problems.join("; ")}`, fix });
    } else out.push({ id: `mcp.${name}`, status: "ok", msg: `MCP ${name} (${profiles} · ${surfaces}) ready${live}` });
  }
  return out;
}
