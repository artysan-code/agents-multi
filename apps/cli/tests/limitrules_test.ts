// limitrules_test.ts — the limits manager (shared/mcp/lib/limitrules.ts): the rules over the windows, the events
// they raise once, the snapshot routines consult, the owner's project defaults, and the proposals that change
// nothing until the owner accepts. Hermetic: temp folders, no provider read, no notification.
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import type { Window } from "../../../shared/mcp/lib/limits.ts";
import {
  alternatives,
  blockedAmong,
  cleanRules,
  decide,
  DEFAULT_RULES,
  defaultAccount,
  evaluate,
  lapseProposals,
  listProposals,
  parseAccountId,
  projectAccount,
  propose,
  readEvents,
  type Reading,
  readSnapshot,
  scan,
  setProjectAccount,
  STALE_S,
} from "../../../shared/mcp/lib/limitrules.ts";
import { addRoutine, applyProposals, readRoutine } from "../../../shared/mcp/lib/routines.ts";

const NOW = 1_800_000_000;
const win = (window: string, usedPercent: number, minutesLeft: number | null): Window => ({
  window,
  usedPercent,
  resetsAt: minutesLeft === null ? null : NOW + minutesLeft * 60,
  source: "statusline",
  at: NOW,
});
const kinds = (e: { kind: string }[]) => e.map((x) => x.kind);

Deno.test("rules: the owner's file is kept to what is valid, over the defaults", () => {
  assertEquals(cleanRules(undefined), DEFAULT_RULES);
  assertEquals(cleanRules({ stopAt: 90, expiringMin: "soon", roomPercent: 500 }), {
    ...DEFAULT_RULES,
    stopAt: 90,
    roomPercent: 99,
  });
  assertEquals(cleanRules("junk"), DEFAULT_RULES);
});

Deno.test("evaluate: at the stop threshold an account is blocked, once; below it is not", () => {
  const a = evaluate("p/claude", undefined, [win("5h", 79, 200)], DEFAULT_RULES, NOW);
  assertEquals([a.state.status, a.events], ["ok", []]);
  const b = evaluate("p/claude", a.state, [win("5h", 81, 200), win("7d", 30, 5000)], DEFAULT_RULES, NOW);
  assertEquals(b.state.status, "blocked");
  assertEquals(b.state.by?.window, "5h");
  assertEquals(kinds(b.events), ["blocked"]);
  assertStringIncludes(b.events[0].detail, "no new unattended work");
  // still blocked on the next scan: no second event
  const c = evaluate("p/claude", b.state, [win("5h", 85, 195)], DEFAULT_RULES, NOW + 300);
  assertEquals([c.state.status, c.events], ["blocked", []]);
  // either window blocks
  assertEquals(
    evaluate("p/claude", undefined, [win("5h", 10, 100), win("7d", 82, 100)], DEFAULT_RULES, NOW).state.status,
    "blocked",
  );
});

Deno.test("evaluate: a window about to reset with room left is announced once; not when blocked, short of room or far", () => {
  const near = evaluate("p/claude", undefined, [win("5h", 40, 30)], DEFAULT_RULES, NOW);
  assertEquals(kinds(near.events), ["expiring"]);
  assertStringIncludes(near.events[0].detail, "60% free");
  // five minutes later: the same window (same reset), no second announcement
  assertEquals(evaluate("p/claude", near.state, [{ ...win("5h", 41, 30) }], DEFAULT_RULES, NOW + 300).events, []);
  assertEquals(evaluate("p/claude", undefined, [win("5h", 40, 90)], DEFAULT_RULES, NOW).events, [], "too far");
  assertEquals(evaluate("p/claude", undefined, [win("5h", 75, 30)], DEFAULT_RULES, NOW).events, [], "no room");
  assertEquals(kinds(evaluate("p/claude", undefined, [win("5h", 90, 30)], DEFAULT_RULES, NOW).events), ["blocked"]);
});

Deno.test("evaluate: a reset is seen when its time passes (the window is gone) or the window comes back later", () => {
  const blocked = evaluate("p/claude", undefined, [win("5h", 90, 10)], DEFAULT_RULES, NOW).state;
  // ten minutes on, the provider no longer has the window
  const gone = evaluate("p/claude", blocked, [], DEFAULT_RULES, NOW + 11 * 60);
  assertEquals(kinds(gone.events), ["reset"]);
  assertEquals(gone.state.status, "ok");
  assertStringIncludes(gone.events[0].detail, "work held for it can go");
  // a new window, with a reset five hours later
  const again = evaluate(
    "p/claude",
    blocked,
    [win("5h", 2, 300)].map((w) => ({ ...w, resetsAt: NOW + 11 * 60 + 5 * 3600 })),
    DEFAULT_RULES,
    NOW + 11 * 60,
  );
  assertEquals(kinds(again.events), ["reset"]);
  // and not again
  assertEquals(evaluate("p/claude", gone.state, [], DEFAULT_RULES, NOW + 12 * 60).events, []);
});

