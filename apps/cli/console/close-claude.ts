// close-claude.ts — «Close Claude and update»: when the install a round left waits for every Claude
// to be closed (selfupdate.ts), the console can close them. The same for a Desktop rollback or variant
// rebuild, which needs only the Desktops closed. The PIDs are the server's
// own reading of /proc, never the page's: a request only says which step (ask, TERM, KILL, reopen) and
// what for, and every step lists the blockers again. Nothing is signalled unless an install is actually
// waiting (or a Desktop is to be replaced), and the console's own process tree (it may have been
// started from a Claude session) is never touched.

import { parentFromStat, parentPid, processAges } from "../../../shared/mcp/lib/platform.ts";
import { REPO } from "../lib/paths.ts";
import { run } from "../lib/proc.ts";
import { running } from "../lib/processes.ts";
import { launchers, profileNames } from "../lib/profiles.ts";
import { installWaiting, log } from "../selfupdate.ts";

type Running = Awaited<ReturnType<typeof running>>;

export interface Blocker {
  /** `cli:<profile>` or `desktop:<profile>`, the keys the update log uses. */
  key: string;
  profile: string;
  surface: "cli" | "desktop";
  pid: number;
  /** A Claude Code run by Desktop itself: it goes down with it. */
  embedded: boolean;
  /** Seconds since the process started; null when unknown. */
  ageSec: number | null;
  /** A CLI session whose transcript was written in the last two minutes; null for Desktop, which says nothing. */
  busy: boolean | null;
  /** In the console's own process tree: listed, never signalled. */
  protected: boolean;
}

const BUSY_WITHIN_MS = 120_000;

/** Pure: the open Claude instances of each profile, as blockers; `protect` are the PIDs not to touch. */
export function listBlockers(
  r: Running,
  profiles: string[],
  protect: Set<number>,
  ages: Map<number, number>,
  now = Date.now(),
): Blocker[] {
  const out: Blocker[] = [];
  for (const p of profiles) {
    for (const c of r.cli.filter((c) => c.profile === p)) {
      out.push({
        key: `cli:${p}`,
        profile: p,
        surface: "cli",
        pid: c.pid,
        embedded: c.embedded,
        ageSec: ages.get(c.pid) ?? null,
        busy: c.lastActivity ? now - Date.parse(c.lastActivity) < BUSY_WITHIN_MS : false,
        protected: protect.has(c.pid),
      });
    }
    for (const d of r.desktop.filter((d) => d.variant === p)) {
      out.push({
        key: `desktop:${p}`,
        profile: p,
        surface: "desktop",
        pid: d.pid,
        embedded: false,
        ageSec: ages.get(d.pid) ?? null,
        busy: null,
        protected: protect.has(d.pid),
      });
    }
  }
  return out;
}

/** Pure: the button shows only when something waits on open Claude instances (an install, a Desktop
 *  replaced) — not for an update skipped for another reason, nor when nothing is open (the action alone is
 *  enough then). */
export function closeOffer(due: boolean, blockers: Blocker[]): boolean {
  return due && blockers.length > 0;
}

export { parentFromStat };

export interface Deps {
  running: () => Promise<Running>;
  profiles: () => Promise<string[]>;
  /** The console's tree: its own pid and every ancestor. */
  protectedPids: () => Promise<Set<number>>;
  ages: (pids: number[]) => Promise<Map<number, number>>;
  pending: () => Promise<string | null>;
  signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<void>;
  note: (event: string, head: string, detail: string) => Promise<void>;
}

export const real: Deps = {
  running,
  profiles: profileNames,
  // deno-lint-ignore require-await
  protectedPids: async () => {
    const seen = new Set<number>();
    let p: number | null = Deno.pid;
    while (p && p > 1 && !seen.has(p)) {
      seen.add(p);
      p = parentPid(p);
    }
    return seen;
  },
  // deno-lint-ignore require-await
  ages: async (pids) => {
    return processAges(pids);
  },
  pending: installWaiting,
  signal: (pid, sig) => Deno.kill(pid, sig),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  note: (event, head, detail) => log(event, "", head, detail),
};

async function current(d: Deps): Promise<Blocker[]> {
  const r = await d.running();
  const protect = await d.protectedPids();
  const pids = [...r.cli.map((c) => c.pid), ...r.desktop.map((x) => x.pid)];
  return listBlockers(r, await d.profiles(), protect, await d.ages(pids));
}

/** What the closing is for: the install a round left waiting, or a Desktop rollback or variant
 *  rebuild (`desktop`, every Desktop; `desktop:<profile>`, that one). */
