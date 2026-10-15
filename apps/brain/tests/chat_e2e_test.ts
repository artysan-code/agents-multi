// The phone's path end to end, in one process (ADR 0014, G1): a turn written as the web app writes it, claimed by
// the node's real loop (apps/cli/node/turns.ts) through the service's real routes (chat.ts), the answer's pieces
// relayed to the chat's event stream, and the turn done in the chat. Only Claude is a fake runner, and the HTTP
// in between is a direct call: what is checked is that the two sides, built apart, agree on the contract.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ChatHub, chatRoute, Chats, type SseEvent } from "../chat.ts";
import { Fleet } from "../fleet.ts";
import { Store } from "../store.ts";
import { type Runner, turnLoop } from "../../cli/node/turns.ts";
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
