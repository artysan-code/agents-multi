// routines_test.ts — the schedule of unattended jobs (shared/mcp/lib/routines.ts): when a routine is due, what
// is kept on disk across restarts, and the tick with its seams faked (no child, no git, no notification).
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { DEFAULT_POLICY, type Policy } from "../../../shared/mcp/lib/policy.ts";
import type { ChildState } from "../../../shared/mcp/lib/agents.ts";
import {
  addRoutine,
  childDone,
  type Deps,
  due,
  eventRuns,
  type Fired,
  listRoutines,
  planIn,
  preamble,
  readState,
  removeRoutine,
  requestFire,
  type Routine,
  routineErrors,
  tick,
  type Watch,
} from "../../../shared/mcp/lib/routines.ts";

const T = (iso: string) => new Date(iso);
const routine = (o: Partial<Routine> = {}): Routine => ({
  id: "night-ab12",
  name: "night",
  trigger: { kind: "at", at: "2026-10-15T00:00:00.000Z" },
  action: { kind: "agent", profile: "personal", task: "run the tests" },
  folder: "/h/repo",
  project: "/h/repo",
  enabled: true,
  created: "2026-10-14T12:00:00.000Z",
  ...o,
});

Deno.test("routines: what is wrong with one is said before it is kept", () => {
  assertEquals(routineErrors(routine()), []);
  assertEquals(routineErrors(routine({ trigger: { kind: "cron", expr: "* * *" } })).length, 1);
  assertEquals(routineErrors(routine({ action: { kind: "agent", profile: "personal", task: " " } })), [
    "say what the child has to do",
  ]);
  assertEquals(routineErrors(routine({ action: { kind: "workflow", plan: "" } })), ["a plan file is needed"]);
  assertEquals(routineErrors(routine({ trigger: { kind: "event", on: "x" as "run-done" } })), [
    "event is run-done, run-failed or limit-reset",
  ]);
});

Deno.test("routines: an `at` runs when due, within its grace; later it is missed, never run at breakfast", () => {
  const r = routine();
  assertEquals(due(r, { runs: [] }, T("2026-10-14T23:59:00Z")).act, "wait");
  assertEquals(due(r, { runs: [] }, T("2026-10-15T00:00:30Z")).act, "fire");
  assertEquals(due(r, { runs: [] }, T("2026-10-15T05:59:00Z")).act, "fire"); // 6 h of grace
  assertEquals(due(r, { runs: [] }, T("2026-10-15T06:30:00Z")).act, "missed");
  assertEquals(due(routine({ grace: 10 }), { runs: [] }, T("2026-10-15T00:11:00Z")).act, "missed");
  // dealt with once
  assertEquals(due(r, { runs: [], status: "fired" }, T("2026-10-15T00:00:30Z")).act, "wait");
  assertEquals(due(routine({ enabled: false }), { runs: [] }, T("2026-10-15T00:00:30Z")).act, "wait");
});

Deno.test("routines: a cron fires on its minute and moves on; one that went by long ago is skipped", () => {
  const r = routine({ trigger: { kind: "cron", expr: "0 2 * * *" } });
  const local = (h: number, m = 0) => new Date(2026, 9, 15, h, m, 5);
  const first = due(r, { runs: [] }, local(1, 59));
  assertEquals(first.act, "wait");
  assertEquals(first.next, new Date(2026, 9, 15, 2, 0).toISOString());
  const now = due(r, { runs: [], next: first.next }, local(2, 0));
  assertEquals(now.act, "fire");
  assertEquals(now.next, new Date(2026, 9, 16, 2, 0).toISOString());
  // the console was down: it is 07:00 and 02:00 was due
  const late = due(r, { runs: [], next: first.next }, local(7));
  assertEquals(late.act, "missed");
  assertEquals(late.next, new Date(2026, 9, 16, 2, 0).toISOString());
});

Deno.test("routines: an event routine takes the ended runs of its project it has not seen", () => {
  const r = routine({ trigger: { kind: "event", on: "run-done", plan: "review" } });
  const runs = [
    { id: "a", project: "/h/repo", plan: { name: "review" }, status: "done" },
    { id: "b", project: "/h/repo", plan: { name: "other" }, status: "done" },
    { id: "c", project: "/h/else", plan: { name: "review" }, status: "done" },
    { id: "d", project: "/h/repo", plan: { name: "review" }, status: "running" },
    { id: "e", project: "/h/repo", plan: { name: "review" }, status: "stopped" },
  ];
  assertEquals(eventRuns(r, runs, []), ["a"]);
  assertEquals(eventRuns(r, runs, ["a"]), []);
  assertEquals(eventRuns(routine({ trigger: { kind: "event", on: "run-failed" } }), runs, []), ["e"]);
});

