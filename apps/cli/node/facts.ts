// facts.ts — what this machine is, as a node: its name, its owner's approval key, and what it announces (ADR
// 0012). Reading a profile's login means only seeing that its file is there, never opening it.

import { voiceReady } from "./voice.ts";
import {
  type Announce,
  APPROVAL_ENTRY,
  approvalKeys,
  memoryLimit,
  nodeNameOf,
  presentFrom,
  sessionCap,
} from "../../../shared/mcp/lib/nodes.ts";
import { claudeToken, loadNodeConfig, type NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { listChildren } from "../../../shared/mcp/lib/agents.ts";
import { listAccounts } from "../../../shared/mcp/lib/providers.ts";
import { getSecret, loadKey, vaultKind } from "../../../shared/mcp/lib/vault.ts";
import { platformOf } from "../../../shared/mcp/lib/platform.ts";
import { CONFIG, RUNTIME, STATE } from "../lib/paths.ts";
import { lstat, readJson } from "../lib/fs.ts";
import manifest from "../../../deno.json" with { type: "json" };

/** This node's name: node.json's, else the one its machine token carries (`agents-multi su <hostname>`). */
export const nodeName = (cfg: NodeConfig) => cfg.name ?? nodeNameOf(Deno.hostname());

/** The owner's public approval key this node checks jobs against: nodes.json's for a node with no vault, else the
 *  one in its vault (a server's: the owner's machine put it there, ADR 0015), else the one the owner's vault key
 *  derives. A server vault without it yet gives none: its own key would derive a key nobody signs with. */
export async function approvalKey(cfg: NodeConfig): Promise<string | null> {
  if (cfg.approvalKey) return cfg.approvalKey;
  try {
    const key = await loadKey();
    const a = APPROVAL_ENTRY;
    const pinned = await getSecret(a.service, a.account, a.field, key);
    if (pinned) return pinned;
    if ((await vaultKind(key)) === "server") return null;
    return (await approvalKeys(key.raw)).public;
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

/** The accounts this machine can run: each with its login's file in place, or, a Claude account on a headless
 *  node, its long-lived token in the vault (ADR 0013). */
async function loggedIn(headless: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const a of await listAccounts(CONFIG)) {
    const file = a.provider === "claude"
      ? `${RUNTIME}/${a.profile}/.credentials.json`
      : `${RUNTIME}/${a.profile}/codex/auth.json`;
    if (await lstat(file)) out.push(a.id);
    else if (headless && a.provider === "claude" && await claudeToken(a.profile)) out.push(a.id);
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
  // through cat: Deno 2 reads nothing under /sys without --allow-all, and the host's memory would count instead
  const max = await text("cat", ["/sys/fs/cgroup/memory.max"]);
  const total = memoryLimit(max, m.total);
  if (total === m.total) return { total, free: m.available };
  // in a container, what is free is what its limit leaves, not the host's
  const used = Number((await text("cat", ["/sys/fs/cgroup/memory.current"]))?.trim());
  return { total, free: Math.min(m.available, Number.isFinite(used) ? Math.max(0, total - used) : total) };
}

/** The sessions alive on this machine: every child of the hub that has not ended. */
export async function running(): Promise<number> {
  return (await listChildren()).filter((c) => c.state.phase !== "ended").length;
}

/** Where `agents node setup` leaves what a server announces about it (ADR 0013, F2): its git key's public half,
 *  for the console's page, and what still waits. This machine only; nothing in it is secret. */
export const setupFile = (): string => `${STATE}/node-setup.json`;

/** What setup left for a headless node to announce, known fields only. */
async function setupFacts(headless: boolean): Promise<{ gitKey?: string; waits?: string[] }> {
  if (!headless) return {};
  const s = await readJson<{ gitKey?: unknown; waits?: unknown }>(setupFile());
  return {
    ...(typeof s?.gitKey === "string" ? { gitKey: s.gitKey } : {}),
    ...(Array.isArray(s?.waits) ? { waits: s.waits.filter((w): w is string => typeof w === "string") } : {}),
  };
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
    accounts: await loggedIn(cfg.headless),
    present: cfg.headless ? false : await present(),
    sandbox,
    voice: await voiceReady(cfg.voice),
    ...(await setupFacts(cfg.headless)),
  };
}

export { loadNodeConfig };
