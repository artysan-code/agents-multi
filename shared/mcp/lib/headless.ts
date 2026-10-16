// headless.ts — a node's settings (ADR 0012, 0013) and what every child gets on a headless node: on a server nobody
// watches, Claude Code's sandbox is the boundary that holds (ADR 0009, 24), so it is turned on for each child from
// the outside (`--settings`), failing closed, with the machine's secrets out of its reach; and its account's
// long-lived token comes from the vault, with Claude Code's scrub keeping it from what the child runs. Read by the
// hub's startChild, which every child goes through (routines, workflows, by hand).
//
// The settings are in two files (ADR 0013): the owner's, the same on every machine (`config/nodes.json`: where the
// clones are, what a command may reach, the approval key, the repositories a server clones), and this machine's,
// never synced (`<state>/node.json`: on or off, headless, its name, its cap). Until 1.2.1 both were
// `config/node.json`, which Syncthing carried to every machine: one `enable` turned them all on.

import { configDir } from "./owner.ts";
import { getSecret } from "./vault.ts";
import { amEnv } from "./env.ts";

export interface NodeConfig {
  /** announce to the service and take the jobs placed here */
  enabled: boolean;
  /** a server: no owner at it, every child sandboxed, only agentd pushes */
  headless: boolean;
  /** this node's name, when its machine token's is not `agents-multi su <hostname>` */
  name?: string;
  /** sessions at once, over what its memory gives (`sessionCap`) */
  maxSessions?: number;
  /** where its clones are, to find a job's repository by its remote */
  repoRoots: string[];
  /** hosts a sandboxed command may reach */
  allowedDomains: string[];
  /** the owner's public approval key, for a node with no vault (`agents node key` on one that has it) */
  approvalKey?: string;
  /** the repositories a server clones when it is set up (`agents node setup`): their remotes */
  repos: string[];
  /** hosts (`git.example.me`) or `host/owner` prefixes whose repositories a node clones the first time a job needs
   *  one (ADR 0014, slice A); absent is none: nothing is cloned on need until the owner lists a host */
  gitHosts?: string[];
  /** this machine transcribes voice notes: whisper.cpp's `whisper-cli` and a ggml model (`agents node voice`) */
  voice?: VoiceConfig;
  /** what this machine publishes of its runs to the service (ADR 0014, third round): `full` (default), `state` (no
   *  output, no branch) or `off` */
  runs?: "full" | "state" | "off";
}

export interface VoiceConfig {
  bin: string;
  model: string;
}

