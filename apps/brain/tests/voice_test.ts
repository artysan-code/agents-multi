// voice_test.ts — the chat's second round on the service (ADR 0014): the voice note (multipart, limits, claimed only
// by a node that transcribes, fetched by the node that holds it, its transcript as the turn's question, deleted when
// the turn ends), renaming a chat, cancelling a turn in both states, and forgetting a machine.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import {
  ChatHub,
  chatRoute,
  Chats,
  forgetNode,
  forgetRoute,
  MAX_AUDIO,
  readLimited,
  readVoiceForm,
  RECLAIM_MS,
  VOICE_TITLE,
} from "../chat.ts";
import { Auth } from "../auth.ts";
import { masterKey, Users } from "../users.ts";
import { Fleet } from "../fleet.ts";
import { Store } from "../store.ts";
import { cleanAnnounce } from "../fleet.ts";
import { type Runner, turnLoop } from "../../cli/node/turns.ts";
import { type Service, ServiceError } from "../../cli/node/service.ts";
import { cleanNodeConfig } from "../../../shared/mcp/lib/headless.ts";

const ann = (x: Record<string, unknown> = {}) => ({
  platform: "linux",
  version: "1.2.1",
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
  let now = Date.parse("2026-10-16T20:00:00Z"), n = 0;
  const db = new Store(":memory:").db;
  const hub = new ChatHub();
  const chats = new Chats(db, hub, { user: "u1", now: () => now, newId: () => `${++n}` });
  const fleet = new Fleet(db, () => now);
  const call = async (node: string | null, method: string, path: string, body?: unknown) => {
    const req = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const r = await chatRoute(req, new URL(req.url), node, chats, hub, "u1");
    return { status: r!.status, body: await r!.json() };
  };
  const voice = async (node: string | null, fields: Record<string, string | Blob> = {}) => {
    const form = new FormData();
    form.set("audio", new File([new Uint8Array([1, 2, 3, 4])], "note.webm", { type: "audio/webm;codecs=opus" }));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const req = new Request("https://b.test/api/chats/voice", { method: "POST", body: form });
    const r = await chatRoute(req, new URL(req.url), node, chats, hub, "u1");
    return { status: r!.status, body: await r!.json() };
  };
  const online = (name: string, x: Record<string, unknown> = {}) => fleet.announce(name, ann(x) as never);
  const audioRows = () => (db.prepare("select count(*) n from turn_audio").get() as { n: number }).n;
  return { chats, hub, call, voice, online, db, fleet, audioRows, tick: (ms: number) => (now += ms) };
}

const multipart = (parts: (fd: FormData) => void, headers: Record<string, string> = {}) => {
  const fd = new FormData();
  parts(fd);
  return new Request("https://b.test/api/chats/voice", { method: "POST", body: fd, headers });
};

Deno.test("voice: the form is parsed, and refused when it is not a form, has no audio, or the type is wrong", async () => {
  const ok = await readVoiceForm(multipart((fd) => {
    fd.set("audio", new File([new Uint8Array([9, 9])], "n.mp4", { type: "audio/mp4" }));
    fd.set("chat", "c-1");
    fd.set("node", "desk");
  }));
  assertEquals([ok.audio.type, [...ok.audio.data], ok.chat, ok.node], ["audio/mp4", [9, 9], "c-1", "desk"]);
  const status = async (p: Promise<unknown>) => await p.then(() => 0, (e) => (e as { status: number }).status);
  assertEquals(await status(readVoiceForm(new Request("https://b.test/x", { method: "POST", body: "{}" }))), 415);
  assertEquals(await status(readVoiceForm(multipart((fd) => fd.set("chat", "c-1")))), 400);
  // a type that is not audio is refused when the turn is made
  const { chats } = setup();
  assertEquals(
    await status(Promise.resolve().then(() => chats.postVoice({ type: "text/html", data: new Uint8Array(3) }))),
    415,
  );
  assertEquals(
    await status(Promise.resolve().then(() => chats.postVoice({ type: "audio/webm", data: new Uint8Array(0) }))),
    400,
  );
  assertEquals(
    await status(
      Promise.resolve().then(() => chats.postVoice({ type: "audio/webm", data: new Uint8Array(MAX_AUDIO + 1) })),
    ),
    413,
  );
});

Deno.test("voice: a body over the limit is refused by its declared size and by its real size", async () => {
  const big = new Uint8Array(1000);
  const status = async (p: Promise<unknown>) => await p.then(() => 0, (e) => (e as { status: number }).status);
  // declared
  assertEquals(
    await status(
      readLimited(
        new Request("https://b.test/x", { method: "POST", body: big, headers: { "content-length": "1000" } }),
        999,
      ),
    ),
    413,
  );
  // not declared: a stream that goes past the limit is cut
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(400));
    },
  });
  const req = new Request("https://b.test/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assertEquals(await status(readLimited(req, 1000)), 413);
  assertEquals(
    (await readLimited(new Request("https://b.test/x", { method: "POST", body: big }), 1000)).byteLength,
    1000,
  );
});

