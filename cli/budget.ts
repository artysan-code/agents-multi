// budget.ts — soglie di consumo che notificano SOLO quando si spende davvero.
//
// Il punto: su abbonamento Max i token non sono fatturati. Il «costo» di usage.ts è un equivalente
// a listino, utile per confrontare — non una spesa. Notificare su quello sarebbe rumore.
// Si paga davvero solo quando il profilo consuma EXTRA CREDITS, e questo Claude Code lo scrive in
// `<profilo>/.claude.json` → `cachedUsageUtilization.utilization.extra_usage`:
//
//   is_enabled false / user_disabled true / disabled_reason  → "included": nessuna notifica di spesa
//   is_enabled true  + monthly_limit + used_credits          → "credits": qui le soglie hanno senso
//
// Oggi (2026-09) personal è included (org_level_disabled), work è a crediti. La classificazione la
// legge il codice, non è cablata: se domani cambia, cambiano le notifiche.
//
// La cache in .claude.json la aggiorna Claude Code quando gli pare: può essere vecchia di settimane.
// Perciò ogni lettura porta la sua età, i campioni finiscono in `credit_samples` (usage.db) per
// ricavare la spesa giornaliera reale, e un dato stantio non fa MAI scattare una notifica.

import { readJson, RUNTIME, STATE, PROFILES, type Profile, type Status } from "./lib.ts";
import type { DatabaseSync } from "node:sqlite";

const STATE_FILE = `${STATE}/budget-last.json`;

// ---------------------------------------------------------------- lettura dello stato reale
export type Billing = "included" | "credits" | "unknown";

export interface Credits {
  enabled: boolean; userDisabled: boolean; spendLimitReached: boolean;
  used: number | null; limit: number | null; utilization: number | null;
  currency: string; decimals: number; everEnabled: boolean;
}
export interface PlanLimit { kind: string; group: string; percent: number; severity: string; resetsAt: string | null; active: boolean }
export interface Snapshot {
  profile: string; billing: Billing; reason: string;
  fetchedAt: string | null; ageHours: number | null; stale: boolean;
  credits: Credits | null; plan: PlanLimit[];
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

/** Pura: dalla cache grezza allo snapshot classificato. `now` iniettabile per i test. */
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
  if (!x) return { ...base, billing: "unknown", reason: disabledReason ?? "nessun dato sugli extra credits in .claude.json", credits: null };
  const dec = x.decimal_places ?? 2, div = 10 ** dec;
  const credits: Credits = {
    enabled: !!x.is_enabled, userDisabled: !!x.user_disabled, spendLimitReached: !!x.spend_limit_reached,
    used: x.used_credits == null ? null : x.used_credits / div,
    limit: x.monthly_limit == null ? null : x.monthly_limit / div,
    utilization: x.utilization ?? null, currency: x.currency ?? "EUR", decimals: dec, everEnabled: !!x.credits_ever_enabled,
  };
  if (x.is_enabled && !x.user_disabled) return { ...base, billing: "credits", reason: "extra credits attivi: il consumo oltre il piano è a pagamento", credits };
  const why = x.user_disabled ? "disattivati dall'utente" : x.disabled_reason ?? disabledReason ?? "non attivi";
  return { ...base, billing: "included", reason: `extra credits ${why}: nessun costo oltre l'abbonamento`, credits };
}

export async function snapshot(profile: Profile, staleAfterHours: number): Promise<Snapshot> {
  const j = await readJson<{ cachedUsageUtilization?: RawCache; cachedExtraUsageDisabledReason?: string }>(`${RUNTIME}/${profile}/.claude.json`);
  return classify(profile, j?.cachedUsageUtilization ?? null, j?.cachedExtraUsageDisabledReason ?? null, staleAfterHours);
}

// ---------------------------------------------------------------- configurazione
export type NotifyMode = boolean | "auto";
export interface Rule { id: string; metric: string; warn?: number | null; crit?: number | null; notify?: NotifyMode; label?: string }
export interface ProfileCfg {
  notify?: NotifyMode; rules?: Rule[]; note?: string;
  /** override della classe: "auto" (default) la legge da .claude.json, che però Claude Code aggiorna
   *  quando gli pare. Se sai che un profilo paga (o non paga), cablalo qui e non dipendi dalla cache. */
  billing?: Billing | "auto";
}
export interface BudgetCfg {
  enabled: boolean; staleAfterHours: number; cooldownMinutes: number;
  quietHours: { from: string; to: string } | null;
  defaults: ProfileCfg; profiles: Record<string, ProfileCfg>;
}
export const CFG_DEFAULT: BudgetCfg = {
  enabled: true, staleAfterHours: 36, cooldownMinutes: 240, quietHours: null,
  defaults: { notify: "auto", rules: [] }, profiles: {},
};
export async function loadCfg(path: string): Promise<BudgetCfg> {
  const c = await readJson<Partial<BudgetCfg>>(path);
  return { ...CFG_DEFAULT, ...(c ?? {}), defaults: { ...CFG_DEFAULT.defaults, ...(c?.defaults ?? {}) }, profiles: c?.profiles ?? {} };
}