/** Pure: a path a voice setting may hold: absolute or under `~/`, no control characters, no way out by `..`. */
export function voicePath(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  if (!(v.startsWith("/") || v.startsWith("~/"))) return null;
  if ([...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  if (v.split("/").includes("..")) return null;
  return v;
}

/** What is this machine's alone: the rest of a node's settings is the owner's. */
export const MACHINE_FIELDS = ["enabled", "headless", "name", "maxSessions", "voice", "runs"] as const;

/** What a headless child's commands may reach by default: the code hosts and package registries a build needs. */
export const DEFAULT_DOMAINS = [
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "jsr.io",
  "deno.land",
  "dl.deno.land",
  "pypi.org",
  "files.pythonhosted.org",
];

const HOST = /^(\*\.)?[a-z0-9.-]+(:\d+)?$/i;
/** A `gitHosts` entry: a host, with its port if any, and at most an owner after it; never a scheme or a wildcard. */
const GIT_HOST = /^[a-z0-9][a-z0-9.-]*(:\d+)?(\/[\w.-]+)?$/;
/** Pure: whether a text is a valid `gitHosts` entry (lowercase). */
export const validGitHost = (h: string) => GIT_HOST.test(h);

/** Pure: node.json's content, kept to what is valid (the rest is ignored, never trusted). */
export function cleanNodeConfig(raw: unknown): NodeConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const out: NodeConfig = {
    enabled: r.enabled === true,
    headless: r.headless === true,
    repoRoots: strings(r.repoRoots)?.filter((p) => p.startsWith("~/") || p.startsWith("/")) ?? ["~"],
    allowedDomains: strings(r.allowedDomains)?.filter((h) => HOST.test(h)) ?? [...DEFAULT_DOMAINS],
    repos: strings(r.repos)?.filter((u) => /^(ssh:\/\/|https:\/\/|[\w.-]+@[\w.-]+:)/.test(u)) ?? [],
  };
  const gitHosts = strings(r.gitHosts)?.map((h) => h.toLowerCase()).filter((h) => GIT_HOST.test(h)) ?? [];
  if (gitHosts.length) out.gitHosts = gitHosts;
  if (typeof r.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(r.name)) out.name = r.name;
  if (typeof r.maxSessions === "number" && Number.isInteger(r.maxSessions) && r.maxSessions >= 0) {
    out.maxSessions = Math.min(r.maxSessions, 64);
  }
  const v = (r.voice && typeof r.voice === "object" ? r.voice : {}) as Record<string, unknown>;
  const bin = voicePath(v.bin), model = voicePath(v.model);
  if (bin && model) out.voice = { bin, model };
  if (r.runs === "full" || r.runs === "state" || r.runs === "off") out.runs = r.runs;
  if (typeof r.approvalKey === "string" && /^[\w-]{43}$/.test(r.approvalKey)) out.approvalKey = r.approvalKey;
  return out;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? v as Raw : {});
const pick = (r: Raw, machine: boolean): Raw =>
  Object.fromEntries(
    Object.entries(r).filter(([k]) => (MACHINE_FIELDS as readonly string[]).includes(k) === machine),
  );

/** Pure: a node's settings from the owner's file and this machine's: each gives only its own fields. */
export function mergeNodeConfig(shared: unknown, machine: unknown): NodeConfig {
  return cleanNodeConfig({ ...pick(obj(shared), false), ...pick(obj(machine), true) });
}

/** Pure: the old `config/node.json` split: the owner's part, and this machine's when the file was this machine's
 *  alone (a configuration no Syncthing folder holds); in a synced one it was every machine's, and none keeps it. */
export function splitLegacy(legacy: unknown, synced: boolean): { shared: Raw; machine: Raw } {
  const r = obj(legacy);
  return { shared: pick(r, false), machine: synced ? {} : pick(r, true) };
}

/** The owner's file: the same on every machine. */
export const nodesFile = (config = configDir()) => `${config}/nodes.json`;
/** Until 1.2.1: both in one file of the configuration. */
export const legacyNodeFile = (config = configDir()) => `${config}/node.json`;

/** This machine's file, in its state folder: never synced. */
export function machineNodeFile(): string {
  const env = (k: string) => {
    try {
      return Deno.env.get(k);
    } catch {
      return undefined;
    }
  };
  return `${env("XDG_STATE_HOME") || `${env("HOME") ?? ""}/.local/state`}/agents-multi/node.json`;
}

/** Where this machine keeps its node token (ADR 0012): a file only the user reads, never synced. */
export const nodeTokenFile = (): string =>
  amEnv("NODE_TOKEN_FILE") ?? machineNodeFile().replace(/node\.json$/, "node-token");

export async function readNodeToken(): Promise<string | null> {
  return (await Deno.readTextFile(nodeTokenFile()).catch(() => "")).trim() || null;
}

/** Whether this machine's own file says headless. A file this process may not read is an error, never a desktop:
 *  on a server that would hand it the vault's brain token (`brainTokenSource`). */
export async function machineHeadless(file = machineNodeFile()): Promise<boolean> {
  try {
    return (JSON.parse(await Deno.readTextFile(file)) as Record<string, unknown>)?.headless === true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) return false;
    throw new Error(`${file} cannot be read here (${(e as Error).message}): agents install`);
  }
}

/** Pure: where a machine's brain token comes from (ADR 0013, F2). A headless node uses its node token only: the
 *  vault's is the owner's, of scope `machine`, and on a server one leak of it would read the whole brain. Elsewhere
 *  the vault's, or the node token first where the caller asks (`agents node`'s service). */
export function brainTokenSource(headless: boolean, preferOwn: boolean, hasOwn: boolean): "node" | "vault" | null {
  if (headless) return hasOwn ? "node" : null;
  return preferOwn && hasOwn ? "node" : "vault";
}

/** Pure: which view of the brain a token got, from the tools its MCP endpoint lists (apps/brain/tools.ts): a node's
 *  narrow one (reads, no page written), the whole one (a wider token), or none of the brain's tools at all. */
export function brainView(tools: string[]): "node" | "whole" | "none" {
  if (tools.includes("brain_write")) return "whole";
  return tools.includes("brain_read") ? "node" : "none";
}

/** The JSON-RPC call the doctor makes to the brain's /mcp (`agents doctor`'s node.brain): the tools it lists say which view the token got. */
export const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
/** What a Streamable HTTP MCP endpoint wants of a request's headers. */
export const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** Pure: the tool names in a tools/list answer, sent as JSON or as one SSE event. */
export function listedTools(body: string): string[] {
  const json = body.trimStart().startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
  try {
    const r = JSON.parse(json ?? "") as { result?: { tools?: { name?: unknown }[] } };
    return (r.result?.tools ?? []).map((t) => String(t.name));
  } catch {
    return [];
  }
}

/** A headless node's answer to anything that would sign it in with a `machine` token or read the vault's. */
export const NODE_ONLY =
  "a headless node talks to the brain with its own node token only: agents node pair --server (the console takes the code)";

/** Whether a folder is inside a Syncthing folder (its root holds `.stfolder`). */
export function inSyncthing(dir: string): boolean {
  let d: string;
  try {
    d = Deno.realPathSync(dir);
  } catch {
    return false;
  }
  for (; d && d !== "/"; d = d.slice(0, d.lastIndexOf("/")) || "/") {
    try {
      if (Deno.statSync(`${d}/.stfolder`)) return true;
    } catch { /* not this one */ }
  }
  return false;
}

const readRaw = (f: string) => Deno.readTextFile(f).then(JSON.parse).catch(() => null);

/** The node's settings. The old single file is still read where the new ones are not there yet, and moved into
 *  them by whoever may write both (the CLI, the console); nobody else changes anything. */
