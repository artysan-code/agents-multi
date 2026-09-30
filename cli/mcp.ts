// mcp.ts — one MCP registry (shared/mcp/servers.json) applied to two surfaces per profile:
//   cli      → ~/.claude-multi/<p>/.claude.json                     (Claude Code CLI, and the copy embedded in Desktop)
//   desktop  → <profile desktop dir>/claude_desktop_config.json     (the Claude Desktop chat)
//
// Registry: { "profiles": [...], "servers": { name: { ...config, "_profiles": [...], "_surfaces": ["cli","desktop"] } } }
//   _profiles  defaults to every profile · _surfaces defaults to ["cli"]
//   _service   the server works on the accounts of that service (shared/mcp/accounts.json): only the
//              profiles that see one of them get it, with CLAUDE_MULTI_PROFILE in its env and
//              {hosts} in its args replaced by those accounts' hosts (its --allow-net)
// The merge is non-destructive: only registry-managed servers are touched, hand-added ones survive.
// State (which servers were managed per target) lives in XDG state: it is per-machine, not in the repo.
// Every write is preceded by a backup in XDG state (600, last 5) — never in the profile directory,
// because .claude.json holds oauthAccount and backups left there have leaked through file sync before.

import { type Account, accountHosts, loadAccounts, visibleAccounts } from "../shared/mcp/lib/accounts.ts";
import { type Check, desktopDir, has, HOME, lstat, type Profile, profileNames, readJson, readText, REPO, run, running, RUNTIME, STATE, stat } from "./lib.ts";

type ServerCfg = Record<string, unknown> & { _profiles?: string[]; _surfaces?: Surface[]; _service?: string };
type Surface = "cli" | "desktop";
export interface Registry { profiles: string[]; servers: Record<string, ServerCfg>; accounts?: Account[] }
/** servers.json as written on disk: `profiles` may be absent (= every declared profile). */
export interface RawRegistry { profiles?: string[]; servers: Record<string, ServerCfg> }
export interface Target { profile: Profile; surface: Surface; path: string; managedKey: string }
export interface Change { target: Target; name: string; kind: "add" | "update" | "remove" }

const REGISTRY = `${REPO}/shared/mcp/servers.json`;
export const ACCOUNTS = `${REPO}/shared/mcp/accounts.json`;
const STATE_FILE = `${STATE}/mcp-state.json`;
const LEGACY_STATE = `${REPO}/shared/mcp/.sync-state.json`;
const BACKUPS = `${STATE}/mcp-sync-backups`;
const KEEP = 5;

export async function loadRegistry(): Promise<Registry> {
  const r = await readJson<Registry>(REGISTRY);
  if (!r?.servers) throw new Error(`MCP registry missing or invalid: ${REGISTRY}`);
  return { profiles: r.profiles ?? await profileNames(), servers: r.servers, accounts: loadAccounts(ACCOUNTS) };
}
/**
 * A profile's server selection applied to the raw registry file. `everyone` is what an absent
 * top-level `profiles` stands for (loadRegistry: every declared profile), and an absent list stays
 * absent — writing one in would freeze the set of profiles and cut out every other one.
 */
export function selectServers(reg: RawRegistry, everyone: string[], name: string, picked: string[]): RawRegistry {
  const out = structuredClone(reg);
  if (out.profiles && !out.profiles.includes(name)) out.profiles = [...out.profiles, name].sort();
  const all = out.profiles ?? everyone;
  const want = new Set(picked);
  for (const [server, cfg] of Object.entries(out.servers)) {
    const set = new Set(cfg._profiles ?? all);
    if (want.has(server)) set.add(name); else set.delete(name);
    // back to the implicit form when the list covers everyone: the file stays readable
    if (all.every((p) => set.has(p))) delete cfg._profiles;
    else cfg._profiles = [...set].sort();
  }
  return out;
}

/** The profiles a server reaches: its _profiles, and for an account-backed one only those that see
 *  one of its accounts (what wanted() applies, and what status and health report). */
export function reachOf(reg: Registry, cfg: ServerCfg): string[] {
  return (cfg._profiles ?? reg.profiles).filter((p) => !cfg._service || visibleAccounts(reg.accounts ?? [], cfg._service, p).length);
}

