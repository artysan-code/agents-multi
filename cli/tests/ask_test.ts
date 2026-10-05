// Tests for cli/ask.ts: what the console asks `claude -p`, and how its stream becomes the page's.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ancestry, askArgs, AskStream, asArg, promptFor, sessionEnv, toolKind, TOOLS } from "../ask.ts";

Deno.test("askArgs: the tools are a fixed list per kind, and anything else is refused", () => {
  const a = askArgs("ask", "cosa ho domani?", "now");
  assertEquals(a.slice(0, 2), ["-p", "cosa ho domani?"]);
  assertEquals(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  assertEquals(a[a.indexOf("--tools") + 1], "");
  assertEquals(a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--append-system-prompt")), TOOLS.ask);
  assert(!askArgs("debrief", "debrief", "now").includes("mcp__google__gmail_search"));
  assert(!a.includes("--resume"));
  // a change from the Brain page writes only in the brain, and never deletes
  assert(TOOLS.brain.every((t) => t.startsWith("mcp__claude_ai_Brain__brain_") || /^Read\(\/\/.+\/\*\*\)$/.test(t)));
  const c = askArgs("brain", "porta nel brain", "now");
  assertEquals(c[c.indexOf("--tools") + 1], "Read");
  assert(TOOLS.brain.includes("mcp__claude_ai_Brain__brain_edit"));
  assert(!TOOLS.brain.includes("mcp__claude_ai_Brain__brain_delete"));
  const b = askArgs("ask", "e dopo?", "now", { session: "s-1" });
  assertEquals(b.slice(-2), ["--resume", "s-1"]);
});

Deno.test("asArg: a leading dash is not read as an option", () => {
  assertEquals(asArg("-h vuol dire?"), " -h vuol dire?");
  assertEquals(asArg("ciao"), "ciao");
});

Deno.test("promptFor: a new task names its project, says there is none, or leaves it to Claude", () => {
  assert(promptFor("newtask", "now", "work/acme/site").includes('"work/acme/site"'));
  assert(promptFor("newtask", "now", null, true).includes("no project (a simple thing to do)"));
  assert(promptFor("newtask", "now", null).includes("work out from what they say"));
  assert(promptFor("ask", "now").includes("[[code:PATH]]"));
  assert(promptFor("brain", "now", "progetti/claude-multi.md").includes("progetti/claude-multi.md"));
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

  // an error the CLI reports as its result (and exit 0) is an error, not the answer
  const e = new AskStream();
  e.line(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired" }));
  assertEquals(e.end(0, ""), { t: "done", text: "", code: null, error: "Failed to authenticate: OAuth session expired" });

  const f = new AskStream();
  assertEquals(f.end(1, "warning\nError: not logged in\n"), { t: "done", text: "", code: null, error: "Error: not logged in" });
});

Deno.test("toolKind: a tool's name to what the page says Claude is doing", () => {
  assertEquals(toolKind("mcp__google__calendar_events"), "calendar");
  assertEquals(toolKind("mcp__google__gmail_thread"), "mail");
  assertEquals(toolKind("mcp__claude_ai_Brain__brain_read"), "brain");
  assertEquals(toolKind("Bash"), "work");
});

Deno.test("ancestry: up the parents to init, never in a loop", () => {
  const parents: Record<number, number> = { 900: 800, 800: 50, 50: 1 };
  assertEquals(ancestry(900, (p) => parents[p] ?? null), [900, 800, 50]);
  assertEquals(ancestry(7, () => 7).length, 64);
});

Deno.test("sessionEnv: the graphical session's variables, unquoted; everything else left out", () => {
  const text = [
    "HOME=/home/u",
    "DISPLAY=:0",
    "WAYLAND_DISPLAY=wayland-0",
    "XDG_CURRENT_DESKTOP=KDE",
    "XAUTHORITY=$'/run/user/1000/xauth_ab cd'",
    "PATH=/usr/bin",
    "",
  ].join("\n");
  assertEquals(sessionEnv(text), { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE", XAUTHORITY: "/run/user/1000/xauth_ab cd" });
  assertEquals(sessionEnv(""), {});
});

Deno.test("askArgs: the chosen model goes with every request but the debrief, which keeps the profile's", () => {
  const ask = askArgs("ask", "ciao", "now", { model: "haiku" });
  assertEquals(ask.slice(ask.indexOf("--model"), ask.indexOf("--model") + 2), ["--model", "haiku"]);
  assertEquals(askArgs("debrief", "debrief", "now", { model: "opus" }).includes("--model"), false);
  assertEquals(askArgs("ask", "ciao", "now").includes("--model"), false);
});
