// mcp.ts — one MCP registry (shared/mcp/servers.json) applied to two surfaces per profile:
//   cli      → ~/.agents-multi/<p>/mcp.json, passed by bin/claude with --mcp-config  (Claude Code CLI; config.ts)
//   desktop  → <profile desktop dir>/claude_desktop_config.json     (the Claude Desktop chat)
//
// Registry: { "profiles": [...], "servers": { name: { ...config, "_profiles": [...], "_surfaces": ["cli","desktop"] } } }
//   The repository's servers.json is a catalogue of templates, off until the person turns one on:
//   an account-backed entry by an account in their accounts.json, any other by `_profiles` in their
//   servers.json (the catalogue writes `[]`). Their own servers go in their servers.json only.
//   _profiles  defaults to every profile · _surfaces defaults to ["cli"]
//   _service   the server works on the accounts of that service (shared/mcp/accounts.json): only the
//              profiles that see one of them get it, with AGENTS_MULTI_PROFILE in its env and
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
//   _allow / _deny / _ask  tool names this server runs without asking (its reads) / must never run /
//              must ask before running (its writes): they become mcp__<server>__<tool> permission rules
//              in each profile's generated settings (settings.ts). A tool in none of them is left to
//              the permission mode (auto: the classifier)
//   _bind      { key: argument }: a stdio `_perAccount` server a project can tie to itself. launch.ts
//              reads the nearest .claude/claude-multi.json from the folder Claude started in, up to
//              the home folder; each key the project sets under the service's name adds its argument
//              ({value} filled in, true as it is). No file: the server is as it always was.
//   _npm       { package, version, bin }: an npm package installed at that version into tools/mcp by
//              `agents install` and started as `node <its bin> <args>` — never through npx, whose
//              `npm exec` parent stays alive for the whole session. The one place the version is pinned
//   _version   the version of a program installed outside the repository (not pinned by its command)
//              that the lists were checked against: mcp health --probe warns when the server reports
//              another one in its initialize answer
//   _auto      tool names left to the permission mode on purpose: in no list, and the checks that look
//              for unlisted tools (mcp health --probe, mcp_tools_test.ts) know it
//   _gateway   false: the server stays a stdio entry of the launch config when the lazy gateway is on (the hub:
//              it needs its session's folder and identity). `_bind` servers stay too, for the same reason
//   _guard     { tool, hook }: a PreToolUse hook of shared/hooks that decides on each call of that tool
//              (allow / ask / deny), wired by the same generated settings

import { type Account, loadAccounts } from "../../../shared/mcp/lib/accounts.ts";
import { vaultDir } from "../../../shared/mcp/lib/vault.ts";
import { readJson } from "../lib/fs.ts";
import { CONFIG, HOME, MCP_TOOLS, REPO, RUNTIME } from "../lib/paths.ts";
import { installation, type Mode } from "../lib/mode.ts";
import { diffPatch, mergePatch } from "../lib/json-patch.ts";
import { loadManifest, profileNames } from "../lib/profiles.ts";
import { type GatewaySettings, loadGatewaySettings } from "./gateway-settings.ts";

