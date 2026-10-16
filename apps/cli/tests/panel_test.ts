// panel_test.ts — the agents panel (shared/mcp/lib/panel.ts, shared/mcp/agents/panel-tools.ts, panel.html):
// the snapshot it shows, the summary the model reads, and the page held to its rules (no CDN, no HTML from
// data, only the tools it may call). One test starts the agents server and reads the panel through MCP.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { Child, ChildState } from "../../../shared/mcp/lib/agents.ts";
import type { Run } from "../../../shared/mcp/lib/runs.ts";
import {
  busy,
  PANEL_MIME,
  PANEL_URI,
  panelChild,
  panelLimit,
  panelRequests,
  panelRun,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
  snapshotOf,
  summaryOf,
} from "../../../shared/mcp/lib/panel.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

const state = (s: Partial<ChildState> = {}): ChildState => ({
  phase: "idle",
  session: null,
  pending: [],
  said: [],
  turns: 0,
  lastResult: null,
  error: null,
  costUsd: 0,
  ...s,
});

const child = (id: string, s: Partial<ChildState> = {}, extra: Partial<Child> = {}): Child => ({
  meta: {
    id,
    profile: "work",
    command: "claude-work",
    dir: "/home/x/p",
    task: "do it",
    started: "2026-10-16T10:00:00Z",
    project: "/home/x/p",
  },
  state: state(s),
  access: "own",
  ...extra,
});

const run = (id: string, steps: Record<string, string>, extra: Partial<Run> = {}): Run => ({
  id,
  plan: { name: "fix", steps: Object.keys(steps).map((k) => ({ id: k, profile: "work", prompt: "p" })) },
  state: {
    status: "running",
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { status: v, attempt: 1 }])),
    control: 0,
    heard: {},
  } as Run["state"],
  alive: true,
  ...extra,
});

Deno.test("panelChild: phase, the last three things said, the run it is a step of, orphan marked", () => {
  const c = child("c1", { phase: "working", said: ["a", "b", "c", "d"], lastResult: "x".repeat(500) }, {
    access: "orphan",
  });
  c.meta.run = { id: "r1", step: "build" };
  const p = panelChild(c);
  assertEquals(p.tail, ["b", "c", "d"]);
  assertEquals(p.orphan, true);
  assertEquals(p.run, { id: "r1", step: "build" });
  assertEquals(p.last!.length, 400);
  assertEquals(p.provider, "claude");
  assertEquals(panelChild(child("c2", { error: "boom", lastResult: "ok" })).last, "boom");
  assertEquals("orphan" in panelChild(child("c3")), false);
});

Deno.test("panelRequests: a request with its session rule, a question with its questions, exact `what`", () => {
  const q = [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }];
  const c = child("c1", {
    phase: "waiting",
    pending: [
      {
        request: "r1",
        kind: "request",
        tool: "Bash",
        what: "rm -rf <b>x</b>",
        input: {},
        session: "Bash(rm:*)",
        at: 1,
      },
      {
        request: "r2",
        kind: "question",
        tool: "AskUserQuestion",
        what: "Which?",
        input: {},
        session: "",
        questions: q,
        at: 2,
      },
    ],
  });
  const [a, b] = panelRequests(c);
  assertEquals(a, {
    id: "r1",
    child: "c1",
    profile: "work",
    kind: "request",
    what: "rm -rf <b>x</b>",
    session: "Bash(rm:*)",
  });
  assertEquals(b.questions, q);
  assertEquals(b.kind, "question");
  assertEquals(panelRequests({ ...c, access: "orphan" })[0].orphan, true);
});

Deno.test("panelRun: the step that needs the owner first, a stalled runner, steps in plan order", () => {
  const r = panelRun(run("r1", { a: "done", b: "running", c: "confirm", d: "waiting" }));
  assertEquals(r.step, "c");
  assertEquals(r.confirm, "c");
  assertEquals(r.steps.map((s) => s.id), ["a", "b", "c", "d"]);
  assertEquals(r.stalled, undefined);
  const f = panelRun(run("r2", { a: "failed", b: "waiting" }, { alive: false }));
  assertEquals([f.step, f.failed, f.stalled], ["a", "a", true]);
  const over = run("r3", { a: "done" }, { alive: false });
  over.state.status = "done";
  assertEquals(panelRun(over).stalled, undefined);
  assertEquals(panelRun(over).step, null);
});

Deno.test("panelLimit: windows with name, rounded use and reset", () => {
  assertEquals(
    panelLimit({
      account: { id: "work/claude", profile: "work", provider: "claude" },
      windows: [{ window: "5h", usedPercent: 41.6, resetsAt: 100, source: "statusline", at: 1 }],
    }),
    { profile: "work", provider: "claude", windows: [{ name: "5h", used: 42, resets: 100 }] },
  );
});

