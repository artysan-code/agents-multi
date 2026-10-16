// node_runs_test.ts — this machine's runs as the phone's Agents view sees them (apps/cli/node/runs.ts): what is
// collected from the hub, how the machine's setting and a client's repository redact it, and the phone's Stop,
// checked here with a real passkey signature (the fixture's authenticator) as a decline is.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  applyStops,
  collect,
  type Facts,
  opaqueId,
  projectName,
  publishable,
  redact,
  resolveRun,
  runsKey,
  scheduleOf,
  stopKey,
  stopText,
  tailOf,
  titleOf,
  verifyStop,
} from "../node/runs.ts";
import { stopText as webStopText } from "../../ui/src/web/agents-core.ts";
import type { Child } from "../../../shared/mcp/lib/agents.ts";
import type { Routine, RoutineState } from "../../../shared/mcp/lib/routines.ts";
import type { Run as WorkflowRun } from "../../../shared/mcp/lib/runs.ts";
import { approvalKeys } from "../../../shared/mcp/lib/nodes.ts";
import { type Passkey, type PasskeyCtx, signEndorsement } from "../../../shared/mcp/lib/webauthn.ts";
import { HIDDEN } from "../../../shared/mcp/lib/mask.ts";
import { Authenticator, SITE } from "./fixtures/authenticator.ts";
import { ownedRemote } from "../node/clone.ts";

const KEY = new Uint8Array(32).fill(7);
const OPAQUE = opaqueId(KEY);
const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOME = "/home/u";

function child(
  id: string,
  x: {
    phase?: string;
    said?: string[];
    error?: string;
    run?: boolean;
    pending?: string[];
    task?: string;
    dir?: string;
  } = {},
): Child {
  return {
    meta: {
      id,
      profile: "work",
      command: "work",
      dir: x.dir ?? `${HOME}/personal/app`,
      project: x.dir ?? `${HOME}/personal/app`,
      task: x.task ?? "Fix the login\nand more",
      started: "2026-10-16T11:00:00Z",
      ...(x.run ? { run: { id: "wf-1", step: "build" } } : {}),
    },
    state: {
      phase: (x.phase ?? "working") as Child["state"]["phase"],
      session: null,
      pending: (x.pending ?? []).map((r) => ({
        request: r,
        kind: "request" as const,
        tool: "Bash",
        what: "Bash: git push",
        input: {},
        session: "s",
        at: 0,
      })),
      said: x.said ?? [],
      turns: 1,
      lastResult: null,
      error: x.error ?? null,
      costUsd: 0,
    },
  } as Child;
}

const facts = (x: Partial<Facts> = {}): Facts => ({
  home: HOME,
  now: NOW,
  touched: () => "2026-10-16T11:59:00Z",
  repoOf: () => "git.example.me/owner/app",
  branchOf: () => "main",
  jobOf: () => undefined,
  ...x,
});

Deno.test("runs: the tail is the last five lines said, masked and bounded", () => {
  const said = ["one\ntwo", "three", "", "four\n\nfive", "six with sk-ant-abcdefghijklmnop0123 in it", "x".repeat(900)];
  const t = tailOf(said);
  assertEquals(t.length, 5);
  assertEquals(t[0], "three");
  assert(t[3].includes(HIDDEN) && !t[3].includes("sk-ant-"));
  assertEquals(t[4].length, 400);
  assertEquals(titleOf("\n  Fix the login  \nmore"), "Fix the login");
  assertEquals(titleOf(undefined), undefined);
});

Deno.test("runs: a project is named by its path under home; a repository is the owner's by repos or gitHosts", () => {
  assertEquals(projectName(`${HOME}/personal/dnd/dragons-lair`, HOME), "personal/dnd/dragons-lair");
  assertEquals(projectName("/srv/x/app", HOME), "app");
  // the rule of a clone on need (clone.ts), the same function: the two lists cannot drift
  const own = (repo: string | null, repos: string[], gitHosts: string[]) => ownedRemote({ repos, gitHosts }, repo);
  assert(own("github.com/me/a", ["git@github.com:me/a.git"], []));
  assert(own("git.example.me/owner/app", [], ["git.example.me"]));
  assert(own("github.com/me/a", [], ["github.com/me"]));
  // whole segments, never a substring
  assert(!own("github.com/meander/a", [], ["github.com/me"]));
  assert(!own("evilgit.example.me/x", [], ["git.example.me"]));
  assert(!own("gitlab.client.it/c/app", [], ["github.com/me"]));
  assert(!own(null, [], ["github.com"]));
});

