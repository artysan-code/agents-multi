// runs_test.ts — the agents of every machine (runs.ts, ADR 0014 third round): a node's list replaces its own, the
// view reads the live, the routines and what ended, the stream says what changed, a Stop is kept for its node to
// check and handed back in the announce's reply, and a resume elsewhere is a proposal. On a brain database in
// memory, through the routes. Also the web app's pure part of the view (agents-core.ts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanRun, Runs, RunsHub, runsRoute } from "../runs.ts";
import { Fleet, fleetRoute } from "../fleet.ts";
import { Waiting, waitingRoute } from "../waiting.ts";
import { Store } from "../store.ts";
import { Authenticator, SITE } from "../../cli/tests/fixtures/authenticator.ts";
import { stopChallenge } from "../../cli/node/runs.ts";
import { applyRunEvent, cannotResume, type RunsState, sortRuns, stoppable } from "../../ui/src/web/agents-core.ts";

const NOW0 = Date.parse("2026-10-16T12:00:00Z");
const run = (id: string, x: Record<string, unknown> = {}) => ({
  id,
  kind: "child",
  profile: "work",
  project: "personal/app",
  started: "2026-10-16T11:00:00Z",
  updated: "2026-10-16T11:59:00Z",
  state: "working",
  tail: ["building"],
  ...x,
});

function setup() {
  let now = NOW0, n = 0;
  const db = new Store(":memory:").db;
  const hub = new RunsHub();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  hub.subscribe("u1", (e) => events.push(e));
  const runs = () => new Runs(db, "u1", hub, () => now);
  const w = new Waiting(db, SITE, () => now, () => `chal-${++n}`);
  const fleet = new Fleet(db, () => now, () => `j${++n}`);
  const call = async (node: string | null, method: string, path: string, body?: unknown) => {
    const r = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const u = new URL(r.url);
    const res = (await runsRoute(r, u, node, runs(), "u1", hub)) ??
      (await waitingRoute(r, u, node, w, () => [], "u1")) ??
      (await fleetRoute(r, u, node, fleet, () => ({}), !node));
    return { status: res!.status, body: await res!.json() };
  };
  const announce = (node: string) => call(node, "PUT", "/api/node", { platform: "linux", cap: 2 });
  return { db, call, announce, events, fleet, tick: (ms: number) => (now += ms), now: () => now };
}

/** A passkey of the account, registered through the routes (endorsing it is the node's to check). */
async function phone(s: ReturnType<typeof setup>) {
  const p = await Authenticator.make();
  const opts = await s.call(null, "POST", "/api/passkeys/options");
  await s.call(null, "POST", "/api/passkeys", { name: "Pixel", credential: await p.register(opts.body.challenge) });
  return p;
}

Deno.test("runs: a run is kept with known fields, its tail bounded again, junk dropped", () => {
  const r = cleanRun(run("work-a", { tail: ["1", "2", "3", "4", "5", "6", "x".repeat(900), 7], extra: true }))!;
  assertEquals(r.tail.length, 5);
  assertEquals(r.tail[4].length, 400);
  assertEquals((r as unknown as Record<string, unknown>).extra, undefined);
  assertEquals(cleanRun(run("work a")), null);
  assertEquals(cleanRun(run("work-a", { state: "sleeping" })), null);
  assertEquals(cleanRun(run("work-a", { kind: "daemon" })), null);
  assertEquals(cleanRun(run("work-a", { started: "soon" })), null);
  assertEquals(cleanRun(run("work-a", { waiting: ["work-a/r1", "bad id"] }))!.waiting, ["work-a/r1"]);
  assertEquals(cleanRun(run("work-a", { ended: "2026-10-16T11:00:00Z" }))!.ended, undefined);
});

