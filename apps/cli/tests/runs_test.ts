// runs_test.ts — the hub's workflows (shared/mcp/lib/runs.ts): plans, what can start, prompts, events.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  attentionOfEvent,
  finished,
  follow,
  frontmatterOf,
  initialState,
  type Plan,
  planErrors,
  readySteps,
  runId,
  savedWorkflows,
  stepPrompt,
  teamLine,
} from "../../../shared/mcp/lib/runs.ts";

const plan = (o: Partial<Plan> = {}): Plan => ({
  name: "review and fix",
  folder: "~/work/site",
  steps: [
    { id: "review", profile: "funnel", prompt: "Review the PR" },
    { id: "lint", profile: "funnel", prompt: "Run the linters" },
    { id: "fix", profile: "otacon", prompt: "Fix it", after: ["review", "lint"] },
    { id: "post", profile: "personal", folder: "~/blog", prompt: "Write it up", after: ["fix"], confirm: true },
  ],
  ...o,
});

Deno.test("runs: a plan is refused for what would stop it — ids, profiles, folders, unknown or circular steps", () => {
  assertEquals(planErrors(plan()), []);
  assertEquals(planErrors(plan({ name: " " })), ["the plan has no name"]);
  assertEquals(planErrors(plan({ steps: [] })), ["the plan has no steps"]);
  assertEquals(planErrors(plan({ concurrency: 9 })), ["concurrency is 1 to 8"]);
  const bad = planErrors(plan({
    folder: undefined,
    steps: [
      { id: "A b", profile: "x", prompt: "p", folder: "~/x" },
      { id: "b", profile: "", prompt: " ", after: ["zz"] },
      { id: "b", profile: "x", prompt: "p", folder: "~/x", model: "a b" },
    ],
  }));
  assertEquals(bad, [
    'step id "A b": lowercase letters, digits, -',
    "step b: no profile",
    "step b: no prompt",
    "step b: no folder, and none for the plan",
    "step b twice",
    "step b: not a model name",
    "step b is after zz, which is not a step",
  ]);
  const circle = plan({
    steps: [
      { id: "a", profile: "x", prompt: "p", after: ["b"] },
      { id: "b", profile: "x", prompt: "p", after: ["a"] },
    ],
  });
  assertEquals(planErrors(circle), ["the steps wait on each other in a circle"]);
});

Deno.test("runs: the steps that can start — their steps before done or skipped, within the concurrency", () => {
  const p = plan();
  const st = initialState(p);
  assertEquals(readySteps(p, st), ["review", "lint"]);
  assertEquals(readySteps(plan({ concurrency: 1 }), st), ["review"]);
  st.steps.review.status = "running";
  assertEquals(readySteps(plan({ concurrency: 1 }), st), []);
  st.steps.review.status = "done";
  st.steps.lint.status = "failed";
  assertEquals(readySteps(p, st), []);
  st.steps.lint.status = "skipped";
  assertEquals(readySteps(p, st), ["fix"]);
  st.steps.fix.status = "done";
  assertEquals(readySteps(p, st), ["post"]);
  assert(!finished(st));
  st.steps.post.status = "done";
  assert(finished(st));
});

Deno.test("runs: a step's prompt — its task, the HANDOFFs to read, the team, where its own goes", () => {
  const p = plan({ tasks: ["TASK-1"] });
  const text = stepPrompt(p, p.steps[2], "run-1", (id) => `/h/${id}.md`);
  assert(text.startsWith("Fix it\n"));
  assertStringIncludes(text, '## You are step "fix" of the workflow "review and fix" (run run-1)');
  assertStringIncludes(text, "- review: /h/review.md\n- lint: /h/lint.md");
  assertStringIncludes(text, "- post (personal)");
  assertStringIncludes(text, "team_send");
  assertStringIncludes(text, "write your HANDOFF to /h/fix.md");
  assertStringIncludes(text, "TASK-1");
  const alone = stepPrompt(
    plan({ steps: [{ id: "solo", profile: "x", prompt: "Do" }] }),
    {
      id: "solo",
      profile: "x",
      prompt: "Do",
    },
    "r",
    () => "/h",
  );
  assert(!alone.includes("team_send") && !alone.includes("Read first"));
  assertEquals(teamLine("review", "found 2 bugs", true), "[team] from review to everyone: found 2 bugs");
  assertEquals(teamLine("review", "yours", false), "[team] from review: yours");
});

