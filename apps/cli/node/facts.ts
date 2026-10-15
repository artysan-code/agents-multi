// facts.ts — what this machine is, as a node: its name, its owner's approval key, and what it announces (ADR
// 0012). Reading a profile's login means only seeing that its file is there, never opening it.

import {
  type Announce,
  approvalKeys,
  memoryLimit,
  nodeNameOf,
  presentFrom,
  sessionCap,
} from "../../../shared/mcp/lib/nodes.ts";
import { loadNodeConfig, type NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { listChildren } from "../../../shared/mcp/lib/agents.ts";
import { listAccounts } from "../../../shared/mcp/lib/providers.ts";
import { loadKey } from "../../../shared/mcp/lib/vault.ts";
import { platformOf } from "../../../shared/mcp/lib/platform.ts";
import { CONFIG, RUNTIME } from "../lib/paths.ts";
import { lstat } from "../lib/fs.ts";
import manifest from "../../../deno.json" with { type: "json" };

/** This node's name: node.json's, else the one its machine token carries (`agents-multi su <hostname>`). */
export const nodeName = (cfg: NodeConfig) => cfg.name ?? nodeNameOf(Deno.hostname());

/** The owner's public approval key this node checks jobs against: node.json's for a node with no vault, else
 *  the one its vault derives. Null when it has neither. */
export async function approvalKey(cfg: NodeConfig): Promise<string | null> {
  if (cfg.approvalKey) return cfg.approvalKey;
  try {
    return (await approvalKeys((await loadKey()).raw)).public;
  } catch {
    return null;
  }
}

async function text(cmd: string, args: string[]): Promise<string | null> {
  try {
    const r = await new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" }).output();
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch {
    return null;
  }
}

/** Whether the owner is at this machine: a graphical session, active and not locked (logind's view). */
async function present(): Promise<boolean> {
  if (platformOf() !== "linux") return false;
  const ids =
    (await text("loginctl", ["list-sessions", "--no-legend"]))?.split("\n").map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean) ?? [];
  const shown = await Promise.all(
    ids.map((id) => text("loginctl", ["show-session", id, "-p", "Type", "-p", "Active", "-p", "LockedHint"])),
  );
  return presentFrom(shown.filter((s): s is string => !!s));
}

/** The accounts this machine can run: each with its login's file in place. */
async function loggedIn(): Promise<string[]> {
  const out: string[] = [];
  for (const a of await listAccounts(CONFIG)) {
    const file = a.provider === "claude"
      ? `${RUNTIME}/${a.profile}/.credentials.json`
      : `${RUNTIME}/${a.profile}/codex/auth.json`;
    if (await lstat(file)) out.push(a.id);
  }
  return out;
}

/** The memory this node counts with: its container's limit where it has one. */
async function memory(): Promise<{ total: number; free: number }> {
  // the CLI's and the app's backend's --allow-sys name it (bin/agents, backend.rs); without it, nothing is known
  const m = (() => {
    try {
      return Deno.systemMemoryInfo();
    } catch {
      return { total: 0, available: 0 };
    }
  })();
  const max = await Deno.readTextFile("/sys/fs/cgroup/memory.max").catch(() => null);
  const total = memoryLimit(max, m.total);
  return { total, free: Math.min(m.available, total) };
}

/** The sessions alive on this machine: every child of the hub that has not ended. */
export async function running(): Promise<number> {
  return (await listChildren()).filter((c) => c.state.phase !== "ended").length;
}

/** What this node announces. */
export async function nodeFacts(cfg: NodeConfig, sandbox: boolean | null): Promise<Announce> {
  const mem = await memory();
  return {
    platform: platformOf(),
    version: manifest.version,
    headless: cfg.headless,
    load: (() => {
      try {
        return Math.round(Deno.loadavg()[0] * 100) / 100;
      } catch {
        return 0;
      }
    })(),
    memTotal: mem.total,
    memFree: mem.free,
    cap: sessionCap(mem.total, cfg.maxSessions),
    running: await running(),
    accounts: await loggedIn(),
    present: cfg.headless ? false : await present(),
    sandbox,
  };
}

export { loadNodeConfig };
