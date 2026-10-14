// apply.ts — the registry's projection into Claude Desktop's config files (claude_desktop_config.json),
// the one surface that cannot be handed its servers at launch. The CLI's servers are not copied anywhere:
// config.ts generates a file per profile that bin/claude passes with --mcp-config.
// The merge is non-destructive: only registry-managed servers are touched, hand-added ones survive.
// A Desktop that is running is skipped, never an error: the projection lands the next time it is
// closed (claude-launch runs it just before opening the app). State (which servers were managed per
// target) lives in XDG state: it is per-machine, not in the repo.
// Every write is preceded by a backup in XDG state (600, last 5) — never in the profile directory.

import { readJson, writeAtomic } from "../lib/fs.ts";
import { CACHE, STATE } from "../lib/paths.ts";
import { running } from "../lib/processes.ts";
import { desktopDir, profileNames } from "../lib/profiles.ts";
import { type Target, wanted } from "./placement.ts";
import { loadRegistry } from "./registry.ts";

export interface Change {
  target: Target;
  name: string;
  kind: "add" | "update" | "remove";
}

const STATE_FILE = `${STATE}/mcp-state.json`;
const BACKUPS = `${STATE}/mcp-sync-backups`;
const KEEP = 5;
/** Present while a Desktop projection waits for its app to be closed: claude-launch looks for it (prelaunch.sh). */
const PENDING = `${CACHE}/desktop-mcp.pending`;

/**
 * Every Desktop config file the projection manages, one per profile. The files may not exist
 * (profile or Desktop not installed).
 */
export async function targets(): Promise<Target[]> {
  const t: Target[] = [];
  for (const p of await profileNames()) {
    t.push({
      profile: p,
      surface: "desktop",
      path: `${await desktopDir(p)}/claude_desktop_config.json`,
      managedKey: `desktop:${p}`,
    });
  }
  return t;
}
/** Which servers each target had managed at the last write (`desktop:<p>`; `cli:<p>` is the old
 *  projection into .claude.json, which config.ts retires). */
export async function loadState(): Promise<Record<string, string[]>> {
  return await readJson<Record<string, string[]>>(STATE_FILE) ?? {};
}
export async function saveState(state: Record<string, string[]>) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Differences per existing target (missing files are skipped: profile or Desktop not installed). */
export async function plan(): Promise<{ changes: Change[]; skipped: Target[] }> {
  const reg = await loadRegistry();
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

/** A copy of a config file before it is rewritten, in XDG state (600, the last 5 of each key). */
export async function backup(t: Pick<Target, "path" | "managedKey">) {
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

/** Who could rewrite a config underneath us, or be hurt by the code being replaced: every open CLI/embedded
 *  session (`cli:<profile>`) and Desktop (`desktop:<profile>`) — what an update waits on. */
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
 * Writes the registry's Desktop servers into every existing Desktop config: merges only the managed
 * servers, backs up each file first, writes atomically and records which servers it manages. A
 * profile whose Desktop is running is left for later.
 *
 * @returns the changes applied, and the targets skipped because their Desktop was open
 */
export async function apply(): Promise<{ changes: Change[]; deferred: string[] }> {
  const reg = await loadRegistry();
  const state = await loadState();
  const { changes } = await plan();
  const open = new Set(Object.keys(await blockers()));
  const done: Change[] = [];
  const deferred: string[] = [];
  for (const t of await targets()) {
    const conf = await readJson<Record<string, unknown> & { mcpServers?: Record<string, unknown> }>(t.path);
    if (!conf) continue;
    const mine = changes.filter((c) => c.target.managedKey === t.managedKey);
    if (mine.length && open.has(t.managedKey)) {
      deferred.push(t.managedKey);
      continue;
    }
    const want = wanted(reg, t);
    if (mine.length) {
      const merged: Record<string, unknown> = { ...(conf.mcpServers ?? {}) };
      for (const c of mine) if (c.kind === "remove") delete merged[c.name];
      Object.assign(merged, want);
      conf.mcpServers = merged;
      await backup(t);
      await writeAtomic(t.path, JSON.stringify(conf, null, 2) + "\n");
      done.push(...mine);
    }
    state[t.managedKey] = Object.keys(want).sort();
  }
  await saveState(state);
  if (deferred.length) {
    await Deno.mkdir(CACHE, { recursive: true });
    await Deno.writeTextFile(PENDING, deferred.join("\n") + "\n");
  } else await Deno.remove(PENDING).catch(() => {});
  return { changes: done, deferred };
}

/** One line for a change: target key, +/~/− and the server name. */
export function describe(c: Change) {
  const sym = { add: "+", update: "~", remove: "−" }[c.kind];
  return `${c.target.managedKey.padEnd(16)} ${sym} ${c.name}`;
}
