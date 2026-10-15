// chat_test.ts — the chats (chat.ts): a turn written, claimed by the node that answers and by no other, its events
// relayed to the stream, its end, the 90 s reclaim with a clock the test moves, and the choice of the answering node.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { answeringNode, ChatHub, chatRoute, Chats, type PushNotice, RECLAIM_MS } from "../chat.ts";
import { Fleet } from "../fleet.ts";
import { Store } from "../store.ts";

const ann = (x: Record<string, unknown> = {}) => ({
  platform: "linux",
  version: "1.2.0",
  headless: false,
  load: 0,
  memTotal: 8e9,
  memFree: 4e9,
  cap: 2,
  running: 0,
  accounts: [],
  present: false,
  sandbox: null,
  ...x,
});

function setup() {
  let now = Date.parse("2026-10-15T20:00:00Z"), n = 0;
  const db = new Store(":memory:").db;
  const hub = new ChatHub();
  const pushed: PushNotice[] = [];
  const chats = new Chats(db, hub, {
    user: "u1",
    now: () => now,
    newId: () => `${++n}`,
    notify: (p) => pushed.push(p),
  });
  const fleet = new Fleet(db, () => now);
  const call = async (node: string | null, method: string, path: string, body?: unknown) => {
    const req = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const r = await chatRoute(req, new URL(req.url), node, chats, hub, "u1");
    return { status: r!.status, body: await r!.json() };
  };
  // a node is online when it announced within 90 s
  const online = (name: string, x: Record<string, unknown> = {}) => fleet.announce(name, ann(x) as never);
  return { chats, hub, call, online, pushed, tick: (ms: number) => (now += ms), db };
}

Deno.test("chats: a turn in a new chat, then in the same one; listed newest first", async () => {
  const { call, tick } = setup();
  const a = await call(null, "POST", "/api/chats", { text: "first\nsecond line" });
  assertEquals([a.status, a.body.chat.title, a.body.turn.state, a.body.turn.q], [
    200,
    "first",
    "waiting",
    "first\nsecond line",
  ]);
  tick(1000);
  const b = await call(null, "POST", "/api/chats", { text: "other" });
  tick(1000);
  const again = await call(null, "POST", "/api/chats", { text: "more", chat: a.body.chat.id });
  assertEquals(again.body.chat.id, a.body.chat.id);
  assertEquals((await call(null, "GET", "/api/chats")).body.chats.map((c: { id: string }) => c.id), [
    a.body.chat.id,
    b.body.chat.id,
  ]);
  const one = await call(null, "GET", `/api/chats/${a.body.chat.id}`);
  assertEquals(one.body.chat.turns.map((t: { q: string }) => t.q), ["first\nsecond line", "more"]);
  assertEquals((await call(null, "POST", "/api/chats", { text: "x", chat: "nope" })).status, 404);
  assertEquals((await call(null, "POST", "/api/chats", { text: "  " })).status, 400);
  assertEquals((await call(null, "DELETE", `/api/chats/${b.body.chat.id}`)).body, { ok: true });
  assertEquals((await call(null, "GET", `/api/chats/${b.body.chat.id}`)).status, 404);
});

Deno.test("chats: only a node token polls, posts events and ends a turn", async () => {
  const { call, online } = setup();
  online("desk");
  const t = (await call(null, "POST", "/api/chats", { text: "hi" })).body.turn.id;
  assertEquals((await call(null, "GET", "/api/node/turns")).status, 403);
  assertEquals((await call(null, "POST", `/api/turns/${t}/events`, { events: [] })).status, 403);
  assertEquals((await call(null, "POST", `/api/turns/${t}/done`, { text: "x" })).status, 403);
});