export type Purpose = "install" | "desktop" | `desktop:${string}`;

/** Pure: the purpose a request names, or null for one this server does not know. */
export function parsePurpose(v: unknown): Purpose | null {
  if (v === undefined || v === null || v === "" || v === "install") return "install";
  if (v === "desktop") return v;
  if (typeof v === "string" && /^desktop:[a-z0-9][a-z0-9-]*$/.test(v)) return v as Purpose;
  return null;
}

/** Who holds what the closing is for: every open Claude for an install, the Desktops for a rollback
 *  or rebuild (a Claude Code Desktop runs goes down with it). `due` is false when there is nothing to close them for. */
async function holders(d: Deps, why: Purpose): Promise<{ pending: string | null; due: boolean; blockers: Blocker[] }> {
  if (why.startsWith("desktop")) {
    const one = why.slice("desktop:".length);
    const all = await current(d);
    return {
      pending: null,
      due: true,
      blockers: all.filter((b) => b.surface === "desktop" && (!one || b.profile === one)),
    };
  }
  const pending = await d.pending();
  return { pending, due: !!pending, blockers: await current(d) };
}

export interface Plan {
  offer: boolean;
  /** The commit the waiting install came with. */
  pending: string | null;
  blockers: Blocker[];
}

/** What the confirmation dialog shows: who would be closed, and who is left alone. */
export async function closePlan(why: Purpose = "install", d: Deps = real): Promise<Plan> {
  const { pending, due, blockers } = await holders(d, why);
  return { offer: closeOffer(due, blockers), pending, blockers };
}

interface Closed {
  ok: boolean;
  message?: string;
  /** Signalled and gone. */
  closed: Blocker[];
  /** Still there: the dialog offers the force step, or says why nothing more can be done. */
  remaining: Blocker[];
  /** The profiles whose Desktop was among the closed ones, for «Reopen». */
  reopen: string[];
}

/**
 * SIGTERM (or, as the second step, SIGKILL) to every blocker outside the console's own tree, then
 * wait up to `waitMs` for them to be gone. Refuses when there is nothing to close them for (no install
 * waiting); with nothing left to close (the person closed them by hand while
 * the dialog was open) it succeeds at once, so the install or the sync goes on.
 */
export async function closeSessions(
  signal: "SIGTERM" | "SIGKILL",
  why: Purpose = "install",
  waitMs = 15000,
  d: Deps = real,
): Promise<Closed> {
  const { pending, due, blockers: before } = await holders(d, why);
  if (due && !before.length) return { ok: true, closed: [], remaining: [], reopen: [] };
  if (!due) {
    return {
      ok: false,
      message: "no install is waiting for Claude to be closed",
      closed: [],
      remaining: [],
      reopen: [],
    };
  }
  const targets = before.filter((b) => !b.protected);
  for (const b of targets) {
    try {
      d.signal(b.pid, signal);
    } catch { /* gone already */ }
  }
  const alive = (bs: Blocker[]) => bs.filter((b) => !b.protected && targets.some((t) => t.pid === b.pid));
  let left = alive(await current(d));
  for (let t = 0; left.length && t < waitMs; t += 500) {
    await d.sleep(500);
    left = alive(await current(d));
  }
  const closed = targets.filter((t) => !left.some((l) => l.pid === t.pid));
  const detail = (why === "install" ? "" : `for ${why}: `) + closed.map((b) => `${b.key} pid ${b.pid}`).join(", ");
  if (closed.length) {
    await d.note(signal === "SIGKILL" ? "force-closed" : "closed", pending ?? "", detail);
  }
  return {
    ok: true,
    closed,
    remaining: left,
    reopen: [...new Set(closed.filter((b) => b.surface === "desktop").map((b) => b.profile))],
  };
}

/** Starts Claude Desktop again for profiles the manifests declare, through the one launcher script. */
export async function reopen(profiles: string[], start = startDetached): Promise<string[]> {
  const known = new Set((await launchers()).map((l) => l.profile));
  const started: string[] = [];
  for (const p of profiles) {
    if (!known.has(p)) continue;
    await start(`${REPO}/bin/claude-launch`, [p]);
    started.push(p);
  }
  return started;
}

/** Detached from the console: a transient user unit when systemd has one to give, so a console
 *  restart (the update may have changed its code) does not take the app down with it. */
async function startDetached(bin: string, args: string[]) {
  const r = await run("systemd-run", ["--user", "--quiet", "--collect", bin, ...args]);
  if (r.code === 0) return;
  new Deno.Command(bin, { args, stdin: "null", stdout: "null", stderr: "null" }).spawn().unref();
}
