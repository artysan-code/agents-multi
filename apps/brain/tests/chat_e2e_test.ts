// The phone's path end to end, in one process (ADR 0014, G1): a turn written as the web app writes it, claimed by
// the node's real loop (apps/cli/node/turns.ts) through the service's real routes (chat.ts), the answer's pieces
// relayed to the chat's event stream, and the turn done in the chat. Only Claude is a fake runner, and the HTTP
// in between is a direct call: what is checked is that the two sides, built apart, agree on the contract.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ChatHub, chatRoute, Chats, type SseEvent } from "../chat.ts";
import { Fleet } from "../fleet.ts";
import { Store } from "../store.ts";
import { type Runner, turnLoop } from "../../cli/node/turns.ts";
import { ServiceChats } from "../../cli/svc-chat.ts";
import { cleanNodeConfig } from "../../../shared/mcp/lib/headless.ts";

Deno.test("e2e: a question from the web app is answered by the node's loop and streamed back", async () => {
  const db = new Store(":memory:").db;
  const hub = new ChatHub();
  const chats = new Chats(db, hub, { user: "u1" });
  const fleet = new Fleet(db);
  fleet.announce("desk", {
    platform: "linux",
    version: "1.2.1",
    headless: false,
    load: 0,
    memTotal: 8e9,
    memFree: 4e9,
    cap: 2,
    running: 0,
    accounts: [],
    present: true,
    sandbox: null,
  } as never);
  const route = async (node: string | null, method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const req = new Request(`https://b.test${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const r = await chatRoute(req, new URL(req.url), node, chats, hub, "u1");
    assert(r, `no route for ${method} ${path}`);
    const out = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(out)}`);
    return out;
  };

  // the web app asks
  const asked = await route(null, "POST", "/api/chats", { text: "Che cosa ho oggi?" });
  const chatId = typeof asked.chat === "string" ? asked.chat : asked.chat.id;
  const seen: SseEvent[] = [];
  const unsubscribe = hub.subscribe("u1", chatId, (e: SseEvent) => seen.push(e));

  // the node answers, through the routes, as the desk node
  const stop = new AbortController();
  const run: Runner = (text, o, onEvent) => {
    assertEquals(text, "Che cosa ho oggi?");
    assertEquals(o.session, null);
    onEvent({ t: "session", id: "sess-1" });
    onEvent({ t: "text", d: "Oggi hai " });
    onEvent({ t: "tool", k: "tasks", n: "tasks_brief" });
    onEvent({ t: "text", d: "due task." });
    return Promise.resolve({ t: "done", text: "Oggi hai due task.", code: null });
  };
  const loop = turnLoop({
    log: () => {},
    signal: stop.signal,
    config: () => Promise.resolve(cleanNodeConfig({ enabled: true })),
    service: () =>
      Promise.resolve({
        url: "https://b.test",
        call: <T>(method: string, path: string, body?: unknown, o?: { signal?: AbortSignal }) =>
          route("desk", method, path, body, o?.signal) as Promise<T>,
      }),
    run,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    batchMs: 5,
  });

  // until the chat says the turn is done (or two seconds pass)
  let chat: { turns: { state: string; a: string; node: string; acts: unknown[] }[] } | null = null;
  for (let i = 0; i < 200; i++) {
    chat = (await route(null, "GET", `/api/chats/${chatId}`)).chat;
    if (chat?.turns[0]?.state === "done") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  stop.abort();
  await loop;
  unsubscribe();

  assertEquals(chat!.turns[0].state, "done");
  assertEquals(chat!.turns[0].a, "Oggi hai due task.");
  assertEquals(chat!.turns[0].node, "desk");
  assertEquals(chat!.turns[0].acts.length, 1);
  const kinds = seen.map((e) => e.event);
  assert(kinds.includes("text"), `events: ${kinds.join(",")}`);
  assert(kinds.includes("act"), `events: ${kinds.join(",")}`);
  assertEquals(kinds.at(-1), "done");
});

Deno.test("e2e: the console's chat asks a pinned turn, the node's loop answers it, the page's lines come back", async () => {
  const db = new Store(":memory:").db;
  const hub = new ChatHub();
  const chats = new Chats(db, hub, { user: "u1" });
  const fleet = new Fleet(db);
  const ann = {
    platform: "linux",
    version: "1.2.1",
    headless: false,
    load: 0,
    memTotal: 8e9,
    memFree: 4e9,
    cap: 2,
    running: 0,
    accounts: [],
    present: true,
    sandbox: null,
  } as never;
  fleet.announce("desk", ann);
  // a headless server is the account's answering node: only the pin sends the console's turn to the desk
  fleet.announce("srv", { ...(ann as object), headless: true } as never);
  const call = async (node: string | null, method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const req = new Request(`https://b.test${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const r = await chatRoute(req, new URL(req.url), node, chats, hub, "u1");
    assert(r, `no route for ${method} ${path}`);
    return r;
  };
  const as = (node: string) => ({
    url: "https://b.test",
    call: async <T>(method: string, path: string, body?: unknown, o?: { signal?: AbortSignal }) => {
      const r = await call(node, method, path, body, o?.signal);
      const out = await r.json();
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(out)}`);
      return out as T;
    },
    stream: (path: string, signal: AbortSignal) => call(node, "GET", path, undefined, signal),
  });

  const stop = new AbortController();
  const loop = turnLoop({
    log: () => {},
    signal: stop.signal,
    config: () => Promise.resolve(cleanNodeConfig({ enabled: true })),
    service: () => Promise.resolve(as("desk")),
    run: (text, _o, onEvent) => {
      onEvent({ t: "text", d: `Re: ${text}` });
      return Promise.resolve({ t: "done", text: `Re: ${text}`, code: "~/work/acme/site" });
    },
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    batchMs: 5,
  });
  const console_ = new ServiceChats({ service: () => Promise.resolve({ svc: as("desk"), node: "desk" }) });
  const out = await console_.ask("ciao", null, new AbortController().signal);
  const lines = (await new Response(out!).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  stop.abort();
  await loop;

  assertEquals(lines[0].t, "chat");
  assertEquals(lines.at(-1), { t: "done", text: "Re: ciao", code: "~/work/acme/site" });
  const listed = await console_.list();
  assertEquals(listed?.map((c) => [c.id, c.turns]), [[lines[0].id, 1]]);
  const opened = await console_.get(lines[0].id);
  assertEquals(opened?.turns.map((t) => [t.q, t.a, t.code]), [["ciao", "Re: ciao", "~/work/acme/site"]]);
  // it ran on the desk, not on the server the account answers with
  assertEquals((await (await call(null, "GET", `/api/chats/${lines[0].id}`)).json()).chat.turns[0].node, "desk");
});
