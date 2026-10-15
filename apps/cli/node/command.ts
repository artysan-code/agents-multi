// command.ts — `agents node`: this machine as a node of the service (ADR 0012). What it would announce, turning
// it on or off (`config/node.json`, the owner's configuration), the sandbox probe, and the owner's public
// approval key, which a node with no vault pins.

import { approvalKeys } from "../../../shared/mcp/lib/nodes.ts";
import { loadNodeConfig, nodeConfigFile } from "../../../shared/mcp/lib/headless.ts";
import { loadKey } from "../../../shared/mcp/lib/vault.ts";
import { ANSI } from "../lib/output.ts";
import { CONFIG } from "../lib/paths.ts";
import { writeAtomic } from "../lib/fs.ts";
import { approvalKey, nodeFacts, nodeName } from "./facts.ts";
import { sandboxProbe } from "./probe.ts";
import { service } from "./service.ts";
import { readNodeState } from "./agentd.ts";

const GiB = 2 ** 30;

/** Pure: node.json after `enable`/`disable`: the owner's other keys kept, the ones the command sets changed. */
export function nodeConfigWith(raw: unknown, set: { enabled: boolean; headless?: boolean; maxSessions?: number }) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = { ...base, enabled: set.enabled };
  if (set.headless !== undefined) out.headless = set.headless;
  if (set.maxSessions !== undefined) out.maxSessions = set.maxSessions;
  return out;
}

export async function nodeCommand(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  const file = nodeConfigFile(CONFIG);
  const opt = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (sub) {
    case "status": {
      const cfg = await loadNodeConfig(CONFIG);
      const probe = cfg.headless ? await sandboxProbe() : null;
      const facts = await nodeFacts(cfg, probe ? probe.ok : null);
      const svc = await service().catch((e) => (e as Error).message);
      const key = await approvalKey(cfg);
      const st = await readNodeState();
      if (rest.includes("--json")) {
        console.log(JSON.stringify({ name: nodeName(cfg), config: cfg, facts, probe, key: !!key, state: st }, null, 2));
        return 0;
      }
      const followed = Object.values(st.runs).filter((r) => !r.done).length;
      console.log(
        `${ANSI.b}${nodeName(cfg)}${ANSI.x}  ${cfg.enabled ? "on" : "off"}${cfg.headless ? ", headless" : ""}`,
      );
      console.log(`  service     ${typeof svc === "string" ? `${ANSI.d}${svc}${ANSI.x}` : svc.url}`);
      console.log(`  sessions    ${facts.running} of ${facts.cap}  (memory ${(facts.memTotal / GiB).toFixed(1)} GiB)`);
      console.log(`  accounts    ${facts.accounts.join(", ") || "none logged in"}`);
      console.log(`  owner here  ${facts.present ? "yes" : "no"}`);
      if (probe) console.log(`  sandbox     ${probe.ok ? "works" : `does not work: ${probe.reason}`}`);
      console.log(
        `  approval    ${key ? "the owner's key is known here" : "no key: no vault, and no approvalKey in node.json"}`,
      );
      console.log(`  runs        ${followed} followed`);
      if (!cfg.enabled) console.log(`\n${ANSI.d}agents node enable [--headless] turns it on (${file})${ANSI.x}`);
      return 0;
    }
    case "enable":
    case "disable": {
      const raw = await Deno.readTextFile(file).then(JSON.parse).catch(() => ({}));
      const max = opt("--max");
      if (max !== undefined && !/^\d+$/.test(max)) {
        console.error("--max is a number of sessions");
        return 2;
      }
      const next = nodeConfigWith(raw, {
        enabled: sub === "enable",
        ...(rest.includes("--headless") ? { headless: true } : {}),
        ...(max !== undefined ? { maxSessions: Number(max) } : {}),
      });
      await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
      console.log(`${sub === "enable" ? "on" : "off"}: ${file}; the console picks it up within 30 s`);
      return 0;
    }
    case "probe": {
      const p = await sandboxProbe();
      console.log(p.ok ? "the Bash sandbox works here" : `the Bash sandbox does not work here: ${p.reason}`);
      return p.ok ? 0 : 1;
    }
    case "key": {
      // the public half only: what a node with no vault puts in node.json as approvalKey
      console.log((await approvalKeys((await loadKey()).raw)).public);
      return 0;
    }
    default:
      console.error("usage: agents node [status [--json]|enable [--headless] [--max N]|disable|probe|key]");
      return 2;
  }
}
