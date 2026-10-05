// mcp.ts — one MCP registry (shared/mcp/servers.json) applied to two surfaces per profile:
//   cli      → ~/.claude-multi/<p>/.claude.json                     (Claude Code CLI, and the copy embedded in Desktop)
//   desktop  → <profile desktop dir>/claude_desktop_config.json     (the Claude Desktop chat)
//
// Registry: { "profiles": [...], "servers": { name: { ...config, "_profiles": [...], "_surfaces": ["cli","desktop"] } } }
//   The repository's servers.json is a catalogue of templates, off until the person turns one on:
//   an account-backed entry by an account in their accounts.json, any other by `_profiles` in their
//   servers.json (the catalogue writes `[]`). Their own servers go in their servers.json only.
//   _profiles  defaults to every profile · _surfaces defaults to ["cli"]
//   _service   the server works on the accounts of that service (shared/mcp/accounts.json): only the
//              profiles that see one of them get it, with CLAUDE_MULTI_PROFILE in its env and
//              {hosts} in its args replaced by those accounts' hosts (its --allow-net); on Desktop
//              also the session bus address, because Desktop starts servers with a bare env (HOME,
//              PATH, USER…) and the vault key is read from the keyring over D-Bus (secret-tool)
//   _perAccount  the server is not ours and works on one account: it becomes one server per account
//              the profile sees, named <entry>-<account>, with {url} {host} {name} replaced by that
//              account's. The secret never enters a config: `env` (stdio) and `headers` (http) are
//              templates where {secret} is filled in at start by shared/mcp/lib/launch.ts, from the
//              vault — as the command's wrapper (stdio) or as Claude Code's headersHelper (http).
//              `{}` is a server that logs in by itself (OAuth): one per account, nothing to fill.
//              http servers do not go to Desktop, whose config holds commands only.
//   _deny / _ask  tool names this server must never run / must ask before running: they become
//              mcp__<server>__<tool> permission rules in each profile's generated settings (settings.ts)
//   _bind      { key: argument }: a stdio `_perAccount` server a project can tie to itself. launch.ts
//              reads the nearest .claude/claude-multi.json from the folder Claude started in, up to
//              the home folder; each key the project sets under the service's name adds its argument
//              ({value} filled in, true as it is). No file: the server is as it always was.
//   _guard     { tool, hook }: a PreToolUse hook of shared/hooks that decides on each call of that tool
//              (allow / ask / deny), wired by the same generated settings
// The merge is non-destructive: only registry-managed servers are touched, hand-added ones survive.
// State (which servers were managed per target) lives in XDG state: it is per-machine, not in the repo.
// Every write is preceded by a backup in XDG state (600, last 5) — never in the profile directory,
// because .claude.json holds oauthAccount and backups left there have leaked through file sync before.

import { type Account, accountHosts, loadAccounts, visibleAccounts } from "../shared/mcp/lib/accounts.ts";
import { vaultDir } from "../shared/mcp/lib/vault.ts";
import { CONFIG, type Check, desktopDir, has, HOME, loadManifest, lstat, type Profile, profileNames, readJson, readText, REPO, run, running, RUNTIME, STATE, stat } from "./lib.ts";
import { diffPatch, mergePatch } from "./settings.ts";

export interface PerAccount { env?: Record<string, string>; headers?: Record<string, string> }
export type ServerCfg = Record<string, unknown> & {
  _profiles?: string[]; _surfaces?: Surface[]; _service?: string; _perAccount?: PerAccount; _deny?: string[]; _ask?: string[];
  /** a PreToolUse hook (a file in shared/hooks) that decides on each call of `tool` */
  _guard?: { tool: string; hook: string };
  /** a project's binding key → the argument it adds (stdio `_perAccount` servers): launch.ts */
  _bind?: Record<string, string>;
  /** how to install the program the server runs, when it is not part of this repository */
  _install?: string;
};
type Surface = "cli" | "desktop";
/** Where launch.ts is and what it may read: the paths of this machine, kept out of the pure code. */
export interface LaunchPaths { script: string; read: string[]; hooks: string }
export interface Registry {
  profiles: string[]; servers: Record<string, ServerCfg>; accounts?: Account[]; bus?: string; brainScopes?: Record<string, string>; launch?: LaunchPaths;
}
/** servers.json as written on disk: `profiles` may be absent (= every declared profile). */
export interface RawRegistry { profiles?: string[]; servers: Record<string, ServerCfg> }
export interface Target { profile: Profile; surface: Surface; path: string; managedKey: string }
export interface Change { target: Target; name: string; kind: "add" | "update" | "remove" }

