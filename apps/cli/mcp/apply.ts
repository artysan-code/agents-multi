// apply.ts — sync of the registry into each target's config file: plan the differences, apply them
// with a backup, and say who could rewrite the file meanwhile.
// The merge is non-destructive: only registry-managed servers are touched, hand-added ones survive.
// State (which servers were managed per target) lives in XDG state: it is per-machine, not in the repo.
// Every write is preceded by a backup in XDG state (600, last 5) — never in the profile directory,
// because .claude.json holds oauthAccount and backups left there have leaked through file sync before.

import { lstat, readJson, readText } from "../lib/fs.ts";
import { REPO, RUNTIME, STATE } from "../lib/paths.ts";
import { running } from "../lib/processes.ts";
import { desktopDir, profileNames } from "../lib/profiles.ts";
import { type Target, wanted } from "./placement.ts";
import { loadRegistry } from "./registry.ts";
import { type Mode } from "../lib/mode.ts";

export interface Change {
  target: Target;
  name: string;
  kind: "add" | "update" | "remove";
}

const STATE_FILE = `${STATE}/mcp-state.json`;
const LEGACY_STATE = `${REPO}/shared/mcp/.sync-state.json`;
const BACKUPS = `${STATE}/mcp-sync-backups`;
const KEEP = 5;

/**
 * Every config file the sync manages: per profile, its CLI `.claude.json` and its Desktop
 * `claude_desktop_config.json`. The files may not exist (profile or Desktop not installed).
 */
export async function targets(): Promise<Target[]> {
  const t: Target[] = [];
  for (const p of await profileNames()) {
    t.push({ profile: p, surface: "cli", path: `${RUNTIME}/${p}/.claude.json`, managedKey: `cli:${p}` });
    t.push({
      profile: p,
      surface: "desktop",
      path: `${await desktopDir(p)}/claude_desktop_config.json`,
      managedKey: `desktop:${p}`,
    });
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
export async function plan(opts: { mode?: Mode } = {}): Promise<{ changes: Change[]; skipped: Target[] }> {
  const reg = await loadRegistry(opts);
  const state = await loadState();
  const changes: Change[] = [];
  const skipped: Target[] = [];
  for (const t of await targets()) {
    const conf = await readJson<{ mcpServers?: Record<string, unknown> }>(t.path);
    if (!conf) {
      skipped.push(t);
      continue;
    }
    const current = conf.mcpServers ?? {};
    const want = wanted(reg, t);
    for (const [name, cfg] of Object.entries(want)) {
      if (!(name in current)) changes.push({ target: t, name, kind: "add" });
      else if (!eq(current[name], cfg)) changes.push({ target: t, name, kind: "update" });
    }
    for (const name of state[t.managedKey] ?? []) {
      if (!(name in want) && name in current) changes.push({ target: t, name, kind: "remove" });
    }
  }
  return { changes, skipped };
}

async function backup(t: Target) {
  await Deno.mkdir(BACKUPS, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  const dest = `${BACKUPS}/${t.managedKey.replace(":", "-")}.${stamp}.json`;
  await Deno.copyFile(t.path, dest);
  await Deno.chmod(dest, 0o600);
  const old = (await Array.fromAsync(Deno.readDir(BACKUPS))).map((e) => e.name).filter((n) =>
    n.startsWith(`${t.managedKey.replace(":", "-")}.`)
  ).sort().slice(0, -KEEP);
  for (const n of old) await Deno.remove(`${BACKUPS}/${n}`);
}

/** Who could rewrite the file underneath us: the profile's CLI/embedded sessions, or the Desktop app. */
export async function blockers(): Promise<Record<string, string[]>> {
  const r = await running();
  const out: Record<string, string[]> = {};
  for (const p of await profileNames()) {
    const cli = r.cli.filter((c) => c.profile === p).map((c) => `pid ${c.pid}${c.embedded ? " (desktop)" : ""}`);
    const desk = r.desktop.filter((d) => d.variant === p).map((d) => `pid ${d.pid}`);
    if (cli.length) out[`cli:${p}`] = cli;
    if (desk.length) out[`desktop:${p}`] = desk;
  }
  return out;
}

/**
 * Writes the registry into every existing target: merges only the managed servers, backs up each
 * file first, writes atomically and records which servers it manages.
 *
 * @param opts.force skip the check for running instances that would rewrite the config
 * @param opts.mode the installation's mode to place servers for (loadRegistry)
 * @returns the changes applied
 * @throws when running instances would rewrite a touched config (without `force`)
 */
export async function apply(opts: { force?: boolean; mode?: Mode } = {}) {
  const reg = await loadRegistry(opts);
  const state = await loadState();
  const { changes } = await plan(opts);
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

/** One line for a change: target key, +/~/− and the server name. */
export function describe(c: Change) {
  const sym = { add: "+", update: "~", remove: "−" }[c.kind];
  return `${c.target.managedKey.padEnd(16)} ${sym} ${c.name}`;
}
/** Whether the old in-repo sync state file still exists. */
export async function legacyStatePresent() {
  return !!(await lstat(LEGACY_STATE));
}
/** The text of a target's config file, or null when it is missing. */
export async function readTargetRaw(t: Target) {
  return await readText(t.path);
}
