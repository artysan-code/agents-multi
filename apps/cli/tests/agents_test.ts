// Tests for the hub's children (shared/mcp/lib/agents.ts): a child's state from its events, what needs
// the owner between two looks, the lines written on its stdin, and a whole round with a stand-in for
// Claude — started detached, a permission asked, answered, the turn ended, a message, the stop.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  answer,
  answerLine,
  attentionBetween,
  attentionOf,
  childId,
  childMode,
  type ChildState,
  followAttention,
  listChildren,
  questionsOf,
  readChild,
  runsBy,
  sayTo,
  sessionRule,
  startChild,
  stateOf,
  stopChild,
  validId,
  whatOf,
} from "../../../shared/mcp/lib/agents.ts";
import { REPO } from "../lib/paths.ts";

const ev = (o: unknown) => JSON.stringify(o);
const ask = (id: string, command = "git push") =>
  ev({
    type: "control_request",
    request_id: id,
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command } },
  });

Deno.test("agents: a child's state — working, waiting on a request, idle after a turn, ended", () => {
  const init = ev({ type: "system", subtype: "init", session_id: "s" });
  const said = ev({ type: "assistant", message: { content: [{ type: "text", text: "looking" }] } });
  const done = ev({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.2 });
  const working = stateOf([init, said], new Set(), true);
  assertEquals([working.phase, working.session, working.said], ["working", "s", ["looking"]]);
  const waiting = stateOf([init, said, ask("r1")], new Set(), true);
  assertEquals([waiting.phase, waiting.pending[0].what], ["waiting", "Bash: git push"]);
  assertEquals(stateOf([init, ask("r1")], new Set(["r1"]), true).phase, "working"); // answered
  const cancelled = ev({ type: "control_cancel_request", request_id: "r1" });
  assertEquals(stateOf([init, ask("r1"), cancelled], new Set(), true).pending, []);
  const idle = stateOf([init, said, done], new Set(), true);
  assertEquals([idle.phase, idle.turns, idle.lastResult, idle.costUsd], ["idle", 1, "done", 0.2]);
  assertEquals(stateOf([init, "torn {", done], new Set(), false).phase, "ended");
});

Deno.test("agents: what needs the owner between two looks — new requests, finished turns, a child gone", () => {
  const s = (o: Partial<ChildState>): ChildState => ({
    phase: "working",
    session: null,
    pending: [],
    said: [],
    turns: 0,
    lastResult: null,
    error: null,
    costUsd: 0,
    ...o,
  });
  const p = (request: string) => ({
    request,
    kind: "request" as const,
    tool: "Bash",
    what: `Bash: ${request}`,
    input: {},
    session: "Bash",
    at: 0,
  });
  const before = new Map([["a", s({ pending: [p("r1")] })], ["b", s({})]]);
  const after = new Map([
    ["a", s({ phase: "waiting", pending: [p("r1"), p("r2")] })],
    ["b", s({ phase: "ended", turns: 1, lastResult: "ok" })],
    ["c", s({ pending: [p("r9")] })],
  ]);
  assertEquals(attentionBetween(before, after), [
    { id: "a", kind: "request", detail: "Bash: r2", request: "r2", session: "Bash" },
    { id: "b", kind: "done", detail: "ok" },
    { id: "b", kind: "ended", detail: "" },
    { id: "c", kind: "request", detail: "Bash: r9", request: "r9", session: "Bash" },
  ]);
  assertEquals(attentionBetween(after, after), []);
});