/** The servers the setup knows how to run (repository), and the person's choices over them: which
 *  profiles see which (`_profiles`), servers of their own, `null` to drop one — a JSON Merge Patch. */
export const REGISTRY = `${REPO}/shared/mcp/servers.json`;
export const PERSON_REGISTRY = `${CONFIG}/servers.json`;
export const ACCOUNTS = `${CONFIG}/accounts.json`;
const STATE_FILE = `${STATE}/mcp-state.json`;
const LEGACY_STATE = `${REPO}/shared/mcp/.sync-state.json`;
const BACKUPS = `${STATE}/mcp-sync-backups`;
const KEEP = 5;

/** Pure: every `${HOME}` in a registry entry's strings as this user's home. servers.json is shared
 *  by everyone who uses the repository, and Desktop and the CLI start servers without a shell, so
 *  the home is filled in here rather than written out. */
export function expandHome<T>(v: T, home = HOME): T {
  if (typeof v === "string") return v.replaceAll("${HOME}", home) as T;
  if (Array.isArray(v)) return v.map((x) => expandHome(x, home)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandHome(x, home)])) as T;
  return v;
}

/** servers.json as the person has it: the repository's catalogue with their patch over it. */
export async function rawRegistry(): Promise<RawRegistry> {
  const base = await readJson<RawRegistry>(REGISTRY);
  if (!base?.servers) throw new Error(`MCP registry missing or invalid: ${REGISTRY}`);
  return mergePatch(base as never, (await readJson(PERSON_REGISTRY) ?? {}) as never) as unknown as RawRegistry;
}
/** Keep `reg` as the person's registry: their file becomes its difference from the catalogue. */
export async function writePersonRegistry(reg: RawRegistry) {
  const base = await readJson<RawRegistry>(REGISTRY) ?? { servers: {} };
  await Deno.writeTextFile(PERSON_REGISTRY, JSON.stringify(diffPatch(base as never, reg as never), null, 2) + "\n");
}

export async function loadRegistry(): Promise<Registry> {
  const raw = await rawRegistry();
  const r = { ...raw, servers: expandHome(raw.servers) };
  const brainScopes: Record<string, string> = {};
  for (const p of await profileNames()) { const s = (await loadManifest(p)).brainScope; if (s) brainScopes[p] = s; }
  return { profiles: r.profiles ?? await profileNames(), servers: r.servers, accounts: loadAccounts(ACCOUNTS), bus: Deno.env.get("DBUS_SESSION_BUS_ADDRESS"), brainScopes, launch: launchPaths() };
}

/** launch.ts as the servers start it: through the runtime path, like every registry server. */
export function launchPaths(): LaunchPaths {
  const mcp = `${RUNTIME}/shared/mcp`;
  return { script: `${mcp}/lib/launch.ts`, read: [vaultDir(), `${RUNTIME}/config`, `${HOME}/.cache/deno`], hooks: `${RUNTIME}/shared/hooks` };
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

const isHttp = (cfg: Record<string, unknown>) => cfg.type === "http" || cfg.type === "sse" || (!cfg.command && typeof cfg.url === "string");

/** Pure: a value with {url} {host} {name} {hosts} replaced by the account's. {secret} is left alone. */
function forAccount<T>(v: T, a: Account): T {
  let host = "";
  try { host = a.url ? new URL(a.url).host : ""; } catch { /* an invalid address has no host */ }
  const sub = (s: string) => s.replaceAll("{url}", a.url ?? "").replaceAll("{hosts}", host || "127.0.0.1:9").replaceAll("{host}", host).replaceAll("{name}", a.name);
  const walk = (x: unknown): unknown =>
    typeof x === "string" ? sub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v) as T;
}