// ---------------------------------------------------------------- metriche
export interface Metric { value: number | null; unit: string; label: string; real: boolean; detail?: string }
export interface Ctx { snap: Snapshot; costDay: number | null; costWeek: number | null; costMonth: number | null; creditsSpentDay: number | null }

/**
 * Il valore della metrica e, soprattutto, se rappresenta SPESA REALE.
 * `real=false` → la soglia si può valutare e mostrare, ma in modalità "auto" non notifica:
 * è consumo incluso nell'abbonamento, svegliare qualcuno per quello è rumore.
 */
export function metricOf(name: string, ctx: Ctx): Metric | null {
  const cur = ctx.snap.credits?.currency ?? "EUR";
  const paying = ctx.snap.billing === "credits";
  switch (name) {
    case "cost.day": return { value: ctx.costDay, unit: "$", label: "costo equivalente oggi", real: paying, detail: paying ? undefined : "equivalente a listino, non fatturato" };
    case "cost.week": return { value: ctx.costWeek, unit: "$", label: "costo equivalente 7 giorni", real: paying, detail: paying ? undefined : "equivalente a listino, non fatturato" };
    case "cost.month": return { value: ctx.costMonth, unit: "$", label: "costo equivalente 30 giorni", real: paying, detail: paying ? undefined : "equivalente a listino, non fatturato" };
    case "credits.utilization": return { value: ctx.snap.credits?.utilization ?? null, unit: "%", label: "crediti del mese usati", real: paying };
    case "credits.used": return { value: ctx.snap.credits?.used ?? null, unit: cur, label: "crediti spesi nel mese", real: paying };
    case "credits.spent.day": return { value: ctx.creditsSpentDay, unit: cur, label: "crediti spesi oggi", real: paying };
    default: {
      const m = name.match(/^plan\.([a-z_]+)\.percent$/);
      if (!m) return null;
      const l = ctx.snap.plan.find((p) => p.kind === m[1] || p.group === m[1]);
      // i limiti del piano non costano: informano su quanto resta della finestra, non su una spesa
      return { value: l?.percent ?? null, unit: "%", label: `limite ${m[1]} del piano`, real: false, detail: "limite dell'abbonamento, non una spesa" };
    }
  }
}

// ---------------------------------------------------------------- valutazione
export type Level = "ok" | "warn" | "crit";
export interface Alert {
  profile: string; ruleId: string; metric: string; label: string; level: Level;
  value: number | null; threshold: number | null; unit: string;
  real: boolean; notify: boolean; why: string;
}

function rulesFor(cfg: BudgetCfg, profile: string): { rules: Rule[]; notify: NotifyMode; note?: string } {
  const p = cfg.profiles[profile] ?? {};
  return { rules: p.rules ?? cfg.defaults.rules ?? [], notify: p.notify ?? cfg.defaults.notify ?? "auto", note: p.note };
}

/** L'override di configurazione vince sulla cache: la classe è una impostazione dell'account, non una misura. */
export function applyOverride(cfg: BudgetCfg, snap: Snapshot): Snapshot {
  const o = cfg.profiles[snap.profile]?.billing ?? cfg.defaults.billing ?? "auto";
  if (o === "auto" || o === snap.billing) return snap;
  return { ...snap, billing: o, reason: `classe forzata a "${o}" in shared/budget.json (letto: ${snap.billing})` };
}