interface PerAccount {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
export type ServerCfg = Record<string, unknown> & {
  _profiles?: string[];
  _surfaces?: Surface[];
  _service?: string;
  _perAccount?: PerAccount;
  _allow?: string[];
  _deny?: string[];
  _ask?: string[];
  /** the version the lists were checked against, for a program installed outside the repository */
  _version?: string;
  /** tools left to the permission mode on purpose (in no list, not a drift) */
  _auto?: string[];
  /** a PreToolUse hook (a file in shared/hooks) that decides on each call of `tool` (one name, or several) */
  _guard?: { tool: string | string[]; hook: string };
  /** a project's binding key → the argument it adds (stdio `_perAccount` servers): launch.ts */
  _bind?: Record<string, string>;
  /** how to install the program the server runs, when it is not part of this repository */
  _install?: string;
  /** an npm package, installed at this version into MCP_TOOLS by `agents install`: the command is `node`
   *  on its `bin` (withNpm), `args` are the arguments after it */
  _npm?: NpmPackage;
  /** false: this server stays a stdio entry of the profile's launch config, never behind the gateway */
  _gateway?: boolean;
};
export interface NpmPackage {
  package: string;
  version: string;
  /** the name of the executable the package links in node_modules/.bin */
  bin: string;
}
export type Surface = "cli" | "desktop";
/** Where launch.ts is and what it may read: the paths of this machine, kept out of the pure code. */
export interface LaunchPaths {
  script: string;
  read: string[];
  hooks: string;
  /** the Deno our servers and their wrapper run on (denoFor) */
  deno: string;
  /** launch.sh: execs a server after launch.ts has resolved its secret */
  shim: string;
}
export interface Registry {
  profiles: string[];
  servers: Record<string, ServerCfg>;
  accounts?: Account[];
  bus?: string;
  brainScopes?: Record<string, string>;
  launch?: LaunchPaths;
  /** the lazy gateway (ADR 0008): when enabled, the servers that can go through it do */
  gateway?: GatewaySettings;
}
/** servers.json as written on disk: `profiles` may be absent (= every declared profile). */
export interface RawRegistry {
  profiles?: string[];
  servers: Record<string, ServerCfg>;
}

/** The servers the setup knows how to run (repository), and the person's choices over them: which
 *  profiles see which (`_profiles`), servers of their own, `null` to drop one — a JSON Merge Patch. */
export const REGISTRY = `${REPO}/shared/mcp/servers.json`;
const PERSON_REGISTRY = `${CONFIG}/servers.json`;
export const ACCOUNTS = `${CONFIG}/accounts.json`;

/** Pure: every `${HOME}` in a registry entry's strings as this user's home. servers.json is shared
 *  by everyone who uses the repository, and Desktop and the CLI start servers without a shell, so
 *  the home is filled in here rather than written out. */
export function expandHome<T>(v: T, home = HOME): T {
  if (typeof v === "string") return v.replaceAll("${HOME}", home) as T;
  if (Array.isArray(v)) return v.map((x) => expandHome(x, home)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandHome(x, home)])) as T;
  }
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

/** Pure: the Deno our servers run on. In app mode the package's, through the runtime's stable link
 *  (appcopy.ts) — Claude and Desktop start servers with their own PATH, which need not have one; in
 *  dev mode the `deno` on PATH, as ever. */
export const denoFor = (mode: Mode, runtime = RUNTIME) => mode === "app" ? `${runtime}/bin/deno` : "deno";

/** Pure: the executable an npm package links, in the tools prefix. */
export const npmBin = (prefix: string, bin: string) => `${prefix}/node_modules/.bin/${bin}`;

/** Pure: every server with an `_npm` run as `node <installed bin> <args>`. */
export function withNpm(servers: Record<string, ServerCfg>, prefix: string): Record<string, ServerCfg> {
  return Object.fromEntries(
    Object.entries(servers).map(([n, c]) => [
      n,
      c._npm ? { ...c, command: "node", args: [npmBin(prefix, c._npm.bin), ...(c.args as string[] ?? [])] } : c,
    ]),
  );
}

/** Pure: every server whose command is `deno` run by `deno` instead. */
export function withDeno(servers: Record<string, ServerCfg>, deno: string): Record<string, ServerCfg> {
  return Object.fromEntries(
    Object.entries(servers).map(([n, c]) => [n, c.command === "deno" ? { ...c, command: deno } : c]),
  );
}

/**
 * The registry as the setup uses it: catalogue plus the person's patch, `${HOME}` expanded, with the
 * profiles, accounts, session bus, brain scopes and launch paths of this machine.
 *
 * @throws when servers.json is missing or invalid.
 */