Deno.test("runs: state mode drops the output and the branch; a client's repository is named (client) whatever", () => {
  const { runs } = collect([child("work-a", { said: ["hello"] })], [], [], facts());
  const r = runs[0].run;
  assertEquals([r.tail, r.branch, r.title], [["hello"], "main", "Fix the login"]);
  const s = redact(r, "state", true, OPAQUE);
  assertEquals([s.tail, s.branch, s.title, s.project], [[], undefined, undefined, "personal/app"]);
  const c = redact(r, "full", false, OPAQUE);
  assertEquals([c.tail, c.branch, c.project, c.repo, c.noMove], [
    [],
    undefined,
    "(client)",
    "(client)",
    "a client's repository",
  ]);
  assertEquals(publishable({ runs, routines: [] }, "off", { repos: [] }, OPAQUE).runs, []);
  const mine = publishable({ runs, routines: [] }, "full", { repos: [], gitHosts: ["git.example.me"] }, OPAQUE);
  assertEquals([mine.runs[0].tail, mine.runs[0].id], [["hello"], "work-a"]);
  assertEquals(publishable({ runs, routines: [] }, "full", { repos: [] }, OPAQUE).runs[0].project, "(client)");
});

Deno.test("runs: nothing of a client's run's id, folder or steps reaches the service; a stop still finds it", () => {
  const dir = `${HOME}/work/acme/acme-portal`;
  const id = "work-acme-portal-20261016T1100-k3x9";
  const kid = child(id, { dir, pending: ["req-acme-1"], phase: "waiting", said: ["acme secrets"] });
  const step = child("work-acme-portal-20261016T1105-q7w2", { dir, run: true, said: ["acme build"] });
  const wf = {
    id: "wf-acme-portal-20261016",
    plan: { name: "acme-deploy", steps: [{ id: "acme-build", profile: "work", prompt: "" }] },
    state: {
      status: "running",
      steps: { "acme-build": { status: "running", attempt: 1, child: step.meta.id, started: "2026-10-16T11:05:00Z" } },
      control: 0,
      heard: {},
    },
    alive: true,
    project: dir,
  } as unknown as WorkflowRun;
  const c = collect([kid, step], [wf], [], facts({ repoOf: () => "gitlab.acme.it/acme/portal" }));
  const out = publishable(c, "full", { repos: [], gitHosts: ["git.example.me"] }, OPAQUE);
  const json = JSON.stringify(out);
  for (const part of ["acme", "portal", "20261016", "k3x9", "q7w2", "req-", "wf-"]) {
    assert(!json.includes(part), `${part} reached the service: ${json}`);
  }
  const k = out.runs.find((r) => r.kind === "child")!, w = out.runs.find((r) => r.kind === "workflow")!;
  assertMatch(k.id, /^x-[0-9a-f]{32}$/);
  assertEquals(k.id, OPAQUE(id)); // the same each time: the service's row stays one row
  assertEquals(k.waiting!.length, 1);
  assertMatch(k.waiting![0], /^x-[0-9a-f]{32}\/x-[0-9a-f]{32}$/);
  assertEquals(w.workflow, { name: "(client)", step: "1", steps: [{ id: "1", state: "running" }] });
  // the phone's stop names the opaque id: the node finds the real one, and nothing else
  const ids = [wf.id, id, step.meta.id];
  assertEquals(resolveRun(k.id, ids, OPAQUE), id);
  assertEquals(resolveRun(w.id, ids, OPAQUE), wf.id);
  assertEquals(resolveRun(id, ids, OPAQUE), id);
  assertEquals(resolveRun("x-0000", ids, OPAQUE), null);
  // another node's key makes other ids
  assert(opaqueId(new Uint8Array(32).fill(8))(id) !== k.id);
});

