// Tests for the hub's children (shared/mcp/lib/agents.ts): a child's state from its events, what needs
// the owner between two looks, the lines written on its stdin, and a whole round with a stand-in for
// Claude — started detached, a permission asked, answered, the turn ended, a message, the stop.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  answer,
  answerLine,
  attentionBetween,
  childId,
  type ChildState,
  listChildren,
  readChild,
  sayTo,
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
  const p = (request: string) => ({ request, tool: "Bash", what: `Bash: ${request}`, input: {}, at: 0 });
  const before = new Map([["a", s({ pending: [p("r1")] })], ["b", s({})]]);
  const after = new Map([
    ["a", s({ phase: "waiting", pending: [p("r1"), p("r2")] })],
    ["b", s({ phase: "ended", turns: 1, lastResult: "ok" })],
    ["c", s({ pending: [p("r9")] })],
  ]);
  assertEquals(attentionBetween(before, after), [
    { id: "a", kind: "request", detail: "Bash: r2" },
    { id: "b", kind: "done", detail: "ok" },
    { id: "b", kind: "ended", detail: "" },
    { id: "c", kind: "request", detail: "Bash: r9" },
  ]);
  assertEquals(attentionBetween(after, after), []);
});

Deno.test("agents: the lines on a child's stdin, ids and a request in one line", () => {
  const p = { request: "r1", tool: "Bash", what: "", input: { command: "ls" }, at: 0 };
  assertEquals(JSON.parse(answerLine(p, true)).response.response, {
    behavior: "allow",
    updatedInput: { command: "ls" },
  });
  assertEquals(JSON.parse(answerLine(p, false, " no ")).response.response, { behavior: "deny", message: "no" });
  assertEquals(JSON.parse(answerLine(p, false)).response.request_id, "r1");
  assertEquals(whatOf("Edit", { file_path: "/a/b.ts", old_string: "x" }), "Edit: /a/b.ts");
  assertEquals(whatOf("Bash", { command: "a\n  b" }), "Bash: a b");
  const id = childId("otacon", "/home/x/work/Lead Qualificator", new Date("2026-10-09T10:20:00Z"), "ab12");
  assertEquals(id, "otacon-lead-qualificator-10091020-ab12");
  assert(validId(id));
  for (const bad of ["../x", "A-b", "x", "a b", ""]) assert(!validId(bad), bad);
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
    const meta = await startChild({ profile: "fake", dir: "~/work/proj", task: "push it" }, runs, home, config);
    assertEquals(meta.dir, work);
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
    await assertRejects(() => answer(meta.id, "r-404", true, undefined, runs));
    await answer(meta.id, "r-1", false, "not now", runs);
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
