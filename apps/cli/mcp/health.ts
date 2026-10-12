// health.ts — static and live checks of the servers the registry places: the program, the files
// it points at, and (on request) a real `initialize` round trip.

import { type Check } from "../lib/output.ts";
import { REPO } from "../lib/paths.ts";
import { readJson, stat } from "../lib/fs.ts";
import { has } from "../lib/proc.ts";
import { reachOf, servers } from "./placement.ts";
import { loadRegistry, type Registry } from "./registry.ts";

/** Pure: a server's tools against its permission lists — the tools in none of them (left to the
 *  permission mode) and the listed tools it does not have (a list naming a tool that is gone). A name
 *  in _deny the server does not offer is fine: switched off in the server and denied as well. */
export function listDrift(
  tools: string[],
  cfg: { _allow?: string[]; _ask?: string[]; _deny?: string[]; _auto?: string[]; _guard?: { tool: string | string[] } },
  elsewhere: (tool: string) => boolean = () => false,
): { unlisted: string[]; stale: string[] } {
  const guarded = cfg._guard ? [cfg._guard.tool].flat() : [];
  const listed = new Set([...cfg._allow ?? [], ...cfg._ask ?? [], ...cfg._deny ?? [], ...cfg._auto ?? [], ...guarded]);
  const have = new Set(tools);
  return {
    unlisted: tools.filter((t) => !listed.has(t) && !elsewhere(t)).sort(),
    stale: [...cfg._allow ?? [], ...cfg._ask ?? [], ...guarded].filter((t) => !have.has(t)).sort(),
  };
}

/** Live probe: start the stdio server with its own config, send `initialize` then `tools/list`, wait
 *  for the replies. Catches what static checks cannot see (native modules built for the wrong ABI,
 *  missing env, cold-start crashes) and the tools the server really offers. It costs a real process
 *  spawn. */
export async function probe(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 20000,
): Promise<{ ok: boolean; ms: number; detail: string; tools?: string[] }> {
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
    const send = (msg: Record<string, unknown>) =>
      w.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"));
    await send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agents-multi", version: "probe" },
      },
    });
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
    let detail = "";
    let initMs = 0;
    let unexpected = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((r) =>
          setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now()))
        ),
      ]);
      if ("timeout" in race || race.done) break;
      buf += dec.decode(race.value);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let msg: { id?: number; result?: Record<string, unknown>; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a log line on stdout
        }
        if (msg.id === 1 && msg.result) {
          const info = msg.result.serverInfo as { name?: string; version?: string } | undefined;
          detail = [info?.name, info?.version].filter(Boolean).join(" ");
          initMs = Date.now() - t0;
          await send({ method: "notifications/initialized" });
          await send({ id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2 && msg.result) {
          const tools = ((msg.result.tools ?? []) as { name: string }[]).map((t) => t.name);
          return { ok: true, ms: initMs, detail, tools };
        } else if (msg.id === 2) {
          return { ok: true, ms: initMs, detail }; // initialize answered; a server may offer no tools/list
        } else if (msg.error) unexpected = line;
      }
      if (unexpected) break;
    }
    if (initMs) return { ok: true, ms: initMs, detail }; // tools/list never answered: initialize is what counts
    const err = errChunks.join("").split("\n").filter((l) => /error|Error|mismatch|ENOENT|not found/.test(l)).slice(
      0,
      2,
    ).join(" | ");
    const seen = unexpected || buf;
    return {
      ok: false,
      ms: Date.now() - t0,
      detail: err || (seen ? `unexpected reply: ${seen.slice(0, 120)}` : "no reply"),
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
  // the shared settings decide some tools themselves (mcp__tasks, gmail_send…): those are not drift
  const perms = (await readJson<{ permissions?: Record<string, string[]> }>(`${REPO}/shared/settings.json`))
    ?.permissions ?? {};
  const rules = new Set(Object.values(perms).flat());
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
    let drift = "";
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
        if (r.tools && !drift) {
          // the lists are the entry's: one server of it is enough to compare
          const d = listDrift(r.tools, cfg, (t) => rules.has(`mcp__${name}`) || rules.has(`mcp__${name}__${t}`));
          if (d.unlisted.length || d.stale.length) {
            drift = [
              d.unlisted.length ? `tools in no list: ${d.unlisted.join(", ")}` : "",
              d.stale.length ? `listed but not offered: ${d.stale.join(", ")}` : "",
            ].filter(Boolean).join("; ");
          }
        }
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
    if (drift) {
      out.push({
        id: `mcp.${name}.lists`,
        status: "warn",
        msg: `MCP ${name}: its permission lists and its tools disagree (${drift})`,
        fix: "classify each tool in _allow, _ask or _deny of shared/mcp/servers.json (or drop the stale name)",
      });
    }
  }
  return out;
}
