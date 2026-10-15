// headless.ts — a node's own settings (`config/node.json`, ADR 0012) and the Bash sandbox every child gets on a
// headless node: on a server nobody watches, Claude Code's sandbox is the boundary that holds (ADR 0009, 24), so
// it is turned on for each child from the outside (`--settings`), failing closed, with the machine's secrets out
// of its reach. Read by the hub's startChild, which every child goes through (routines, workflows, by hand).

import { configDir } from "./owner.ts";

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
}

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

/** Pure: node.json's content, kept to what is valid (the rest is ignored, never trusted). */
export function cleanNodeConfig(raw: unknown): NodeConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const out: NodeConfig = {
    enabled: r.enabled === true,
    headless: r.headless === true,
    repoRoots: strings(r.repoRoots)?.filter((p) => p.startsWith("~/") || p.startsWith("/")) ?? ["~"],
    allowedDomains: strings(r.allowedDomains)?.filter((h) => HOST.test(h)) ?? [...DEFAULT_DOMAINS],
  };
  if (typeof r.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(r.name)) out.name = r.name;
  if (typeof r.maxSessions === "number" && Number.isInteger(r.maxSessions) && r.maxSessions >= 0) {
    out.maxSessions = Math.min(r.maxSessions, 64);
  }
  if (typeof r.approvalKey === "string" && /^[\w-]{43}$/.test(r.approvalKey)) out.approvalKey = r.approvalKey;
  return out;
}

export const nodeConfigFile = (config = configDir()) => `${config}/node.json`;

export async function loadNodeConfig(config = configDir()): Promise<NodeConfig> {
  return cleanNodeConfig(await Deno.readTextFile(nodeConfigFile(config)).then(JSON.parse).catch(() => null));
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
): Promise<Record<string, unknown> | undefined> {
  const node = await loadNodeConfig(config);
  if (!node.headless) return undefined;
  const profiles: string[] = [];
  try {
    for await (const e of Deno.readDir(`${config}/profiles`)) if (e.isDirectory) profiles.push(e.name);
  } catch { /* no profiles: the shared secrets are still covered */ }
  return sandboxSettings(secretPaths(home, runtime, profiles.sort()), node.allowedDomains);
}