Deno.test("routines: a saved plan moves into the worktree, and a step outside the repository is refused", () => {
  const plan = {
    name: "p",
    steps: [
      { id: "a", profile: "x", prompt: "do {{task}}" },
      { id: "b", profile: "x", folder: "/h/repo/sub", prompt: "b", after: ["a"] },
    ],
  };
  const moved = planIn(plan, "/h/repo", "/h/repo-wt/agent-1", "the thing", "/h");
  assertEquals(moved.folder, "/h/repo-wt/agent-1");
  assertEquals(moved.steps[0].prompt, "do the thing");
  assertEquals(moved.steps[1].folder, "/h/repo-wt/agent-1/sub");
  assertThrows(
    () =>
      planIn(
        { ...plan, steps: [{ id: "a", profile: "x", folder: "~/other", prompt: "p" }] },
        "/h/repo",
        "/w",
        undefined,
        "/h",
      ),
    Error,
    "outside the routine's repository",
  );
});

Deno.test("routines: the first message tells the child its branch and its limits", () => {
  const m = preamble(routine(), "night-1", "agent/night-1", DEFAULT_POLICY, "/h/repo-wt/agent-night-1");
  assertStringIncludes(m, "agent/night-1");
  assertStringIncludes(m, "push agent/night-1 and dev");
  assertStringIncludes(m, "main, master, release");
  assertStringIncludes(
    preamble(routine(), "x", "agent/x", { ...DEFAULT_POLICY, push: false, commit: false }, "/w"),
    "may not push",
  );
});

// ---------------------------------------------------------------- on disk

async function withHome<T>(f: (home: string, dir: string) => Promise<T>): Promise<T> {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "am-routines-" }));
  try {
    await Deno.mkdir(`${tmp}/repo/.git`, { recursive: true });
    return await f(tmp, `${tmp}/state/routines`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("routines: added, listed, asked to fire and removed — files that survive a restart", async () => {
  await withHome(async (home, dir) => {
    const r = await addRoutine(
      {
        name: "Night tests",
        trigger: { kind: "at", at: "2099-01-01T02:00:00.000Z" },
        action: { kind: "agent", profile: "personal", task: "run the tests" },
        folder: "~/repo",
      },
      dir,
      home,
    );
    assertEquals(r.project, `${home}/repo`);
    assert(r.id.startsWith("night-tests-"));
    assertEquals((await listRoutines(dir)).map((x) => x.id), [r.id]);
    assertEquals((await readState(r.id, dir)).next, "2099-01-01T02:00:00.000Z");
    await requestFire(r.id, dir);
    assert(await Deno.stat(`${dir}/${r.id}.fire`).then(() => true, () => false));
    await removeRoutine(r.id, dir);
    assertEquals(await listRoutines(dir), []);
    await assertRejects(() => removeRoutine(r.id, dir), Error, "no routine");
  });
});

Deno.test("routines: a folder outside home, or outside a repository, or a bad cron, is refused", async () => {
  await withHome(async (home, dir) => {
    const base = {
      trigger: { kind: "cron" as const, expr: "0 2 * * *" },
      action: { kind: "agent" as const, profile: "p", task: "t" },
    };
    await assertRejects(() => addRoutine({ ...base, folder: "/tmp" }, dir, home), Error, "under the home");
    await Deno.mkdir(`${home}/plain`);
    await assertRejects(() => addRoutine({ ...base, folder: `${home}/plain` }, dir, home), Error, "git repository");
    await assertRejects(
      () => addRoutine({ ...base, folder: `${home}/repo`, trigger: { kind: "cron", expr: "x" } }, dir, home),
      Error,
      "cron",
    );
    assertEquals(await listRoutines(dir), []);
  });
});

// ---------------------------------------------------------------- the tick

function harness(over: Partial<Deps> = {}) {
  const log: string[] = [], told: string[] = [], fired: Routine[] = [], stopped: string[] = [];
  let now = T("2026-10-15T00:00:10Z");
  let n = 0;
  const deps: Deps = {
    now: () => now,
    fire: (r) => {
      fired.push(r);
      const f: Fired = {
        id: `run-${++n}`,
        at: now.toISOString(),
        child: `child-${n}`,
        branch: `agent/run-${n}`,
        worktree: `/w${n}`,
        told: [],
      };
      return Promise.resolve(f);
    },
    policy: () => Promise.resolve(DEFAULT_POLICY as Policy),
    watch: () => Promise.resolve({ requests: [], ended: false } as Watch),
    stop: (f) => (stopped.push(f.id), Promise.resolve()),
    runs: () => Promise.resolve([]),
    held: () => Promise.resolve([]),
    elsewhere: () => Promise.resolve([]),
    propose: () => Promise.resolve(),
    lapse: () => Promise.resolve(),
    limitEvents: () => Promise.resolve([]),
    holdMaxMin: () => Promise.resolve(720),
    notify: (t, b) => (told.push(`${t} | ${b}`), undefined),
    log: (s) => log.push(s),
    ...over,
  };
  return { deps, log, told, fired, stopped, at: (iso: string) => (now = T(iso)) };
}

const addAt = (home: string, dir: string, at: string, extra = {}) =>
  addRoutine(
    {
      name: "night",
      trigger: { kind: "at", at },
      action: { kind: "agent", profile: "personal", task: "t" },
      folder: "~/repo",
      ...extra,
    },
    dir,
    home,
  );

Deno.test("tick: an `at` fires once, and a restart (a new tick over the same files) does not fire it again", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2026-10-15T00:00:00.000Z");
    const h = harness();
    await tick(dir, h.deps);
    assertEquals(h.fired.map((x) => x.id), [r.id]);
    const st = await readState(r.id, dir);
    assertEquals([st.status, st.runs.length, st.runs[0].branch], ["fired", 1, "agent/run-1"]);
    const again = harness();
    again.at("2026-10-15T00:05:00Z");
    await tick(dir, again.deps);
    assertEquals(again.fired, []);
    assertEquals((await readState(r.id, dir)).runs.length, 1);
  });
});