Deno.test("runs: ids, events for the owner, and a saved workflow's frontmatter", () => {
  assertEquals(runId("Review & Fix!", new Date("2026-10-09T15:30:00Z"), "ab12"), "review-fix-10091530-ab12");
  const e = { at: "", run: "r", step: "post", detail: "ready" };
  assertEquals(attentionOfEvent({ ...e, kind: "confirm" }), {
    id: "r",
    kind: "run-confirm",
    detail: "ready",
    run: "r",
    step: "post",
  });
  assertEquals(attentionOfEvent({ ...e, kind: "step" }), null);
  assertEquals(attentionOfEvent({ ...e, kind: "started" }), null);
  assertEquals(frontmatterOf('---\nname: review-pr\ndescription: "Review a PR"\n---\nbody'), {
    name: "review-pr",
    description: "Review a PR",
  });
  assertEquals(frontmatterOf("no frontmatter"), {});
});

Deno.test("runs: saved workflows — the project's first, then the owner's, the project's on a name in both", async () => {
  const project = await Deno.makeTempDir();
  const config = await Deno.makeTempDir();
  const skill = async (root: string, dir: string, body: string) => {
    await Deno.mkdir(`${root}/${dir}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${dir}/SKILL.md`, body);
  };
  await skill(`${project}/.agents/workflows`, "review", "---\nname: review\ndescription: the project's\n---\n");
  await skill(`${config}/workflows`, "review", "---\nname: review\ndescription: the owner's\n---\n");
  await skill(`${config}/workflows`, "deploy", "---\ndescription: ship it\n---\n");
  await Deno.mkdir(`${config}/workflows/empty`);
  const found = await savedWorkflows(project, config);
  assertEquals(found.map((w) => [w.name, w.description, w.scope]), [
    ["deploy", "ship it", "user"],
    ["review", "the project's", "project"],
  ]);
  await Deno.remove(project, { recursive: true });
  await Deno.remove(config, { recursive: true });
});

Deno.test("runs: a run's step to confirm reaches the owner, from its state and then from its events", async () => {
  const runs = await Deno.makeTempDir();
  const dir = `${runs}/runs/r-1`;
  await Deno.mkdir(dir, { recursive: true });
  const p = plan();
  const st = initialState(p);
  st.steps.post.status = "confirm";
  await Deno.writeTextFile(`${dir}/plan.json`, JSON.stringify(p));
  await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify(st));
  await Deno.writeTextFile(`${dir}/events.jsonl`, "");
  await Deno.writeTextFile(`${dir}/runner.pid`, String(Deno.pid)); // a runner at work: this test's process
  const stop = new AbortController();
  const it = follow(runs, 50, stop.signal);
  assertEquals((await it.next()).value, {
    id: "r-1",
    kind: "run-confirm",
    detail: "post is ready",
    run: "r-1",
    step: "post",
  });
  await Deno.writeTextFile(
    `${dir}/events.jsonl`,
    JSON.stringify({ at: "", kind: "failed", run: "r-1", step: "fix", detail: "fix: no HANDOFF" }) + "\n",
  );
  assertEquals((await it.next()).value?.kind, "run-failed");
  stop.abort();
  await it.return(undefined);
  await Deno.remove(runs, { recursive: true });
});

Deno.test("runs: a running run whose runner is gone reaches the owner once, with what the runner wrote", async () => {
  const runs = await Deno.makeTempDir();
  const dir = `${runs}/runs/r-2`;
  await Deno.mkdir(dir, { recursive: true });
  const p = plan();
  await Deno.writeTextFile(`${dir}/plan.json`, JSON.stringify(p));
  await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify(initialState(p)));
  await Deno.writeTextFile(`${dir}/events.jsonl`, "");
  await Deno.writeTextFile(`${dir}/err.log`, "bash: line 1: /nowhere/bin/agents: No such file or directory\n");
  const stop = new AbortController();
  const it = follow(runs, 20, stop.signal);
  const a = (await it.next()).value;
  assertEquals([a?.kind, a?.run, a?.step], ["run-failed", "r-2", undefined]);
  assertStringIncludes(a?.detail ?? "", "No such file or directory");
  // said once: the next news is something else
  await Deno.writeTextFile(
    `${dir}/events.jsonl`,
    JSON.stringify({ at: "", kind: "stopped", run: "r-2", detail: "stopped" }) + "\n",
  );
  assertEquals((await it.next()).value?.kind, "run-stopped");
  stop.abort();
  await it.return(undefined);
  await Deno.remove(runs, { recursive: true });
});