Deno.test("runs: a node's list replaces its own; the view has the live, the routines and what ended", async () => {
  const s = setup();
  await s.announce("desk");
  await s.announce("srv");
  assertEquals((await s.call(null, "PUT", "/api/node/runs", { runs: [] })).status, 403);
  const put = await s.call("desk", "PUT", "/api/node/runs", {
    runs: [run("work-a"), run("work-b", { state: "waiting", started: "2026-10-16T10:00:00Z" }), { junk: 1 }],
    routines: [{ name: "Nightly", schedule: "0 3 * * *", enabled: true, next: "2026-10-17T03:00:00Z" }],
  });
  assertEquals(put.body, { ok: true, runs: 2, routines: 1 });
  await s.call("srv", "PUT", "/api/node/runs", { runs: [run("work-c", { started: "2026-10-16T11:30:00Z" })] });
  let v = (await s.call(null, "GET", "/api/runs")).body;
  // waiting first, then working, the newest first
  assertEquals(v.runs.map((r: { node: string; id: string }) => `${r.node}:${r.id}`), [
    "desk:work-b",
    "srv:work-c",
    "desk:work-a",
  ]);
  assertEquals(v.runs[0].online, true);
  assertEquals(v.routines, [{
    name: "Nightly",
    schedule: "0 3 * * *",
    enabled: true,
    next: "2026-10-17T03:00:00Z",
    node: "desk",
  }]);
  // the next list: work-a ended, work-b dropped without ending
  s.events.length = 0;
  await s.call("desk", "PUT", "/api/node/runs", {
    runs: [run("work-a", { state: "ended", ended: "2026-10-16T12:00:00Z" })],
  });
  v = (await s.call(null, "GET", "/api/runs")).body;
  assertEquals(v.runs.map((r: { id: string }) => r.id), ["work-c"]);
  assertEquals(v.recent.map((r: { id: string; node: string }) => `${r.node}:${r.id}`), ["desk:work-a"]);
  assertEquals(s.events.map((e) => e.event).sort(), ["gone", "run"]);
  assertEquals(s.events.find((e) => e.event === "gone")!.data, { id: "work-b", node: "desk" });
  // an ended run stays when the node no longer lists it, for a week
  await s.call("desk", "PUT", "/api/node/runs", { runs: [] });
  assertEquals((await s.call(null, "GET", "/api/runs")).body.recent.length, 1);
  s.tick(8 * 86400_000);
  assertEquals((await s.call(null, "GET", "/api/runs")).body.recent, []);
});

Deno.test("runs: an unchanged run is not told again; a silent machine's runs leave the view; a forgotten one's go", async () => {
  const s = setup();
  await s.announce("desk");
  await s.call("desk", "PUT", "/api/node/runs", { runs: [run("work-a")] });
  s.events.length = 0;
  await s.call("desk", "PUT", "/api/node/runs", { runs: [run("work-a")] });
  assertEquals(s.events, []);
  await s.call("desk", "PUT", "/api/node/runs", { runs: [run("work-a", { tail: ["new line"] })] });
  assertEquals(s.events.length, 1);
  assertEquals((s.events[0].data.run as { tail: string[] }).tail, ["new line"]);
  // offline but heard from lately: shown stale
  s.tick(5 * 60_000);
  let v = (await s.call(null, "GET", "/api/runs")).body;
  assertEquals([v.runs.length, v.runs[0].online], [1, false]);
  s.tick(6 * 60_000);
  assertEquals((await s.call(null, "GET", "/api/runs")).body.runs, []);
  // a forgotten machine: its runs and routines are purged with the next read
  await s.announce("desk");
  await s.call("desk", "PUT", "/api/node/runs", {
    runs: [run("work-a", { state: "ended" })],
    routines: [{ name: "R", schedule: "x", enabled: true }],
  });
  s.fleet.forget("desk");
  v = (await s.call(null, "GET", "/api/runs")).body;
  assertEquals([v.runs, v.recent, v.routines], [[], [], []]);
  assertEquals((s.db.prepare("select count(*) as n from runs").get() as { n: number }).n, 0);
});

Deno.test("runs: the stream says a machine went offline and came back", () => {
  const s = setup();
  const runs = new Runs(s.db, "u1", new RunsHub(), () => s.now());
  const last = new Map<string, boolean>();
  s.db.prepare("insert into nodes (name, info, seen) values (?, ?, ?)").run(
    "desk",
    "{}",
    new Date(s.now()).toISOString(),
  );
  assertEquals(runs.nodeChanges(last), []);
  s.tick(2 * 60_000);
  assertEquals(runs.nodeChanges(last), [{ event: "node", data: { node: "desk", online: false } }]);
  assertEquals(runs.nodeChanges(last), []);
  s.db.prepare("update nodes set seen = ?").run(new Date(s.now()).toISOString());
  assertEquals(runs.nodeChanges(last), [{ event: "node", data: { node: "desk", online: true } }]);
});