/** Pura: regole + contesto → allarmi, ciascuno con il verdetto su «va notificato?» e perché. */
export function evaluate(cfg: BudgetCfg, ctx: Ctx): Alert[] {
  const { rules, notify: pnotify } = rulesFor(cfg, ctx.snap.profile);
  const out: Alert[] = [];
  for (const r of rules) {
    const m = metricOf(r.metric, ctx);
    if (!m) { out.push({ profile: ctx.snap.profile, ruleId: r.id, metric: r.metric, label: r.metric, level: "ok", value: null, threshold: null, unit: "", real: false, notify: false, why: "metrica sconosciuta" }); continue; }
    const v = m.value;
    const level: Level = v == null ? "ok" : (r.crit != null && v >= r.crit) ? "crit" : (r.warn != null && v >= r.warn) ? "warn" : "ok";
    const threshold = level === "crit" ? r.crit! : level === "warn" ? r.warn! : (r.warn ?? r.crit ?? null);
    const mode = r.notify ?? pnotify;
    let notify = level !== "ok", why = "";
    if (!cfg.enabled) { notify = false; why = "budget disabilitato in configurazione"; }
    else if (level === "ok") why = v == null ? "nessun dato" : "sotto soglia";
    else if (mode === false) { notify = false; why = "notifiche spente per questa regola"; }
    else if (mode === "auto" && !m.real) { notify = false; why = m.detail ?? "consumo incluso nell'abbonamento"; }
    else if (ctx.snap.stale && r.metric.startsWith("credits")) { notify = false; why = `dato crediti vecchio di ${Math.round(ctx.snap.ageHours ?? 0)} h: non affidabile`; }
    else why = `${m.label} oltre la soglia ${threshold}${m.unit === "$" ? "" : m.unit}`;
    out.push({ profile: ctx.snap.profile, ruleId: r.id, metric: r.metric, label: r.label ?? m.label, level, value: v, threshold, unit: m.unit, real: m.real, notify, why });
  }
  return out;
}

/** Pura: ora locale dentro la finestra di silenzio? Supporta finestre a cavallo di mezzanotte. */
export function inQuietHours(now: Date, q: { from: string; to: string } | null): boolean {
  if (!q) return false;
  const min = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };
  const t = now.getHours() * 60 + now.getMinutes(), a = min(q.from), b = min(q.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export interface LastState { at: string; levels: Record<string, { level: Level; at: string }> }
/** Pura: quali allarmi meritano davvero una notifica adesso (salita di livello o rientro, fuori cooldown). */
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
    // il timestamp si aggiorna solo quando il livello cambia o quando si rinotifica (cooldown)
    if (!before || before.level !== a.level || rising.includes(a)) next.levels[key] = { level: a.level, at: now.toISOString() };
  }
  for (const k of Object.keys(next.levels)) if (next.levels[k].level === "ok") delete next.levels[k];
  return { rising, recovered, next };
}

export function announceText(rising: Alert[], recovered: string[]): { title: string; body: string; urgency: "normal" | "critical" } | null {
  if (rising.length) {
    const crit = rising.some((a) => a.level === "crit");
    const fmtv = (a: Alert) => a.value == null ? "—" : a.unit === "$" ? `$${a.value.toFixed(2)}` : a.unit === "%" ? `${a.value.toFixed(1)}%` : `${a.value.toFixed(2)} ${a.unit}`;
    const lines = rising.slice(0, 4).map((a) => `• ${a.profile}: ${a.label} ${fmtv(a)} (soglia ${a.threshold}${a.unit === "$" ? "" : a.unit})${a.metric.startsWith("cost.") ? " — equivalente a listino, proxy della spesa" : ""}`);
    return { title: `claude-multi: spesa ${crit ? "oltre il limite" : "in avvicinamento"}`, body: lines.join("\n"), urgency: crit ? "critical" : "normal" };
  }
  if (recovered.length) return { title: "claude-multi: spesa rientrata", body: recovered.join(", "), urgency: "normal" };
  return null;
}

// ---------------------------------------------------------------- stato e campioni
export async function loadLast(): Promise<LastState | null> {
  try { return JSON.parse(await Deno.readTextFile(STATE_FILE)); } catch { return null; }
}
export async function saveLast(s: LastState) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

