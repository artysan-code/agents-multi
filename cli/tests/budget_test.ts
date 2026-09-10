// Tests for budget.ts: the three planes and the rule that follows from them — only billed extra
// usage may ever raise an alert. That rule is the whole point of the module.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  announceText, billedToday, type BudgetCfg, capFor, CFG_DEFAULT, classify,
  type Ctx, evaluate, inQuietHours, metricOf, sampleCredits, type Snapshot, toAnnounce,
} from "../budget.ts";
import { openDb } from "../usage.ts";

const NOW = new Date("2026-09-09T12:00:00Z").getTime();
const raw = (extra: Record<string, unknown> | null, hoursAgo = 1) => ({
  fetchedAtMs: NOW - hoursAgo * 36e5,
  utilization: { extra_usage: extra, limits: [{ kind: "weekly_all", group: "weekly", percent: 100, severity: "critical", is_active: true }] },
});

Deno.test("classify: extra usage on/off, currency scaling, staleness", () => {
  const on = classify("work", raw({ is_enabled: true, monthly_limit: 50000, used_credits: 7839, utilization: 15.678, currency: "EUR", decimal_places: 2, credits_ever_enabled: true }), null, 36, NOW);
  assertEquals(on.extra!.active, true);
  assertEquals(on.extra!.used, 78.39); // credits arrive in cents
  assertEquals(on.extra!.cap, 500);
  assertEquals(on.stale, false);

  const off = classify("personal", raw({ is_enabled: false, user_disabled: true, credits_ever_enabled: true }), "org_level_disabled", 36, NOW);
  assertEquals(off.extra!.active, false);
  assert(off.reason.includes("disabled by user"));

  assertEquals(classify("x", null, null, 36, NOW).extra, null);
  assertEquals(classify("x", raw({ is_enabled: true }, 100), null, 36, NOW).stale, true);
  assertEquals(classify("x", raw({ is_enabled: true }, 100), null, 36, NOW).ageHours, 100);
});

const snapOf = (extra: Record<string, unknown> | null, hoursAgo = 1) => classify("work", raw(extra, hoursAgo), null, 36, NOW);
const spending = () => snapOf({ is_enabled: true, monthly_limit: 5000, used_credits: 4000, utilization: 80, currency: "EUR", decimal_places: 2 });
const subOnly = () => snapOf({ is_enabled: false, user_disabled: true });
const ctxOf = (snap: Snapshot, over: Partial<Ctx> = {}): Ctx => ({
  snap, cap: snap.extra?.cap ?? null, estDay: 300, estWeek: 900, estMonth: 3900, billedToday: null, ...over,
});

Deno.test("capFor: configured ceiling wins over the reported one", () => {
  const cfg: BudgetCfg = { ...CFG_DEFAULT, profiles: { work: { cap: 20 } } };
  assertEquals(capFor(cfg, spending()), 20);
  assertEquals(capFor(CFG_DEFAULT, spending()), 50);
  assertEquals(capFor(CFG_DEFAULT, snapOf(null)), null);
});

Deno.test("metricOf: every metric knows which plane it lives on", () => {
  assertEquals(metricOf("billed.today", ctxOf(spending(), { billedToday: 3 }))!.plane, "billed");
  assertEquals(metricOf("billed.month", ctxOf(spending()))!.value, 40);
  assertEquals(metricOf("billed.month.percent", ctxOf(spending()))!.value, 80);
  assertEquals(metricOf("estimate.day", ctxOf(spending()))!.plane, "estimate");
  assertEquals(metricOf("plan.weekly.percent", ctxOf(spending()))!.plane, "plan");
  assertEquals(metricOf("plan.weekly.percent", ctxOf(spending()))!.value, 100);
  assertEquals(metricOf("nope", ctxOf(spending())), null);
});

Deno.test("billed.month.percent follows the configured cap, not just the reported one", () => {
  // 40 EUR spent: 80% of the reported 50, but already over a 20 EUR alert ceiling
  assertEquals(metricOf("billed.month.percent", ctxOf(spending(), { cap: 20 }))!.value, 200);
});

const cfgWith = (rules: BudgetCfg["defaults"]["rules"]): BudgetCfg => ({ ...CFG_DEFAULT, defaults: { rules } });

Deno.test("evaluate: the estimate plane never notifies, however far past the threshold", () => {
  // $300 today against a $40 threshold — the old model woke you for this every single day
  const a = evaluate(cfgWith([{ id: "est", metric: "estimate.day", warn: 40, crit: 120 }]), ctxOf(spending()))[0];
  assertEquals([a.level, a.notify], ["crit", false]);
  assert(a.why.includes("list price"));
});

Deno.test("evaluate: a full plan window is loud on screen and silent in notifications", () => {
  const a = evaluate(cfgWith([{ id: "wk", metric: "plan.weekly.percent", warn: 85, crit: 100 }]), ctxOf(spending()))[0];
  assertEquals([a.level, a.notify], ["crit", false]);
  assert(a.why.includes("not a charge"));
  // unless the rule explicitly opts in
  const optedIn = evaluate(cfgWith([{ id: "wk", metric: "plan.weekly.percent", crit: 100, notify: true }]), ctxOf(spending()))[0];
  assertEquals(optedIn.notify, true);
});

Deno.test("evaluate: billed metrics notify by default and can be silenced per rule", () => {
  const on = evaluate(cfgWith([{ id: "b", metric: "billed.month.percent", warn: 60, crit: 85 }]), ctxOf(spending()))[0];
  assertEquals([on.level, on.notify], ["warn", true]);
  const muted = evaluate(cfgWith([{ id: "b", metric: "billed.month.percent", warn: 60, notify: false }]), ctxOf(spending()))[0];
  assertEquals(muted.notify, false);
});

