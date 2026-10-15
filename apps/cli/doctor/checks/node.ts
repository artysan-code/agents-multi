// node.ts — this machine as a node (ADR 0012): nothing of ours listens beyond loopback, the vault key file is the
// user's alone, and a node that is on can reach the service and check the owner's signature.

import { brainAccount } from "../../../../shared/mcp/lib/brain-tasks.ts";
import { loadNodeConfig, type NodeConfig } from "../../../../shared/mcp/lib/headless.ts";
import { platformOf } from "../../../../shared/mcp/lib/platform.ts";
import { loadKey, vaultKeyFile } from "../../../../shared/mcp/lib/vault.ts";
import { type Check } from "../../lib/output.ts";
import { DEFAULT_PORT } from "../../lib/paths.ts";
import { checkList } from "../context.ts";

/** The console's port and the MCP gateway's (ADR 0008). */
export const OUR_PORTS = [DEFAULT_PORT, DEFAULT_PORT + 1];

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|\[::1\]|::1|localhost)$/;

/** Pure: the listening addresses (`ss -ltnH` lines) on our ports that are not loopback. */
export function exposed(ss: string, ports = OUR_PORTS): string[] {
  const out: string[] = [];
  for (const line of ss.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const m = local.match(/^(.*):(\d+)$/);
    if (!m || !ports.includes(Number(m[2]))) continue;
    const host = m[1].replace(/%.*$/, "");
    if (!LOOPBACK.test(host)) out.push(local);
  }
  return out;
}

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
}

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

/** This machine as a node. */
export async function nodeChecks(): Promise<Check[]> {
  const cfg = await loadNodeConfig();
  const st = await Deno.stat(vaultKeyFile()).catch(() => null);
  const ss = await ssListening();
  const account = brainAccount();
  // the vault's approval key needs its key; asking the keyring only when the node is on
  let approval = !!cfg.approvalKey;
  if (cfg.enabled && !approval) approval = await loadKey().then(() => true, () => false);
  return nodeFindings({
    cfg,
    keyMode: st?.mode != null ? st.mode & 0o777 : null,
    exposed: ss === null ? null : exposed(ss),
    service: account?.url ?? null,
    approval,
  });
}