Deno.test("runs: a stop is kept for its node, handed in the announce's reply, and reported back", async () => {
  const s = setup();
  const p = await phone(s);
  await s.announce("srv");
  await s.call("srv", "PUT", "/api/node/runs", { runs: [run("work-a"), run("work-z", { state: "ended" })] });
  const expires = new Date(s.now() + 5 * 60_000).toISOString();
  const signed = async (x: Record<string, unknown> = {}) => ({
    expires,
    assertion: await p.assert(await stopChallenge({ node: "srv", run: "work-a", expires })),
    ...x,
  });
  assertEquals((await s.call(null, "POST", "/api/runs/srv/work-x/stop", await signed())).status, 404);
  assertEquals((await s.call(null, "POST", "/api/runs/srv/work-z/stop", await signed())).status, 409);
  assertEquals(
    (await s.call(null, "POST", "/api/runs/srv/work-a/stop", await signed({ expires: "soon" }))).status,
    400,
  );
  const far = new Date(s.now() + 30 * 60_000).toISOString();
  assertEquals((await s.call(null, "POST", "/api/runs/srv/work-a/stop", await signed({ expires: far }))).status, 400);
  assertEquals((await s.call(null, "POST", "/api/runs/srv/work-a/stop", await signed({ assertion: {} }))).status, 400);
  const stranger = await Authenticator.make();
  const bad = await signed({ assertion: await stranger.assert(new Uint8Array(32)) });
  assertEquals(
    (await s.call(null, "POST", "/api/runs/srv/work-a/stop", bad)).body.error,
    "not a passkey of this account",
  );
  const ok = await s.call(null, "POST", "/api/runs/srv/work-a/stop", await signed());
  assertEquals(ok.body, { run: "work-a", node: "srv", state: "pending" });
  assertEquals((await s.call(null, "POST", "/api/runs/srv/work-a/stop", await signed())).status, 409);
  // the node gets it with its announce, nobody else's does
  const reply = (await s.announce("srv")).body;
  assertEquals(reply.stops.length, 1);
  assertEquals([reply.stops[0].run, reply.stops[0].expires, reply.stops[0].assertion.credential], [
    "work-a",
    expires,
    p.id,
  ]);
  assertEquals((await s.announce("desk")).body.stops, []);
  // the node's result comes with its next publish; the phone sees how it ended
  await s.call("srv", "PUT", "/api/node/runs", {
    runs: [run("work-a")],
    results: [{ id: "stop:work-a", ok: false, why: "not endorsed" }],
  });
  assertEquals((await s.announce("srv")).body.stops, []);
  const v = (await s.call(null, "GET", "/api/runs")).body;
  assertEquals([v.stops[0].run, v.stops[0].state, v.stops[0].why], ["work-a", "refused", "not endorsed"]);
  // a stop nobody fetched in time lapses; the assertion goes an hour after its expiry
  await s.call(null, "POST", "/api/runs/srv/work-a/stop", await signed());
  s.tick(6 * 60_000);
  assertEquals((await s.announce("srv")).body.stops, []);
  s.tick(2 * 3600_000);
  await s.call(null, "GET", "/api/runs");
  assertEquals((s.db.prepare("select count(*) as n from run_stops").get() as { n: number }).n, 0);
});

