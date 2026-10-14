// limits.ts — an account's usage windows in one shape, whichever provider's they are, read the passive
// way: Claude's from the status line's snapshots (`<state>/live/*.json`, written by
// shared/statusline-command.sh), Codex's from the account's session logs (codex.ts). Nothing here asks a
// vendor and nothing reads a login: the one place that does, on the owner's request, is apps/cli/live.ts.
// A window whose reset has passed says nothing about the next one, so it is left out: unknown, never a guess.

import type { CodexLimits } from "./codex.ts";

/** Where a window's reading came from. */
export type LimitSource = "statusline" | "endpoint" | "codex-log";

/** One window of an account: `window` is its length by name ("5h", "7d", "30d"…), `usedPercent` 0–100
 *  (above 100 once exceeded), `resetsAt` epoch seconds, `at` when it was read (epoch seconds). */
export interface Window {
  window: string;
  usedPercent: number;
  resetsAt: number | null;
  source: LimitSource;
  at: number | null;
}

export interface Limit {
  /** 0–100, above 100 once exceeded */
  used: number;
  /** when the window starts again, epoch seconds */
  resets: number | null;
}
export interface Limits {
  five_hour?: Limit;
  seven_day?: Limit;
}

/** What a limits reading needs of a snapshot (apps/cli/live.ts keeps more of it). */
export interface LimitSnapshot {
  /** epoch seconds */
  at: number;
  profile: string;
  limits?: Limits;
  source?: "statusline" | "endpoint";
}

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

/** Pure: a window of the limits as Claude Code gives it (the status line: used_percentage and epoch
 *  seconds; the endpoint: utilization and an ISO date or seconds) in one shape. */
export function limitOf(v: unknown): Limit | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const used = num(o.used_percentage) ?? num(o.utilization);
  if (used === null) return undefined;
  const r = o.resets_at;
  const resets = typeof r === "number"
    ? r
    : typeof r === "string" && r
    ? Math.round(Date.parse(r) / 1000) || null
    : null;
  return { used: Math.round(used * 10) / 10, resets };
}

/** Pure: the limits out of a status line's rate_limits or the endpoint's answer. */
export function limitsOf(v: unknown): Limits | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const l: Limits = {};
  const f = limitOf(o.five_hour), s = limitOf(o.seven_day);
  if (f) l.five_hour = f;
  if (s) l.seven_day = s;
  return f || s ? l : undefined;
}

/** Pure: a window's length in minutes as its name: 300 → "5h", 10080 → "7d", 43200 → "30d". */
export function windowName(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const live = (w: Window, now: number) => w.resetsAt === null || w.resetsAt > now;

/** Pure: a profile's Claude windows: the newest snapshot of the profile that carries limits (whichever
 *  session or the endpoint wrote it), its windows that have not reset yet. */
export function claudeWindows(snaps: LimitSnapshot[], profile: string, now: number): Window[] {
  const newest = snaps.filter((s) => s.profile === profile && s.limits).sort((a, b) => b.at - a.at)[0];
  if (!newest?.limits) return [];
  const w = (name: string, l: Limit | undefined): Window[] =>
    l
      ? [{
        window: name,
        usedPercent: l.used,
        resetsAt: l.resets,
        source: newest.source ?? "statusline",
        at: newest.at,
      }]
      : [];
  return [...w("5h", newest.limits.five_hour), ...w("7d", newest.limits.seven_day)].filter((x) => live(x, now));
}

/** Pure: Codex's windows (codex.ts) in the same shape, the ones that have not reset yet. */
export function codexWindows(l: CodexLimits | null, now: number): Window[] {
  if (!l) return [];
  const at = l.at ? Math.round(Date.parse(l.at) / 1000) || null : null;
  return [l.primary, l.secondary].flatMap((w) =>
    w
      ? [{
        window: windowName(w.window),
        usedPercent: w.used_percent,
        resetsAt: w.resets_at,
        source: "codex-log" as const,
        at,
      }]
      : []
  ).filter((x) => live(x, now));
}

/** The snapshots on disk, read only (the console's reader also prunes the old ones: a server of ours may
 *  not write there). Missing folder, unreadable or malformed files: nothing. */
export async function readLiveSnapshots(dir: string): Promise<LimitSnapshot[]> {
  const out: LimitSnapshot[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      try {
        const s = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`)) as LimitSnapshot;
        if (typeof s?.at === "number" && typeof s.profile === "string") out.push(s);
      } catch { /* a file being replaced, or not ours */ }
    }
  } catch { /* no snapshot yet */ }
  return out;
}