/** Pure: one word for a POSIX shell. */
export const shellQuote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/** Pure: the deno command line of launch.ts, allowed to run `run` and nothing else. */
export function launcher(paths: LaunchPaths, run?: string, bind = false): string[] {
  return [
    "deno", "run", "--quiet", "--no-lock",
    // a binding is looked for from the session's folder up to the home folder
    `--allow-read=${(bind ? [...paths.read, HOME] : paths.read).join(",")}`,
    "--allow-env=HOME,CLAUDE_MULTI_PROFILE,CLAUDE_MULTI_VAULT,CLAUDE_MULTI_ACCOUNTS",
    `--allow-run=/usr/bin/secret-tool${run ? `,${run}` : ""}`,
    paths.script,
  ];
}

/** Pure: a `_perAccount` entry made into one server for one account (name and config). */
export function perAccount(reg: Registry, name: string, cfg: ServerCfg, clean: Record<string, unknown>, a: Account, t: Pick<Target, "profile" | "surface">): [string, Record<string, unknown>] {
  const paths = reg.launch ?? launchPaths();
  const out = forAccount(clean, a);
  const tpl = forAccount(cfg._perAccount ?? {}, a);
  const service = cfg._service!;
  if (isHttp(out)) {
    const headers = Object.entries(tpl.headers ?? {}).map(([k, v]) => `${k}=${v}`);
    // Claude Code runs it through a shell, with its own env: the profile goes on the line
    if (headers.length) out.headersHelper = [`CLAUDE_MULTI_PROFILE=${shellQuote(t.profile)}`, ...launcher(paths), "headers", service, a.name, ...headers].map((w, i) => i ? shellQuote(w) : w).join(" ");
  } else {
    const env = Object.entries(tpl.env ?? {});
    if (env.length) {
      const cmd = String(out.command);
      const binds = Object.entries(cfg._bind ?? {}).flatMap(([k, v]) => ["--bind", `${k}=${v}`]);
      out.args = [...launcher(paths, cmd, binds.length > 0).slice(1), "run", service, a.name, ...env.flatMap(([k, v]) => ["--env", `${k}=${v}`]), ...binds, "--", cmd, ...(out.args as string[] ?? [])];
      out.command = "deno";
    }
    out.env = { ...(out.env as Record<string, string> ?? {}), CLAUDE_MULTI_PROFILE: t.profile };
    if (t.surface === "desktop" && reg.bus) (out.env as Record<string, string>).DBUS_SESSION_BUS_ADDRESS = reg.bus;
  }
  return [`${name}-${a.name}`, out];
}

/** One server a target gets: the registry entry it comes from, the name it has there, the accounts it works on. */
interface Placed { entry: string; name: string; cfg: Record<string, unknown>; accounts: string[] }