export async function loadNodeConfig(config = configDir(), machineFile = machineNodeFile()): Promise<NodeConfig> {
  let shared = await readRaw(nodesFile(config));
  let machine = await readRaw(machineFile);
  const legacy = await readRaw(legacyNodeFile(config));
  if (legacy !== null) {
    const split = splitLegacy(legacy, inSyncthing(config));
    shared ??= split.shared;
    machine ??= split.machine;
    try {
      if (!(await readRaw(nodesFile(config)))) {
        await Deno.writeTextFile(nodesFile(config), JSON.stringify(split.shared, null, 2) + "\n");
      }
      if (Object.keys(split.machine).length && !(await readRaw(machineFile))) {
        await Deno.mkdir(machineFile.slice(0, machineFile.lastIndexOf("/")), { recursive: true });
        await Deno.writeTextFile(machineFile, JSON.stringify(split.machine, null, 2) + "\n");
      }
      await Deno.remove(legacyNodeFile(config));
    } catch { /* a reader that may not write (an MCP server, a read-only configuration): read as it is */ }
  }
  return mergeNodeConfig(shared, machine);
}

/** Pure: the files and folders of a machine a child's commands must not read: the vault and its key, each
 *  profile's Claude login, gateway token and Codex login, the console's token, the hub's state (other runs'
 *  requests and answers), and the git and SSH credentials (so that on a server only agentd pushes). */
export function secretPaths(home: string, runtime: string, profiles: string[]): string[] {
  return [
    `${home}/vault`,
    `${home}/agents-multi-vault`,
    `${home}/.local/state/agents-multi`,
    `${home}/.ssh`,
    `${home}/.git-credentials`,
    `${home}/.config/git/credentials`,
    `${home}/.config/gh`,
    ...profiles.flatMap((p) => [
      `${runtime}/${p}/.credentials.json`,
      `${runtime}/${p}/mcp-token`,
      `${runtime}/${p}/codex/auth.json`,
    ]),
  ];
}

/** Pure: the settings a headless child starts with: the sandbox on and impossible to leave (it fails at start
 *  rather than run unsandboxed, a command cannot retry outside it, a repository's settings cannot loosen it),
 *  the secrets unreadable by its commands and by its Read and Edit tools, the network limited to a list. */
export function sandboxSettings(secrets: string[], allowedDomains: string[]): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: secrets },
      network: { allowedDomains, strictAllowlist: true },
    },
    permissions: {
      // an absolute path in a permission rule starts with two slashes
      deny: secrets.flatMap((p) => [`Read(/${p}/**)`, `Read(/${p})`, `Edit(/${p}/**)`, `Edit(/${p})`]),
    },
  };
}

/** The settings of a child started on this machine: the sandbox's on a headless node, none elsewhere. */
export async function childSettings(
  home: string,
  runtime: string,
  config = configDir(),
  machineFile = machineNodeFile(),
): Promise<Record<string, unknown> | undefined> {
  const node = await loadNodeConfig(config, machineFile);
  if (!node.headless) return undefined;
  const profiles: string[] = [];
  try {
    for await (const e of Deno.readDir(`${config}/profiles`)) if (e.isDirectory) profiles.push(e.name);
  } catch { /* no profiles: the shared secrets are still covered */ }
  // this machine's state and its node token wherever they are (XDG_STATE_HOME, AGENTS_MULTI_NODE_TOKEN_FILE): the
  // brain server's helper reads the token there, and a child's commands must not
  const own = [machineFile.slice(0, machineFile.lastIndexOf("/")), nodeTokenFile()];
  const secrets = [...new Set([...secretPaths(home, runtime, profiles.sort()), ...own])];
  return sandboxSettings(secrets, node.allowedDomains);
}

/** Where an account's long-lived token is kept (ADR 0013): `claude setup-token`, made on the owner's desktop
 *  (`agents node token <profile>`), in the vault under the profile's name. */
export const CLAUDE_TOKEN = { service: "claude", field: "oauth-token" } as const;

/** An account's long-lived token from the vault, or null (none, or no vault this process opens). */
export async function claudeToken(profile: string): Promise<string | null> {
  try {
    return await getSecret(CLAUDE_TOKEN.service, profile, CLAUDE_TOKEN.field);
  } catch {
    return null;
  }
}

/** Pure: what the start script is handed for a child (under names of ours: the script clears Claude's own),
 *  and exports just before Claude starts: on a headless node the scrub always, the token when there is one.
 *  A desktop's child gets nothing: it has its `/login`. */
export function childEnvOf(headless: boolean, token: string | null): Record<string, string> {
  if (!headless) return {};
  return token ? { AM_HEADLESS: "1", AM_CLAUDE_TOKEN: token } : { AM_HEADLESS: "1" };
}

/** The same, read from this machine: its node settings and, for Claude, the profile's token. */
export async function childEnv(
  profile: string,
  provider: string,
  config = configDir(),
): Promise<Record<string, string>> {
  const node = await loadNodeConfig(config);
  if (!node.headless) return {};
  return childEnvOf(true, provider === "claude" ? await claudeToken(profile) : null);
}
