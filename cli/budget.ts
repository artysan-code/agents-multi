// budget.ts — thresholds that alert on money actually spent, and on nothing else.
//
// Every profile is a subscription, and every profile may also have extra usage enabled. What you
// pay for is never the subscription — it is the extra usage on top of it. So consumption splits
// into three planes, and they are not interchangeable:
//
//   billed    extra-usage credits, in real currency. The only plane that can raise an alert.
//   plan      how full a subscription window is (session, weekly…). Tells you when you will be
//             throttled, never what you will pay. Silent unless a rule opts in with notify:true.
//   estimate  what the same tokens would cost at list price. A comparison figure. Never alerts.
//
// The old model asked "does this profile pay?" and cached the answer per profile. Wrong question:
// a profile does not pay, a *consumption* does. Here the plane belongs to the metric, so a profile
// on a subscription that occasionally spills into credits is handled without any per-profile
// wiring — which is also what makes adding a third profile a no-op.
//
// Source: `<profile>/.claude.json` → cachedUsageUtilization. Claude Code refreshes that cache when
// it feels like it, so every read carries its age, samples land in `credit_samples` (usage.db) to
// derive real daily spend, and a stale reading NEVER fires an alert.

import { readJson, RUNTIME, STATE, type Status } from "./lib.ts";
import type { DatabaseSync } from "node:sqlite";

const STATE_FILE = `${STATE}/budget-last.json`;

// ---------------------------------------------------------------- reading real state
/** The three planes consumption can live on. Only "billed" is money. */
export type Plane = "billed" | "plan" | "estimate";

export interface Extra {
  /** Extra usage switched on for this profile right now (per the cached reading). */
  active: boolean;
  everEnabled: boolean;
  spendLimitReached: boolean;
  /** Spent this month, in `currency`. */
  used: number | null;
  /** Monthly ceiling, in `currency`. */
  cap: number | null;
  /** Percentage of the cap consumed, as reported. */
  utilization: number | null;
  currency: string;
  decimals: number;
}
export interface PlanWindow { kind: string; group: string; percent: number; severity: string; resetsAt: string | null; active: boolean }
export interface Snapshot {
  profile: string;
  fetchedAt: string | null; ageHours: number | null; stale: boolean;
  extra: Extra | null; plan: PlanWindow[];
  /** Human-readable account of what the reading says, for the UI and the CLI. */
  reason: string;
}

interface RawExtra {
  is_enabled?: boolean; user_disabled?: boolean; spend_limit_reached?: boolean; credits_ever_enabled?: boolean;
  monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null;
  currency?: string | null; decimal_places?: number | null; disabled_reason?: string | null;
}
interface RawCache {
  fetchedAtMs?: number;
  utilization?: { extra_usage?: RawExtra | null; limits?: { kind?: string; group?: string; percent?: number; severity?: string; resets_at?: string | null; is_active?: boolean }[] };
}

/** Pure: raw cache to snapshot. `now` injectable for tests. */
export function classify(profile: string, raw: RawCache | null, disabledReason: string | null, staleAfterHours: number, now = Date.now()): Snapshot {
  const fetchedMs = raw?.fetchedAtMs ?? null;
  const ageHours = fetchedMs ? (now - fetchedMs) / 36e5 : null;
  const base = {
    profile, fetchedAt: fetchedMs ? new Date(fetchedMs).toISOString() : null, ageHours,
    stale: ageHours == null || ageHours > staleAfterHours,
    plan: (raw?.utilization?.limits ?? []).map((l) => ({
      kind: l.kind ?? "?", group: l.group ?? "?", percent: Number(l.percent ?? 0),
      severity: l.severity ?? "normal", resetsAt: l.resets_at ?? null, active: !!l.is_active,
    })),
  };
  const x = raw?.utilization?.extra_usage;
  if (!x) return { ...base, extra: null, reason: disabledReason ?? "no extra-usage data in .claude.json" };
  const dec = x.decimal_places ?? 2, div = 10 ** dec;
  const extra: Extra = {
    active: !!x.is_enabled && !x.user_disabled,
    everEnabled: !!x.credits_ever_enabled,
    spendLimitReached: !!x.spend_limit_reached,
    used: x.used_credits == null ? null : x.used_credits / div,
    cap: x.monthly_limit == null ? null : x.monthly_limit / div,
    utilization: x.utilization ?? null,
    currency: x.currency ?? "EUR", decimals: dec,
  };
  const why = extra.active
    ? "extra usage on — spending past the plan is charged"
    : `extra usage off (${x.user_disabled ? "disabled by user" : x.disabled_reason ?? disabledReason ?? "not active"})`;
  return { ...base, extra, reason: why };
}

