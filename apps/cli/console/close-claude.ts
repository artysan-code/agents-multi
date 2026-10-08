// close-claude.ts — «Close Claude and update»: when the install a round left waits for every Claude
// to be closed (selfupdate.ts), the console can close them. The PIDs are the server's own reading of
// /proc, never the page's: a request only says which step (ask, TERM, KILL, reopen), and every step
// lists the blockers again. Nothing is signalled unless an install is actually waiting, and the
// console's own process tree (it may have been started from a Claude session) is never touched.

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

/** Pure: the button shows only for an install waiting on open Claude instances — not for an update
 *  skipped for another reason, nor when nothing is open (Update now is enough then). */
export function closeOffer(pending: string | null, blockers: Blocker[]): boolean {
  return !!pending && blockers.length > 0;
}

/** The parent pid out of /proc/<pid>/stat: the name between parentheses may hold spaces. */
export function parentFromStat(stat: string): number | null {
  const m = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  return Number(m[1]) || null;
}

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

async function procParent(pid: number): Promise<number | null> {
  const r = await run("cat", [`/proc/${pid}/stat`]);
  return r.code === 0 ? parentFromStat(r.out) : null;
}

export const real: Deps = {
  running,
  profiles: profileNames,
  protectedPids: async () => {
    const seen = new Set<number>();
    let p: number | null = Deno.pid;
    while (p && p > 1 && !seen.has(p)) {
      seen.add(p);
      p = await procParent(p);
    }
    return seen;
  },
  ages: async (pids) => {
    const m = new Map<number, number>();
    if (!pids.length) return m;
    const r = await run("ps", ["-o", "pid=,etimes=", "-p", pids.join(",")]);
    for (const l of r.out.split("\n")) {
      const [pid, s] = l.trim().split(/\s+/).map(Number);
      if (pid && Number.isFinite(s)) m.set(pid, s);
    }
    return m;
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

export interface Plan {
  offer: boolean;
  /** The commit the waiting install came with. */
  pending: string | null;
  blockers: Blocker[];
}

/** What the confirmation dialog shows: who would be closed, and who is left alone. */
export async function closePlan(d: Deps = real): Promise<Plan> {
  const pending = await d.pending();
  const blockers = await current(d);
  return { offer: closeOffer(pending, blockers), pending, blockers };
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
 * wait up to `waitMs` for them to be gone. Refuses when no install is waiting; with nothing left to
 * close (the person closed them by hand while the dialog was open) it succeeds at once, so the
 * install goes on.
 */
export async function closeSessions(signal: "SIGTERM" | "SIGKILL", waitMs = 15000, d: Deps = real): Promise<Closed> {
  const pending = await d.pending();
  const before = await current(d);
  if (pending && !before.length) return { ok: true, closed: [], remaining: [], reopen: [] };
  if (!closeOffer(pending, before)) {
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
  const detail = closed.map((b) => `${b.key} pid ${b.pid}`).join(", ");
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