Deno.test("runs: the node's key is made once, private, and read back the same", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/node/runs-key`;
    const a = await runsKey(file);
    assertEquals(a.length, 32);
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals(await Deno.readFile(file), a);
    assertEquals(await runsKey(file), a);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runs: children, routine firings and workflow runs are collected; a step's child is inside its run", () => {
  const kids = [
    child("work-a", { pending: ["r1"], phase: "waiting" }),
    child("work-b", { phase: "ended", error: "boom" }),
    child("work-c", { run: true, said: ["building"] }),
    child("work-d", { phase: "ended" }),
  ];
  const wf: WorkflowRun = {
    id: "wf-1",
    plan: {
      name: "release",
      steps: [{ id: "build", profile: "work", prompt: "" }, { id: "ship", profile: "work", prompt: "" }],
    },
    state: {
      status: "running",
      steps: {
        build: { status: "running", attempt: 1, child: "work-c", started: "2026-10-16T11:10:00Z" },
        ship: { status: "waiting", attempt: 0 },
      },
      control: 0,
      heard: {},
    },
    alive: true,
    project: `${HOME}/personal/app`,
  } as unknown as WorkflowRun;
  const routine = {
    id: "nightly",
    name: "Nightly",
    trigger: { kind: "cron", expr: "0 3 * * *" },
    action: { kind: "agent", profile: "work", task: "t" },
    folder: `${HOME}/personal/app`,
    project: `${HOME}/personal/app`,
    enabled: true,
    created: "",
  } as Routine;
  const st: RoutineState = {
    next: "2026-10-17T03:00:00Z",
    lastFired: "2026-10-16T03:00:00Z",
    runs: [{ id: "nightly-1", at: "", child: "work-d", branch: "agent/nightly-1", worktree: "", told: [] }],
  };
  const out = collect(
    kids,
    [wf],
    [{ r: routine, st }],
    facts({ jobOf: (id) => id === "nightly-1" ? "job-9" : undefined }),
  );
  const by = Object.fromEntries(out.runs.map((x) => [x.run.id, x.run]));
  assertEquals(Object.keys(by).sort(), ["wf-1", "work-a", "work-b", "work-d"]);
  assertEquals([by["work-a"].state, by["work-a"].waiting], ["waiting", ["work-a/r1"]]);
  assertEquals(by["work-b"].state, "failed");
  assertEquals([by["wf-1"].kind, by["wf-1"].workflow!.step, by["wf-1"].tail, by["wf-1"].state], ["workflow", "build", [
    "building",
  ], "working"]);
  assertEquals([by["work-d"].kind, by["work-d"].routine, by["work-d"].branch, by["work-d"].job], [
    "routine",
    "Nightly",
    "agent/nightly-1",
    "job-9",
  ]);
  // live runs before ended ones
  assertEquals(
    out.runs.map((x) => x.run.state).indexOf("ended") > out.runs.map((x) => x.run.state).indexOf("working"),
    true,
  );
  assertEquals(out.routines[0].routine, {
    name: "Nightly",
    schedule: "0 3 * * *",
    next: "2026-10-17T03:00:00Z",
    last: "2026-10-16T03:00:00Z",
    enabled: true,
  });
  assertEquals(scheduleOf({ ...routine, trigger: { kind: "event", on: "run-done" } }), "on run-done");
  // a run without a remote cannot move
  const none = collect([child("work-a")], [], [], facts({ repoOf: () => null })).runs[0].run;
  assertMatch(none.noMove!, /no remote/);
});

Deno.test("runs: an ended run older than a week is not published; at most a hundred", () => {
  const old = collect([child("work-x", { phase: "ended" })], [], [], facts({ touched: () => "2026-10-01T00:00:00Z" }));
  assertEquals(old.runs, []);
  const many = collect(Array.from({ length: 130 }, (_, i) => child(`work-${i}`)), [], [], facts());
  assertEquals(many.runs.length, 100);
});

// ---- the phone's stop
async function world() {
  const owner = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  const phone = await Authenticator.make();
  const passkey: Passkey = { id: phone.id, name: "Pixel", publicKey: phone.publicKey, endorsement: null, created: "" };
  passkey.endorsement = await signEndorsement(passkey.id, passkey.publicKey, owner.sign);
  const ctx: PasskeyCtx = { site: SITE, passkeys: [passkey], ownerKey: owner.public, now: NOW };
  const expires = new Date(NOW + 5 * 60_000).toISOString();
  const { stopChallenge } = await import("../node/runs.ts");
  const signed = async (node = "srv", run = "work-a", exp = expires, by = phone) => ({
    run,
    expires: exp,
    assertion: await by.assert(await stopChallenge({ node, run, expires: exp })),
  });
  return { ctx, phone, signed, expires };
}

Deno.test("stop: the web app and the node sign the same text", () => {
  const s = { node: "srv", run: "work-a", expires: "2026-10-16T12:05:00.000Z" };
  assertEquals(stopText(s), webStopText(s));
  assertEquals(stopText(s), 'agents-multi stop v1\n{"expires":"2026-10-16T12:05:00.000Z","node":"srv","run":"work-a"}');
});

Deno.test("stop: held only for this node, in time, by an endorsed passkey, once", async () => {
  const w = await world();
  assertEquals(await verifyStop(await w.signed(), "srv", w.ctx, []), null);
  // signed for another machine: the assertion does not hold here
  assertMatch((await verifyStop(await w.signed("desk"), "srv", w.ctx, []))!, /challenge/);
  assertMatch((await verifyStop(await w.signed(), "srv", { ...w.ctx, now: NOW + 6 * 60_000 }, []))!, /expired/);
  const far = new Date(NOW + 30 * 60_000).toISOString();
  assertMatch((await verifyStop(await w.signed("srv", "work-a", far), "srv", w.ctx, []))!, /ten minutes/);
  const mallory = await Authenticator.make();
  assertMatch(
    (await verifyStop(await w.signed("srv", "work-a", w.expires, mallory), "srv", w.ctx, []))!,
    /not a passkey/,
  );
  assertMatch(
    (await verifyStop(await w.signed(), "srv", { ...w.ctx, revoked: new Set([w.phone.id]) }, []))!,
    /revoked/,
  );
  assertMatch((await verifyStop(await w.signed(), "srv", { ...w.ctx, ownerKey: null }, []))!, /no approval key/);
  const key = await stopKey({ node: "srv", run: "work-a", expires: w.expires });
  assertEquals(await verifyStop(await w.signed(), "srv", w.ctx, [key]), "already used");
});

Deno.test("stop: applied once, refused with why, left for later when the passkeys cannot be read", async () => {
  const w = await world();
  const stopped: string[] = [], seen: string[] = [];
  const d = { ctx: () => Promise.resolve(w.ctx), stop: (r: string) => (stopped.push(r), Promise.resolve()) };
  const good = await w.signed();
  const bad = { ...await w.signed("srv", "work-b"), run: "work-c" };
  assertEquals(await applyStops([good, bad], "srv", seen, d), [
    { id: "stop:work-a", ok: true },
    { id: "stop:work-c", ok: false, why: "the challenge is not the one of this answer" },
  ]);
  assertEquals(stopped, ["work-a"]);
  assertEquals(seen.length, 1);
  // the same stop again is not applied twice
  assertEquals(await applyStops([good], "srv", seen, d), [{ id: "stop:work-a", ok: false, why: "already used" }]);
  assertEquals(stopped, ["work-a"]);
  // a stop the hub could not apply says what the hub said
  const gone = await w.signed("srv", "work-z");
  const failing = { ...d, stop: () => Promise.reject(new Error("no child work-z")) };
  assertEquals(await applyStops([gone], "srv", seen, failing), [{
    id: "stop:work-z",
    ok: false,
    why: "no child work-z",
  }]);
  // unreadable passkeys: nothing decided, nothing remembered
  const later = await w.signed("srv", "work-y");
  assertEquals(await applyStops([later], "srv", seen, { ...d, ctx: () => Promise.reject(new Error("offline")) }), []);
});

Deno.test("doctor: node.runs says what is published, and warns when nothing tells the owner's repositories", async () => {
  const { runsFindings } = await import("../doctor/checks/runs.ts");
  const { cleanNodeConfig } = await import("../../../shared/mcp/lib/headless.ts");
  assertEquals(runsFindings(cleanNodeConfig({})), []);
  assertEquals(runsFindings(cleanNodeConfig({ enabled: true }))[0].status, "warn");
  assertEquals(runsFindings({ ...cleanNodeConfig({ enabled: true }), gitHosts: ["github.com/me"] })[0].status, "ok");
  assertMatch(runsFindings(cleanNodeConfig({ enabled: true, runs: "off" }))[0].msg, /not published/);
  assertEquals(cleanNodeConfig({ runs: "loud" }).runs, undefined);
  assertEquals(cleanNodeConfig({ runs: "state" }).runs, "state");
});

Deno.test("hosts: agents node hosts adds and removes the owner's forge in nodes.json, the doctor proposes it", async () => {
  const { gitHostsWith, HOSTS_HINT } = await import("../node/command.ts");
  const { runsFindings } = await import("../doctor/checks/runs.ts");
  const { cleanNodeConfig } = await import("../../../shared/mcp/lib/headless.ts");
  const raw = { repos: ["git@github.com:me/a.git"], repoRoots: ["~/src"] };
  const added = gitHostsWith(raw, "add", "Git.Example.ME");
  assert(added.ok);
  assertEquals(added.config, { ...raw, gitHosts: ["git.example.me"] });
  // a scheme or a user is dropped; adding twice keeps one; the result is a valid config
  const again = gitHostsWith(added.config, "add", "ssh://git@git.example.me/");
  assert(again.ok);
  assertEquals(again.config.gitHosts, ["git.example.me"]);
  const two = gitHostsWith(again.config, "add", "github.com/me");
  assert(two.ok);
  assertEquals(cleanNodeConfig(two.config).gitHosts, ["git.example.me", "github.com/me"]);
  const less = gitHostsWith(two.config, "remove", "git.example.me");
  assert(less.ok);
  assertEquals(less.config.gitHosts, ["github.com/me"]);
  for (const bad of ["*.example.me", "github.com/me/repo", "", "a b"]) assert(!gitHostsWith(raw, "add", bad).ok, bad);
  // the doctor and `enable` name the command
  assertMatch(runsFindings(cleanNodeConfig({ enabled: true }))[0].fix ?? "", /agents node hosts add/);
  assertMatch(HOSTS_HINT, /agents node hosts add/);
});
