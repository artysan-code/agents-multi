// svc_chat_test.ts — the console's Chat on the service (apps/cli/svc-chat.ts, ADR 0014 G1b): the Server-Sent Events of
// the service mapped to the NDJSON the page reads, the pin of a question to this machine, the chats as the page keeps
// them, and the fall back to the local chats when the service is not there.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  chatOf,
  DOWN_MS,
  endedTurn,
  headOf,
  isLocalChat,
  relay,
  ServiceChats,
  SseParser,
  type SvcTurn,
} from "../svc-chat.ts";
import type { Service } from "../node/service.ts";

const T = "u-1";
const turn = (x: Partial<SvcTurn> = {}): SvcTurn => ({
  id: T,
  q: "hello",
  a: "",
  acts: [],
  state: "waiting",
  node: null,
  error: null,
  created: "2026-10-15T10:00:00Z",
  ended: null,
  ...x,
});

Deno.test("sse: events across chunks, comments and bad data dropped", () => {
  const p = new SseParser();
  assertEquals(p.push(': connected\n\nevent: turn\ndata: {"turn":"u-1","sta'), []);
  assertEquals(p.push('te":"running"}\n\n: \n\nevent: text\r\ndata: {"turn":"u-1","d":"Ciao"}\r\n\r\n'), [
    { event: "turn", data: { turn: "u-1", state: "running" } },
    { event: "text", data: { turn: "u-1", d: "Ciao" } },
  ]);
  assertEquals(p.push('event: text\ndata: not json\n\ndata: [1]\n\nevent: done\ndata: {"turn":"u-1"}\n\n'), [
    { event: "done", data: { turn: "u-1" } },
  ]);
});

Deno.test("relay: the service's events become the lines the page reads", () => {
  const ev = (event: string, data: Record<string, unknown>) => ({ event, data: { turn: T, ...data } });
  assertEquals(relay(ev("text", { d: "Oggi " }), T), { out: [{ t: "text", d: "Oggi " }], end: false });
  assertEquals(relay(ev("act", { k: "tasks", n: "tasks_add", d: "Call Ann" }), T), {
    out: [{ t: "tool", k: "tasks", n: "tasks_add", d: "Call Ann" }],
    end: false,
  });
  assertEquals(relay(ev("act", { k: "brain", n: "brain_read" }), T).out, [{ t: "tool", k: "brain", n: "brain_read" }]);
  assertEquals(relay(ev("done", { a: "Fatto.", code: "~/work/x" }), T), {
    out: [{ t: "done", text: "Fatto.", code: "~/work/x" }],
    end: true,
  });
  // a number is an exit code, not a folder; the page wants a folder or null
  assertEquals(relay(ev("done", { a: "ok", code: 0 }), T).out, [{ t: "done", text: "ok", code: null }]);
  assertEquals(relay(ev("turn", { state: "failed", error: "no login" }), T), {
    out: [{ t: "done", text: "", code: null, error: "no login" }],
    end: true,
  });
  assertEquals(relay(ev("turn", { state: "running", node: "desk" }), T), { out: [], end: false });
  // another turn of the chat (the phone asking meanwhile) says nothing here
  assertEquals(relay({ event: "text", data: { turn: "u-2", d: "x" } }, T), { out: [], end: false });
  assertEquals(relay({ event: "done", data: { turn: "u-2", a: "x" } }, T), { out: [], end: false });
});

Deno.test("endedTurn: a turn over before the stream opened is read from the chat", () => {
  assertEquals(endedTurn(turn({ state: "done", a: "Ecco", code: "~/p" })), { t: "done", text: "Ecco", code: "~/p" });
  assertEquals(endedTurn(turn({ state: "failed", error: "boom" })), { t: "done", text: "", code: null, error: "boom" });
  assertEquals(endedTurn(turn({ state: "running" })), null);
  assertEquals(endedTurn(undefined), null);
});

Deno.test("chats: the service's rows and turns as the page keeps them", () => {
  assert(isLocalChat("0b8f5c1e-3a4d-4c2b-9e7f-1a2b3c4d5e6f"));
  assert(!isLocalChat("c-8f2a"));
  assertEquals(headOf({ id: "c-1", title: "T", updated: "u", node: "desk", turns: 3 }), {
    id: "c-1",
    title: "T",
    updated: "u",
    turns: 3,
  });
  assertEquals(headOf({ id: "c-1", title: "T", updated: "u", node: null }).turns, 0);
  const c = chatOf({
    id: "c-1",
    title: "T",
    turns: [
      turn({
        id: "a",
        state: "done",
        a: "A",
        ended: "2026-10-15T10:01:00Z",
        code: "~/x",
        acts: [{ k: "tasks", n: "tasks_add" }],
      }),
      turn({
        id: "b",
        q: "again",
        state: "failed",
        error: "no",
        created: "2026-10-15T11:00:00Z",
        ended: "2026-10-15T11:00:05Z",
      }),
    ],
  });
  assertEquals([c.id, c.session, c.created, c.updated], ["c-1", null, "2026-10-15T10:00:00Z", "2026-10-15T11:00:05Z"]);
  assertEquals(c.turns[0], {
    q: "hello",
    a: "A",
    acts: [{ k: "tasks", n: "tasks_add" }],
    code: "~/x",
    at: "2026-10-15T10:00:00Z",
  });
  assertEquals(c.turns[1].error, "no");
});

// ---- the whole path, against a stand-in for the service