/** Registra il campione crediti se la cache è più recente dell'ultimo visto (chiave = fetched_at). */
export function sampleCredits(db: DatabaseSync, s: Snapshot) {
  if (!s.fetchedAt || !s.credits) return false;
  const r = db.prepare("SELECT 1 FROM credit_samples WHERE profile = ? AND fetched_at = ?").get(s.profile, s.fetchedAt);
  if (r) return false;
  db.prepare(`INSERT INTO credit_samples (profile, fetched_at, seen_at, day, enabled, used_credits, monthly_limit, currency, decimals, utilization, plan_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    s.profile, s.fetchedAt, new Date().toISOString(), s.fetchedAt.slice(0, 10), s.credits.enabled ? 1 : 0,
    s.credits.used, s.credits.limit, s.credits.currency, s.credits.decimals, s.credits.utilization, JSON.stringify(s.plan));
  return true;
}

/** Spesa a crediti di oggi: ultimo campione di oggi meno l'ultimo precedente. null se non calcolabile. */
export function creditsSpentToday(db: DatabaseSync, profile: string, today = new Date().toISOString().slice(0, 10)): number | null {
  const last = db.prepare("SELECT used_credits, fetched_at FROM credit_samples WHERE profile = ? AND day = ? ORDER BY fetched_at DESC LIMIT 1").get(profile, today) as { used_credits: number | null; fetched_at: string } | undefined;
  if (!last || last.used_credits == null) return null;
  const before = db.prepare("SELECT used_credits FROM credit_samples WHERE profile = ? AND fetched_at < ? ORDER BY fetched_at DESC LIMIT 1").get(profile, last.fetched_at) as { used_credits: number | null } | undefined;
  if (!before || before.used_credits == null) return null;
  // il contatore è mensile: a inizio mese riparte da zero, un delta negativo non è spesa
  return Math.max(0, last.used_credits - before.used_credits);
}

// ---------------------------------------------------------------- check per il doctor
export function doctorChecks(snaps: Snapshot[], cfg: BudgetCfg, alerts: Alert[]): { id: string; status: Status; msg: string; fix?: string }[] {
  const out: { id: string; status: Status; msg: string; fix?: string }[] = [];
  for (const s of snaps) {
    if (s.billing !== "credits") continue;
    if (s.stale) out.push({ id: `budget.${s.profile}.stale`, status: "warn", msg: `${s.profile}: consuma crediti ma lo stato è vecchio di ${s.ageHours == null ? "?" : Math.round(s.ageHours)} h (le soglie non scattano)`, fix: `apri una sessione ${s.profile === "work" ? "claude-work" : "claude"} o /usage per rinfrescare` });
    else if (s.credits?.spendLimitReached) out.push({ id: `budget.${s.profile}.limit`, status: "fail", msg: `${s.profile}: limite di spesa crediti raggiunto`, fix: "alza il limite o attendi il rinnovo mensile" });
  }
  const crit = alerts.filter((a) => a.level === "crit" && a.real);
  if (crit.length) out.push({ id: "budget.soglie", status: "warn", msg: `${crit.length} soglia/e di spesa reale superata/e: ${crit.map((a) => `${a.profile}/${a.ruleId}`).join(", ")}`, fix: "claude-multi budget" });
  if (!out.length) out.push({ id: "budget", status: "ok", msg: budgetSummary(snaps) });
  return out;
}
export function budgetSummary(snaps: Snapshot[]) {
  const parts = snaps.map((s) => {
    if (s.billing === "credits" && s.credits) {
      const c = s.credits;
      return `${s.profile} a crediti${c.limit ? ` ${c.used?.toFixed(2) ?? "?"}/${c.limit.toFixed(0)} ${c.currency}` : ""}`;
    }
    return `${s.profile} ${s.billing === "included" ? "solo abbonamento" : "stato ignoto"}`;
  });
  return `budget: ${parts.join(" · ")}`;
}
export const ALL_PROFILES = PROFILES;

// ---------------------------------------------------------------- orchestrazione
import { ANSI, has, icon, REPO, run } from "./lib.ts";
import { ingest, openDb, sinceDate } from "./usage.ts";

export const CFG_PATH = `${REPO}/shared/budget.json`;

function costSince(db: DatabaseSync, profile: string, spec: string): number | null {
  const since = sinceDate(spec);
  const r = db.prepare(`SELECT SUM(cost_usd) AS c FROM messages WHERE profile = ?${since ? " AND day >= ?" : ""}`)
    .get(...(since ? [profile, since] : [profile])) as { c: number | null } | undefined;
  return r?.c ?? null;
}

export interface BudgetReport { cfg: BudgetCfg; at: string; profiles: { snap: Snapshot; ctx: Omit<Ctx, "snap">; alerts: Alert[] }[]; alerts: Alert[] }

/** Legge lo stato dei profili, campiona i crediti, calcola le metriche e valuta le regole. */
export async function collect(opts: { ingest?: boolean } = {}): Promise<BudgetReport> {
  const cfg = await loadCfg(CFG_PATH);
  const db = openDb();
  if (opts.ingest !== false) await ingest(db, { quiet: true });
  const today = new Date().toISOString().slice(0, 10);
  const profiles: BudgetReport["profiles"] = [];
  for (const p of ALL_PROFILES) {
    const snap = applyOverride(cfg, await snapshot(p, cfg.staleAfterHours));
    sampleCredits(db, snap);
    const ctx: Ctx = {
      snap, costDay: costSince(db, p, "1d"), costWeek: costSince(db, p, "7d"), costMonth: costSince(db, p, "30d"),
      creditsSpentDay: creditsSpentToday(db, p, today),
    };
    profiles.push({ snap, ctx: { costDay: ctx.costDay, costWeek: ctx.costWeek, costMonth: ctx.costMonth, creditsSpentDay: ctx.creditsSpentDay }, alerts: evaluate(cfg, ctx) });
  }
  db.close();
  return { cfg, at: new Date().toISOString(), profiles, alerts: profiles.flatMap((p) => p.alerts) };
}

const fmtVal = (a: Alert) => a.value == null ? "—" : a.unit === "$" ? `$${a.value.toFixed(2)}` : a.unit === "%" ? `${a.value.toFixed(1)}%` : `${a.value.toFixed(2)} ${a.unit}`;

export function printBudget(r: BudgetReport) {
  const { b, d, g, y, c, x } = { b: ANSI.b, d: ANSI.d, g: ANSI.g, y: ANSI.y, c: ANSI.c, x: ANSI.x };
  console.log(`${b}claude-multi budget${x}  ${d}(notifiche solo sulla spesa reale: gli extra credits, non l'abbonamento)${x}`);
  for (const p of r.profiles) {
    const s = p.snap;
    const tag = s.billing === "credits" ? `${y}crediti a pagamento${x}` : s.billing === "included" ? `${g}solo abbonamento${x}` : `${d}stato ignoto${x}`;
    const age = s.ageHours == null ? "mai letto" : s.ageHours < 1 ? "aggiornato ora" : `letto ${Math.round(s.ageHours)} h fa${s.stale ? " (stantio)" : ""}`;
    console.log(`\n  ${b}${s.profile}${x} · ${tag}  ${d}${age}${x}`);
    console.log(`    ${d}${s.reason}${x}`);
    if (s.credits?.limit != null) console.log(`    crediti mese: ${c}${s.credits.used?.toFixed(2) ?? "?"}${x} / ${s.credits.limit.toFixed(2)} ${s.credits.currency}${s.credits.utilization != null ? ` (${s.credits.utilization.toFixed(1)}%)` : ""}`);
    const plan = s.plan.filter((l) => l.percent > 0);
    if (plan.length) console.log(`    ${d}piano: ${plan.map((l) => `${l.kind} ${l.percent}%`).join(" · ")}${x}`);
    console.log(`    ${d}equivalente: oggi ${p.ctx.costDay == null ? "—" : `$${p.ctx.costDay.toFixed(2)}`} · 7g ${p.ctx.costWeek == null ? "—" : `$${p.ctx.costWeek.toFixed(2)}`} · 30g ${p.ctx.costMonth == null ? "—" : `$${p.ctx.costMonth.toFixed(2)}`}${x}`);
    for (const a of p.alerts) {
      const st = a.level === "crit" ? icon.fail : a.level === "warn" ? icon.warn : icon.ok;
      const soglia = a.threshold == null ? "" : ` ${d}/ soglia ${a.threshold}${a.unit === "$" ? "" : a.unit}${x}`;
      console.log(`    ${st} ${a.label}: ${fmtVal(a)}${soglia}  ${d}${a.notify ? "→ notifica" : a.why}${x}`);
    }
  }
}

/** Confronta con l'ultimo stato e manda la notifica quando serve. Ritorna true se ha notificato. */
export async function notifyBudget(r: BudgetReport, opts: { dryRun?: boolean } = {}) {
  const now = new Date();
  const { rising, recovered, next } = toAnnounce(await loadLast(), r.alerts, now, r.cfg.cooldownMinutes);
  const t = announceText(rising, recovered);
  if (inQuietHours(now, r.cfg.quietHours) && t) {
    // in finestra di silenzio non si salva lo stato: la notifica arriva al primo giro utile
    console.log(`[silenzio ${r.cfg.quietHours!.from}-${r.cfg.quietHours!.to}] rimando: ${t.title}`);
    return false;
  }
  if (!opts.dryRun) await saveLast(next);
  if (!t) return false;
  if (opts.dryRun || !(await has("notify-send"))) { console.log(`[notifica${opts.dryRun ? " dry-run" : " (notify-send assente)"}] ${t.title}\n${t.body}`); return true; }
  await run("notify-send", ["-a", "claude-multi", "-i", "claude-desktop", "-u", t.urgency, "--expire-time=600000", t.title, t.body]);
  return true;
}