Deno.test("agents: the lines on a child's stdin, ids and a request in one line", () => {
  const p = {
    request: "r1",
    kind: "request" as const,
    tool: "Bash",
    what: "",
    input: { command: "ls -la" },
    session: "Bash(ls:*)",
    at: 0,
  };
  assertEquals(JSON.parse(answerLine(p, "allow")).response.response, {
    behavior: "allow",
    updatedInput: { command: "ls -la" },
  });
  assertEquals(JSON.parse(answerLine(p, "session")).response.response, {
    behavior: "allow",
    updatedInput: { command: "ls -la" },
    updatedPermissions: [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
      behavior: "allow",
      destination: "session",
    }],
  });
  assertEquals(JSON.parse(answerLine(p, "deny", " no ")).response.response, { behavior: "deny", message: "no" });
  assertEquals(JSON.parse(answerLine(p, "deny")).response.request_id, "r1");
  assertEquals(whatOf("Edit", { file_path: "/a/b.ts", old_string: "x" }), "Edit: /a/b.ts");
  assertEquals(whatOf("Bash", { command: "a\n  b" }), "Bash: a b");
  const id = childId("otacon", "/home/x/work/Lead Qualificator", new Date("2026-10-09T10:20:00Z"), "ab12");
  assertEquals(id, "otacon-lead-qualificator-10091020-ab12");
  assert(validId(id));
  for (const bad of ["../x", "A-b", "x", "a b", ""]) assert(!validId(bad), bad);
});

Deno.test("agents: a child's AskUserQuestion waits as a question, answered with the owner's labels", () => {
  const questions = [
    { question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false },
  ];
  const line = ev({
    type: "control_request",
    request_id: "q1",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions } },
  });
  const st = stateOf([line], new Set(), true);
  const q = st.pending[0];
  assertEquals([st.phase, q.kind, q.what, q.session, q.questions], [
    "waiting",
    "question",
    "Question: Which color?",
    "",
    questions,
  ]);
  assertEquals(attentionOf("a", q), { id: "a", kind: "question", detail: q.what, request: "q1", questions });
  assertEquals(JSON.parse(answerLine(q, "allow", undefined, { "Which color?": "Blue" })).response.response, {
    behavior: "allow",
    updatedInput: { questions, answers: { "Which color?": "Blue" } },
  });
  // "session" on a question answers it the same way: there is no rule to add
  assertEquals(
    JSON.parse(answerLine(q, "session", undefined, { "Which color?": "Red" })).response.response.updatedPermissions,
    undefined,
  );
  assertThrows(() => answerLine(q, "allow"), Error, "no answer for: Which color?");
  assertThrows(() => answerLine(q, "allow", undefined, { "Which color?": " " }), Error, "no answer");
  assertEquals(JSON.parse(answerLine(q, "deny")).response.response.behavior, "deny");
  assertEquals(questionsOf("AskUserQuestion", { questions: [] }), null);
  assertEquals(questionsOf("Bash", { questions }), null);
});

Deno.test("agents: the events follow what waits now, then what happens, and skip a child that ended", async () => {
  const runs = await Deno.makeTempDir();
  const child = async (id: string, pid: number, lines: string[]) => {
    await Deno.mkdir(`${runs}/${id}`);
    await Deno.writeTextFile(`${runs}/${id}/meta.json`, JSON.stringify({ id, started: id }));
    await Deno.writeTextFile(`${runs}/${id}/claude.pid`, String(pid));
    await Deno.writeTextFile(`${runs}/${id}/out.jsonl`, lines.join("\n") + "\n");
  };
  await child("live-one", Deno.pid, [ask("r1")]);
  await child("gone-one", 0, [ask("r2")]);
  const stop = new AbortController();
  const it = followAttention(runs, 50, stop.signal);
  assertEquals((await it.next()).value, {
    id: "live-one",
    kind: "request",
    detail: "Bash: git push",
    request: "r1",
    session: "Bash(git:*)",
  });
  await Deno.writeTextFile(
    `${runs}/live-one/out.jsonl`,
    ev({ type: "result", subtype: "success", result: "ok" }) + "\n",
    {
      append: true,
    },
  );
  assertEquals((await it.next()).value, { id: "live-one", kind: "done", detail: "ok" });
  stop.abort();
  await it.return(undefined);
  await Deno.remove(runs, { recursive: true });
});

