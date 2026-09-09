// Test di budget.ts: la classificazione di chi paga davvero e la regola «niente notifiche
// sull'uso incluso nell'abbonamento», che è il punto di tutto il modulo.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  announceText, applyOverride, type BudgetCfg, CFG_DEFAULT, classify, creditsSpentToday,
  type Ctx, evaluate, inQuietHours, metricOf, sampleCredits, type Snapshot, toAnnounce,
} from "../budget.ts";
import { openDb } from "../usage.ts";

const NOW = new Date("2026-09-09T12:00:00Z").getTime();
const raw = (extra: Record<string, unknown> | null, hoursAgo = 1) => ({
  fetchedAtMs: NOW - hoursAgo * 36e5,
  utilization: { extra_usage: extra, limits: [{ kind: "weekly_all", group: "weekly", percent: 100, severity: "critical", is_active: true }] },
});

Deno.test("classify: credits, included, unknown, valuta e stale", () => {
  const paying = classify("work", raw({ is_enabled: true, monthly_limit: 50000, used_credits: 7839, utilization: 15.678, currency: "EUR", decimal_places: 2, credits_ever_enabled: true }), null, 36, NOW);
  assertEquals(paying.billing, "credits");
  assertEquals(paying.credits!.used, 78.39);   // i crediti arrivano in centesimi
  assertEquals(paying.credits!.limit, 500);
  assertEquals(paying.stale, false);

  const off = classify("personal", raw({ is_enabled: false, user_disabled: true, credits_ever_enabled: true }), "org_level_disabled", 36, NOW);
  assertEquals(off.billing, "included");
  assert(off.reason.includes("disattivati dall'utente"));

  assertEquals(classify("x", null, null, 36, NOW).billing, "unknown");
  assertEquals(classify("x", raw({ is_enabled: true }, 100), null, 36, NOW).stale, true);
  assertEquals(classify("x", raw({ is_enabled: true }, 100), null, 36, NOW).ageHours, 100);
});

Deno.test("applyOverride: la configurazione vince sulla cache (che resta indietro di settimane)", () => {
  const cfg: BudgetCfg = { ...CFG_DEFAULT, profiles: { work: { billing: "credits" } } };
  const snap = classify("work", raw({ is_enabled: false, user_disabled: true }), null, 36, NOW);
  assertEquals(snap.billing, "included");
  const o = applyOverride(cfg, snap);
  assertEquals(o.billing, "credits");
  assert(o.reason.includes("forzata"));
  // senza override lo snapshot non viene toccato
  assertEquals(applyOverride(CFG_DEFAULT, snap), snap);
});

const ctxOf = (snap: Snapshot, over: Partial<Ctx> = {}): Ctx => ({ snap, costDay: 50, costWeek: 200, costMonth: 800, creditsSpentDay: null, ...over });
const included = () => classify("personal", raw({ is_enabled: false, user_disabled: true }), null, 36, NOW);
const credits = () => classify("work", raw({ is_enabled: true, monthly_limit: 50000, used_credits: 40000, utilization: 80, currency: "EUR", decimal_places: 2 }), null, 36, NOW);

Deno.test("metricOf: solo la spesa vera è «real»; i limiti del piano non lo sono mai", () => {
  assertEquals(metricOf("cost.day", ctxOf(included()))!.real, false);
  assertEquals(metricOf("cost.day", ctxOf(credits()))!.real, true);
  assertEquals(metricOf("credits.utilization", ctxOf(credits()))!.value, 80);
  assertEquals(metricOf("plan.weekly.percent", ctxOf(credits()))!.real, false);
  assertEquals(metricOf("plan.weekly.percent", ctxOf(credits()))!.value, 100);
  assertEquals(metricOf("boh", ctxOf(credits())), null);
});

const cfgWith = (rules: BudgetCfg["defaults"]["rules"]): BudgetCfg => ({ ...CFG_DEFAULT, defaults: { notify: "auto", rules } });

Deno.test("evaluate: stessa soglia, esiti opposti — l'abbonamento non sveglia nessuno", () => {
  const cfg = cfgWith([{ id: "day", metric: "cost.day", warn: 10, crit: 40 }]);
  const inc = evaluate(cfg, ctxOf(included()))[0];
  assertEquals([inc.level, inc.notify], ["crit", false]);
  assert(inc.why.includes("non fatturato"));
  const pay = evaluate(cfg, ctxOf(credits()))[0];
  assertEquals([pay.level, pay.notify], ["crit", true]);
});

Deno.test("evaluate: notify esplicito, dati stantii, budget spento, metrica assente", () => {
  // notify:true forza la notifica anche su un profilo incluso; false la spegne ovunque
  assertEquals(evaluate(cfgWith([{ id: "d", metric: "cost.day", crit: 10, notify: true }]), ctxOf(included()))[0].notify, true);
  assertEquals(evaluate(cfgWith([{ id: "d", metric: "cost.day", crit: 10, notify: false }]), ctxOf(credits()))[0].notify, false);
  // un valore crediti vecchio non fa scattare nulla: sarebbe un allarme su un numero di settimane fa
  const old = classify("work", raw({ is_enabled: true, monthly_limit: 50000, used_credits: 45000, utilization: 90, decimal_places: 2 }, 400), null, 36, NOW);
  const a = evaluate(cfgWith([{ id: "m", metric: "credits.utilization", crit: 50 }]), ctxOf(old))[0];
  assertEquals([a.level, a.notify], ["crit", false]);
  assert(a.why.includes("vecchio"));
  // interruttore generale
  assertEquals(evaluate({ ...cfgWith([{ id: "d", metric: "cost.day", crit: 1 }]), enabled: false }, ctxOf(credits()))[0].notify, false);
  // regola su metrica inesistente: non esplode, resta ok
  assertEquals(evaluate(cfgWith([{ id: "x", metric: "nope", crit: 1 }]), ctxOf(credits()))[0].level, "ok");
  // nessun dato = nessun allarme
  assertEquals(evaluate(cfgWith([{ id: "c", metric: "credits.spent.day", crit: 1 }]), ctxOf(credits()))[0].level, "ok");
});