Deno.test("voice: a voice note is a turn with no text, a chat named for it, and its audio kept", async () => {
  const { voice, call, audioRows } = setup();
  const r = await voice(null);
  assertEquals(r.status, 200);
  assertEquals([r.body.chat.title, r.body.turn.voice, r.body.turn.q, r.body.turn.state], [
    VOICE_TITLE,
    true,
    "",
    "waiting",
  ]);
  assertEquals(audioRows(), 1);
  // a voice note into an existing chat, pinned to a machine
  const again = await voice(null, { chat: r.body.chat.id, node: "desk" });
  assertEquals(again.body.chat.id, r.body.chat.id);
  assertEquals((await call(null, "GET", `/api/chats/${r.body.chat.id}`)).body.chat.turns.length, 2);
  assertEquals((await voice(null, { chat: "c-nope" })).status, 404);
  assertEquals((await voice(null, { node: "bad name" })).status, 400);
});

Deno.test("voice: only a node that announced voice claims it, and a text turn goes to anyone", async () => {
  const { voice, call, online } = setup();
  online("plain");
  const v = await voice(null);
  // the node without voice is the account's answering node, and still gets nothing
  assertEquals((await call("plain", "GET", "/api/node/turns")).body.turns, []);
  online("listener", { voice: true });
  assertEquals((await call("plain", "GET", "/api/node/turns")).body.turns, []);
  const got = (await call("listener", "GET", "/api/node/turns")).body.turns;
  assertEquals(got.map((t: { id: string; voice?: boolean }) => [t.id, t.voice]), [[v.body.turn.id, true]]);
  // text turns: the answering node (the first online) takes them, voice or not, and a pinned one is its node's
  const t = await call(null, "POST", "/api/chats", { text: "hello", node: "plain" });
  assertEquals((await call("plain", "GET", "/api/node/turns")).body.turns.map((x: { id: string }) => x.id), [
    t.body.turn.id,
  ]);
});