/** Pure: the servers one target gets, each with the registry entry it comes from. */
function servers(reg: Registry, t: Pick<Target, "profile" | "surface">): Placed[] {
  const out: Placed[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const profiles = cfg._profiles ?? reg.profiles;
    const surfaces = cfg._surfaces ?? ["cli"];
    if (!profiles.includes(t.profile) || !surfaces.includes(t.surface)) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) if (!k.startsWith("_")) clean[k] = v;
    if (cfg._perAccount && cfg._service) {
      if (t.surface === "desktop" && isHttp(clean)) continue; // Desktop's config holds commands only
      for (const a of visibleAccounts(reg.accounts ?? [], cfg._service, t.profile)) {
        const [n, c] = perAccount(reg, name, cfg, clean, a, t);
        if (t.surface === "desktop") delete c.type;
        out.push({ entry: name, name: n, cfg: c, accounts: [a.name] });
      }
      continue;
    }
    if (cfg._service) {
      const visible = visibleAccounts(reg.accounts ?? [], cfg._service, t.profile);
      if (!visible.length) continue; // nothing this profile could use it for
      // with no address at all, reach nothing rather than everything
      const hosts = accountHosts(visible).join(",") || "127.0.0.1:9";
      if (Array.isArray(clean.args)) clean.args = clean.args.map((a) => typeof a === "string" ? a.replaceAll("{hosts}", hosts) : a);
      if (isHttp(clean)) {
        // a remote server at the account's address ({url}): the person's own brain, not anyone's written in
        if (visible.length !== 1) continue; // which one would it be? accounts.json must say, with profiles
        out.push({ entry: name, name, cfg: forAccount(clean, visible[0]), accounts: [visible[0].name] });
        continue;
      }
      clean.env = { ...(clean.env as Record<string, string> ?? {}), CLAUDE_MULTI_PROFILE: t.profile };
      // a work profile sees only its part of the brain (manifest brainScope)
      const scope = cfg._service === "brain" ? reg.brainScopes?.[t.profile] : undefined;
      if (scope) (clean.env as Record<string, string>).CLAUDE_MULTI_BRAIN_SCOPE = scope;
      if (t.surface === "desktop" && reg.bus) (clean.env as Record<string, string>).DBUS_SESSION_BUS_ADDRESS = reg.bus;
    }
    if (t.surface === "desktop") delete clean.type; // Desktop takes command/args/env; "type" is CLI vocabulary
    const accounts = cfg._service ? visibleAccounts(reg.accounts ?? [], cfg._service, t.profile).map((a) => a.name) : [];
    out.push({ entry: name, name, cfg: clean, accounts });
  }
  return out;
}

/** Pure: every server the registry places, per profile and surface, under the name it has there. */
export function placements(reg: Registry): { entry: string; name: string; profile: string; surface: Surface; service?: string; accounts: string[] }[] {
  return reg.profiles.flatMap((profile) =>
    (["cli", "desktop"] as const).flatMap((surface) =>
      servers(reg, { profile, surface }).map(({ entry, name, accounts }) => ({ entry, name, profile, surface, service: reg.servers[entry]._service, accounts }))
    )
  );
}

/** What one profile has mounted at its last sync: CLI servers, and Desktop's (null: never opened). */
export interface Mounted { cli: string[]; desktop: string[] | null }
/** Where one account (or one server that needs none) reaches: the profiles that get it, those still
 *  waiting for a sync, those waiting for their Desktop to be opened once (not wrong: sync applies then). */
export interface Reach { profiles: string[]; pending: string[]; noDesktop: string[] }

/** Pure: Reach per account (`service/name`) and per server without accounts (`server/entry`),
 *  against what each profile mounted. `desktop` false: no Claude Desktop here, its places do not count. */
export function reach(places: ReturnType<typeof placements>, mounted: Record<string, Mounted>, desktop: boolean): Record<string, Reach> {
  const out: Record<string, { profiles: Set<string>; pending: Set<string>; noDesktop: Set<string> }> = {};
  const at = (k: string) => out[k] ??= { profiles: new Set(), pending: new Set(), noDesktop: new Set() };
  for (const pl of places) {
    if (pl.surface === "desktop" && !desktop) continue;
    const keys = pl.service ? pl.accounts.map((a) => `${pl.service}/${a}`) : [`server/${pl.entry}`];
    const m = mounted[pl.profile];
    const have = pl.surface === "cli" ? m?.cli : m?.desktop;
    for (const k of keys) {
      const r = at(k);
      r.profiles.add(pl.profile);
      if (pl.surface === "desktop" && m && m.desktop === null) r.noDesktop.add(pl.profile);
      else if (!have?.includes(pl.name)) r.pending.add(pl.profile);
    }
  }
  const sorted = (x: Set<string>) => [...x].sort();
  return Object.fromEntries(Object.entries(out).map(([k, r]) => [k, { profiles: sorted(r.profiles), pending: sorted(r.pending), noDesktop: sorted(r.noDesktop) }]));
}

