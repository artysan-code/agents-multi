// Tests for apps/cli/node/turns.ts (ADR 0014, G1): the batching of events, the prompt with history, the
// headless environment, and the loop against a fake service with an injected runner.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { askArgs, withHistory } from "../ask.ts";
import {
  answerTurn,
  batcher,
  type Claimed,
  coalesce,
  headlessTurnEnv,
  type Piece,
  type Runner,
  turnLoop,
} from "../node/turns.ts";
import type { Service } from "../node/service.ts";
import type { NodeConfig } from "../../../shared/mcp/lib/headless.ts";

const on: NodeConfig = { enabled: true, headless: false, repoRoots: ["~"], allowedDomains: [], repos: [] };
const text = (d: string): Piece => ({ t: "text", d });

Deno.test("coalesce: neighbouring text pieces join, tools and sessions stay in order", () => {
  const tool: Piece = { t: "tool", k: "tasks", n: "tasks_add", d: "x" };
  assertEquals(coalesce([text("a"), text("b"), tool, text("c"), { t: "session", id: "s" }, text("d")]), [
    text("ab"),
    tool,
    text("c"),
    { t: "session", id: "s" },
    text("d"),
  ]);
});

Deno.test("batcher: one flush per window, in order, and the rest at close", async () => {
  const sent: Piece[][] = [];
  const b = batcher((e) => (sent.push(e), Promise.resolve()), 30);
  b.push(text("a"));
  b.push(text("b"));
  assertEquals(sent.length, 0); // nothing before the window ends
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(sent, [[text("ab")]]);
  b.push(text("c"));
  b.push({ t: "tool", k: "brain", n: "brain_append" });
  await b.close(); // no waiting for the timer
  assertEquals(sent.length, 2);
  assertEquals(sent[1], [text("c"), { t: "tool", k: "brain", n: "brain_append" }]);
  await b.close();
  assertEquals(sent.length, 2); // nothing left, nothing sent
});

Deno.test("batcher: a failed flush keeps its events for the next one", async () => {
  const sent: Piece[][] = [];
  let down = true;
  const b = batcher((e) => down ? Promise.reject(new Error("down")) : (sent.push(e), Promise.resolve()), 10);
  b.push(text("a"));
  await new Promise((r) => setTimeout(r, 40));
  down = false;
  b.push(text("b"));
  await b.close();
  assertEquals(sent, [[text("ab")]]);
});

Deno.test("withHistory: no session means the earlier turns come first, compactly; none means the text as is", () => {
  assertEquals(withHistory("ciao", []), "ciao");
  assertEquals(withHistory("ciao"), "ciao");
  const p = withHistory("e domani?", [{ q: "cosa ho oggi?", a: "Due cose." }, {
    q: "x".repeat(900),
    a: "y".repeat(2000),
  }]);
  assertStringIncludes(p, "Q: cosa ho oggi?\nA: Due cose.");
  assert(p.endsWith("e domani?"));
  assert(!p.includes("x".repeat(700)) && !p.includes("y".repeat(1300)));
  assertEquals(
    withHistory("a", Array.from({ length: 14 }, (_, i) => ({ q: `q${i}`, a: "" }))).includes("Q: q3\n"),
    false,
  );
});

Deno.test("askArgs: a headless turn carries its sandbox settings", () => {
  const a = askArgs("x", "now", { settings: { sandbox: { enabled: true } } });
  assertEquals(JSON.parse(a[a.indexOf("--settings") + 1]), { sandbox: { enabled: true } });
  assert(!askArgs("x", "now").includes("--settings"));
});