Deno.test("chats: the right node claims, once; another node's call gets nothing", async () => {
  const { call, online } = setup();
  online("desk");
  online("srv", { headless: true });
  const c = (await call(null, "POST", "/api/chats", { text: "hi" })).body;
  // no choice made: the first online headless node answers
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns, []);
  const got = (await call("srv", "GET", "/api/node/turns")).body.turns;
  assertEquals(got.length, 1);
  assertEquals([got[0].id, got[0].chat, got[0].text, got[0].session, got[0].history], [
    c.turn.id,
    c.chat.id,
    "hi",
    null,
    [],
  ]);
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns, []);
  const st = (await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0];
  assertEquals([st.state, st.node], ["running", "srv"]);
  // another node cannot end it
  assertEquals((await call("desk", "POST", `/api/turns/${c.turn.id}/done`, { text: "x" })).status, 403);
});

Deno.test("chats: the chosen orchestrator, its fallbacks, and the default", async () => {
  const { call, online, tick } = setup();
  online("desk");
  online("laptop");
  online("srv", { headless: true });
  assertEquals((await call(null, "GET", "/api/settings/orchestrator")).body, { node: null, order: [] });
  assertEquals(
    (await call(null, "PUT", "/api/settings/orchestrator", { node: "laptop", order: ["desk", "srv"] })).body,
    { node: "laptop", order: ["desk", "srv"] },
  );
  assertEquals((await call(null, "PUT", "/api/settings/orchestrator", { node: "../x" })).status, 400);
  await call(null, "POST", "/api/chats", { text: "hi" });
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns, []);
  // the chosen node goes silent past 90 s; the others keep announcing: the next of the order answers
  tick(100_000);
  online("desk");
  online("srv", { headless: true });
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns.length, 1);
});

Deno.test("chats: answeringNode, as written", () => {
  const now = Date.parse("2026-10-15T20:00:00Z");
  const seen = new Date(now - 10_000).toISOString(), old = new Date(now - 200_000).toISOString();
  const nodes = [
    { name: "a", seen, headless: false },
    { name: "b", seen, headless: true },
    { name: "c", seen: old, headless: true },
  ];
  assertEquals(answeringNode(nodes, { node: null, order: [] }, now), "b");
  assertEquals(answeringNode(nodes, { node: "a", order: ["b"] }, now), "a");
  assertEquals(answeringNode(nodes, { node: "c", order: ["a", "b"] }, now), "a");
  assertEquals(answeringNode(nodes, { node: "c", order: [] }, now), "b");
  assertEquals(answeringNode([nodes[0], nodes[2]], { node: null, order: [] }, now), "a");
  assertEquals(answeringNode([nodes[2]], { node: null, order: [] }, now), null);
  // the node asking is online by asking
  assertEquals(answeringNode([nodes[2]], { node: null, order: [] }, now, "c"), "c");
  assertEquals(answeringNode([], { node: null, order: [] }, now, "new"), "new");
});

Deno.test("chats: events are kept and relayed, done ends the turn and pushes", async () => {
  const { call, online, hub, pushed, chats } = setup();
  online("desk");
  const c = (await call(null, "POST", "/api/chats", { text: "what is up" })).body;
  const seen: string[] = [];
  const off = hub.subscribe("u1", c.chat.id, (e) => seen.push(`${e.event}:${JSON.stringify(e.data)}`));
  const [claimed] = (await call("desk", "GET", "/api/node/turns")).body.turns;
  assertEquals(claimed.id, c.turn.id);
  const evs = [{ t: "text", d: "Hel" }, { t: "tool", k: "tasks", n: "tasks_add", d: "buy milk" }, {
    t: "text",
    d: "lo",
  }, {
    t: "session",
    id: "sess-1",
  }];
  assertEquals((await call("desk", "POST", `/api/turns/${c.turn.id}/events`, { events: evs })).body, { ok: true });
  assertEquals((await call("desk", "POST", `/api/turns/${c.turn.id}/events`, { events: [{ t: "nope" }] })).status, 400);
  const mid = (await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0];
  assertEquals([mid.a, mid.acts], ["Hello", [{ k: "tasks", n: "tasks_add", d: "buy milk" }]]);
  assertEquals(
    (await call("desk", "POST", `/api/turns/${c.turn.id}/done`, { text: "Hello there\nbye", code: 0 })).body,
    {
      ok: true,
    },
  );
  off();
  assertEquals(seen, [
    `turn:{"turn":"${c.turn.id}","state":"running","node":"desk"}`,
    `text:{"turn":"${c.turn.id}","d":"Hel"}`,
    `act:{"turn":"${c.turn.id}","k":"tasks","n":"tasks_add","d":"buy milk"}`,
    `text:{"turn":"${c.turn.id}","d":"lo"}`,
    `turn:{"turn":"${c.turn.id}","state":"done","node":"desk"}`,
    `done:{"turn":"${c.turn.id}","a":"Hello there\\nbye","code":0}`,
  ]);
  const end = chats.get(c.chat.id)!.turns[0];
  assertEquals([end.state, end.a, end.error, end.ended !== null], ["done", "Hello there\nbye", null, true]);
  assertEquals(pushed, [{ chat: c.chat.id, turn: c.turn.id, title: "what is up", body: "Hello there", failed: false }]);
  // finished: no more events, no second end
  assertEquals((await call("desk", "POST", `/api/turns/${c.turn.id}/done`, { text: "x" })).status, 409);
  // the next turn of the chat resumes the session on the same node, and carries the history
  await call(null, "POST", "/api/chats", { text: "and then?", chat: c.chat.id });
  const [next] = (await call("desk", "GET", "/api/node/turns")).body.turns;
  assertEquals([next.session, next.history], ["sess-1", [{ q: "what is up", a: "Hello there\nbye" }]]);
});