Deno.test("voice: a pinned voice note is only its node's, and only if that node transcribes; the setting picks among voice nodes", async () => {
  const { voice, call, online, chats } = setup();
  online("a", { voice: true });
  online("b", { voice: true });
  online("c");
  chats.setOrchestrator({ node: "c", order: ["b", "a"] });
  // the chosen node cannot transcribe: the fallback that can answers
  const free = await voice(null);
  assertEquals((await call("a", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call("b", "GET", "/api/node/turns")).body.turns.map((t: { id: string }) => t.id), [
    free.body.turn.id,
  ]);
  // pinned to "a": b does not take it, a does
  const pinned = await voice(null, { node: "a" });
  assertEquals((await call("b", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call("a", "GET", "/api/node/turns")).body.turns.map((t: { id: string }) => t.id), [
    pinned.body.turn.id,
  ]);
  // pinned to a node that cannot: nobody takes it
  const stuck = await voice(null, { node: "c", chat: pinned.body.chat.id });
  assert(stuck.status === 200);
  assertEquals((await call("c", "GET", "/api/node/turns")).body.turns, []);
});

Deno.test("voice: the audio is the holder's alone, the transcript becomes the question, the audio goes with the turn", async () => {
  const { voice, call, online, hub, audioRows } = setup();
  online("a", { voice: true });
  online("b", { voice: true });
  const v = await voice(null, { node: "a" });
  const id = v.body.turn.id, chat = v.body.chat.id;
  const seen: string[] = [];
  hub.subscribe("u1", chat, (e) => seen.push(`${e.event}:${JSON.stringify(e.data)}`));
  // not claimed yet: nobody
  assertEquals((await call("a", "GET", `/api/turns/${id}/audio`)).status, 403);
  await call("a", "GET", "/api/node/turns");
  // the holder gets the bytes and their type; another node and a web session do not
  assertEquals((await call("b", "GET", `/api/turns/${id}/audio`)).status, 403);
  assertEquals((await call(null, "GET", `/api/turns/${id}/audio`)).status, 403);
  // the transcript: kept as the question, the chat named for it, relayed
  assertEquals(
    (await call("a", "POST", `/api/turns/${id}/events`, {
      events: [{ t: "transcript", text: "  ricordami di chiamare Anna\nalle dieci " }],
    })).body,
    { ok: true },
  );
  const t = (await call(null, "GET", `/api/chats/${chat}`)).body.chat;
  assertEquals([t.title, t.turns[0].q, t.turns[0].voice], [
    "ricordami di chiamare Anna",
    "ricordami di chiamare Anna\nalle dieci",
    true,
  ]);
  assertEquals(seen.filter((s) => s.startsWith("transcript:")), [
    `transcript:{"turn":"${id}","text":"ricordami di chiamare Anna\\nalle dieci"}`,
  ]);
  // a text turn has no transcript; an empty one is refused
  const text = await call(null, "POST", "/api/chats", { text: "x" });
  await call("a", "GET", "/api/node/turns");
  assertEquals(
    (await call("a", "POST", `/api/turns/${text.body.turn.id}/events`, { events: [{ t: "transcript", text: "y" }] }))
      .status,
    400,
  );
  assertEquals(
    (await call("a", "POST", `/api/turns/${id}/events`, { events: [{ t: "transcript", text: "  " }] })).status,
    400,
  );
  assertEquals(audioRows(), 1);
  await call("a", "POST", `/api/turns/${id}/done`, { text: "fatto" });
  assertEquals(audioRows(), 0);
  assertEquals((await call("a", "GET", `/api/turns/${id}/audio`)).status, 403);
});

// the route test above reads the audio through chatRoute, whose body is not JSON: this one checks the bytes
Deno.test("voice: the holder reads the bytes with their type", async () => {
  const { voice, online, chats, hub } = setup();
  online("a", { voice: true });
  const v = await voice(null);
  chats.claim("a");
  const req = new Request(`https://b.test/api/turns/${v.body.turn.id}/audio`);
  const r = (await chatRoute(req, new URL(req.url), "a", chats, hub, "u1"))!;
  assertEquals([r.status, r.headers.get("content-type")], [200, "audio/webm"]);
  assertEquals([...new Uint8Array(await r.arrayBuffer())], [1, 2, 3, 4]);
});

Deno.test("voice: a failed voice turn and a deleted chat leave no audio", async () => {
  const { voice, call, online, audioRows } = setup();
  online("a", { voice: true });
  const one = await voice(null);
  await call("a", "GET", "/api/node/turns");
  await call("a", "POST", `/api/turns/${one.body.turn.id}/done`, { text: "", error: "no speech was heard" });
  assertEquals(audioRows(), 0);
  const two = await voice(null);
  assertEquals(audioRows(), 1);
  await call(null, "DELETE", `/api/chats/${two.body.chat.id}`);
  assertEquals(audioRows(), 0);
});

Deno.test("voice: a voice turn lost by a silent node waits again, with its audio", async () => {
  const { voice, call, online, tick, audioRows } = setup();
  online("a", { voice: true });
  const v = await voice(null);
  await call("a", "GET", "/api/node/turns");
  tick(RECLAIM_MS + 1000);
  online("a", { voice: true });
  const again = (await call("a", "GET", "/api/node/turns")).body.turns;
  assertEquals(again.map((t: { id: string; voice: boolean }) => [t.id, t.voice]), [[v.body.turn.id, true]]);
  assertEquals(audioRows(), 1);
});

Deno.test("chats: renaming a chat", async () => {
  const { call } = setup();
  const c = (await call(null, "POST", "/api/chats", { text: "first" })).body;
  const r = await call(null, "PATCH", `/api/chats/${c.chat.id}`, { title: "  Spesa   di sabato " });
  assertEquals([r.status, r.body.chat.title], [200, "Spesa di sabato"]);
  assertEquals((await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.title, "Spesa di sabato");
  assertEquals((await call(null, "PATCH", `/api/chats/${c.chat.id}`, { title: "   " })).status, 400);
  assertEquals((await call(null, "PATCH", `/api/chats/${c.chat.id}`, { title: "x".repeat(121) })).status, 400);
  assertEquals((await call(null, "PATCH", `/api/chats/${c.chat.id}`, {})).status, 400);
  assertEquals((await call(null, "PATCH", "/api/chats/c-nope", { title: "x" })).status, 404);
});

Deno.test("cancel: a waiting turn ends at once, the chat goes on with the next", async () => {
  const { call, online, hub, audioRows, voice } = setup();
  online("desk", { voice: true });
  const c = (await call(null, "POST", "/api/chats", { text: "one" })).body;
  const seen: string[] = [];
  hub.subscribe("u1", c.chat.id, (e) => seen.push(`${e.event}:${e.data.state ?? ""}`));
  const r = await call(null, "POST", `/api/turns/${c.turn.id}/cancel`);
  assertEquals([r.status, r.body], [200, { ok: true, state: "cancelled" }]);
  assertEquals(seen, ["turn:cancelled"]);
  const turn = (await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0];
  assertEquals([turn.state, turn.ended !== null], ["cancelled", true]);
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns, []);
  assertEquals((await call(null, "POST", `/api/turns/${c.turn.id}/cancel`)).status, 409); // already over
  assertEquals((await call(null, "POST", "/api/turns/u-none/cancel")).status, 404);
  // the chat's next turn is not blocked by it
  const next = await call(null, "POST", "/api/chats", { text: "two", chat: c.chat.id });
  assertEquals((await call("desk", "GET", "/api/node/turns")).body.turns.map((t: { id: string }) => t.id), [
    next.body.turn.id,
  ]);
  // a cancelled voice note drops its audio
  const v = await voice(null, { node: "desk" });
  assertEquals(audioRows(), 1);
  await call(null, "POST", `/api/turns/${v.body.turn.id}/cancel`);
  assertEquals(audioRows(), 0);
});

Deno.test("cancel: a running turn is marked, and its node's next events or heartbeat gets 409 cancelled", async () => {
  const { call, online, hub } = setup();
  online("desk");
  const c = (await call(null, "POST", "/api/chats", { text: "long job" })).body;
  await call("desk", "GET", "/api/node/turns");
  const seen: string[] = [];
  hub.subscribe("u1", c.chat.id, (e) => seen.push(`${e.event}:${e.data.state ?? ""}`));
  assertEquals((await call(null, "POST", `/api/turns/${c.turn.id}/cancel`)).body, { ok: true, state: "running" });
  assertEquals(seen, []); // the node has not been told yet
  const hb = await call("desk", "POST", `/api/turns/${c.turn.id}/events`, { events: [] });
  assertEquals([hb.status, hb.body.cancelled], [409, true]);
  assertEquals(seen, ["turn:cancelled"]);
  assertEquals((await call(null, "GET", `/api/chats/${c.chat.id}`)).body.chat.turns[0].state, "cancelled");
  // later calls say the turn is over, without the flag
  const late = await call("desk", "POST", `/api/turns/${c.turn.id}/done`, { text: "x" });
  assertEquals([late.status, late.body.cancelled], [409, undefined]);
  // an ordinary conflict never carries it
  assertEquals(
    (await call("desk", "POST", `/api/turns/${c.turn.id}/events`, { events: [] })).body.cancelled,
    undefined,
  );
});

Deno.test("cancel: a node that finishes after the mark is told too, and a silent one does not restart the turn", async () => {
  const { call, online, tick, chats } = setup();
  online("desk");
  const a = (await call(null, "POST", "/api/chats", { text: "a" })).body;
  await call("desk", "GET", "/api/node/turns");
  await call(null, "POST", `/api/turns/${a.turn.id}/cancel`);
  const done = await call("desk", "POST", `/api/turns/${a.turn.id}/done`, { text: "answer" });
  assertEquals([done.status, done.body.cancelled], [409, true]);
  assertEquals(chats.get(a.chat.id)!.turns[0].state, "cancelled");
  const b = (await call(null, "POST", "/api/chats", { text: "b" })).body;
  await call("desk", "GET", "/api/node/turns");
  await call(null, "POST", `/api/turns/${b.turn.id}/cancel`);
  tick(RECLAIM_MS + 1000);
  assertEquals(chats.get(b.chat.id)!.turns[0].state, "cancelled"); // reclaimed as cancelled, not waiting
});

async function accounts() {
  const db = new DatabaseSync(":memory:");
  const users = new Users(db, await masterKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))), false);
  return { db, auth: new Auth(db, users, { url: "https://b.test" }) };
}