export async function snapshot(profile: string, staleAfterHours: number): Promise<Snapshot> {
  const j = await readJson<{ cachedUsageUtilization?: RawCache; cachedExtraUsageDisabledReason?: string }>(`${RUNTIME}/${profile}/.claude.json`);
  return classify(profile, j?.cachedUsageUtilization ?? null, j?.cachedExtraUsageDisabledReason ?? null, staleAfterHours);
}

// ---------------------------------------------------------------- configuration
export type NotifyMode = boolean;
export interface Rule {
  id: string; metric: string; warn?: number | null; crit?: number | null; label?: string;
  /** Opt a non-billed metric into notifying. Billed metrics notify by default; everything else
   *  stays silent unless this is true, which is what keeps plan windows from crying wolf. */
  notify?: NotifyMode;
}
export interface ProfileCfg {
  rules?: Rule[]; note?: string;
  /** Alert ceiling in account currency, overriding the reported monthly cap. Useful when you want
   *  to hear about it well before the real limit. */
  cap?: number;
}
export interface BudgetCfg {
  enabled: boolean; staleAfterHours: number; cooldownMinutes: number;
  quietHours: { from: string; to: string } | null;
  defaults: ProfileCfg; profiles: Record<string, ProfileCfg>;
}
export const CFG_DEFAULT: BudgetCfg = {
  enabled: true, staleAfterHours: 36, cooldownMinutes: 240, quietHours: null,
  defaults: { rules: [] }, profiles: {},
};
export async function loadCfg(path: string): Promise<BudgetCfg> {
  const c = await readJson<Partial<BudgetCfg>>(path);
  return { ...CFG_DEFAULT, ...(c ?? {}), defaults: { ...CFG_DEFAULT.defaults, ...(c?.defaults ?? {}) }, profiles: c?.profiles ?? {} };
}

// ---------------------------------------------------------------- metrics
export interface Metric { value: number | null; unit: string; label: string; plane: Plane; detail?: string }
export interface Ctx {
  snap: Snapshot;
  /** Alert ceiling in effect for this profile: config override, else the reported cap. */
  cap: number | null;
  estDay: number | null; estWeek: number | null; estMonth: number | null;
  billedToday: number | null;
}

/** Metric value plus the plane it belongs to, which is what decides whether it may ever alert. */
export function metricOf(name: string, ctx: Ctx): Metric | null {
  const cur = ctx.snap.extra?.currency ?? "EUR";
  switch (name) {
    case "billed.today":
      return { value: ctx.billedToday, unit: cur, label: "billed today", plane: "billed" };
    case "billed.month":
      return { value: ctx.snap.extra?.used ?? null, unit: cur, label: "billed this month", plane: "billed" };
    case "billed.month.percent": {
      const used = ctx.snap.extra?.used ?? null;
      const pct = ctx.cap && used != null ? (used / ctx.cap) * 100 : ctx.snap.extra?.utilization ?? null;
      return { value: pct, unit: "%", label: "monthly cap used", plane: "billed" };
    }
    case "estimate.day": return { value: ctx.estDay, unit: "$", label: "list-price estimate today", plane: "estimate", detail: "list price, never billed" };
    case "estimate.week": return { value: ctx.estWeek, unit: "$", label: "list-price estimate, 7 days", plane: "estimate", detail: "list price, never billed" };
    case "estimate.month": return { value: ctx.estMonth, unit: "$", label: "list-price estimate, 30 days", plane: "estimate", detail: "list price, never billed" };
    default: {
      const m = name.match(/^plan\.([a-z_]+)\.percent$/);
      if (!m) return null;
      const l = ctx.snap.plan.find((p) => p.kind === m[1] || p.group === m[1]);
      return { value: l?.percent ?? null, unit: "%", label: `${m[1]} window`, plane: "plan", detail: "subscription window, not a charge" };
    }
  }
}