Deno.test("runs: resume elsewhere is a proposal for the run's job, refused while it runs on an online machine", async () => {
  const s = setup();
  await s.announce("desk");
  await s.announce("srv");
  const job = (await s.call("desk", "POST", "/api/jobs", {
    kind: "routine",
    local: true,
    spec: { name: "Nightly", repo: "git.example.me/o/app", path: "", action: { kind: "agent" }, id: "nightly-1" },
  })).body.job;
  await s.call("desk", "PUT", "/api/node/runs", {
    runs: [
      run("work-a", { kind: "routine", job: job.id }),
      run("work-b"),
      run("work-c", { noMove: "a client's repository", job: job.id, state: "idle" }),
    ],
  });
  assertEquals((await s.call(null, "POST", "/api/runs/desk/work-a/resume", {})).status, 409);
  assertEquals((await s.call(null, "POST", "/api/runs/desk/work-b/resume", {})).status, 409);
  assertEquals(
    (await s.call(null, "POST", "/api/runs/desk/work-c/resume", {})).body.error,
    "it cannot move: a client's repository",
  );
  // its machine went silent: the move may be proposed, to the machine asked for or the best one free
  s.tick(2 * 60_000);
  await s.announce("srv");
  assertEquals((await s.call(null, "POST", "/api/runs/desk/work-a/resume", { node: "desk" })).status, 400);
  const r = await s.call(null, "POST", "/api/runs/desk/work-a/resume", {});
  assertEquals([r.body.job.kind, r.body.job.node, r.body.job.status, r.body.job.spec.id, r.body.job.spec.from], [
    "resume",
    "srv",
    "proposed",
    "nightly-1",
    "desk",
  ]);
  // one open proposal per run: the phone asking again, or the sweep finding the machine gone, raises no second
  assertEquals((await s.call(null, "POST", "/api/runs/desk/work-a/resume", {})).status, 409);
  s.tick(60 * 60_000);
  await s.announce("srv");
  s.fleet.sweep();
  assertEquals((s.db.prepare("select count(*) as n from jobs where kind = 'resume'").get() as { n: number }).n, 1);
});

Deno.test("runs: a resume the sweep proposed is not proposed again from the phone", async () => {
  const s = setup();
  await s.announce("desk");
  await s.announce("srv");
  const job = (await s.call("desk", "POST", "/api/jobs", {
    kind: "routine",
    local: true,
    spec: { name: "Nightly", repo: "git.example.me/o/app", path: "", action: { kind: "agent" }, id: "nightly-1" },
  })).body.job;
  await s.call("desk", "PUT", "/api/node/runs", { runs: [run("work-a", { kind: "routine", job: job.id })] });
  s.tick(60 * 60_000);
  await s.announce("srv");
  s.fleet.sweep();
  const r = await s.call(null, "POST", "/api/runs/desk/work-a/resume", {});
  assertEquals(r.status, 409);
  assert(/already proposed/.test(r.body.error));
  assertEquals((s.db.prepare("select count(*) as n from jobs where kind = 'resume'").get() as { n: number }).n, 1);
});

Deno.test("runs: its tables are the database's, made once at start; runs.ts and fleet.ts do not import each other", async () => {
  const src = (f: string) => Deno.readTextFile(new URL(`../${f}`, import.meta.url));
  const runs = await src("runs.ts"), fleet = await src("fleet.ts");
  assert(!/create table/i.test(runs), "runs.ts makes no table: store.ts's migrations do");
  assert(!/from "\.\/runs\.ts"/.test(fleet), "fleet.ts imports runs.ts");
  const db = new Store(":memory:").db;
  for (const t of ["runs", "run_routines", "run_stops"]) {
    assert(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t), t);
  }
});

Deno.test("web: the stream's events applied to the view, and what a row offers", () => {
  const base = { ...run("work-a"), node: "desk", online: true } as RunsState["runs"][number];
  let s: RunsState = { runs: [base], routines: [], recent: [] };
  s = applyRunEvent(s, "run", { run: { ...base, id: "work-b", state: "waiting" } });
  assertEquals(s.runs.map((r) => r.id), ["work-b", "work-a"]);
  s = applyRunEvent(s, "node", { node: "desk", online: false });
  assert(s.runs.every((r) => r.online === false));
  assert(!stoppable(s.runs[0]));
  s = applyRunEvent(s, "run", { run: { ...base, state: "ended" } });
  assertEquals([s.runs.map((r) => r.id), s.recent.map((r) => r.id)], [["work-b"], ["work-a"]]);
  s = applyRunEvent(s, "gone", { id: "work-b", node: "desk" });
  assertEquals(s.runs, []);
  assertEquals(applyRunEvent(s, "whatever", {}), s);
  assertEquals(cannotResume({ ...base }), "nojob");
  assertEquals(cannotResume({ ...base, job: "j" }), "running");
  assertEquals(cannotResume({ ...base, job: "j", online: false }), null);
  assertEquals(cannotResume({ ...base, job: "j", noMove: "no remote" }), "no remote");
  assertEquals(
    sortRuns([base, { ...base, id: "x", state: "idle", started: "2026-10-16T11:59:00Z" }]).map((r) => r.id),
    [
      "work-a",
      "x",
    ],
  );
});
