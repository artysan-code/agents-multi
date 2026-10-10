// live.ts — Claude at work, as Today's «Claude now» shows it: each profile's usage limits (the five
// hours and the week) and each session's context.
//
// The status line writes them (shared/statusline-command.sh): Claude Code hands it, at every turn, the
// session's context window and the account's rate limits, and the script keeps a snapshot per session
// in <state>/live/<session>.json. Nothing here asks Anthropic for them, except when the person asks to
// refresh (POST /api/live/refresh): then each profile's own login reads its limits from the endpoint
// Claude Code's /usage uses, and the answer is kept as <state>/live/limits-<profile>.json. The token is
// read for that request and never kept, logged or sent anywhere else.

import { readJson } from "./lib/fs.ts";
import { RUNTIME, STATE } from "./lib/paths.ts";
import { profileNames } from "./lib/profiles.ts";
import { openDb, report } from "./usage.ts";

const LIVE = `${STATE}/live`;
/** Snapshots older than this are of sessions long gone: dropped when read. */
const KEEP_S = 7 * 24 * 3600;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

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
export interface Snapshot {
  /** epoch seconds */
  at: number;
  profile: string;
  session?: string;
  cwd?: string;
  model?: string;
  context?: { used: number | null; size: number | null; tokens: number | null };
  limits?: Limits;
  cost?: number | null;
  /** where the limits came from */
  source?: "statusline" | "endpoint";
}

export interface LiveView {
  profiles: Record<string, { limits: Limits | null; at: number | null; source: string | null; tokens: number }>;
  sessions: Record<string, { context: Snapshot["context"]; model: string | null; at: number; cwd: string | null }>;
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

/** Pure: what the page shows, from the snapshots, the profiles and today's tokens by profile. The
 *  limits of a profile are its newest, whichever wrote them; a session is the newest of its own. */
export function liveView(snaps: Snapshot[], profiles: string[], tokens: Record<string, number> = {}): LiveView {
  const view: LiveView = { profiles: {}, sessions: {} };
  for (const p of profiles) view.profiles[p] = { limits: null, at: null, source: null, tokens: tokens[p] ?? 0 };
  for (const s of [...snaps].sort((a, b) => a.at - b.at)) {
    const p = view.profiles[s.profile];
    if (p && s.limits) Object.assign(p, { limits: s.limits, at: s.at, source: s.source ?? "statusline" });
    if (s.session) {
      view.sessions[s.session] = { context: s.context, model: s.model ?? null, at: s.at, cwd: s.cwd ?? null };
    }
  }
  return view;
}

/** The snapshots on disk, the ones too old removed. */
async function readSnapshots(now = Date.now() / 1000): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  try {
    for await (const e of Deno.readDir(LIVE)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const path = `${LIVE}/${e.name}`;
      const s = await readJson<Snapshot>(path);
      if (!s || typeof s.at !== "number" || typeof s.profile !== "string") continue;
      if (now - s.at > KEEP_S) {
        await Deno.remove(path).catch(() => {});
        continue;
      }
      out.push(s);
    }
  } catch { /* no snapshot yet */ }
  return out;
}

/** Today's tokens (input, output, cache read and write) by profile, from the usage database. */
function todayTokens(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const db = openDb();
    const today = new Date().toISOString().slice(0, 10);
    for (const r of report(db, { by: "profile", since: today }).rows) {
      out[r.key] = (r.input ?? 0) + (r.output ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0);
    }
    db.close();
  } catch { /* no database yet */ }
  return out;
}

export async function live(): Promise<LiveView> {
  return liveView(await readSnapshots(), await profileNames(), todayTokens());
}

/** One profile's limits from the endpoint, with its own login; null with the reason when it cannot. */
async function fetchLimits(profile: string): Promise<{ limits: Limits } | { error: string }> {
  const creds = await readJson<{ claudeAiOauth?: { accessToken?: string } }>(`${RUNTIME}/${profile}/.credentials.json`);
  const token = creds?.claudeAiOauth?.accessToken;
  // a login Claude Code keeps elsewhere (the keyring, a token in the environment): the status line still reports them
  if (!token) return { error: "no login token readable here: its sessions report the limits" };
  const r = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10000),
  }).catch((e: Error) => e);
  if (r instanceof Error) return { error: r.message };
  if (r.status === 401) return { error: "the login has expired: open Claude to sign in again" };
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const limits = limitsOf(await r.json().catch(() => null));
  return limits ? { limits } : { error: "no limits in the answer" };
}

/** Asks the endpoint for every profile's limits now, keeps what comes back; the errors by profile. */
export async function refresh(): Promise<Record<string, string>> {
  await Deno.mkdir(LIVE, { recursive: true });
  const errors: Record<string, string> = {};
  for (const p of await profileNames()) {
    const r = await fetchLimits(p);
    if ("error" in r) {
      errors[p] = r.error;
      continue;
    }
    const snap: Snapshot = { at: Math.round(Date.now() / 1000), profile: p, limits: r.limits, source: "endpoint" };
    const path = `${LIVE}/limits-${p}.json`;
    await Deno.writeTextFile(`${path}.tmp`, JSON.stringify(snap));
    await Deno.rename(`${path}.tmp`, path);
  }
  return errors;
}