Deno.test("tick: an `at` that went by while the console was down is marked missed and the owner is told", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2026-10-15T00:00:00.000Z");
    const h = harness();
    h.at("2026-10-15T08:00:00Z");
    await tick(dir, h.deps);
    assertEquals(h.fired, []);
    assertEquals((await readState(r.id, dir)).status, "missed");
    assertEquals(h.told.length, 1);
    assertStringIncludes(h.told[0], "missed");
    await tick(dir, h.deps);
    assertEquals(h.told.length, 1, "told once");
  });
});

Deno.test("tick: a request of a running routine reaches the owner once; the end and the timeout too", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2026-10-15T00:00:00.000Z");
    let w: Watch = { requests: [{ id: "child-1:req1", what: "Bash(git push origin dev)" }], ended: false };
    const h = harness({ watch: () => Promise.resolve(w) });
    await tick(dir, h.deps);
    h.at("2026-10-15T00:01:00Z");
    await tick(dir, h.deps);
    await tick(dir, h.deps);
    assertEquals(h.told.filter((t) => t.includes("waits for you")).length, 1);
    assertStringIncludes(h.told[0], "git push origin dev");
    // too long: the policy's timeout (120 min) passed
    h.at("2026-10-15T02:30:00Z");
    await tick(dir, h.deps);
    assertEquals(h.stopped, ["run-1"]);
    assert(h.told.some((t) => t.includes("timed out")));
    assert((await readState(r.id, dir)).runs[0].ended);
    // and one that ends by itself
    const r2 = await addAt(home, dir, "2026-10-15T02:40:00.000Z");
    h.at("2026-10-15T02:41:00Z");
    w = { requests: [], ended: false };
    await tick(dir, h.deps);
    w = { requests: [], ended: true, lingering: true };
    h.at("2026-10-15T02:50:00Z");
    await tick(dir, h.deps);
    assert(h.told.some((t) => t.includes("finished")));
    assert((await readState(r2.id, dir)).runs[0].ended);
    assertEquals(h.stopped, ["run-1", "run-2"], "a child idle after its turn is stopped, not left to time out");
  });
});