// ---------------------------------------------------------------- evaluation
export type Level = "ok" | "warn" | "crit";
export interface Alert {
  profile: string; ruleId: string; metric: string; label: string; level: Level;
  value: number | null; threshold: number | null; unit: string;
  plane: Plane; notify: boolean; why: string;
}

function rulesFor(cfg: BudgetCfg, profile: string): { rules: Rule[]; note?: string } {
  const p = cfg.profiles[profile] ?? {};
  return { rules: p.rules ?? cfg.defaults.rules ?? [], note: p.note };
}

/** Alert ceiling for a profile: the configured override wins over the reported cap. */
export function capFor(cfg: BudgetCfg, snap: Snapshot): number | null {
  return cfg.profiles[snap.profile]?.cap ?? cfg.defaults.cap ?? snap.extra?.cap ?? null;
}

/** Pure: rules plus context to alerts, each carrying the verdict on "should this notify?" and why. */
export function evaluate(cfg: BudgetCfg, ctx: Ctx): Alert[] {
  const { rules } = rulesFor(cfg, ctx.snap.profile);
  const out: Alert[] = [];
  for (const r of rules) {
    const m = metricOf(r.metric, ctx);
    if (!m) {
      out.push({ profile: ctx.snap.profile, ruleId: r.id, metric: r.metric, label: r.metric, level: "ok", value: null, threshold: null, unit: "", plane: "estimate", notify: false, why: "unknown metric" });
      continue;
    }
    const v = m.value;
    const level: Level = v == null ? "ok" : (r.crit != null && v >= r.crit) ? "crit" : (r.warn != null && v >= r.warn) ? "warn" : "ok";
    const threshold = level === "crit" ? r.crit! : level === "warn" ? r.warn! : (r.warn ?? r.crit ?? null);
    // Billed metrics notify by default; the other two planes only when a rule asks for it.
    const allowed = r.notify ?? (m.plane === "billed");
    let notify = level !== "ok", why = "";
    if (!cfg.enabled) { notify = false; why = "budget alerts disabled in configuration"; }
    else if (level === "ok") why = v == null ? "no data" : "below threshold";
    else if (!allowed) { notify = false; why = m.detail ?? "not a charge — informational only"; }
    else if (ctx.snap.stale && m.plane === "billed") { notify = false; why = `billing data ${Math.round(ctx.snap.ageHours ?? 0)} h old — not trusted`; }
    else why = `${m.label} past ${threshold}${m.unit === "$" ? "" : m.unit}`;
    out.push({ profile: ctx.snap.profile, ruleId: r.id, metric: r.metric, label: r.label ?? m.label, level, value: v, threshold, unit: m.unit, plane: m.plane, notify, why });
  }
  return out;
}

