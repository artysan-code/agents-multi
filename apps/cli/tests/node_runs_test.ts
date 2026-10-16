// node_runs_test.ts — this machine's runs as the phone's Agents view sees them (apps/cli/node/runs.ts): what is
// collected from the hub, how the machine's setting and a client's repository redact it, and the phone's Stop,
// checked here with a real passkey signature (the fixture's authenticator) as a decline is.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  applyStops,
  collect,
  type Facts,
  ownRepo,
  projectName,
  publishable,
  redact,
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
  assert(ownRepo("github.com/me/a", ["git@github.com:me/a.git"], []));
  assert(ownRepo("git.example.me/owner/app", [], ["git.example.me"]));
  assert(ownRepo("github.com/me/a", [], ["github.com/me"]));
  // whole segments, never a substring
  assert(!ownRepo("github.com/meander/a", [], ["github.com/me"]));
  assert(!ownRepo("evilgit.example.me/x", [], ["git.example.me"]));
  assert(!ownRepo("gitlab.client.it/c/app", [], ["github.com/me"]));
  assert(!ownRepo(null, [], ["github.com"]));
});

Deno.test("runs: state mode drops the output and the branch; a client's repository is named (client) whatever", () => {
  const { runs } = collect([child("work-a", { said: ["hello"] })], [], [], facts());
  const r = runs[0].run;
  assertEquals([r.tail, r.branch, r.title], [["hello"], "main", "Fix the login"]);
  const s = redact(r, "state", true);
  assertEquals([s.tail, s.branch, s.title, s.project], [[], undefined, undefined, "personal/app"]);
  const c = redact(r, "full", false);
  assertEquals([c.tail, c.branch, c.project, c.repo, c.noMove], [
    [],
    undefined,
    "(client)",
    "(client)",
    "a client's repository",
  ]);
  assertEquals(publishable({ runs, routines: [] }, "off", [], []).runs, []);
  assertEquals(publishable({ runs, routines: [] }, "full", [], ["git.example.me"]).runs[0].tail, ["hello"]);
  assertEquals(publishable({ runs, routines: [] }, "full", [], []).runs[0].project, "(client)");
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