export function wanted(reg: Registry, t: Target): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const profiles = cfg._profiles ?? reg.profiles;
    const surfaces = cfg._surfaces ?? ["cli"];
    if (!profiles.includes(t.profile) || !surfaces.includes(t.surface)) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) if (!k.startsWith("_")) clean[k] = v;
    if (cfg._service) {
      const visible = visibleAccounts(reg.accounts ?? [], cfg._service, t.profile);
      if (!visible.length) continue; // nothing this profile could use it for
      // with no address at all, reach nothing rather than everything
      const hosts = accountHosts(visible).join(",") || "127.0.0.1:9";
      if (Array.isArray(clean.args)) clean.args = clean.args.map((a) => typeof a === "string" ? a.replaceAll("{hosts}", hosts) : a);
      clean.env = { ...(clean.env as Record<string, string> ?? {}), CLAUDE_MULTI_PROFILE: t.profile };
    }
    if (t.surface === "desktop") delete clean.type; // Desktop takes command/args/env; "type" is CLI vocabulary
    out[name] = clean;
  }
  return out;
}
export async function targets(): Promise<Target[]> {
  const t: Target[] = [];
  for (const p of await profileNames()) {
    t.push({ profile: p, surface: "cli", path: `${RUNTIME}/${p}/.claude.json`, managedKey: `cli:${p}` });
    t.push({ profile: p, surface: "desktop", path: `${await desktopDir(p)}/claude_desktop_config.json`, managedKey: `desktop:${p}` });
  }
  return t;
}
async function loadState(): Promise<Record<string, string[]>> {
  const s = await readJson<Record<string, string[]>>(STATE_FILE);
  if (s) return s;
  // migration from the old in-repo file (keys were profile → cli surface)
  const legacy = await readJson<Record<string, string[]>>(LEGACY_STATE);
  if (!legacy) return {};
  const out: Record<string, string[]> = {};
  for (const [p, names] of Object.entries(legacy)) out[`cli:${p}`] = names;
  return out;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Differences per existing target (missing files are skipped: profile or Desktop not installed). */
export async function plan(): Promise<{ changes: Change[]; skipped: Target[] }> {
  const reg = await loadRegistry(); const state = await loadState();
  const changes: Change[] = []; const skipped: Target[] = [];
  for (const t of await targets()) {
    const conf = await readJson<{ mcpServers?: Record<string, unknown> }>(t.path);
    if (!conf) { skipped.push(t); continue; }
    const current = conf.mcpServers ?? {};
    const want = wanted(reg, t);
    for (const [name, cfg] of Object.entries(want)) {
      if (!(name in current)) changes.push({ target: t, name, kind: "add" });
      else if (!eq(current[name], cfg)) changes.push({ target: t, name, kind: "update" });
    }
    for (const name of state[t.managedKey] ?? []) if (!(name in want) && name in current) changes.push({ target: t, name, kind: "remove" });
  }
  return { changes, skipped };
}

async function backup(t: Target) {
  await Deno.mkdir(BACKUPS, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  const dest = `${BACKUPS}/${t.managedKey.replace(":", "-")}.${stamp}.json`;
  await Deno.copyFile(t.path, dest); await Deno.chmod(dest, 0o600);
  const old = (await Array.fromAsync(Deno.readDir(BACKUPS))).map((e) => e.name).filter((n) => n.startsWith(`${t.managedKey.replace(":", "-")}.`)).sort().slice(0, -KEEP);
  for (const n of old) await Deno.remove(`${BACKUPS}/${n}`);
}

/** Who could rewrite the file underneath us: the profile's CLI/embedded sessions, or the Desktop app. */
export async function blockers(): Promise<Record<string, string[]>> {
  const r = await running(); const out: Record<string, string[]> = {};
  for (const p of await profileNames()) {
    const cli = r.cli.filter((c) => c.profile === p).map((c) => `pid ${c.pid}${c.embedded ? " (desktop)" : ""}`);
    const desk = r.desktop.filter((d) => d.variant === p).map((d) => `pid ${d.pid}`);
    if (cli.length) out[`cli:${p}`] = cli;
    if (desk.length) out[`desktop:${p}`] = desk;
  }
  return out;
}

export async function apply(opts: { force?: boolean } = {}) {
  const reg = await loadRegistry(); const state = await loadState();
  const { changes } = await plan();
  const block = opts.force ? {} : await blockers();
  const touched = new Set(changes.map((c) => c.target.managedKey));
  const blocked = [...touched].filter((k) => block[k]);
  if (blocked.length) {
    const msg = blocked.map((k) => `${k} (${block[k].join(", ")})`).join("; ");
    throw new Error(`running instances would rewrite this config: ${msg}. Close them and retry, or pass --force.`);
  }
  for (const t of await targets()) {
    const mine = changes.filter((c) => c.target.managedKey === t.managedKey);
    const conf = await readJson<Record<string, unknown> & { mcpServers?: Record<string, unknown> }>(t.path);
    if (!conf) continue;
    const want = wanted(reg, t);
    if (mine.length) {
      const merged: Record<string, unknown> = { ...(conf.mcpServers ?? {}) };
      for (const c of mine) if (c.kind === "remove") delete merged[c.name];
      Object.assign(merged, want);
      conf.mcpServers = merged;
      await backup(t);
      const tmp = `${t.path}.claude-multi.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(conf, null, 2) + "\n");
      await Deno.rename(tmp, t.path);
    }
    state[t.managedKey] = Object.keys(want).sort();
  }
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  return changes;
}

// ---------------------------------------------------------------- health
// Note: a server may speak the Ollama protocol without Ollama being installed. Here port 11434 is
// answered by `llama-embed-shim` (shared/tools, llama-embed-shim.service), which translates to
// llama.cpp's `llama-server` (llama-embed.service, port 8090). The provider name is a protocol.
async function getJson(url: string, ms = 1500): Promise<unknown | null> {
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), ms);
    // Deno's --allow-net is per literal host, so localhost and 127.0.0.1 are two different hosts
    const r = await fetch(url.replace("://localhost", "://127.0.0.1"), { signal: ctrl.signal }); clearTimeout(to);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function embeddingModels(base: string): Promise<string[] | null> {
  const j = await getJson(`${base.replace(/\/$/, "")}/api/tags`) as { models?: { name: string }[] } | null;
  return j ? (j.models ?? []).map((m) => m.name) : null;
}
export const LLAMA_EMBED_URL = "http://127.0.0.1:8090";
export async function llamaServerOk() { const j = await getJson(`${LLAMA_EMBED_URL}/health`) as { status?: string } | null; return j?.status === "ok"; }

/** Live probe: start the stdio server with its own config, send `initialize`, wait for the reply.
 *  Catches what static checks cannot see (native modules built for the wrong ABI, missing env,
 *  cold-start crashes). It costs a real process spawn. */
export async function probe(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 20000): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  let child: Deno.ChildProcess | null = null;
  try {
    child = new Deno.Command(cmd, { args, env: { ...Deno.env.toObject(), ...env }, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-multi", version: "probe" } } }) + "\n"));
    const reader = child.stdout.getReader(); const dec = new TextDecoder(); let buf = "";
    const errChunks: string[] = []; const errReader = child.stderr.getReader();
    (async () => { try { for (;;) { const { value, done } = await errReader.read(); if (done) break; errChunks.push(dec.decode(value)); } } catch { /* closed */ } })();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const race = await Promise.race([reader.read(), new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now())))]);
      if ("timeout" in race) break;
      if (race.done) break;
      buf += dec.decode(race.value);
      if (buf.includes('"result"') && buf.includes("serverInfo")) return { ok: true, ms: Date.now() - t0, detail: (buf.match(/"name":"([^"]+)","version":"([^"]+)"/) ?? []).slice(1).join(" ") };
      if (buf.includes('"error"')) break;
    }
    const err = errChunks.join("").split("\n").filter((l) => /error|Error|mismatch|ENOENT|not found/.test(l)).slice(0, 2).join(" | ");
    return { ok: false, ms: Date.now() - t0, detail: err || (buf ? `unexpected reply: ${buf.slice(0, 120)}` : "no reply") };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message };
  } finally {
    try { child?.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

/** Cheap static checks per registry server: binary, files, dependencies. With `live`, also the initialize probe. */
export async function health(opts: { live?: boolean } = {}): Promise<Check[]> {
  const reg = await loadRegistry(); const out: Check[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const cmd = String(cfg.command ?? ""); const args = (cfg.args ?? []) as string[]; const env = (cfg.env ?? {}) as Record<string, string>;
    const problems: string[] = [];
    if (env.PATH) for (const dir of env.PATH.split(":").slice(0, 2)) if (!(await stat(dir))) problems.push(`pinned PATH: missing directory ${dir}`);
    if (cmd.startsWith("/")) { if (!(await stat(cmd))) problems.push(`missing binary: ${cmd}`); }
    else if (cmd && !(await has(cmd))) problems.push(`command not on PATH: ${cmd}`);
    for (const a of args) {
      if (a.startsWith("/") && /\.(ts|js|py|lock)$/.test(a) && !(await stat(a))) problems.push(`missing file: ${a}`);
      const lock = a.match(/^--lock=(.+)$/); if (lock && !(await stat(lock[1]))) problems.push(`missing lock file: ${lock[1]}`);
    }
    if (env.VAULT_PATH && !(await stat(env.VAULT_PATH))) problems.push(`missing vault: ${env.VAULT_PATH}`);
    // Embedding is kept apart: without it the server still starts and only loses semantic search.
    // On a machine that has no local inference backend at all that is a choice, not a fault.
    const embedding: string[] = [];
    if (env.EMBEDDING_PROVIDER === "ollama") {
      const base = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const models = await embeddingModels(base);
      if (!models) embedding.push(`embedding endpoint ${base} is not answering`);
      else if (env.EMBEDDING_MODEL && !models.some((m) => m.startsWith(env.EMBEDDING_MODEL))) embedding.push(`model ${env.EMBEDDING_MODEL} is not served there`);
      if (!(await llamaServerOk())) embedding.push(`llama-server ${LLAMA_EMBED_URL} is not answering (llama-embed.service)`);
    }
    const llamaInstalled = !!(await stat(`${HOME}/.local/opt/llama-vulkan/bin/llama-server`));
    if (embedding.length && llamaInstalled) problems.push(...embedding);
    const envFile = args.join(" ").match(/\. "?\$HOME\/([^"\s;]+)/); // the `. "$HOME/.config/x/.env"` pattern
    if (envFile && !(await stat(`${Deno.env.get("HOME")}/${envFile[1]}`))) problems.push(`missing env file: ~/${envFile[1]}`);
    const surfaces = (cfg._surfaces ?? ["cli"]).join("+"); const profiles = reachOf(reg, cfg).join("+");
    let live = "";
    if (opts.live && !problems.length && cmd) {
      const r = await probe(cmd, args, env);
      if (r.ok) live = ` · initialize ok in ${(r.ms / 1000).toFixed(1)}s${r.detail ? ` (${r.detail})` : ""}`;
      else problems.push(`no answer to initialize: ${r.detail}`);
    }
    if (problems.length) {
      const fix = problems.some((x) => x.includes("llama-server") || x.includes("embedding")) ? "systemctl --user start llama-embed-shim.service (it pulls in llama-embed.service too)"
        : problems.some((x) => x.startsWith("model ")) ? "check SHIM_MODEL in systemd/user/llama-embed-shim.service against the model llama-embed.service loads"
        : problems.some((x) => x.includes("ABI") || x.includes("NODE_MODULE_VERSION")) ? "native module built for a different Node: rebuild it with the Node on the pinned PATH (prebuild-install)"
        : "install the dependency, or correct shared/mcp/servers.json";
      out.push({ id: `mcp.${name}`, status: "fail", msg: `MCP ${name}: ${problems.join("; ")}`, fix });
    }
    else if (embedding.length) {
      out.push({
        id: `mcp.${name}`, status: "warn",
        msg: `MCP ${name} (${profiles} · ${surfaces}) ready, without semantic search${live}`,
        fix: "no local inference backend here: text and graph search work, semantic does not. Install llama.cpp and enable llama-embed{,-shim}.service to get it",
      });
    } else out.push({ id: `mcp.${name}`, status: "ok", msg: `MCP ${name} (${profiles} · ${surfaces}) ready${live}` });
  }
  return out;
}

export function describe(c: Change) {
  const sym = { add: "+", update: "~", remove: "−" }[c.kind];
  return `${c.target.managedKey.padEnd(16)} ${sym} ${c.name}`;
}
export async function legacyStatePresent() { return !!(await lstat(LEGACY_STATE)); }
export async function readTargetRaw(t: Target) { return await readText(t.path); }
export { run };