const enc = new TextEncoder();
const sseOf = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function fake(opts: { frames?: string[][]; chat?: () => SvcTurn[]; failPost?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let opened = 0;
  const svc: Service = {
    url: "https://b.test",
    call: (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST") {
        if (opts.failPost) return Promise.reject(new Error("POST /api/chats: HTTP 502"));
        return Promise.resolve(
          { chat: { id: "c-1", title: "hello", updated: "u", node: null, turns: 1 }, turn: turn() } as never,
        );
      }
      if (path === "/api/chats") {
        return Promise.resolve(
          { chats: [{ id: "c-1", title: "hello", updated: "u", node: "desk", turns: 1 }] } as never,
        );
      }
      return Promise.resolve(
        { chat: { id: "c-1", title: "hello", turns: opts.chat?.() ?? [turn({ state: "running" })] } } as never,
      );
    },
    stream: () =>
      Promise.resolve(sseOf((opts.frames ?? [])[Math.min(opened++, (opts.frames ?? [[]]).length - 1)] ?? [])),
  };
  return { svc, calls, opened: () => opened };
}

const lines = async (s: ReadableStream<Uint8Array>) =>
  (await new Response(s).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const chats = (f: ReturnType<typeof fake> | null, now = () => 0) =>
  new ServiceChats({
    service: () => Promise.resolve(f ? { svc: f.svc, node: "desk" } : null),
    now,
    sleep: () => Promise.resolve(),
  });

Deno.test("ask: a question is a turn pinned to this machine, and its answer comes back as the page's lines", async () => {
  const f = fake({
    frames: [[
      ": connected\n\n",
      frame("turn", { turn: T, state: "running", node: "desk" }),
      frame("text", { turn: T, d: "Oggi hai " }),
      frame("act", { turn: T, k: "tasks", n: "tasks_brief" }),
      frame("text", { turn: T, d: "due task." }),
      frame("done", { turn: T, a: "Oggi hai due task." }),
    ]],
  });
  const out = await chats(f).ask("hello", null, new AbortController().signal);
  assertEquals(f.calls[0], { method: "POST", path: "/api/chats", body: { text: "hello", node: "desk" } });
  assertEquals(await lines(out!), [
    { t: "chat", id: "c-1" },
    { t: "text", d: "Oggi hai " },
    { t: "tool", k: "tasks", n: "tasks_brief" },
    { t: "text", d: "due task." },
    { t: "done", text: "Oggi hai due task.", code: null },
  ]);
});

Deno.test("ask: a question in a chat of the service names it, and the saved callback runs at the end", async () => {
  const f = fake({ frames: [[frame("done", { turn: T, a: "ok" })]] });
  let saved = 0;
  const out = await chats(f).ask("again", "c-1", new AbortController().signal, () => saved++);
  assertEquals((f.calls[0].body as { chat: string }).chat, "c-1");
  assertEquals((await lines(out!)).at(-1), { t: "done", text: "ok", code: null });
  assertEquals(saved, 1);
});

Deno.test("ask: an answer finished before the stream was open is read from the chat", async () => {
  const f = fake({ frames: [[]], chat: () => [turn({ state: "done", a: "Già fatto." })] });
  const out = await chats(f).ask("hello", null, new AbortController().signal);
  assertEquals((await lines(out!)).at(-1), { t: "done", text: "Già fatto.", code: null });
});

Deno.test("ask: a stream that drops is opened again until the turn ends", async () => {
  const f = fake({
    frames: [[frame("text", { turn: T, d: "Un po'" })], [frame("done", { turn: T, a: "Un po' dopo" })]],
  });
  const out = await chats(f).ask("hello", null, new AbortController().signal);
  const got = await lines(out!);
  assertEquals(got.at(-1), { t: "done", text: "Un po' dopo", code: null });
  assertEquals(f.opened(), 2);
});

Deno.test("ask: a failed turn is an error line", async () => {
  const f = fake({ frames: [[frame("turn", { turn: T, state: "failed", error: "Not logged in" })]] });
  const got = await lines((await chats(f).ask("hello", null, new AbortController().signal))!);
  assertEquals(got.at(-1), { t: "done", text: "", code: null, error: "Not logged in" });
});

Deno.test("ask: no service means local; a service that fails a new chat means local, then it is left alone a while", async () => {
  assertEquals(await chats(null).ask("hello", null, new AbortController().signal), null);
  assertEquals(await chats(null).list(), null);
  let now = 1000;
  const f = fake({ failPost: true });
  const c = chats(f, () => now);
  assertEquals(await c.ask("hello", null, new AbortController().signal), null);
  const n = f.calls.length;
  // left alone: no call at all, the page reads the local chats
  assertEquals(await c.list(), null);
  assertEquals(f.calls.length, n);
  now += DOWN_MS + 1;
  assertEquals((await c.list())?.length, 1);
});

Deno.test("ask: a service that fails a turn in its own chat says so, it does not answer from elsewhere", async () => {
  const f = fake({ failPost: true });
  const out = await chats(f).ask("again", "c-1", new AbortController().signal);
  assertEquals(await lines(out!), [
    { t: "chat", id: "c-1" },
    { t: "done", text: "", code: null, error: "POST /api/chats: HTTP 502" },
  ]);
});

Deno.test("list, get and remove go to the service", async () => {
  const f = fake({ chat: () => [turn({ state: "done", a: "A" })] });
  const c = chats(f);
  assertEquals(await c.list(), [{ id: "c-1", title: "hello", updated: "u", turns: 1 }]);
  assertEquals((await c.get("c-1"))?.turns.map((t) => t.a), ["A"]);
  assertEquals(await c.remove("c-1"), true);
  assertEquals(f.calls.at(-1), { method: "DELETE", path: "/api/chats/c-1", body: undefined });
});