Deno.test("chats: a failed turn carries its error and pushes it; a chat's turns run one at a time", async () => {
  const { call, online, pushed } = setup();
  online("desk");
  const c = (await call(null, "POST", "/api/chats", { text: "one" })).body;
  await call(null, "POST", "/api/chats", { text: "two", chat: c.chat.id });
  const first = (await call("desk", "GET", "/api/node/turns?max=5")).body.turns;
  assertEquals(first.map((t: { text: string }) => t.text), ["one"]);
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns, []);
  await call("desk", "POST", `/api/turns/${c.turn.id}/done`, { text: "", error: "claude crashed" });
  const t = (await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0];
  assertEquals([t.state, t.error], ["failed", "claude crashed"]);
  assertEquals([pushed[0].failed, pushed[0].body], [true, "claude crashed"]);
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns.map((x: { text: string }) => x.text), ["two"]);
});

Deno.test("chats: a turn held by a node silent for 90 s goes back to waiting, and heartbeats keep it", async () => {
  const { call, online, tick } = setup();
  online("desk");
  online("srv");
  await call(null, "PUT", "/api/settings/orchestrator", { node: "desk", order: ["srv"] });
  const c = (await call(null, "POST", "/api/chats", { text: "long job" })).body;
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns.length, 1);
  await call("desk", "POST", `/api/turns/${c.turn.id}/events`, { events: [{ t: "text", d: "partial" }] });
  tick(RECLAIM_MS - 1000);
  await call("desk", "POST", `/api/turns/${c.turn.id}/events`, { events: [] }); // heartbeat
  tick(RECLAIM_MS - 1000);
  assertEquals((await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0].state, "running");
  // then silence
  tick(2000);
  online("srv"); // desk is silent: only srv is online now
  const w = (await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0];
  assertEquals([w.state, w.node, w.a], ["waiting", null, ""]);
  // the node that lost it cannot end it; the one that answers now takes it from the top
  assertEquals((await call("desk", "POST", `/api/turns/${c.turn.id}/done`, { text: "late" })).status, 409);
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns.map((t: { id: string }) => t.id), [c.turn.id]);
});

Deno.test("chats: a poll waits, and a turn written meanwhile wakes it", async () => {
  const { call, online, chats } = setup();
  online("desk");
  const poll = call("desk", "GET", "/api/node/turns?wait=10");
  await new Promise((r) => setTimeout(r, 20));
  chats.post("wake up");
  const r = await poll;
  assertEquals(r.body.turns.map((t: { text: string }) => t.text), ["wake up"]);
});