Deno.test("forget: the node, what waits on it, its claimed turns and its tokens go; others stay", async () => {
  const { call, online, fleet, chats, db } = setup();
  const { auth, db: adb } = await accounts();
  const revoked = (token: string) =>
    adb.prepare("select revoked from tokens where name = ? and user = ?").all(token, "u1").map((r) =>
      (r as { revoked: number }).revoked
    );
  online("old");
  online("keep");
  chats.setOrchestrator({ node: "old", order: [] });
  db.prepare(
    "insert into waiting (node, id, data, updated) values ('old', 'a/1', '{}', 'x'), ('keep', 'b/1', '{}', 'x')",
  ).run();
  const held = (await call(null, "POST", "/api/chats", { text: "held" })).body;
  assertEquals((await call("old", "GET", "/api/node/turns")).body.turns.length, 1);
  const pinned = (await call(null, "POST", "/api/chats", { text: "pinned", node: "old" })).body;
  const tOld = await auth.createPersonal("u1", "old"), tSu = await auth.createPersonal("u1", "agents-multi su old");
  const tKeep = await auth.createPersonal("u1", "keep"), tOther = await auth.createPersonal("u2", "old");
  const req = (m: string, name: string) => new Request(`https://b.test/api/nodes/${name}`, { method: m });
  const revoke = (n: string) => auth.revokeNode("u1", n);

  const r = forgetRoute(req("DELETE", "old"), new URL("https://b.test/api/nodes/old"), fleet, chats, revoke)!;
  assertEquals([r.status, await r.json()], [200, { ok: true, node: true, turns: 2, tokens: 2 }]);
  assertEquals(fleet.nodes().map((n) => n.name), ["keep"]);
  assertEquals((db.prepare("select node from waiting").all() as { node: string }[]).map((x) => x.node), ["keep"]);
  // the turn it held waits again for whoever answers; the one pinned to it is over
  const t = (id: string) => chats.get(id)!.turns[0];
  assertEquals([t(held.chat.id).state, t(held.chat.id).node], ["waiting", null]);
  assertEquals([t(pinned.chat.id).state, t(pinned.chat.id).error], ["failed", "the machine was forgotten"]);
  assertEquals((await call("keep", "GET", "/api/node/turns")).body.turns.map((x: { id: string }) => x.id), [
    held.turn.id,
  ]);
  // its tokens, named by the pairing or by the login, no longer open the door; the others' still do
  assertEquals([revoked("old"), revoked("agents-multi su old"), revoked("keep")], [[1], [1], [0]]);
  assert(tOld && tSu && tKeep && tOther);
  assertEquals(
    (adb.prepare("select revoked from tokens where user = 'u2'").all() as { revoked: number }[]).map((x) => x.revoked),
    [0],
  );
  // nothing left to forget
  const again = forgetRoute(req("DELETE", "old"), new URL("https://b.test/api/nodes/old"), fleet, chats, revoke)!;
  assertEquals(again.status, 404);
  assertEquals(
    forgetRoute(req("DELETE", "bad%20name"), new URL("https://b.test/api/nodes/bad%20name"), fleet, chats, revoke)!
      .status,
    400,
  );
  assertEquals(forgetRoute(req("GET", "old"), new URL("https://b.test/api/nodes/old"), fleet, chats, revoke), null);
  assertEquals(forgetNode(fleet, chats, revoke, "never-was"), { node: false, turns: 0, tokens: 0 });
});