Deno.test("accounts: ids, and the project default is the longest folder that holds the project", () => {
  assertEquals(parseAccountId("otacon"), { profile: "otacon", provider: "claude" });
  assertEquals(parseAccountId("otacon/codex"), { profile: "otacon", provider: "codex" });
  assertEquals(parseAccountId("Otacon/x"), null);
  const table = {
    "work/otacon": { profile: "otacon" },
    "work/otacon/smc": { profile: "funnel", provider: "codex" },
    "~/personal": { profile: "personal" },
    junk: "x",
  };
  assertEquals(defaultAccount(table, "/h/work/otacon/site", "/h"), { profile: "otacon", provider: "claude" });
  assertEquals(defaultAccount(table, "/h/work/otacon/smc/api", "/h"), { profile: "funnel", provider: "codex" });
  assertEquals(defaultAccount(table, "/h/personal/blog", "/h"), { profile: "personal", provider: "claude" });
  assertEquals(defaultAccount(table, "/h/other", "/h"), null);
  assertEquals(defaultAccount(undefined, "/h/x", "/h"), null);
});

Deno.test("gate: a stale scan blocks nobody; alternatives skip blocked accounts, same provider first, least used first", () => {
  const snap = {
    at: NOW,
    accounts: {
      "a/claude": { ...evaluate("a/claude", undefined, [win("5h", 90, 100)], DEFAULT_RULES, NOW).state, windows: [] },
      "b/claude": { ...evaluate("b/claude", undefined, [win("5h", 60, 100)], DEFAULT_RULES, NOW).state, windows: [] },
      "c/claude": { ...evaluate("c/claude", undefined, [win("5h", 10, 100)], DEFAULT_RULES, NOW).state, windows: [] },
    },
  };
  assertEquals(blockedAmong(snap, ["a/claude", "b/claude"], NOW + 60).map((x) => x.account), ["a/claude"]);
  assertEquals(blockedAmong(snap, ["a/claude"], NOW + STALE_S + 1), [], "old reading: unknown, not blocked");
  assertEquals(blockedAmong(null, ["a/claude"], NOW), []);
  const all = [
    { id: "a/claude", provider: "claude" as const },
    { id: "b/claude", provider: "claude" as const },
    { id: "c/claude", provider: "claude" as const },
    { id: "d/codex", provider: "codex" as const },
  ];
  assertEquals(alternatives(snap, all, "a/claude", NOW + 60), ["c/claude", "b/claude", "d/codex"]);
});