Deno.test("snapshotOf: requests from every child, 2 s while busy, 15 s idle, stale only when something was not read", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const idle = snapshotOf({ children: [child("c1")], runs: [], limits: [] }, now);
  assertEquals(idle.poll, POLL_IDLE_MS);
  assertEquals(idle.at, "2026-10-16T12:00:00.000Z");
  assertEquals("stale" in idle, false);
  const waiting = child("c2", {
    phase: "waiting",
    pending: [{ request: "r1", kind: "request", tool: "Bash", what: "ls", input: {}, session: "", at: 1 }],
  });
  const s = snapshotOf({ children: [child("c1"), waiting], runs: [], limits: [], stale: ["limits"] }, now);
  assertEquals(s.requests.map((r) => r.id), ["r1"]);
  assertEquals(s.poll, POLL_BUSY_MS);
  assertEquals(s.stale, ["limits"]);
  assert(busy({ children: [], requests: [], runs: [panelRun(run("r", { a: "running" }))] }));
  assert(!busy({ children: [panelChild(child("x", { phase: "ended" }))], requests: [], runs: [] }));
});

Deno.test("summaryOf: counts, what waits, a run that needs the owner", () => {
  const waiting = child("c2", {
    phase: "waiting",
    pending: [{ request: "r1", kind: "request", tool: "Bash", what: "git push", input: {}, session: "", at: 1 }],
  });
  const text = summaryOf(snapshotOf({
    children: [waiting],
    runs: [run("run1", { a: "confirm" })],
    limits: [],
    stale: ["limits"],
  }));
  assertStringIncludes(text, "1 child (0 working), 1 run (1 running), 1 request waiting.");
  assertStringIncludes(text, "c2 (work) wants: git push");
  assertStringIncludes(text, "run run1: step a waits for a go");
  assertStringIncludes(text, "(not read: limits)");
});

Deno.test("panel.html: self-contained, never HTML from data, only the tools it may call", async () => {
  const html = await Deno.readTextFile(`${ROOT}shared/mcp/agents/panel/panel.html`);
  assertEquals(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(html), false);
  assertEquals(/<(script|link|img|iframe)[^>]+(src|href)=/i.test(html), false, "no external resource");
  assertEquals(/https?:\/\//.test(html), false, "no URL at all");
  const called = new Set([...html.matchAll(/call\("([a-z_]+)"/g)].map((m) => m[1]));
  assertEquals(
    [...called].sort(),
    ["agent_answer", "agent_stop", "agents_panel_state", "workflow_answer", "workflow_status"],
  );
});

/** One JSON-RPC line as MCP's stdio transport frames it. */
const frame = (id: number, method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

Deno.test("agents server: the panel's tools point at its resource, which is the page", async () => {
  const home = await Deno.makeTempDir();
  const proc = new Deno.Command("deno", {
    args: [
      "run",
      "--quiet",
      "-A",
      "--no-config",
      `--lock=${ROOT}shared/mcp/agents/deno.lock`,
      `${ROOT}shared/mcp/agents/server.ts`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
    env: { HOME: home, XDG_STATE_HOME: `${home}/state`, AGENTS_MULTI_CONFIG: `${home}/config` },
    cwd: home,
  }).spawn();
  const w = proc.stdin.getWriter();
  await w.write(new TextEncoder().encode(
    frame(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    }) +
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" +
      frame(2, "tools/list") + frame(3, "resources/read", { uri: PANEL_URI }) +
      frame(4, "tools/call", { name: "agents_panel", arguments: {} }),
  ));
  const got = new Map<number, Record<string, unknown>>();
  let buf = "";
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) if (l.trim()) got.set(JSON.parse(l).id, JSON.parse(l));
      if (got.has(2) && got.has(3) && got.has(4)) break;
    }
  } finally {
    clearTimeout(timer);
    await w.close().catch(() => {});
    proc.kill();
    await proc.status;
    await Deno.remove(home, { recursive: true });
  }
  type Tool = { name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } };
  const tools = (got.get(2)!.result as { tools: Tool[] }).tools;
  const panel = tools.find((t) => t.name === "agents_panel")!;
  const state = tools.find((t) => t.name === "agents_panel_state")!;
  assertEquals(panel._meta?.ui?.resourceUri, PANEL_URI);
  assertEquals(state._meta?.ui?.visibility, ["app"]);
  const read = got.get(3)!.result as { contents: { mimeType: string; text: string }[] };
  assertEquals(read.contents[0].mimeType, PANEL_MIME);
  assertStringIncludes(read.contents[0].text, "ui/initialize");
  const call = got.get(4)!.result as { content: { text: string }[]; structuredContent: { children: unknown[] } };
  assertStringIncludes(call.content[0].text, "0 children (0 working)");
  assertEquals(call.structuredContent.children, []);
});