Deno.test("forget: a token of another account with the same name is out of reach", async () => {
  const { auth, db } = await accounts();
  await auth.createPersonal("u1", "laptop");
  await auth.createPersonal("u2", "laptop");
  assertEquals(auth.revokeNode("u1", "laptop"), 1);
  assertEquals(auth.revokeNode("u1", "laptop"), 0);
  assertEquals(
    (db.prepare("select user, revoked from tokens order by user").all() as { user: string; revoked: number }[]).map((
      r,
    ) => [r.user, r.revoked]),
    [["u1", 1], ["u2", 0]],
  );
});

Deno.test("announce: voice is kept only when it is true", () => {
  assertEquals(cleanAnnounce({ voice: true }).voice, true);
  for (const v of [false, "yes", 1, null, undefined]) assertEquals(cleanAnnounce({ voice: v }).voice, false);
});

// the two sides built apart, in one process: the node's real loop against the service's real routes
function wire(chats: Chats, hub: ChatHub, node: string, stop: () => void): Service {
  const send = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const r = await chatRoute(req, new URL(req.url), node, chats, hub, "u1");
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  let polls = 0;
  return {
    url: "https://b.test",
    async call<T>(method: string, path: string, body?: unknown) {
      // the loop is stopped at its third poll: by then the one turn of the test is over
      if (path.startsWith("/api/node/turns") && ++polls > 2) return (stop(), { turns: [] }) as T;
      const r = await send(method, path.replace("wait=25", "wait=0"), body);
      const j = await r.json() as Record<string, unknown>;
      if (!r.ok) throw new ServiceError(`${method} ${path}: ${j.error}`, r.status, j);
      return j as T;
    },
    async bytes(path: string) {
      const r = await send("GET", path);
      if (!r.ok) throw new ServiceError(`GET ${path}: ${(await r.json()).error}`, r.status, {});
      return { type: r.headers.get("content-type") ?? "", data: new Uint8Array(await r.arrayBuffer()) };
    },
  };
}