Deno.test("tick: no more unattended runs at once than the policy allows — the rest wait, then start, or are missed", async () => {
  await withHome(async (home, dir) => {
    const a = await addAt(home, dir, "2026-10-15T00:00:00.000Z", { name: "a" });
    const b = await addAt(home, dir, "2026-10-15T00:00:00.000Z", { name: "b" });
    const c = await addAt(home, dir, "2026-10-15T00:00:00.000Z", { name: "c" });
    let ended = false;
    const h = harness({
      policy: () => Promise.resolve({ ...DEFAULT_POLICY, maxConcurrent: 2 }),
      watch: () => Promise.resolve({ requests: [], ended }),
    });
    await tick(dir, h.deps);
    assertEquals(h.fired.length, 2, "two of three");
    const waiting = [a, b, c].filter((x) => h.fired.every((f) => f.id !== x.id))[0];
    assert((await readState(waiting.id, dir)).queued);
    // room appears
    ended = true;
    h.at("2026-10-15T00:01:00Z");
    await tick(dir, h.deps);
    ended = false;
    h.at("2026-10-15T00:02:00Z");
    await tick(dir, h.deps);
    assertEquals(h.fired.length, 3);
    assertEquals((await readState(waiting.id, dir)).queued, undefined);
  });
});

Deno.test("tick: a firing that cannot start is recorded and told, not retried forever", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2026-10-15T00:00:00.000Z");
    const h = harness({ fire: () => Promise.reject(new Error("no profile personal")) });
    await tick(dir, h.deps);
    await tick(dir, h.deps);
    const st = await readState(r.id, dir);
    assertEquals(st.lastError, "no profile personal");
    assertEquals(h.told.filter((t) => t.includes("failed to start")).length, 1);
  });
});

Deno.test("tick: `run` asks for a firing now, once", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2099-01-01T00:00:00.000Z");
    const h = harness();
    await tick(dir, h.deps);
    assertEquals(h.fired, []);
    await requestFire(r.id, dir);
    await tick(dir, h.deps);
    await tick(dir, h.deps);
    assertEquals(h.fired.length, 1);
  });
});

Deno.test("tick: an event routine ignores the history, fires for a run that ends after it, once", async () => {
  await withHome(async (home, dir) => {
    const r = await addRoutine(
      {
        name: "after review",
        trigger: { kind: "event", on: "run-done" },
        action: { kind: "agent", profile: "personal", task: "t" },
        folder: "~/repo",
      },
      dir,
      home,
    );
    let runs = [{ id: "old", project: r.project, plan: { name: "x" }, status: "done" }];
    const h = harness({ runs: () => Promise.resolve(runs) });
    await tick(dir, h.deps);
    assertEquals(h.fired, [], "what ended before is history");
    runs = [...runs, { id: "new", project: r.project, plan: { name: "x" }, status: "running" }];
    await tick(dir, h.deps);
    assertEquals(h.fired, []);
    runs = runs.map((x) => ({ ...x, status: "done" }));
    await tick(dir, h.deps);
    await tick(dir, h.deps);
    assertEquals(h.fired.length, 1);
  });
});

Deno.test("tick: a routine's own workflow run never triggers a routine", async () => {
  await withHome(async (home, dir) => {
    const wf = await addAt(home, dir, "2026-10-15T00:00:00.000Z", { name: "wf" });
    const ev = await addRoutine(
      {
        name: "on done",
        trigger: { kind: "event", on: "run-done" },
        action: { kind: "agent", profile: "personal", task: "t" },
        folder: "~/repo",
      },
      dir,
      home,
    );
    let runs: { id: string; project: string; plan: { name: string }; status: string }[] = [];
    const started: Routine[] = [];
    const h = harness({
      fire: (
        r,
      ) => (started.push(r),
        Promise.resolve(
          {
            id: "r1",
            at: "2026-10-15T00:00:10.000Z",
            run: "wfrun",
            branch: "agent/r1",
            worktree: "/w",
            told: [],
          } as Fired,
        )),
      runs: () => Promise.resolve(runs),
    });
    await tick(dir, h.deps);
    assertEquals(started.map((x) => x.id), [wf.id]);
    runs = [{ id: "wfrun", project: ev.project, plan: { name: "p" }, status: "done" }];
    await tick(dir, h.deps);
    assertEquals(started.map((x) => x.id), [wf.id]);
  });
});