Deno.test("evaluate: stale billing data, master switch, unknown metric, missing value", () => {
  // an old credits reading raises nothing: it would alert on a number from weeks ago
  const old = classify("work", raw({ is_enabled: true, monthly_limit: 5000, used_credits: 4500, utilization: 90, decimal_places: 2 }, 400), null, 36, NOW);
  const a = evaluate(cfgWith([{ id: "m", metric: "billed.month.percent", crit: 50 }]), ctxOf(old))[0];
  assertEquals([a.level, a.notify], ["crit", false]);
  assert(a.why.includes("old"));
  assertEquals(evaluate({ ...cfgWith([{ id: "b", metric: "billed.month", crit: 1 }]), enabled: false }, ctxOf(spending()))[0].notify, false);
  assertEquals(evaluate(cfgWith([{ id: "x", metric: "nope", crit: 1 }]), ctxOf(spending()))[0].level, "ok");
  // no sample yet for today: no alert rather than a false zero
  assertEquals(evaluate(cfgWith([{ id: "t", metric: "billed.today", crit: 1 }]), ctxOf(spending()))[0].level, "ok");
});

Deno.test("evaluate: a subscription-only profile has nothing billed to alert on", () => {
  const rows = evaluate(cfgWith([{ id: "b", metric: "billed.month", warn: 1 }]), ctxOf(subOnly()));
  assertEquals([rows[0].level, rows[0].notify], ["ok", false]);
});

Deno.test("evaluate: per-profile rules replace the defaults", () => {
  const cfg: BudgetCfg = { ...CFG_DEFAULT, defaults: { rules: [{ id: "d", metric: "billed.month", crit: 10 }] }, profiles: { work: { rules: [{ id: "mine", metric: "estimate.week", crit: 100000 }] } } };
  const rows = evaluate(cfg, ctxOf(spending()));
  assertEquals(rows.map((r) => r.ruleId), ["mine"]);
  assertEquals(rows[0].level, "ok");
});

Deno.test("inQuietHours: normal window and one crossing midnight", () => {
  const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  assertEquals(inQuietHours(at(3), { from: "01:30", to: "09:00" }), true);
  assertEquals(inQuietHours(at(10), { from: "01:30", to: "09:00" }), false);
  assertEquals(inQuietHours(at(1), { from: "01:30", to: "09:00" }), false);
  assertEquals(inQuietHours(at(23), { from: "22:00", to: "07:00" }), true);
  assertEquals(inQuietHours(at(2), { from: "22:00", to: "07:00" }), true);
  assertEquals(inQuietHours(at(12), { from: "22:00", to: "07:00" }), false);
  assertEquals(inQuietHours(at(12), null), false);
});

const alert = (id: string, level: "ok" | "warn" | "crit", notify = true) =>
  ({ profile: "work", ruleId: id, metric: "billed.today", label: "billed today", level, value: 1, threshold: 1, unit: "EUR", plane: "billed" as const, notify, why: "" });

Deno.test("toAnnounce: level rise, cooldown, recovery", () => {
  const t0 = new Date("2026-09-09T10:00:00Z");
  const a = toAnnounce(null, [alert("day", "warn")], t0, 240);
  assertEquals(a.rising.length, 1);
  assertEquals(a.next.levels["work/day"].level, "warn");
  const t1 = new Date(t0.getTime() + 60 * 6e4);
  assertEquals(toAnnounce(a.next, [alert("day", "warn")], t1, 240).rising.length, 0);
  assertEquals(toAnnounce(a.next, [alert("day", "crit")], t1, 240).rising.length, 1);
  const t2 = new Date(t0.getTime() + 300 * 6e4);
  assertEquals(toAnnounce(a.next, [alert("day", "warn")], t2, 240).rising.length, 1);
  const back = toAnnounce(a.next, [alert("day", "ok")], t2, 240);
  assertEquals(back.recovered, ["work/day"]);
  assertEquals(back.next.levels["work/day"], undefined);
  assertEquals(toAnnounce(null, [alert("day", "crit", false)], t0, 240).rising.length, 0);
});

Deno.test("announceText: severity picks the title, nothing to say returns null", () => {
  const crit = announceText([alert("day", "crit")], [])!;
  assertEquals(crit.urgency, "critical");
  assert(crit.title.includes("over the limit"));
  assertEquals(announceText([alert("day", "warn")], [])!.urgency, "normal");
  assert(announceText([], ["work/day"])!.title.includes("back under"));
  assertEquals(announceText([], []), null);
});

Deno.test("credit samples: deduped by fetched_at, daily spend as a delta", () => {
  const db = openDb(":memory:");
  const snap = (used: number, at: string): Snapshot => ({
    profile: "work", reason: "", fetchedAt: at, ageHours: 1, stale: false,
    extra: { active: true, everEnabled: true, spendLimitReached: false, used, cap: 500, utilization: used / 5, currency: "EUR", decimals: 2 },
    plan: [],
  });
  assertEquals(sampleCredits(db, snap(10, "2026-09-08T22:00:00Z")), true);
  assertEquals(sampleCredits(db, snap(10, "2026-09-08T22:00:00Z")), false); // same fetch, not duplicated
  assertEquals(billedToday(db, "work", "2026-09-09"), null);                // no sample for today yet
  sampleCredits(db, snap(26.5, "2026-09-09T09:00:00Z"));
  assertEquals(billedToday(db, "work", "2026-09-09"), 16.5);
  // the counter is monthly: when it restarts at zero the negative delta is not spending
  sampleCredits(db, snap(2, "2026-09-09T23:00:00Z"));
  assertEquals(billedToday(db, "work", "2026-09-09"), 0);
  db.close();
});
