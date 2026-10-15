// fleet_test.ts — the service's nodes and jobs (fleet.ts): announcing, the life of a job, who may do what, and
// what a silent node's jobs become. On a brain database in memory, through the routes the machines call.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanAnnounce, Fleet, fleetRoute } from "../fleet.ts";
import { Store } from "../store.ts";
import { type Job, type JobSpec } from "../../../shared/mcp/lib/nodes.ts";

const spec: JobSpec = {
  name: "nightly",
  repo: "git.example.com/me/site",
  path: "",
  action: { kind: "agent" },
  id: "n-1",
};
const ann = (x: Record<string, unknown> = {}) => ({
  platform: "linux",
  version: "1.2.0",
  headless: false,
  load: 0.2,
  memTotal: 8e9,
  memFree: 4e9,
  cap: 2,
  running: 0,
  accounts: ["work/claude"],
  present: false,
  sandbox: null,
  ...x,
});

function setup() {
  let now = Date.parse("2026-10-15T20:00:00Z"), n = 0;
  const fleet = new Fleet(new Store(":memory:").db, () => now, () => `j${++n}`);
  const call = async (node: string | null, method: string, path: string, body?: unknown) => {
    const req = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const r = await fleetRoute(req, new URL(req.url), node, fleet);
    return { status: r!.status, body: await r!.json() };
  };
  return { fleet, call, tick: (ms: number) => (now += ms) };
}

Deno.test("fleet: an announcement keeps known fields only, bounded", () => {
  const a = cleanAnnounce({ ...ann(), cap: 9999, load: -1, accounts: ["work/claude", "../x", 3], extra: "x" });
  assertEquals([a.cap, a.load, a.accounts], [256, 0, ["work/claude"]]);
  assert(!("extra" in a));
  assertEquals(cleanAnnounce(null).sandbox, null);
});

Deno.test("fleet: a proposal is accepted with a signature, claimed and reported by its node alone", async () => {
  const { call } = setup();
  assertEquals((await call("desk", "PUT", "/api/node", ann())).status, 200);
  const created = await call("desk", "POST", "/api/jobs", { kind: "routine", node: "srv", spec, reason: "away" });
  const id = (created.body.job as Job).id;
  assertEquals(created.body.job.status, "proposed");
  // a Claude connection reads, never acts
  assertEquals((await call(null, "POST", `/api/jobs/${id}`, { op: "decline" })).status, 403);
  // accepted: the signature is stored, not checked (the node checks it)
  const sig = "x".repeat(86), expires = new Date(Date.parse("2026-10-16T08:00:00Z")).toISOString();
  assertEquals(
    (await call("desk", "POST", `/api/jobs/${id}`, { op: "accept", signature: "short", expires })).status,
    400,
  );
  assertEquals(
    (await call("desk", "POST", `/api/jobs/${id}`, { op: "accept", signature: sig, expires: "2026-10-20T00:00:00Z" }))
      .status,
    400,
    "an approval holds a day at most",
  );
  const ok = await call("desk", "POST", `/api/jobs/${id}`, { op: "accept", signature: sig, expires });
  assertEquals([ok.body.job.status, ok.body.job.signature], ["accepted", sig]);
  // the node gets it with its announcement
  const got = await call("srv", "PUT", "/api/node", ann({ headless: true, sandbox: true }));
  assertEquals(got.body.jobs.map((j: Job) => j.id), [id]);
  assertEquals((await call("desk", "POST", `/api/jobs/${id}`, { op: "claim" })).status, 403, "another node's token");
  assertEquals((await call("srv", "POST", `/api/jobs/${id}`, { op: "claim" })).body.job.status, "running");
  assertEquals((await call("srv", "POST", `/api/jobs/${id}`, { op: "claim" })).status, 409, "claimed once");
  const done = await call("srv", "POST", `/api/jobs/${id}`, { op: "report", status: "done", head: "abc123" });
  assertEquals([done.body.job.status, done.body.job.head], ["done", "abc123"]);
  const list = await call(null, "GET", "/api/nodes");
  assertEquals(list.body.nodes.map((n: { name: string }) => n.name), ["desk", "srv"]);
  assertEquals(list.body.jobs.map((j: Job) => j.status), ["done"]);
});

Deno.test("fleet: a node's own firing is running at once, on that node, without a signature", async () => {
  const { call } = setup();
  const r = await call("desk", "POST", "/api/jobs", { kind: "routine", node: "srv", local: true, spec });
  assertEquals([r.body.job.node, r.body.job.status, r.body.job.local], ["desk", "running", true]);
  assertEquals(
    (await call("desk", "POST", "/api/jobs", { kind: "routine", spec: { ...spec, path: "../x" } })).status,
    400,
  );
  assertEquals((await call("desk", "POST", "/api/jobs", { kind: "shell", spec })).status, 400);
});

Deno.test("fleet: a node silent for ten minutes loses its running jobs, proposed to resume elsewhere once", async () => {
  const { call, tick, fleet } = setup();
  await call("desk", "PUT", "/api/node", ann());
  await call("srv", "PUT", "/api/node", ann({ headless: true, sandbox: true }));
  const local = (await call("desk", "POST", "/api/jobs", { kind: "routine", local: true, spec })).body.job as Job;
  tick(5 * 60_000);
  await call("srv", "PUT", "/api/node", ann({ headless: true, sandbox: true }));
  assertEquals(fleet.get(local.id)!.status, "running", "five minutes is not gone");
  tick(6 * 60_000);
  await call("srv", "PUT", "/api/node", ann({ headless: true, sandbox: true }));
  assertEquals(fleet.get(local.id)!.status, "interrupted");
  const jobs = fleet.jobs();
  const resume = jobs.find((j) => j.parent === local.id)!;
  assertEquals([resume.kind, resume.status, resume.node, resume.by, resume.spec.from], [
    "resume",
    "proposed",
    "srv",
    "service",
    "desk",
  ]);
  fleet.sweep();
  assertEquals(fleet.jobs().filter((j) => j.parent === local.id).length, 1, "proposed once");
  // the node comes back and says how it ended
  await call("desk", "PUT", "/api/node", ann());
  assertEquals(
    (await call("desk", "POST", `/api/jobs/${local.id}`, { op: "report", status: "done" })).body.job.status,
    "done",
  );
});

Deno.test("fleet: a proposal nobody answers lapses after a day", async () => {
  const { call, tick, fleet } = setup();
  const p = (await call("desk", "POST", "/api/jobs", { kind: "routine", node: "srv", spec })).body.job as Job;
  tick(25 * 3600_000);
  fleet.sweep();
  assertEquals(fleet.get(p.id)!.status, "lapsed");
});