Deno.test("evaluate: le regole per profilo vincono su quelle di default", () => {
  const cfg: BudgetCfg = { ...CFG_DEFAULT, defaults: { notify: "auto", rules: [{ id: "d", metric: "cost.day", crit: 10 }] }, profiles: { work: { rules: [{ id: "solo-mia", metric: "cost.week", crit: 1000 }] } } };
  const rows = evaluate(cfg, ctxOf(credits()));
  assertEquals(rows.map((r) => r.ruleId), ["solo-mia"]);
  assertEquals(rows[0].level, "ok");
});

Deno.test("inQuietHours: finestra normale e a cavallo di mezzanotte", () => {
  const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  assertEquals(inQuietHours(at(3), { from: "01:30", to: "09:00" }), true);
  assertEquals(inQuietHours(at(10), { from: "01:30", to: "09:00" }), false);
  assertEquals(inQuietHours(at(1), { from: "01:30", to: "09:00" }), false);
  assertEquals(inQuietHours(at(23), { from: "22:00", to: "07:00" }), true);
  assertEquals(inQuietHours(at(2), { from: "22:00", to: "07:00" }), true);
  assertEquals(inQuietHours(at(12), { from: "22:00", to: "07:00" }), false);
  assertEquals(inQuietHours(at(12), null), false);
});

const alert = (id: string, level: "ok" | "warn" | "crit", notify = true) => ({ profile: "work", ruleId: id, metric: "cost.day", label: "l", level, value: 1, threshold: 1, unit: "$", real: true, notify, why: "" });

Deno.test("toAnnounce: salita di livello, cooldown, rientro", () => {
  const t0 = new Date("2026-09-09T10:00:00Z");
  // primo allarme: si annuncia
  const a = toAnnounce(null, [alert("day", "warn")], t0, 240);
  assertEquals(a.rising.length, 1);
  assertEquals(a.next.levels["work/day"].level, "warn");
  // stesso livello poco dopo: silenzio
  const t1 = new Date(t0.getTime() + 60 * 6e4);
  assertEquals(toAnnounce(a.next, [alert("day", "warn")], t1, 240).rising.length, 0);
  // peggiora: si riannuncia subito
  assertEquals(toAnnounce(a.next, [alert("day", "crit")], t1, 240).rising.length, 1);
  // stesso livello oltre il cooldown: si ripete
  const t2 = new Date(t0.getTime() + 300 * 6e4);
  assertEquals(toAnnounce(a.next, [alert("day", "warn")], t2, 240).rising.length, 1);
  // rientro: annuncio di recupero e stato ripulito
  const back = toAnnounce(a.next, [alert("day", "ok")], t2, 240);
  assertEquals(back.recovered, ["work/day"]);
  assertEquals(back.next.levels["work/day"], undefined);
  // un allarme che non va notificato non entra mai negli annunci
  assertEquals(toAnnounce(null, [alert("day", "crit", false)], t0, 240).rising.length, 0);
});

Deno.test("announceText: titolo per gravità, nota sul proxy, niente testo se non c'è nulla", () => {
  const crit = announceText([alert("day", "crit")], [])!;
  assertEquals(crit.urgency, "critical");
  assert(crit.body.includes("equivalente a listino"));
  assertEquals(announceText([alert("day", "warn")], [])!.urgency, "normal");
  assert(announceText([], ["work/day"])!.title.includes("rientrata"));
  assertEquals(announceText([], []), null);
});

Deno.test("campioni crediti: dedupe per fetched_at e spesa del giorno come delta", () => {
  const db = openDb(":memory:");
  const snap = (used: number, at: string): Snapshot => ({
    profile: "work", billing: "credits", reason: "", fetchedAt: at, ageHours: 1, stale: false,
    credits: { enabled: true, userDisabled: false, spendLimitReached: false, used, limit: 500, utilization: used / 5, currency: "EUR", decimals: 2, everEnabled: true },
    plan: [],
  });
  assertEquals(sampleCredits(db, snap(10, "2026-09-08T22:00:00Z")), true);
  assertEquals(sampleCredits(db, snap(10, "2026-09-08T22:00:00Z")), false); // stesso fetch: non si duplica
  assertEquals(creditsSpentToday(db, "work", "2026-09-09"), null);          // ancora nessun campione di oggi
  sampleCredits(db, snap(26.5, "2026-09-09T09:00:00Z"));
  assertEquals(creditsSpentToday(db, "work", "2026-09-09"), 16.5);
  // il contatore è mensile: quando riparte da zero il delta negativo non è spesa
  sampleCredits(db, snap(2, "2026-09-09T23:00:00Z"));
  assertEquals(creditsSpentToday(db, "work", "2026-09-09"), 0);
  db.close();
});