Deno.test("e2e: a voice note is transcribed by the node's loop, answered, and its audio is gone", async () => {
  const { chats, hub, fleet, voice, call, audioRows } = setup();
  fleet.announce("desk", ann({ voice: true }) as never);
  const v = await voice(null);
  const ctl = new AbortController();
  const run: Runner = (text, _o, onEvent) => {
    onEvent({ t: "text", d: `Capito: ${text}` });
    return Promise.resolve({ t: "done", text: `Capito: ${text}`, code: null });
  };
  const svc = wire(chats, hub, "desk", () => ctl.abort());
  await turnLoop({
    log: () => {},
    signal: ctl.signal,
    config: () => Promise.resolve(cleanNodeConfig({ enabled: true })),
    service: () => Promise.resolve(svc),
    run,
    transcribe: (a) =>
      Promise.resolve(a.data.length === 4 && a.type === "audio/webm" ? "compra il latte" : "wrong audio"),
    sleep: () => Promise.resolve(),
    batchMs: 5,
  });
  const chat = (await call(null, "GET", `/api/chats/${v.body.chat.id}`)).body.chat;
  assertEquals([chat.title, chat.turns[0].q, chat.turns[0].a, chat.turns[0].state], [
    "compra il latte",
    "compra il latte",
    "Capito: compra il latte",
    "done",
  ]);
  assertEquals(audioRows(), 0);
});

Deno.test("e2e: cancelling a running turn stops the node's run and leaves the turn cancelled", async () => {
  const { chats, hub, fleet, call } = setup();
  fleet.announce("desk", ann() as never);
  const c = (await call(null, "POST", "/api/chats", { text: "long job" })).body;
  const ctl = new AbortController();
  const logs: string[] = [];
  let ended = false;
  const run: Runner = (_t, o, onEvent) => {
    onEvent({ t: "text", d: "step one" });
    // the person cancels while Claude works; the node learns it at its next post
    void call(null, "POST", `/api/turns/${c.turn.id}/cancel`);
    return new Promise((res) => {
      o.signal!.addEventListener("abort", () => {
        ended = true;
        res({ t: "done", text: "step one", code: null, error: "killed" });
      });
    });
  };
  const svc = wire(chats, hub, "desk", () => ctl.abort());
  await turnLoop({
    log: (m) => logs.push(m),
    signal: ctl.signal,
    config: () => Promise.resolve(cleanNodeConfig({ enabled: true })),
    service: () => Promise.resolve(svc),
    run,
    sleep: () => Promise.resolve(),
    batchMs: 5,
  });
  assert(ended, "the run was stopped");
  assert(logs.some((l) => l.includes("was cancelled")), logs.join("|"));
  assertEquals(chats.get(c.chat.id)!.turns[0].state, "cancelled");
});