export function wanted(reg: Registry, t: Pick<Target, "profile" | "surface">): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers(reg, t).map((s) => [s.name, s.cfg]));
}
export interface GuardHook { matcher: string; hooks: { type: "command"; command: string }[] }
export interface RegistryRules { deny: string[]; ask: string[]; hooks: GuardHook[] }

/** Pure: what the registry implies for one profile's settings — `_deny` and `_ask` of every server
 *  it gets on the CLI as permission rules, and each `_guard` as a PreToolUse hook on exactly those
 *  servers, under the name each one has there (one per account, for `_perAccount`). */
export function permissionRules(reg: Registry, profile: string): RegistryRules {
  const deny: string[] = []; const ask: string[] = []; const guarded = new Map<string, string[]>();
  for (const { entry, name } of servers(reg, { profile, surface: "cli" })) {
    const cfg = reg.servers[entry];
    for (const tool of cfg._deny ?? []) deny.push(`mcp__${name}__${tool}`);
    for (const tool of cfg._ask ?? []) ask.push(`mcp__${name}__${tool}`);
    if (cfg._guard) guarded.set(entry, [...guarded.get(entry) ?? [], `mcp__${name}__${cfg._guard.tool}`]);
  }
  const dir = (reg.launch ?? launchPaths()).hooks;
  const hooks: GuardHook[] = [...guarded].map(([entry, tools]) => ({
    matcher: `^(${tools.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
    hooks: [{ type: "command", command: `deno run --quiet --no-lock ${dir}/${reg.servers[entry]._guard!.hook}` }],
  }));
  return { deny: deny.sort(), ask: ask.sort(), hooks };
}

/** Pure: what is wrong with the registry as written. The doctor reports it; sync still runs, and
 *  what it writes can at worst hold a literal "{secret}", never a secret. */
export function registryProblems(reg: Pick<Registry, "servers">): string[] {
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const { _perAccount, ...rest } = cfg;
    if (JSON.stringify(rest).includes("{secret}")) out.push(`${name}: {secret} outside _perAccount would be written into a config as it is`);
    if (!_perAccount) continue;
    if (!cfg._service) out.push(`${name}: _perAccount needs _service (whose accounts?)`);
    if (isHttp(cfg) && _perAccount.env) out.push(`${name}: an http server takes _perAccount.headers, not env`);
    if (!isHttp(cfg) && _perAccount.headers) out.push(`${name}: a stdio server takes _perAccount.env, not headers`);
    if (cfg._bind && (isHttp(cfg) || !_perAccount.env)) out.push(`${name}: _bind needs a stdio server started through launch.ts (_perAccount.env)`);
    if (isHttp(cfg) && cfg._surfaces?.includes("desktop")) out.push(`${name}: an http server cannot go to Desktop, whose config holds commands only`);
    if (cfg._guard && !/^[\w.-]+$/.test(cfg._guard.hook)) out.push(`${name}: _guard.hook is a file name in shared/hooks, not a path`);
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

/** Why the program a server runs is not here (an absolute path that does not exist, a command not
 *  on PATH), or null. */
async function commandProblem(cmd: string): Promise<string | null> {
  if (!cmd) return null;
  if (cmd.startsWith("/")) return (await stat(cmd)) ? null : `missing binary: ${cmd}`;
  return (await has(cmd)) ? null : `command not on PATH: ${cmd}`;
}

/** The servers of a service whose program is not installed on this machine, with how to install
 *  it: what the Connections page says when an account of that service is added. */
export async function missingPrograms(service: string, reg?: Registry): Promise<{ server: string; problem: string; install?: string }[]> {
  const r = reg ?? await loadRegistry();
  const out = [];
  for (const [name, cfg] of Object.entries(r.servers)) {
    if (cfg._service !== service) continue;
    const problem = await commandProblem(String(cfg.command ?? ""));
    if (problem) out.push({ server: name, problem, ...(cfg._install ? { install: cfg._install.replaceAll("{repo}", REPO) } : {}) });
  }
  return out;
}

/** Cheap static checks per server the person uses (it reaches a profile): binary, files,
 *  dependencies. With `live`, also the initialize probe. */
export async function health(opts: { live?: boolean } = {}): Promise<Check[]> {
  const reg = await loadRegistry(); const out: Check[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    // a template nobody turned on (no profile, no account) is not this person's: nothing to check
    if (!reachOf(reg, cfg).length) continue;
    const cmd = String(cfg.command ?? ""); const args = (cfg.args ?? []) as string[]; const env = (cfg.env ?? {}) as Record<string, string>;
    const problems: string[] = [];
    if (env.PATH) for (const dir of env.PATH.split(":").slice(0, 2)) if (!(await stat(dir))) problems.push(`pinned PATH: missing directory ${dir}`);
    const missing = await commandProblem(cmd);
    if (missing) problems.push(cfg._install ? `${missing} (install: ${cfg._install.replaceAll("{repo}", REPO)})` : missing);
    for (const a of args) {
      if (a.startsWith("/") && /\.(ts|js|py|lock)$/.test(a) && !(await stat(a))) problems.push(`missing file: ${a}`);
      const lock = a.match(/^--lock=(.+)$/); if (lock && !(await stat(lock[1]))) problems.push(`missing lock file: ${lock[1]}`);
    }
    if (cfg._guard && !(await stat(`${REPO}/shared/hooks/${cfg._guard.hook}`))) problems.push(`missing guard hook: shared/hooks/${cfg._guard.hook}`);
    const envFile = args.join(" ").match(/\. "?\$HOME\/([^"\s;]+)/); // the `. "$HOME/.config/x/.env"` pattern
    if (envFile && !(await stat(`${Deno.env.get("HOME")}/${envFile[1]}`))) problems.push(`missing env file: ~/${envFile[1]}`);
    const surfaces = (cfg._surfaces ?? ["cli"]).join("+"); const profiles = reachOf(reg, cfg).join("+");
    let live = "";
    if (opts.live && !problems.length && cmd) {
      // an account-backed entry is probed as the profile gets it ({hosts} filled in, its profile set),
      // and a per-account one as each of its servers, through launch.ts with the account's secret
      const profile = reachOf(reg, cfg)[0];
      const runs: [string, string, string[], Record<string, string>][] = cfg._service
        ? (profile ? servers(reg, { profile, surface: "cli" }).filter((s) => s.entry === name && s.cfg.command) : [])
          .map((s) => [s.name, String(s.cfg.command), s.cfg.args as string[] ?? [], s.cfg.env as Record<string, string> ?? {}])
        : [[name, cmd, args, env]];
      const oks: string[] = [];
      for (const [n, c, a, e] of runs) {
        const r = await probe(c, a, e);
        if (r.ok) oks.push(`${runs.length > 1 ? `${n} ` : ""}initialize ok in ${(r.ms / 1000).toFixed(1)}s${r.detail ? ` (${r.detail})` : ""}`);
        else problems.push(`${runs.length > 1 ? `${n}: ` : ""}no answer to initialize: ${r.detail}`);
      }
      if (oks.length) live = ` · ${oks.join(", ")}`;
    }
    if (problems.length) {
      const fix = problems.some((x) => x.includes("ABI") || x.includes("NODE_MODULE_VERSION")) ? "native module built for a different Node: rebuild it with the Node on the pinned PATH (prebuild-install)"
        : "install the dependency, or correct shared/mcp/servers.json";
      out.push({ id: `mcp.${name}`, status: "fail", msg: `MCP ${name}: ${problems.join("; ")}`, fix });
    }
    else out.push({ id: `mcp.${name}`, status: "ok", msg: `MCP ${name} (${profiles} · ${surfaces}) ready${live}` });
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