export async function loadRegistry(): Promise<Registry> {
  const raw = await rawRegistry();
  const mode = (await installation()).mode;
  const deno = denoFor(mode);
  const r = { ...raw, servers: withNpm(withDeno(expandHome(raw.servers), deno), MCP_TOOLS) };
  const brainScopes: Record<string, string> = {};
  for (const p of await profileNames()) {
    const s = (await loadManifest(p)).brainScope;
    if (s) brainScopes[p] = s;
  }
  return {
    profiles: r.profiles ?? await profileNames(),
    servers: r.servers,
    accounts: loadAccounts(ACCOUNTS),
    bus: Deno.env.get("DBUS_SESSION_BUS_ADDRESS"),
    brainScopes,
    launch: launchPaths(deno),
    gateway: await loadGatewaySettings(mode),
  };
}

/** launch.ts as the servers start it: through the runtime path, like every registry server. */
export function launchPaths(deno = "deno"): LaunchPaths {
  const mcp = `${RUNTIME}/shared/mcp`;
  return {
    script: `${mcp}/lib/launch.ts`,
    shim: `${mcp}/lib/launch.sh`,
    read: [vaultDir(), `${RUNTIME}/config`, `${HOME}/.cache/deno`],
    hooks: `${RUNTIME}/shared/hooks`,
    deno,
  };
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
    if (want.has(server)) set.add(name);
    else set.delete(name);
    // back to the implicit form when the list covers everyone: the file stays readable
    if (all.every((p) => set.has(p))) delete cfg._profiles;
    else cfg._profiles = [...set].sort();
  }
  return out;
}

/** Pure: whether a registry entry is a remote (http/sse) server rather than a command. */
export const isHttp = (cfg: Record<string, unknown>) =>
  cfg.type === "http" || cfg.type === "sse" || (!cfg.command && typeof cfg.url === "string");

/** Pure: what is wrong with the servers as written, before loadRegistry fills in what it derives
 *  (withNpm sets `command: "node"` on every `_npm` server, so only the raw entries can tell a mistake). */
export function rawProblems(servers: Record<string, ServerCfg>): string[] {
  return Object.entries(servers).filter(([, c]) => c._npm && c.command).map(([name]) =>
    `${name}: _npm is the command (node on the package's bin): drop "command"`
  );
}

/** Pure: what is wrong with the registry as written. The doctor reports it; sync still runs, and
 *  what it writes can at worst hold a literal "{secret}", never a secret. */
export function registryProblems(reg: Pick<Registry, "servers">): string[] {
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const { _perAccount, ...rest } = cfg;
    if (JSON.stringify(rest).includes("{secret}")) {
      out.push(`${name}: {secret} outside _perAccount would be written into a config as it is`);
    }
    const lists = [cfg._allow ?? [], cfg._deny ?? [], cfg._ask ?? [], cfg._auto ?? []];
    for (const t of new Set(lists.flat())) {
      if (lists.filter((l) => l.includes(t)).length > 1) {
        out.push(`${name}: ${t} is in more than one of _allow, _deny, _ask, _auto`);
      }
    }
    if (!_perAccount) continue;
    if (!cfg._service) out.push(`${name}: _perAccount needs _service (whose accounts?)`);
    if (isHttp(cfg) && _perAccount.env) out.push(`${name}: an http server takes _perAccount.headers, not env`);
    if (!isHttp(cfg) && _perAccount.headers) out.push(`${name}: a stdio server takes _perAccount.env, not headers`);
    if (cfg._bind && (isHttp(cfg) || !_perAccount.env)) {
      out.push(`${name}: _bind needs a stdio server started through launch.ts (_perAccount.env)`);
    }
    if (isHttp(cfg) && cfg._surfaces?.includes("desktop")) {
      out.push(`${name}: an http server cannot go to Desktop, whose config holds commands only`);
    }
    if (cfg._guard && !/^[\w.-]+$/.test(cfg._guard.hook)) {
      out.push(`${name}: _guard.hook is a file name in shared/hooks, not a path`);
    }
  }
  return out;
}