Deno.test("chats: the stream starts with the unfinished turns and carries what follows", async () => {
  const { call, online, chats, hub } = setup();
  online("desk");
  const c = (await call(null, "POST", "/api/chats", { text: "hi" })).body;
  const ac = new AbortController();
  const req = new Request(`https://b.test/api/chats/${c.chat.id}/events`, { signal: ac.signal });
  const res = await chatRoute(req, new URL(req.url), null, chats, hub, "u1");
  assertEquals(res!.headers.get("content-type"), "text/event-stream");
  const reader = res!.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const until = async (needle: string) => {
    while (!text.includes(needle)) text += dec.decode((await reader.read()).value);
  };
  await until(`"state":"waiting"`);
  assert(text.startsWith(": connected"));
  chats.claim("desk");
  await until(`"state":"running"`);
  assertEquals(hub.following("u1", c.chat.id), 1);
  ac.abort();
  assertEquals(hub.following("u1", c.chat.id), 0);
});

Deno.test("chats: one account's stream never hears another's chat", () => {
  const hub = new ChatHub();
  const got: string[] = [];
  const off = hub.subscribe("u1", "c-1", (e) => got.push(e.event));
  hub.publish("u2", "c-1", { event: "text", data: {} });
  hub.publish("u1", "c-1", { event: "done", data: {} });
  off();
  assertEquals(got, ["done"]);
});

Deno.test("chats: a turn pinned to a node is only that node's, whatever the account's setting says", async () => {
  const { call, online } = setup();
  online("desk");
  online("srv", { headless: true });
  // a pin must be a node name
  assertEquals((await call(null, "POST", "/api/chats", { text: "x", node: "../x" })).status, 400);
  const pinned = (await call(null, "POST", "/api/chats", { text: "from the desk", node: "desk" })).body;
  assertEquals(pinned.turn.state, "waiting");
  // srv is the answering node (first online headless one), but the turn is pinned to desk
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns, []);
  const got = (await call("desk", "GET", "/api/node/turns")).body.turns;
  assertEquals(got.map((t: { id: string }) => t.id), [pinned.turn.id]);
  // an unpinned turn still follows the setting, and a pin on an offline node waits for it
  const free = (await call(null, "POST", "/api/chats", { text: "anyone" })).body;
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns.map((t: { id: string }) => t.id), [
    free.turn.id,
  ]);
  const away = (await call(null, "POST", "/api/chats", { text: "elsewhere", node: "laptop" })).body;
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call("laptop", "GET", "/api/node/turns")).body.turns.map((t: { id: string }) => t.id), [
    away.turn.id,
  ]);
});

Deno.test("chats: a pinned turn lost by a silent node goes back to waiting, still pinned", async () => {
  const { call, online, tick } = setup();
  online("desk");
  const t = (await call(null, "POST", "/api/chats", { text: "x", node: "desk" })).body.turn.id;
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns.length, 1);
  tick(RECLAIM_MS + 1000);
  online("srv", { headless: true });
  assertEquals((await call("srv", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns.map((x: { id: string }) => x.id), [t]);
});

Deno.test("chats: the list counts the turns, and the folder an answer named is kept with it", async () => {
  const { call, online, hub } = setup();
  online("desk");
  const c = (await call(null, "POST", "/api/chats", { text: "look at the site" })).body;
  assertEquals((await call(null, "GET", "/api/chats")).body.chats[0].turns, 1);
  const seen: { event: string; data: Record<string, unknown> }[] = [];
  hub.subscribe("u1", c.chat.id, (e) => seen.push(e));
  const t = (await call("desk", "GET", "/api/node/turns")).body.turns[0];
  await call("desk", "POST", `/api/turns/${t.id}/done`, { text: "Open the site.", code: "~/work/acme/site" });
  assertEquals(seen.find((e) => e.event === "done")!.data, {
    turn: t.id,
    a: "Open the site.",
    code: "~/work/acme/site",
  });
  const turn = (await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0];
  assertEquals([turn.state, turn.code], ["done", "~/work/acme/site"]);
  await call(null, "POST", "/api/chats", { text: "more", chat: c.chat.id });
  assertEquals((await call(null, "GET", "/api/chats")).body.chats[0].turns, 2);
});