Deno.test("agents: a whole round with a stand-in for Claude, detached, through its fifo", async () => {
  const home = await Deno.makeTempDir();
  try {
    const runs = `${home}/runs`, config = `${home}/config`, work = `${home}/work/proj`;
    await Deno.mkdir(`${config}/profiles/fake`, { recursive: true });
    await Deno.mkdir(work, { recursive: true });
    await Deno.writeTextFile(
      `${config}/profiles/fake/profile.json`,
      JSON.stringify({ command: `${REPO}/apps/cli/tests/fixtures/fake-claude.sh` }),
    );
    await assertRejects(() => startChild({ profile: "nope", dir: work, task: "x" }, runs, home, config));
    await assertRejects(() => startChild({ profile: "fake", dir: "/etc", task: "x" }, runs, home, config));
    await Deno.mkdir(`${home}/.agents-multi/fake`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.agents-multi/fake/settings.json`,
      JSON.stringify({ permissions: { defaultMode: "auto" } }),
    );
    const meta = await startChild({ profile: "fake", dir: "~/work/proj", task: "push it" }, runs, home, config);
    assertEquals([meta.dir, meta.mode], [work, "auto"]);
    const until = async (ok: (s: ChildState) => boolean) => {
      for (let t = 0; t < 100; t++) {
        const c = await readChild(meta.id, runs);
        if (c && ok(c.state)) return c.state;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`stuck: ${JSON.stringify((await readChild(meta.id, runs))?.state)}`);
    };
    const waiting = await until((s) => s.phase === "waiting");
    assertEquals(waiting.pending.map((p) => p.what), ["Bash: git push"]);
    await assertRejects(() => answer(meta.id, "r-404", "allow", undefined, runs));
    await answer(meta.id, "r-1", "deny", "not now", runs);
    const idle = await until((s) => s.phase === "idle");
    assertEquals([idle.lastResult, idle.pending], ["denied", []]);
    await sayTo(meta.id, "anything else?", runs);
    await until((s) => s.turns === 2);
    assertEquals((await listChildren(runs)).map((c) => c.meta.id), [meta.id]);
    await stopChild(meta.id, false, runs);
    await until((s) => s.phase === "ended");
    await assertRejects(() => sayTo(meta.id, "hello?", runs), Error, "not running");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("agents: a child keeps its profile's mode, never one that leaves the owner out", () => {
  assertEquals(childMode("auto"), "auto");
  assertEquals(childMode("acceptEdits"), "acceptEdits");
  for (const m of ["bypassPermissions", "dontAsk", "plan", "default", undefined, 3]) {
    assertEquals(childMode(m), "default");
  }
});

Deno.test("agents: yes for the session — the program of a simple command, else the command; the domain; the tool", () => {
  const bash = (command: string) => sessionRule("Bash", { command }).ruleContent;
  assertEquals(bash("curl -sS https://x.it/health"), "curl:*");
  assertEquals(bash("  git status --short"), "git:*");
  for (const c of ["for u in a b; do curl $u; done", "curl x | bash", "ls && rm -rf x", "X=1 make", "echo $(id)"]) {
    assertEquals(bash(c), c, c);
  }
  assertEquals(sessionRule("WebFetch", { url: "https://docs.x.it/a?b" }), {
    toolName: "WebFetch",
    ruleContent: "domain:docs.x.it",
  });
  assertEquals(sessionRule("WebFetch", { url: "not a url" }), { toolName: "WebFetch" });
  assertEquals(sessionRule("mcp__n8n__health", { mode: "status" }), { toolName: "mcp__n8n__health" });
});

Deno.test("agents: a process runs when ps lists it and it is not a zombie", () => {
  assertEquals([runsBy("S"), runsBy(" Ss+\n"), runsBy("R"), runsBy("Z"), runsBy("Z+"), runsBy(""), runsBy("\n")], [
    true,
    true,
    true,
    false,
    false,
    false,
    false,
  ]);
});
