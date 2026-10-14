// live.ts — Claude at work, as Today's «Claude now» shows it: each profile's usage limits (the five
// hours and the week) and each session's context.
//
// The status line writes them (shared/statusline-command.sh): Claude Code hands it, at every turn, the
// session's context window and the account's rate limits, and the script keeps a snapshot per session
// in <state>/live/<session>.json. Nothing here asks Anthropic for them, except when the person asks to
// refresh (POST /api/live/refresh): then each profile's own login reads its limits from the endpoint
// Claude Code's /usage uses, and the answer is kept as <state>/live/limits-<profile>.json. The token is
// read for that request and never kept, logged or sent anywhere else.
//
// The access token lives a few hours and only Claude Code renews it, when the profile runs in a
// terminal: a profile used from Desktop (which has its own login) keeps an expired one. That is not a
// sign-out, so an expired token is renewed by Claude Code itself — one tiny request through the
// profile's launcher (probeLogin) — never here: two renewers of one token would revoke each other.

import { type Limits, limitsOf } from "../../shared/mcp/lib/limits.ts";
import { readJson, writeAtomic } from "./lib/fs.ts";
import { RUNTIME, STATE } from "./lib/paths.ts";
import { launchers, profileNames } from "./lib/profiles.ts";
import { isLoginError, probeLogin, recordLogin } from "./login.ts";
import { openDb, report } from "./usage.ts";

export { type Limit, limitOf, type Limits, limitsOf } from "../../shared/mcp/lib/limits.ts";

const LIVE = `${STATE}/live`;
/** Snapshots older than this are of sessions long gone: dropped when read. */
const KEEP_S = 7 * 24 * 3600;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

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

/** Pure: whether a stored access token has to be renewed before it is used (gone, or within a minute). */
export const tokenStale = (expiresAt: unknown, now = Date.now()): boolean =>
  typeof expiresAt === "number" && expiresAt - now < 60_000;

/** Pure: what the page says when the limits cannot be read with an expired token. `probeError` is why
 *  the renewal failed: a login error is a real sign-out, anything else is not one. */
export function expiredMessage(command: string, probeError: string | null, isLogin: boolean): string {
  if (probeError === null) return `the token was renewed but refused: run ${command}, then /login`;
  if (isLogin) return `signed out: run ${command}, then /login`;
  return `the token has expired and could not be renewed (${probeError}): it is not a sign-out, running ${command} renews it`;
}

type Creds = { accessToken?: string; expiresAt?: number };
const readCreds = async (profile: string) =>
  (await readJson<{ claudeAiOauth?: Creds }>(`${RUNTIME}/${profile}/.credentials.json`))?.claudeAiOauth;

/** Claude Code renews the profile's token with one tiny request; null when it worked, else the message. */
async function renew(profile: string, command: string): Promise<string | null> {
  const v = await probeLogin(command);
  const err = v.ok ? null : v.error ?? "error";
  await recordLogin(profile, command, err);
  return err === null ? null : expiredMessage(command, err, isLoginError(err));
}

/** One profile's limits from the endpoint, with its own login; null with the reason when it cannot. */
async function fetchLimits(profile: string, command: string): Promise<{ limits: Limits } | { error: string }> {
  let creds = await readCreds(profile);
  // a login Claude Code keeps elsewhere (the keyring, a token in the environment): the status line still reports them
  if (!creds?.accessToken) return { error: "no login token readable here: its sessions report the limits" };
  let renewed = false;
  if (tokenStale(creds.expiresAt)) {
    const e = await renew(profile, command);
    if (e) return { error: e };
    creds = await readCreds(profile);
    renewed = true;
  }
  const ask = (token: string | undefined) =>
    fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10000),
    }).catch((e: Error) => e);
  let r = await ask(creds?.accessToken);
  // refused before its stated expiry (revoked, clock skew): one renewal, then once more
  if (!(r instanceof Error) && r.status === 401 && !renewed) {
    const e = await renew(profile, command);
    if (e) return { error: e };
    r = await ask((await readCreds(profile))?.accessToken);
  }
  if (r instanceof Error) return { error: r.message };
  if (r.status === 401) return { error: expiredMessage(command, null, false) };
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const limits = limitsOf(await r.json().catch(() => null));
  return limits ? { limits } : { error: "no limits in the answer" };
}

/** Asks the endpoint for every profile's limits now, keeps what comes back; the errors by profile. */
export async function refresh(): Promise<Record<string, string>> {
  await Deno.mkdir(LIVE, { recursive: true });
  const errors: Record<string, string> = {};
  // side by side: a renewal takes seconds, and each profile has its own token
  await Promise.all((await launchers()).map(async ({ profile: p, command }) => {
    const r = await fetchLimits(p, command);
    if ("error" in r) {
      errors[p] = r.error;
      return;
    }
    const snap: Snapshot = { at: Math.round(Date.now() / 1000), profile: p, limits: r.limits, source: "endpoint" };
    await writeAtomic(`${LIVE}/limits-${p}.json`, JSON.stringify(snap));
  }));
  return errors;
}
