// node.ts — this machine as a node (ADR 0012): nothing of ours listens beyond loopback, the vault key file is the
// user's alone, and a node that is on can reach the service and check the owner's signature.

import { brainAccount } from "../../../../shared/mcp/lib/brain-tasks.ts";
import { loadNodeConfig, type NodeConfig } from "../../../../shared/mcp/lib/headless.ts";
import { platformOf } from "../../../../shared/mcp/lib/platform.ts";
import { hasVault, loadKey, vaultDir, vaultKeyFile } from "../../../../shared/mcp/lib/vault.ts";
import { type Check } from "../../lib/output.ts";
import { exposedListeners, headlessProbe, type Probe } from "../../node/probe.ts";
import { nodeTokenFile, readNodeToken } from "../../node/service.ts";
import { DEFAULT_PORT } from "../../lib/paths.ts";
import { checkList } from "../context.ts";

/** The console's port and the MCP gateway's (ADR 0008). */
export const OUR_PORTS = [DEFAULT_PORT, DEFAULT_PORT + 1];

/** Pure: the listening addresses (`ss -ltnH` lines) on our ports that are not loopback. */
export const exposed = (ss: string, ports = OUR_PORTS): string[] => exposedListeners(ss, ports);

export interface NodeFacts {
  cfg: NodeConfig;
  /** the vault key file's mode (`& 0o777`), null when there is none */
  keyMode: number | null;
  /** our ports listening beyond loopback; null when it could not be read */
  exposed: string[] | null;
  /** the service's address, from the brain account */
  service: string | null;
  /** an approval key to check jobs against: the vault's, or node.json's for a node with none */
  approval: boolean;
  /** the Bash sandbox probe, on a headless node (null elsewhere: a desktop does not need it) */
  sandbox: Probe | null;
  /** this machine's own node token file: its mode (`& 0o777`), null when there is none */
  tokenMode?: number | null;
  /** a vault in sight, on a headless node (null elsewhere: a desktop's vault has its own checks) */
  vault?: boolean | null;
  /** on a headless node, the variables set here that outrank an account's token (ADR 0013) */
  outranking?: string[];
  /** on a headless node with a token, what the service lets it reach (`tokenScope`); null elsewhere */
  scope?: TokenScope | null;
}

/** What a node token reaches: a node's routes only, more (a machine's scope: the whole brain), or not known. */
export type TokenScope = "node" | "wider" | "unknown";

/** Pure: the scope from the service's answer to `GET /api/nodes` with the token, a route a `node` scope never
 *  reaches (apps/brain/auth.ts `NODE_ROUTES`): refused is a node's, answered is wider, anything else unknown. */
export function tokenScope(status: number | null, error?: string): TokenScope {
  if (status === 403 && /scope/.test(error ?? "")) return "node";
  if (status === 200) return "wider";
  return "unknown";
}

/** What Claude Code reads before a long-lived token (its *Authentication precedence*): set where agentd runs, it
 *  would decide which account a child uses. The script that starts a child clears the first two; the rest are
 *  CLAUDE_CODE_* and go with the session's variables. */
