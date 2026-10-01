// Tests for cli/ask.ts: what the console asks `claude -p`, and how its stream becomes the page's.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ancestry, askArgs, AskStream, asArg, promptFor, toolKind, TOOLS } from "../ask.ts";

Deno.test("askArgs: the tools are a fixed list per kind, and anything else is refused", () => {
  const a = askArgs("ask", "cosa ho domani?", "now");
  assertEquals(a.slice(0, 2), ["-p", "cosa ho domani?"]);
  assertEquals(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  assertEquals(a[a.indexOf("--tools") + 1], "");
  assertEquals(a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--append-system-prompt")), TOOLS.ask);
  assert(!askArgs("debrief", "debrief", "now").includes("mcp__google__gmail_search"));
  assert(!a.includes("--resume"));
  const b = askArgs("ask", "e dopo?", "now", { session: "s-1" });
  assertEquals(b.slice(-2), ["--resume", "s-1"]);
});

Deno.test("asArg: a leading dash is not read as an option", () => {
  assertEquals(asArg("-h vuol dire?"), " -h vuol dire?");
  assertEquals(asArg("ciao"), "ciao");
});

Deno.test("promptFor: a new task names its project, or says there is none", () => {
  assert(promptFor("newtask", "now", "work/acme/site").includes('"work/acme/site"'));
  assert(promptFor("newtask", "now", null).includes("no project"));
  assert(promptFor("ask", "now").includes("[[code:PATH]]"));
});

Deno.test("AskStream: deltas when streamed, the message otherwise, the result as a last resort", () => {
  const s = new AskStream();
  const out = [
    ...s.line(JSON.stringify({ type: "system", session_id: "abc" })),
    ...s.line(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Domani " } } })),
    ...s.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__tasks__tasks_brief" }] } })),
    ...s.line(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "niente.\n[[code:~/work/x]]" } } })),
    ...s.line("not json"),
  ];
  assertEquals(out[0], { t: "session", id: "abc" });
  assert(out.some((o) => o.t === "tool" && o.k === "tasks"));
  assertEquals(s.end(0, ""), { t: "done", text: "Domani \n\nniente.", code: "~/work/x" });

  const r = new AskStream();
  r.line(JSON.stringify({ type: "result", result: "solo il risultato" }));
  assertEquals(r.end(0, "").text, "solo il risultato");

  const f = new AskStream();
  assertEquals(f.end(1, "warning\nError: not logged in\n"), { t: "done", text: "", code: null, error: "Error: not logged in" });
});

Deno.test("toolKind: a tool's name to what the page says Claude is doing", () => {
  assertEquals(toolKind("mcp__google__calendar_events"), "calendar");
  assertEquals(toolKind("mcp__google__gmail_thread"), "mail");
  assertEquals(toolKind("mcp__wiki-claude__read_note"), "wiki");
  assertEquals(toolKind("Bash"), "work");
});

Deno.test("ancestry: up the parents to init, never in a loop", () => {
  const parents: Record<number, number> = { 900: 800, 800: 50, 50: 1 };
  assertEquals(ancestry(900, (p) => parents[p] ?? null), [900, 800, 50]);
  assertEquals(ancestry(7, () => 7).length, 64);
});