Deno.test("scan: keeps the snapshot, raises each event once and tells the owner once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "am-limits-" });
  try {
    let windows: Window[] = [win("5h", 82, 120)];
    let now = NOW;
    const told: string[] = [];
    const deps = {
      now: () => now,
      read: (): Promise<Reading[]> => Promise.resolve([{ account: "p/claude", provider: "claude", windows }]),
      rules: () => Promise.resolve(DEFAULT_RULES),
      notify: (t: string) => void told.push(t),
    };
    assertEquals(kinds(await scan(deps, dir)), ["blocked"]);
    now += 60;
    assertEquals(await scan(deps, dir), []);
    assertEquals(told, ["Limits: p/claude blocked"]);
    assertEquals((await readSnapshot(dir))?.accounts["p/claude"].status, "blocked");
    // the window resets: it is gone from the reading
    windows = [];
    now += 3 * 3600;
    assertEquals(kinds(await scan(deps, dir)), ["reset"]);
    assertEquals((await readSnapshot(dir))?.accounts["p/claude"].status, "ok");
    // a restart of the scan (new process, same files) does not repeat the reset
    assertEquals(await scan(deps, dir), []);
    assertEquals(kinds(await readEvents(dir)), ["blocked", "reset"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("proposals: one pending per change; nothing is applied until accepted; an unknown account is refused", async () => {
  const dir = await Deno.makeTempDir({ prefix: "am-prop-" });
  try {
    const accounts = ["a/claude", "b/claude"];
    const base = {
      scope: "project" as const,
      project: "/h/p",
      from: "a/claude",
      to: "b/claude",
      reason: "limit",
      by: "coordinator" as const,
    };
    const p = await propose(base, accounts, dir);
    assertEquals(p.status, "pending");
    assertEquals((await propose(base, accounts, dir)).id, p.id, "asking again is the same proposal");
    await assertRejects(() => propose({ ...base, to: "z/claude" }, accounts, dir), Error, "no account");
    await assertRejects(() => propose({ ...base, to: "a/claude" }, accounts, dir), Error, "that is the account");
    await assertRejects(() => propose({ ...base, scope: "routine" }, accounts, dir), Error, "names its routine");
    const accepted = await decide(p.id, true, dir);
    assertEquals(accepted.status, "accepted");
    await assertRejects(() => decide(p.id, false, dir), Error, "already accepted");
    assertEquals((await listProposals(dir)).map((x) => x.status), ["accepted"]);
    // a routine that started on its own: its pending proposal lapses, another routine's stays
    const mine = await propose({ ...base, scope: "routine", routine: "night-1" }, accounts, dir);
    const other = await propose({ ...base, scope: "routine", routine: "night-2" }, accounts, dir);
    assertEquals((await lapseProposals("night-1", dir)).map((x) => x.id), [mine.id]);
    const by = new Map((await listProposals(dir)).map((x) => [x.id, x.status]));
    assertEquals([by.get(mine.id), by.get(other.id)], ["lapsed", "pending"]);
    await assertRejects(() => decide(mine.id, true, dir), Error, "already lapsed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("apply: an accepted project proposal sets the default in the owner's config; a routine's changes that routine only", async () => {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "am-apply-" }));
  try {
    await Deno.mkdir(`${tmp}/repo/.git`, { recursive: true });
    const config = `${tmp}/config`, limits = `${tmp}/limits`, routines = `${tmp}/routines`;
    const r = await addRoutine(
      {
        name: "night",
        trigger: { kind: "cron", expr: "0 2 * * *" },
        action: { kind: "agent", profile: "a", task: "t" },
        folder: "~/repo",
      },
      routines,
      tmp,
    );
    const accounts = ["a/claude", "b/claude", "c/codex"];
    const project = `${tmp}/repo`;
    const pr = await propose(
      { scope: "routine", project, routine: r.id, from: "a/claude", to: "c/codex", reason: "limit", by: "console" },
      accounts,
      limits,
    );
    const pp = await propose(
      { scope: "project", project, from: "none", to: "b/claude", reason: "organisation", by: "coordinator" },
      accounts,
      limits,
    );
    const told: string[] = [];
    // nothing accepted: nothing applied
    assertEquals(await applyProposals((t) => void told.push(t), routines, limits, config, tmp), 0);
    assertEquals((await readRoutine(r.id, routines))?.action, { kind: "agent", profile: "a", task: "t" });
    await decide(pr.id, true, limits);
    await decide(pp.id, true, limits);
    assertEquals(await applyProposals((t) => void told.push(t), routines, limits, config, tmp), 2);
    const after = (await readRoutine(r.id, routines))!;
    assertEquals(after.action, { kind: "agent", profile: "c", provider: "codex", task: "t" });
    assertEquals(await projectAccount(project, config, tmp), { profile: "b", provider: "claude" });
    assertEquals((await listProposals(limits)).map((x) => x.status), ["applied", "applied"]);
    assertEquals(told.length, 2);
    // and not twice
    assertEquals(await applyProposals((t) => void told.push(t), routines, limits, config, tmp), 0);
    // a default set by hand
    await setProjectAccount(project, { profile: "c", provider: "codex" }, config, tmp);
    assertEquals(JSON.parse(await Deno.readTextFile(`${config}/projects.json`)), {
      repo: { profile: "c", provider: "codex" },
    });
    // a routine without a profile takes the project's default; with none it says so
    const bare = {
      trigger: { kind: "at" as const, at: "2099-01-01T00:00:00.000Z" },
      action: { kind: "agent" as const, profile: "", task: "t" },
      folder: "~/repo",
    };
    const d = await addRoutine(bare, routines, tmp, config);
    assertEquals(d.action, { kind: "agent", profile: "c", provider: "codex", task: "t" });
    await assertRejects(() => addRoutine(bare, routines, tmp, `${tmp}/no-config`), Error, "no default account");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