export const OUTRANKING = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/** Pure: what the doctor says of this machine as a node. */
export function nodeFindings(f: NodeFacts): Check[] {
  const [c, add] = checkList();
  if (f.exposed === null) add("node.bind", "ok", "listening addresses not read on this platform");
  else if (f.exposed.length) {
    add(
      "node.bind",
      "fail",
      `the console or the gateway listens beyond loopback: ${f.exposed.join(", ")}`,
      "nothing of Agents Multi listens beyond 127.0.0.1 (ADR 0012): find what started it and stop it",
    );
  } else add("node.bind", "ok", "console and gateway listen on loopback only");
  if (f.keyMode !== null) {
    if (f.keyMode & 0o077) {
      add(
        "node.keyfile",
        "fail",
        `the vault key file is readable by others (mode ${f.keyMode.toString(8)})`,
        `chmod 600 ${vaultKeyFile()}`,
      );
    } else add("node.keyfile", "ok", "the vault key file is the user's alone (0600)");
  }
  if (f.scope === "wider") {
    add(
      "node.scope",
      "fail",
      "headless node, but its token is a machine's: one leak of it reads the whole brain",
      `revoke it on ${f.service ?? "the brain"}/account, then rm ${nodeTokenFile()} && agents node pair --server`,
    );
  } else if (f.scope === "node") {
    add("node.scope", "ok", "headless node: its token is a node's (projects, notes, tasks)");
  } else if (f.scope === "unknown") {
    add("node.scope", "warn", "headless node: the service did not say what its token reaches", "agents doctor, later");
  }
  if (!f.cfg.enabled) {
    add("node.on", "ok", "not a node: it takes no job from the service (agents node enable)");
    return c;
  }
  if (!f.service) {
    add(
      "node.service",
      "fail",
      "node on, but no brain account with an address: the service is the brain",
      "agents brain-login",
    );
  } else add("node.service", "ok", `node on, service ${f.service}${f.cfg.headless ? " · headless" : ""}`);
  if (f.tokenMode == null) {
    add(
      "node.token",
      "fail",
      "node on, but no token of its own: it does not announce itself (the vault's token would make it every machine)",
      f.cfg.headless
        ? "agents node pair --server (the console takes the code)"
        : "agents node pair (a code), or agents node login --no-browser",
    );
  } else if (f.tokenMode & 0o077) {
    add(
      "node.token",
      "fail",
      `the node token file is readable by others (mode ${f.tokenMode.toString(8)})`,
      `chmod 600 ${nodeTokenFile()}`,
    );
  } else add("node.token", "ok", "a node token of its own (0600)");
  if (f.sandbox && !f.sandbox.ok) {
    add(
      "node.sandbox",
      "fail",
      `headless node, not ready for work: ${f.sandbox.reason}; it takes no job`,
      "apps/node/README.md: the seccomp profile, systempaths=unconfined and, with AppArmor, its profile",
    );
  } else if (f.sandbox) add("node.sandbox", "ok", "headless node: the Bash sandbox starts, the token's scrub holds");
  if (f.vault === false) {
    add(
      "node.vault",
      "warn",
      `headless node, but no vault in ${vaultDir()}: its jobs open no service's account`,
      "apps/node/README.md, «The vault»: the Syncthing folder mounted at ~/agents-multi-vault",
    );
  } else if (f.vault) add("node.vault", "ok", "headless node: the vault is in sight (read only)");
  if (f.outranking?.length) {
    add(
      "node.claude",
      "warn",
      `headless node: ${f.outranking.join(", ")} set here, which Claude Code reads before an account's token`,
      "remove them from the container's environment: the children start without them, but a session by hand does not",
    );
  }
  if (!f.approval) {
    add(
      "node.approval",
      "fail",
      "node on, but no key to check the owner's signature: it can run no job",
      "agents vault pair (or --file on a server), or approvalKey in config/node.json from `agents node key`",
    );
  }
  return c;
}

async function ssListening(): Promise<string | null> {
  if (platformOf() !== "linux") return null;
  try {
    const r = await new Deno.Command("ss", { args: ["-ltnH"], stdout: "piped", stderr: "null" }).output();
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch {
    return null;
  }
}

/** What this headless node's token reaches, asked of the service (`tokenScope`). */
async function probeScope(url: string, token: string): Promise<TokenScope> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/nodes`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({})) as { error?: string };
    return tokenScope(r.status, j.error);
  } catch {
    return tokenScope(null);
  }
}

/** This machine as a node. */
export async function nodeChecks(): Promise<Check[]> {
  const cfg = await loadNodeConfig();
  const st = await Deno.stat(vaultKeyFile()).catch(() => null);
  const ss = await ssListening();
  const account = brainAccount();
  // the vault's approval key needs its key; asking the keyring only when the node is on
  let approval = !!cfg.approvalKey;
  if (cfg.enabled && !approval) approval = await loadKey().then(() => true, () => false);
  const token = cfg.headless ? await readNodeToken() : null;
  return nodeFindings({
    cfg,
    scope: token && account?.url ? await probeScope(account.url, token) : null,
    keyMode: st?.mode != null ? st.mode & 0o777 : null,
    exposed: ss === null ? null : exposed(ss),
    service: account?.url ?? null,
    approval,
    sandbox: cfg.enabled && cfg.headless ? await headlessProbe() : null,
    vault: cfg.enabled && cfg.headless ? hasVault(vaultDir()) : null,
    outranking: cfg.enabled && cfg.headless ? OUTRANKING.filter((n) => !!Deno.env.get(n)) : [],
    tokenMode: await Deno.stat(nodeTokenFile()).then((s) => s.mode != null ? s.mode & 0o777 : 0o600, () => null),
  });
}