Deno.test("tick: a routine whose account is at its limit is held, tells the owner once, proposes another, and starts when released", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2026-10-15T00:00:00.000Z");
    let blocked = true;
    const by = { window: "5h", used: 91, resetsAt: null };
    const proposed: string[] = [], lapsed: string[] = [];
    const h = harness({
      held: () => Promise.resolve(blocked ? [{ account: "personal/claude", by }] : []),
      elsewhere: () => Promise.resolve(["otacon/claude"]),
      propose: (_r, from, to) => (proposed.push(`${from}>${to}`), Promise.resolve()),
      lapse: (x) => (lapsed.push(x.id), Promise.resolve()),
    });
    await tick(dir, h.deps);
    await tick(dir, h.deps);
    assertEquals(h.fired, []);
    assertEquals(proposed, ["personal/claude>otacon/claude"]);
    assertEquals(h.told.filter((t) => t.includes("is held")).length, 1);
    assertStringIncludes(h.told[0], "91%");
    const st = await readState(r.id, dir);
    assertEquals([st.held, !!st.queued], [["personal/claude"], true]);
    // the window resets: the same routine goes, nothing was lost
    blocked = false;
    h.at("2026-10-15T01:00:00Z");
    await tick(dir, h.deps);
    assertEquals(h.fired.map((x) => x.id), [r.id]);
    assertEquals(lapsed, [r.id], "the proposal it no longer needs is closed");
    const after = await readState(r.id, dir);
    assertEquals([after.held, after.queued], [undefined, undefined]);
  });
});

Deno.test("tick: held for a limit it waits for the window (holdMaxMin), not its short grace, then it is missed", async () => {
  await withHome(async (home, dir) => {
    const r = await addAt(home, dir, "2026-10-15T00:00:00.000Z", { grace: 10 });
    const by = { window: "5h", used: 90, resetsAt: null };
    const h = harness({
      held: () => Promise.resolve([{ account: "personal/claude", by }]),
      holdMaxMin: () => Promise.resolve(120),
    });
    await tick(dir, h.deps);
    h.at("2026-10-15T01:00:00Z"); // far past its 10 minutes of grace, inside the 120 of the hold
    await tick(dir, h.deps);
    assert((await readState(r.id, dir)).queued);
    h.at("2026-10-15T02:30:00Z");
    await tick(dir, h.deps);
    const st = await readState(r.id, dir);
    assertEquals([st.queued, st.held], [undefined, undefined]);
    assert(h.told.some((t) => t.includes("stayed at its limit")));
    assertEquals(h.fired, []);
  });
});

Deno.test("tick: a plan that is held proposes nothing (its accounts are its steps')", async () => {
  await withHome(async (home, dir) => {
    await addRoutine(
      {
        name: "flow",
        trigger: { kind: "at", at: "2026-10-15T00:00:00.000Z" },
        action: { kind: "workflow", plan: "plan.json" },
        folder: "~/repo",
      },
      dir,
      home,
    );
    const proposed: string[] = [];
    const h = harness({
      held: () => Promise.resolve([{ account: "a/claude", by: { window: "5h", used: 90, resetsAt: null } }]),
      elsewhere: () => Promise.resolve(["b/claude"]),
      propose: (_r, f, t) => (proposed.push(f + t), Promise.resolve()),
    });
    await tick(dir, h.deps);
    assertEquals([h.fired, proposed], [[], []]);
    assertEquals(h.told.length, 1);
  });
});

Deno.test("tick: a `limit-reset` routine ignores the past and fires when its account resets", async () => {
  await withHome(async (home, dir) => {
    const r = await addRoutine(
      {
        name: "resume",
        trigger: { kind: "event", on: "limit-reset", account: "personal/claude" },
        action: { kind: "agent", profile: "personal", task: "t" },
        folder: "~/repo",
      },
      dir,
      home,
    );
    const ev = (id: string, account: string, kind: "reset" | "blocked") => ({
      id,
      at: "",
      kind,
      account,
      window: "5h",
      used: null,
      resetsAt: null,
      detail: "",
    });
    let events = [ev("old", "personal/claude", "reset")];
    const h = harness({ limitEvents: () => Promise.resolve(events) });
    await tick(dir, h.deps);
    assertEquals(h.fired, [], "an old reset is history");
    events = [...events, ev("o2", "otacon/claude", "reset"), ev("b1", "personal/claude", "blocked")];
    await tick(dir, h.deps);
    assertEquals(h.fired, [], "another account's reset, or a block, is not it");
    events = [...events, ev("r2", "personal/claude", "reset")];
    await tick(dir, h.deps);
    await tick(dir, h.deps);
    assertEquals(h.fired.map((x) => x.id), [r.id]);
  });
});

Deno.test("routines: an unattended child is done when gone or idle after a turn, not before its first", () => {
  const st = (phase: ChildState["phase"], turns: number) =>
    ({ phase, turns, session: null, pending: [], said: [], lastResult: null, error: null, costUsd: 0 }) as ChildState;
  assert(childDone(undefined));
  assert(childDone(st("ended", 0)));
  assert(childDone(st("idle", 1)));
  assert(!childDone(st("idle", 0)));
  assert(!childDone(st("working", 3)));
  assert(!childDone(st("waiting", 1)));
});