Deno.test("headlessTurnEnv: the scrub and the token on a server, nothing that outranks it, no Claude session's variables", () => {
  const base = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_AUTH_TOKEN: "t",
    CLAUDE_CONFIG_DIR: "/x",
    CLAUDECODE: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "old",
  };
  const e = headlessTurnEnv(base, { AM_HEADLESS: "1", AM_CLAUDE_TOKEN: "tok" });
  assertEquals(e, { PATH: "/bin", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  // a headless node with no token for the account: the scrub still applies
  assertEquals(headlessTurnEnv(base, { AM_HEADLESS: "1" }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  // a desktop: the environment is the machine's, minus the session's
  assertEquals(headlessTurnEnv(base, {}), { PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" });
});

type Call = { method: string; path: string; body?: unknown };
function fake(polls: Claimed[][], opts: { failPolls?: number } = {}) {
  const calls: Call[] = [];
  let failures = opts.failPolls ?? 0;
  const ctl = new AbortController();
  const svc: Service = {
    url: "https://svc",
    call<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      if (path.startsWith("/api/node/turns")) {
        if (failures-- > 0) return Promise.reject(new Error("GET: HTTP 502"));
        const turns = polls.shift();
        if (!turns) {
          ctl.abort();
          return Promise.resolve({ turns: [] } as T);
        }
        return Promise.resolve({ turns } as T);
      }
      return Promise.resolve({ ok: true } as T);
    },
  };
  return { svc, calls, ctl };
}

const turn = (id: string, x: Partial<Claimed> = {}): Claimed => ({
  id,
  chat: "c1",
  text: `q-${id}`,
  session: null,
  history: [],
  ...x,
});

Deno.test("turnLoop: claimed turns are answered one at a time, pieces batched, then done", async () => {
  const f = fake([[turn("t1", { session: "s0" }), turn("t2", { history: [{ q: "a", a: "b" }] })]]);
  const seen: { text: string; session: string | null | undefined; history: unknown }[] = [];
  const run: Runner = (t, o, onEvent) => {
    seen.push({ text: t, session: o.session, history: o.history });
    onEvent({ t: "session", id: "s1" });
    onEvent({ t: "text", d: "Ciao " });
    onEvent({ t: "text", d: "mondo" });
    onEvent({ t: "tool", k: "tasks", n: "tasks_add", d: "milk" });
    return Promise.resolve({ t: "done", text: "Ciao mondo", code: "~/work/x" });
  };
  await turnLoop({
    log: () => {},
    signal: f.ctl.signal,
    config: () => Promise.resolve(on),
    service: () => Promise.resolve(f.svc),
    run,
    sleep: () => Promise.resolve(),
    batchMs: 5,
  });
  assertEquals(seen.map((s) => [s.text, s.session]), [["q-t1", "s0"], ["q-t2", null]]);
  assertEquals(seen[1].history, [{ q: "a", a: "b" }]);
  const paths = f.calls.map((c) => `${c.method} ${c.path}`);
  assertEquals(paths[0], "GET /api/node/turns?wait=25&max=1");
  assertEquals(paths.filter((p) => p === "POST /api/turns/t1/done").length, 1);
  // t1 is entirely reported before t2 starts
  assert(paths.indexOf("POST /api/turns/t1/done") < paths.indexOf("POST /api/turns/t2/events"));
  const events = f.calls.find((c) => c.path === "/api/turns/t1/events")!.body as { events: Piece[] };
  assertEquals(events.events, [
    { t: "session", id: "s1" },
    { t: "text", d: "Ciao mondo" },
    { t: "tool", k: "tasks", n: "tasks_add", d: "milk" },
  ]);
  assertEquals(f.calls.find((c) => c.path === "/api/turns/t1/done")!.body, { text: "Ciao mondo", code: "~/work/x" });
});

Deno.test("turnLoop: a run that fails or cannot start ends its turn with the error", async () => {
  const f = fake([[turn("bad"), turn("worse")]]);
  const run: Runner = (t) =>
    t === "q-bad"
      ? Promise.resolve({ t: "done", text: "", code: null, error: "login expired" })
      : Promise.reject(new Error("no profile"));
  const logs: string[] = [];
  await turnLoop({
    log: (s) => logs.push(s),
    signal: f.ctl.signal,
    config: () => Promise.resolve(on),
    service: () => Promise.resolve(f.svc),
    run,
    sleep: () => Promise.resolve(),
    batchMs: 5,
  });
  const done = (id: string) => f.calls.find((c) => c.path === `/api/turns/${id}/done`)!.body;
  assertEquals(done("bad"), { text: "", error: "login expired" });
  assertEquals(done("worse"), { text: "", error: "no profile" });
  assert(logs.some((l) => l.includes("login expired")));
});

Deno.test("turnLoop: backs off while the service is down, says it once, and carries on", async () => {
  const f = fake([[turn("t1")]], { failPolls: 3 });
  const waits: number[] = [];
  const logs: string[] = [];
  await turnLoop({
    log: (s) => logs.push(s),
    signal: f.ctl.signal,
    config: () => Promise.resolve(on),
    service: () => Promise.resolve(f.svc),
    run: () => Promise.resolve({ t: "done", text: "ok", code: null }),
    sleep: (ms) => (waits.push(ms), Promise.resolve()),
    batchMs: 5,
  });
  assertEquals(waits.slice(0, 3), [2000, 4000, 8000]);
  assertEquals(logs.filter((l) => l.includes("HTTP 502")).length, 1);
  assert(f.calls.some((c) => c.path === "/api/turns/t1/done"));
});

Deno.test("turnLoop: a node that is off, or has no token, never polls", async () => {
  const ctl = new AbortController();
  let polled = 0, passes = 0;
  const svc: Service = { url: "u", call: () => (polled++, Promise.resolve({ turns: [] }) as never) };
  const logs: string[] = [];
  await turnLoop({
    log: (s) => logs.push(s),
    signal: ctl.signal,
    config: () => Promise.resolve(++passes < 3 ? { ...on, enabled: false } : on),
    service: () => Promise.resolve(passes > 3 ? svc : "this machine has no node token of its own"),
    run: () => Promise.resolve({ t: "done", text: "", code: null }),
    sleep: () => (passes >= 5 ? (ctl.abort(), Promise.resolve()) : Promise.resolve()),
  });
  assertEquals(polled > 0, true);
  assertEquals(logs.filter((l) => l.includes("no node token")).length, 1);
});

Deno.test("answerTurn: stopping the node does not report a turn it cannot finish", async () => {
  const f = fake([]);
  f.ctl.abort();
  const r = await answerTurn(
    f.svc,
    turn("t9"),
    () => Promise.resolve({ t: "done", text: "x", code: null }),
    f.ctl.signal,
    5,
  )
    .catch((e) => e as Error);
  assert(r instanceof Error);
  assert(!f.calls.some((c) => c.path.endsWith("/done")));
});

Deno.test("answerTurn: a silent run keeps its turn with empty batches, and a failure keeps what was said", async () => {
  const f = fake([]);
  const r = await answerTurn(
    f.svc,
    turn("t7"),
    (_t, _o, onEvent) => {
      onEvent({ t: "text", d: "half an answer" });
      // silent for longer than three heartbeats, then it breaks
      return new Promise((_, no) => setTimeout(() => no(new Error("claude exited")), 70));
    },
    new AbortController().signal,
    5,
    20,
  );
  assertEquals(r.error, "claude exited");
  const beats = f.calls.filter((c) =>
    c.path === "/api/turns/t7/events" && (c.body as { events: unknown[] }).events.length === 0
  );
  assert(beats.length >= 2, `heartbeats: ${beats.length}`);
  const done = f.calls.find((c) => c.path === "/api/turns/t7/done")!.body as { text: string; error: string };
  assertEquals(done, { text: "half an answer", error: "claude exited" });
});