/** Pure: is the local time inside the quiet window? Handles windows crossing midnight. */
export function inQuietHours(now: Date, q: { from: string; to: string } | null): boolean {
  if (!q) return false;
  const min = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
  const t = now.getHours() * 60 + now.getMinutes(), a = min(q.from), b = min(q.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export interface LastState { at: string; levels: Record<string, { level: Level; at: string }> }
/** Pure: which alerts deserve a notification right now (level rose, or recovered, outside cooldown). */
export function toAnnounce(prev: LastState | null, alerts: Alert[], now: Date, cooldownMinutes: number) {
  const rank: Record<Level, number> = { ok: 0, warn: 1, crit: 2 };
  const levels = prev?.levels ?? {};
  const rising: Alert[] = [], recovered: string[] = [];
  for (const a of alerts) {
    const key = `${a.profile}/${a.ruleId}`;
    const before = levels[key];
    const prevLevel = before?.level ?? "ok";
    const ageMin = before ? (now.getTime() - new Date(before.at).getTime()) / 6e4 : Infinity;
    if (rank[a.level] > rank[prevLevel] && a.notify) rising.push(a);
    else if (a.level !== "ok" && a.notify && rank[a.level] === rank[prevLevel] && ageMin >= cooldownMinutes) rising.push(a);
    else if (a.level === "ok" && rank[prevLevel] > 0) recovered.push(key);
  }
  const next: LastState = { at: now.toISOString(), levels: { ...levels } };
  for (const a of alerts) {
    const key = `${a.profile}/${a.ruleId}`;
    const before = next.levels[key];
    // the timestamp only moves when the level changes or when we re-notify after the cooldown
    if (!before || before.level !== a.level || rising.includes(a)) next.levels[key] = { level: a.level, at: now.toISOString() };
  }
  for (const k of Object.keys(next.levels)) if (next.levels[k].level === "ok") delete next.levels[k];
  return { rising, recovered, next };
}

const fmtVal = (a: Alert) => a.value == null ? "—" : a.unit === "$" ? `$${a.value.toFixed(2)}` : a.unit === "%" ? `${a.value.toFixed(1)}%` : `${a.value.toFixed(2)} ${a.unit}`;

export function announceText(rising: Alert[], recovered: string[]): { title: string; body: string; urgency: "normal" | "critical" } | null {
  if (rising.length) {
    const crit = rising.some((a) => a.level === "crit");
    const lines = rising.slice(0, 4).map((a) => `• ${a.profile}: ${a.label} ${fmtVal(a)} (threshold ${a.threshold}${a.unit === "$" ? "" : a.unit})`);
    return { title: `claude-multi: extra usage ${crit ? "over the limit" : "approaching the limit"}`, body: lines.join("\n"), urgency: crit ? "critical" : "normal" };
  }
  if (recovered.length) return { title: "claude-multi: back under the threshold", body: recovered.join(", "), urgency: "normal" };
  return null;
}

// ---------------------------------------------------------------- state and samples
export async function loadLast(): Promise<LastState | null> {
  try { return JSON.parse(await Deno.readTextFile(STATE_FILE)); } catch { return null; }
}
export async function saveLast(s: LastState) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

/** Record a credits sample when the cache is newer than the last one seen (key = fetched_at). */
export function sampleCredits(db: DatabaseSync, s: Snapshot) {
  if (!s.fetchedAt || !s.extra) return false;
  const r = db.prepare("SELECT 1 FROM credit_samples WHERE profile = ? AND fetched_at = ?").get(s.profile, s.fetchedAt);
  if (r) return false;
  db.prepare(`INSERT INTO credit_samples (profile, fetched_at, seen_at, day, enabled, used_credits, monthly_limit, currency, decimals, utilization, plan_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    s.profile, s.fetchedAt, new Date().toISOString(), s.fetchedAt.slice(0, 10), s.extra.active ? 1 : 0,
    s.extra.used, s.extra.cap, s.extra.currency, s.extra.decimals, s.extra.utilization, JSON.stringify(s.plan));
  return true;
}

/** Today's billed spend: latest sample of today minus the one before it. null when not derivable. */
export function billedToday(db: DatabaseSync, profile: string, today = new Date().toISOString().slice(0, 10)): number | null {
  const last = db.prepare("SELECT used_credits, fetched_at FROM credit_samples WHERE profile = ? AND day = ? ORDER BY fetched_at DESC LIMIT 1").get(profile, today) as { used_credits: number | null; fetched_at: string } | undefined;
  if (!last || last.used_credits == null) return null;
  const before = db.prepare("SELECT used_credits FROM credit_samples WHERE profile = ? AND fetched_at < ? ORDER BY fetched_at DESC LIMIT 1").get(profile, last.fetched_at) as { used_credits: number | null } | undefined;
  if (!before || before.used_credits == null) return null;
  // the counter is monthly: it restarts at zero, and a negative delta is not spending
  return Math.max(0, last.used_credits - before.used_credits);
}

// ---------------------------------------------------------------- doctor checks
export function doctorChecks(snaps: Snapshot[], _cfg: BudgetCfg, alerts: Alert[]): { id: string; status: Status; msg: string; fix?: string }[] {
  const out: { id: string; status: Status; msg: string; fix?: string }[] = [];
  for (const s of snaps) {
    // Only profiles that actually spend are worth warning about: a stale reading matters when
    // there is money behind it, and is noise when there is not.
    const spends = !!s.extra && (s.extra.active || (s.extra.used ?? 0) > 0);
    if (!spends) continue;
    if (s.stale) {
      out.push({ id: `budget.${s.profile}.stale`, status: "warn", msg: `${s.profile}: extra usage is on but the reading is ${s.ageHours == null ? "?" : Math.round(s.ageHours)} h old — alerts are held`, fix: `open a ${s.profile} session, or run /usage inside it, to refresh` });
    } else if (s.extra?.spendLimitReached) {
      out.push({ id: `budget.${s.profile}.limit`, status: "fail", msg: `${s.profile}: extra-usage spend limit reached`, fix: "raise the limit or wait for the monthly reset" });
    }
  }
  const crit = alerts.filter((a) => a.level === "crit" && a.plane === "billed");
  if (crit.length) out.push({ id: "budget.thresholds", status: "warn", msg: `${crit.length} billing threshold(s) exceeded: ${crit.map((a) => `${a.profile}/${a.ruleId}`).join(", ")}`, fix: "claude-multi budget" });
  if (!out.length) out.push({ id: "budget", status: "ok", msg: budgetSummary(snaps) });
  return out;
}

export function budgetSummary(snaps: Snapshot[]) {
  const billed = snaps.reduce((a, s) => a + (s.extra?.used ?? 0), 0);
  const cur = snaps.find((s) => s.extra)?.extra?.currency ?? "EUR";
  const on = snaps.filter((s) => s.extra?.active).length;
  return `budget: ${billed.toFixed(2)} ${cur} billed this month across ${snaps.length} profile(s), extra usage on for ${on}`;
}

// ---------------------------------------------------------------- orchestration
import { ANSI, has, icon, profileNames, REPO, run } from "./lib.ts";
import { ingest, openDb, sinceDate } from "./usage.ts";

export const CFG_PATH = `${REPO}/shared/budget.json`;

function estimateSince(db: DatabaseSync, profile: string, spec: string): number | null {
  const since = sinceDate(spec);
  const r = db.prepare(`SELECT SUM(cost_usd) AS c FROM messages WHERE profile = ?${since ? " AND day >= ?" : ""}`)
    .get(...(since ? [profile, since] : [profile])) as { c: number | null } | undefined;
  return r?.c ?? null;
}

export interface BudgetReport { cfg: BudgetCfg; at: string; profiles: { snap: Snapshot; ctx: Omit<Ctx, "snap">; alerts: Alert[] }[]; alerts: Alert[] }

/** Read profile state, sample credits, compute the metrics and evaluate the rules. */
export async function collect(opts: { ingest?: boolean } = {}): Promise<BudgetReport> {
  const cfg = await loadCfg(CFG_PATH);
  const db = openDb();
  if (opts.ingest !== false) await ingest(db, { quiet: true });
  const today = new Date().toISOString().slice(0, 10);
  const profiles: BudgetReport["profiles"] = [];
  for (const p of await profileNames()) {
    const snap = await snapshot(p, cfg.staleAfterHours);
    sampleCredits(db, snap);
    const ctx: Ctx = {
      snap, cap: capFor(cfg, snap),
      estDay: estimateSince(db, p, "1d"), estWeek: estimateSince(db, p, "7d"), estMonth: estimateSince(db, p, "30d"),
      billedToday: billedToday(db, p, today),
    };
    const { snap: _s, ...rest } = ctx;
    profiles.push({ snap, ctx: rest, alerts: evaluate(cfg, ctx) });
  }
  db.close();
  return { cfg, at: new Date().toISOString(), profiles, alerts: profiles.flatMap((p) => p.alerts) };
}

export function printBudget(r: BudgetReport) {
  const { b, d, g, y, c, x } = { b: ANSI.b, d: ANSI.d, g: ANSI.g, y: ANSI.y, c: ANSI.c, x: ANSI.x };
  console.log(`${b}claude-multi budget${x}  ${d}(alerts fire on billed extra usage only)${x}`);
  for (const p of r.profiles) {
    const s = p.snap;
    const cur = s.extra?.currency ?? "EUR";
    const age = s.ageHours == null ? "never read" : s.ageHours < 1 ? "just refreshed" : `read ${Math.round(s.ageHours)} h ago${s.stale ? " (stale)" : ""}`;
    const tag = s.extra?.active ? `${y}extra usage on${x}` : `${g}subscription only${x}`;
    console.log(`\n  ${b}${s.profile}${x} · ${tag}  ${d}${age}${x}`);
    const billedM = s.extra?.used;
    console.log(`    billed     ${c}${billedM == null ? "—" : `${billedM.toFixed(2)} ${cur}`}${x} this month${p.ctx.cap ? ` ${d}of ${p.ctx.cap.toFixed(0)} ${cur}${x}` : ""}${p.ctx.billedToday != null ? ` · ${p.ctx.billedToday.toFixed(2)} ${cur} today` : ""}`);
    const plan = s.plan.filter((l) => l.percent > 0);
    if (plan.length) console.log(`    plan       ${plan.map((l) => `${l.kind} ${l.percent}%`).join(" · ")}`);
    console.log(`    ${d}estimate   today ${p.ctx.estDay == null ? "—" : `$${p.ctx.estDay.toFixed(2)}`} · 7d ${p.ctx.estWeek == null ? "—" : `$${p.ctx.estWeek.toFixed(2)}`} · 30d ${p.ctx.estMonth == null ? "—" : `$${p.ctx.estMonth.toFixed(2)}`}${x}`);
    for (const a of p.alerts) {
      const st = a.level === "crit" ? icon.fail : a.level === "warn" ? icon.warn : icon.ok;
      const th = a.threshold == null ? "" : ` ${d}/ ${a.threshold}${a.unit === "$" ? "" : a.unit}${x}`;
      console.log(`    ${st} ${a.label}: ${fmtVal(a)}${th}  ${d}${a.notify ? "→ notifying" : a.why}${x}`);
    }
  }
}

/** Compare with the last state and send a notification when warranted. True if it notified. */
export async function notifyBudget(r: BudgetReport, opts: { dryRun?: boolean } = {}) {
  const now = new Date();
  const { rising, recovered, next } = toAnnounce(await loadLast(), r.alerts, now, r.cfg.cooldownMinutes);
  const t = announceText(rising, recovered);
  if (inQuietHours(now, r.cfg.quietHours) && t) {
    // inside the quiet window the state is not saved: the notification lands on the next run
    console.log(`[quiet ${r.cfg.quietHours!.from}-${r.cfg.quietHours!.to}] holding: ${t.title}`);
    return false;
  }
  if (!opts.dryRun) await saveLast(next);
  if (!t) return false;
  if (opts.dryRun || !(await has("notify-send"))) { console.log(`[notification${opts.dryRun ? " dry-run" : " (notify-send missing)"}] ${t.title}\n${t.body}`); return true; }
  await run("notify-send", ["-a", "claude-multi", "-i", "claude-desktop", "-u", t.urgency, "--expire-time=600000", t.title, t.body]);
  return true;
}
