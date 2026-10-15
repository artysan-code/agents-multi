// Tests for the web app's pure helpers (apps/ui/src/web/lib.ts): the chat stream applied to a conversation,
// the day groups, the task sections, the hash routes, the node order and the notification advice.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  actKind,
  answersOf,
  applyEvent,
  cancellable,
  deviceName,
  endorsed,
  explainError,
  filterChats,
  groupByDay,
  hashOf,
  isIos,
  keyBytes,
  localDay,
  memUsed,
  moved,
  normalizeCode,
  online,
  orderOf,
  parseHash,
  parseTasks,
  type Passkey,
  pending,
  pushAdvice,
  retryable,
  sendsOnEnter,
  showCode,
  tabOf,
  taskSections,
  themeOf,
  type Turn,
  waitingCount,
} from "../../ui/src/web/lib.ts";
import {
  answerChallenge,
  answerText,
  b64u,
  creationOptions,
  declineChallenge,
  declineText,
  expiryFrom,
  jobChallenge,
  requestHash,
  unb64u,
} from "../../ui/src/web/webauthn-core.ts";
import {
  intentOf,
  neighbour,
  rowCommits,
  rowFollow,
  rubber,
  settle,
  springDone,
  springStep,
  velocityOf,
} from "../../ui/src/web/gesture.ts";
import {
  clock,
  extOf,
  joinDictation,
  levelOf,
  MAX_BYTES,
  MAX_SECONDS,
  pickRecorderType,
  pushLevel,
  slidCancel,
  speechLang,
} from "../../ui/src/web/voice-core.ts";
import { canonical, signedText } from "../../../shared/mcp/lib/nodes.ts";
import { toFile } from "../../../shared/mcp/lib/tasks/format.ts";
import type { Task } from "../../../shared/mcp/lib/tasks/types.ts";

const turn = (id: string, over: Partial<Turn> = {}): Turn => ({
  id,
  q: "q",
  a: "",
  acts: [],
  state: "waiting",
  node: null,
  created: "2026-10-15T10:00:00Z",
  ...over,
});

Deno.test("web: the chat stream builds the answer, turn by turn", () => {
  let turns = [turn("t1", { state: "done", a: "old" }), turn("t2")];
  turns = applyEvent(turns, "turn", { turn: "t2", state: "running", node: "mac" })!;
  assertEquals(turns[1].state, "running");
  assertEquals(turns[1].node, "mac");
  turns = applyEvent(turns, "text", { turn: "t2", d: "Hel" })!;
  turns = applyEvent(turns, "text", { turn: "t2", d: "lo" })!;
  assertEquals(turns[1].a, "Hello");
  turns = applyEvent(turns, "act", { turn: "t2", k: "tasks", n: "tasks_add", d: "Call Ann" })!;
  turns = applyEvent(turns, "act", { turn: "t2", k: "brain", n: "brain_read" })!;
  assertEquals(turns[1].acts, [{ k: "tasks", n: "tasks_add", d: "Call Ann" }, { k: "brain", n: "brain_read" }]);
  turns = applyEvent(turns, "done", { turn: "t2", a: "Hello, Sam." })!;
  assertEquals([turns[1].state, turns[1].a], ["done", "Hello, Sam."]);
  assertEquals(turns[0].a, "old"); // the other turns are not touched
});

Deno.test("web: a piece of text moves a waiting turn to running; a failed turn stays failed; an unknown turn asks for a reload", () => {
  const a = applyEvent([turn("t1")], "text", { turn: "t1", d: "x" })!;
  assertEquals(a[0].state, "running");
  const failed = applyEvent([turn("t1")], "turn", { turn: "t1", state: "failed", error: "node lost" })!;
  assertEquals([failed[0].state, failed[0].error], ["failed", "node lost"]);
  assertEquals(applyEvent(failed, "done", { turn: "t1", a: "partial" })![0].state, "failed");
  assertEquals(applyEvent([turn("t1")], "text", { turn: "other", d: "x" }), null);
  const same = [turn("t1")];
  assertEquals(applyEvent(same, "ping", { turn: "t1" }), same);
  // the input is never changed
  assertEquals(same[0].a, "");
});

Deno.test("web: the chat list is grouped by the day on the viewer's clock", () => {
  const now = new Date(2026, 9, 15, 12, 0);
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
  const chats = [
    { id: "a", updated: at(15, 11) },
    { id: "b", updated: at(15, 8) },
    { id: "c", updated: at(14, 23) },
    { id: "d", updated: at(9, 9) },
    { id: "e", updated: at(9, 7) },
    { id: "f", updated: at(1, 9) },
  ];
  const g = groupByDay(chats, (c) => c.updated, now);
  assertEquals(g.map((x) => [x.day, x.items.map((c) => c.id).join("")]), [
    ["today", "ab"],
    ["yesterday", "c"],
    ["2026-10-09", "de"],
    ["2026-10-01", "f"],
  ]);
  assertEquals(groupByDay([], () => "", now), []);
  assertEquals(localDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  // across a month's end
  assertEquals(
    groupByDay([{ u: new Date(2026, 8, 30, 10).toISOString() }], (x) => x.u, new Date(2026, 9, 1, 9))[0].day,
    "yesterday",
  );
});

const task = (id: string, over: Partial<Task>): Task => ({
  id,
  title: id,
  status: "todo",
  created: "2026-10-01T08:00:00Z",
  updated: "2026-10-01T08:00:00Z",
  ...over,
});

Deno.test("web: tasks are today with times first, overdue oldest first, and what was done today", () => {
  const now = new Date(2026, 9, 15, 12, 0);
  const tasks = [
    task("t-untimed", { due: "2026-10-15", priority: 2 }),
    task("t-late", { due: "2026-10-15", time: "16:30" }),
    task("t-early", { due: "2026-10-15", time: "09:00" }),
    task("t-over2", { due: "2026-10-13" }),
    task("t-over1", { due: "2026-10-10", time: "10:00" }),
    task("t-future", { due: "2026-10-16" }),
    task("t-nodue", {}),
    task("t-dropped", { due: "2026-10-12", status: "dropped" }),
    task("t-done", { due: "2026-10-15", status: "done", done: new Date(2026, 9, 15, 8, 0).toISOString() }),
    task("t-done-old", { status: "done", done: new Date(2026, 9, 14, 8, 0).toISOString() }),
  ];
  const s = taskSections(tasks, now);
  assertEquals(s.day, "2026-10-15");
  assertEquals(s.today.map((t) => t.id), ["t-early", "t-late", "t-untimed"]);
  assertEquals(s.overdue.map((t) => t.id), ["t-over1", "t-over2"]);
  assertEquals(s.done.map((t) => t.id), ["t-done"]);
});

Deno.test("web: the task files the service returns are read, and what is not a task file is left out", () => {
  const t = task("t-abc", { due: "2026-10-15", time: "10:30", title: "Call Ann", notes: "- [ ] dial" });
  const parsed = parseTasks([toFile(t), "not a task", "---\nid: x\n---\n"]);
  assertEquals(parsed.length, 1);
  assertEquals([parsed[0].id, parsed[0].title, parsed[0].time], ["t-abc", "Call Ann", "10:30"]);
});

Deno.test("web: the hash names a view, and a chat or a brain page", () => {
  assertEquals(parseHash(""), { view: "chat" });
  assertEquals(parseHash("#"), { view: "chat" });
  assertEquals(parseHash("#tasks"), { view: "tasks" });
  assertEquals(parseHash("#chat/c-12"), { view: "chat", id: "c-12" });
  assertEquals(parseHash("#chat/new"), { view: "chat", id: "new" });
  assertEquals(parseHash("#brain/progetti%2Fagents-multi"), { view: "brain", id: "progetti/agents-multi" });
  assertEquals(parseHash("#/machines"), { view: "machines" });
  assertEquals(parseHash("#waiting"), { view: "waiting" });
  assertEquals(parseHash("#more"), { view: "more" });
  assertEquals(parseHash("#settings"), { view: "chat" }); // the old name of More
  assertEquals(parseHash("#tasks/ignored"), { view: "tasks" });
  assertEquals(parseHash("#nowhere"), { view: "chat" });
  assertEquals(parseHash("#brain/%E0%A4%A"), { view: "brain" });
  for (
    const r of [{ view: "chat" as const }, { view: "chat" as const, id: "c-1" }, {
      view: "brain" as const,
      id: "a b/c",
    }]
  ) {
    assertEquals(parseHash(hashOf(r)), r);
  }
});

Deno.test("web: a node is online when it announced within 90 s of the service's clock", () => {
  const now = "2026-10-15T10:00:00.000Z";
  assert(online({ seen: "2026-10-15T09:59:00.000Z" }, now));
  assert(!online({ seen: "2026-10-15T09:58:00.000Z" }, now));
});

Deno.test("web: the order of the nodes keeps what the account set and adds the rest", () => {
  assertEquals(orderOf(["b", "gone", "a", "b"], ["a", "b", "c", "d"]), ["b", "a", "c", "d"]);
  assertEquals(orderOf([], ["z", "a"]), ["a", "z"]);
  assertEquals(moved(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assertEquals(moved(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
  const l = ["a", "b"];
  assertEquals(moved(l, 0, -1), l);
  assertEquals(moved(l, 1, 1), l);
});

Deno.test("web: notification advice puts the home screen first on iOS, then what the browser can do", () => {
  const e = { hasApi: true, ios: false, standalone: false, permission: "default" };
  assertEquals(pushAdvice(e), "ready");
  assertEquals(pushAdvice({ ...e, permission: "denied" }), "denied");
  assertEquals(pushAdvice({ ...e, hasApi: false }), "unsupported");
  // Safari's tab on iOS has no push API at all: the answer is to install, not «unsupported»
  assertEquals(pushAdvice({ ...e, ios: true, hasApi: false }), "install");
  assertEquals(pushAdvice({ ...e, ios: true }), "install");
  assertEquals(pushAdvice({ ...e, ios: true, standalone: true }), "ready");
});

Deno.test("web: iOS and the device's name come from the user agent", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const ipadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  assert(isIos(iphone));
  assert(isIos(ipadDesktop, 5));
  assert(!isIos(ipadDesktop, 0));
  assertEquals(deviceName(iphone), "iPhone");
  assertEquals(deviceName(ipadDesktop, 5), "iPad");
  assertEquals(deviceName(ipadDesktop), "Mac");
  assertEquals(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), "Android");
  assertEquals(deviceName("Mozilla/5.0 (X11; Linux x86_64)"), "Linux");
  assertEquals(deviceName("curl/8"), "Browser");
});

Deno.test("web: the VAPID key is URL-safe base64 turned into bytes", () => {
  assertEquals([...keyBytes("AQID")], [1, 2, 3]);
  assertEquals([...keyBytes("-_8")], [251, 255]); // - and _ are + and /, the padding is added
  assertEquals(keyBytes("").length, 0);
});

Deno.test("web: Machines belongs to the More tab, every other view to its own", () => {
  assertEquals(tabOf("machines"), "more");
  assertEquals(tabOf("waiting"), "waiting");
  assertEquals(tabOf("chat"), "chat");
});

Deno.test("web: what waits is the requests plus the jobs only proposed", () => {
  const job = (status: string) => ({ id: status, status }) as never;
  const req = { id: "a/b" } as never;
  assertEquals(waitingCount(null), 0);
  assertEquals(waitingCount({ requests: [req, req], jobs: [job("proposed"), job("accepted"), job("declined")] }), 3);
  assertEquals(waitingCount({ requests: [], jobs: [job("running")] }), 0);
});

Deno.test("web: a passkey with no endorsement is pending and cannot answer", () => {
  const k = (id: string, endorsement: string | null): Passkey => ({
    id,
    name: id,
    publicKey: "p",
    endorsement,
    created: "2026-10-15T10:00:00Z",
  });
  const keys = [k("a", "sig"), k("b", null), k("c", "sig")];
  assertEquals(endorsed(keys).map((x) => x.id), ["a", "c"]);
  assertEquals(pending(keys).map((x) => x.id), ["b"]);
});

Deno.test("web: the answers of a question are complete only when every question has one", () => {
  const qs = [
    { question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
    { question: "Which tags?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] },
  ];
  assertEquals(answersOf(qs, {}), null);
  assertEquals(answersOf(qs, { "Which database?": ["SQLite"] }), null);
  assertEquals(answersOf(qs, { "Which database?": ["SQLite"], "Which tags?": ["a", "b"] }), {
    "Which database?": "SQLite",
    "Which tags?": "a, b",
  });
  assertEquals(answersOf([], {}), {});
});

Deno.test("web: a change is of the kind its tool says, and only a failed turn is retried", () => {
  assertEquals(actKind("tasks_add"), "task");
  assertEquals(actKind("brain_edit"), "brain");
  assertEquals(actKind("calendar_create"), "calendar");
  assertEquals(actKind("gmail_draft"), "mail");
  assertEquals(actKind("routine_add"), "job");
  assertEquals(actKind("Bash"), "other");
  assertEquals(retryable({ state: "failed" }), true);
  assertEquals(retryable({ state: "done" }), false);
  assertEquals(retryable({ state: "cancelled" }), true);
  assertEquals([
    cancellable({ state: "waiting" }),
    cancellable({ state: "running" }),
    cancellable({ state: "cancelled" }),
  ], [true, true, false]);
});

Deno.test("web: a voice note's words arrive as the question; a cancelled turn stays cancelled when its done comes", () => {
  let turns = [turn("v1", { voice: true, q: "" })];
  turns = applyEvent(turns, "transcript", { turn: "v1", text: "call the accountant" })!;
  assertEquals([turns[0].q, turns[0].voice], ["call the accountant", true]);
  turns = applyEvent(turns, "turn", { turn: "v1", state: "cancelled" })!;
  turns = applyEvent(turns, "done", { turn: "v1", a: "" })!;
  assertEquals(turns[0].state, "cancelled");
  // a transcript with no words changes nothing
  assertEquals(applyEvent(turns, "transcript", { turn: "v1" }), turns);
});

Deno.test("web: the chat list is searched by the words of the title, any order, any case", () => {
  const chats = [{ title: "Plan for today" }, { title: "Release notes wording" }, { title: "" }];
  assertEquals(filterChats(chats, "").length, 3);
  assertEquals(filterChats(chats, "NOTES release"), [chats[1]]);
  assertEquals(filterChats(chats, "zzz"), []);
  assertEquals(filterChats(chats, "new", "New conversation"), [chats[2]]);
});

Deno.test("web: a passkey error shows the browser's name and message, with a hint for the names a person can act on", () => {
  assertEquals(explainError({ name: "NotAllowedError", message: "timed out" }, true), {
    name: "NotAllowedError",
    message: "timed out",
    hint: "NotAllowedError",
  });
  assertEquals(explainError({ name: "InvalidStateError", message: "x" }, true).hint, "InvalidStateError");
  assertEquals(explainError({ name: "SecurityError", message: "x" }, true).hint, "SecurityError");
  // an error of the service has no name to show and no hint
  assertEquals(explainError({ name: "Error", message: "no such code" }, false), {
    name: null,
    message: "no such code",
    hint: null,
  });
  assertEquals(explainError({ name: "WeirdError", message: "m" }, true), {
    name: "WeirdError",
    message: "m",
    hint: null,
  });
});

Deno.test("web: the theme is light, dark or the device's", () => {
  assertEquals([themeOf("light"), themeOf("dark"), themeOf(null), themeOf("blue")], [
    "light",
    "dark",
    "system",
    "system",
  ]);
});

Deno.test("web: Enter sends on a desktop and breaks the line on a touch screen; Ctrl or Cmd+Enter sends anywhere", () => {
  const e = (over = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, ...over });
  assertEquals(sendsOnEnter(e(), true), true);
  assertEquals(sendsOnEnter(e({ shiftKey: true }), true), false);
  assertEquals(sendsOnEnter(e(), false), false);
  assertEquals(sendsOnEnter(e({ ctrlKey: true }), false), true);
  assertEquals(sendsOnEnter(e({ metaKey: true }), false), true);
  assertEquals(sendsOnEnter(e({ isComposing: true }), true), false); // an IME choosing a character
  assertEquals(sendsOnEnter(e({ key: "a" }), true), false);
});

Deno.test("web: a pairing code is read as Crockford base32 and shown in two groups of four", () => {
  assertEquals(normalizeCode("abcd-ef12"), "ABCDEF12");
  assertEquals(normalizeCode("o0il 1l"), "0011" + "11");
  assertEquals(normalizeCode("ABCD EFGH JKMN"), "ABCDEFGH"); // at most eight
  assertEquals(showCode("ABCD"), "ABCD");
  assertEquals(showCode("ABCDEF"), "ABCD-EF");
  assertEquals(showCode(normalizeCode("abcdef12")), "ABCD-EF12");
});

Deno.test("web: memory in use is a percentage, and 0 when the node did not say", () => {
  assertEquals(memUsed({ memTotal: 32e9, memFree: 16e9 }), 50);
  assertEquals(memUsed({ memTotal: 8e9, memFree: 9e9 }), 0); // free cannot exceed total
  assertEquals(memUsed({ memTotal: 0, memFree: 0 }), 0);
});

const sha = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

Deno.test("web: base64url round-trips bytes, without padding", () => {
  const bytes = Uint8Array.from([0, 250, 251, 252, 253, 254, 255, 1]);
  const text = b64u(bytes);
  assert(!/[+/=]/.test(text));
  assertEquals(unb64u(text), bytes);
  assertEquals(b64u(new Uint8Array([]).buffer), "");
});

Deno.test("web: the challenge of an answer (v2) is SHA-256 of the contract's text, keys in order, no answers when there are none, the request's hash inside", async () => {
  const body = {
    id: "ch-1/rq-1",
    node: "studio",
    verdict: "allow" as const,
    expires: "2026-10-15T10:05:00.000Z",
    what: "HASH",
  };
  assertEquals(
    answerText(body),
    'agents-multi answer v2\n{"expires":"2026-10-15T10:05:00.000Z","id":"ch-1/rq-1","node":"studio","verdict":"allow","what":"HASH"}',
  );
  assertEquals(await answerChallenge(body), await sha(answerText(body)));
  const withAnswers = { ...body, answers: { "Which?": "SQLite" } };
  assertEquals(
    answerText(withAnswers),
    `agents-multi answer v2\n${
      canonical({
        answers: { "Which?": "SQLite" },
        expires: body.expires,
        id: body.id,
        node: body.node,
        verdict: "allow",
        what: "HASH",
      })
    }`,
  );
  // another verdict, another challenge: a yes cannot be replayed as a no
  assert(b64u(await answerChallenge({ ...body, verdict: "deny" })) !== b64u(await answerChallenge(body)));
  // other words, another challenge: the signature belongs to what the person saw
  assert(b64u(await answerChallenge({ ...body, what: "OTHER" })) !== b64u(await answerChallenge(body)));
});

Deno.test("web: the request's hash is the base64url SHA-256 of the canonical {what, questions}, questions left out when absent", async () => {
  const q = [{ question: "Which?", options: [{ label: "A" }] }];
  assertEquals(await requestHash({ what: "git push" }), b64u(await sha('{"what":"git push"}')));
  assertEquals(
    await requestHash({ what: "w", questions: q }),
    b64u(await sha(canonical({ what: "w", questions: q }))),
  );
  assert((await requestHash({ what: "a" })) !== (await requestHash({ what: "b" })));
});

Deno.test("web: declining a job signs its own text, which an accept cannot be replayed as", async () => {
  const job = {
    id: "j-1",
    node: "hetzner",
    kind: "routine" as const,
    spec: { name: "Backup", repo: "git@x:me/b.git", path: "", action: { kind: "child" } },
  };
  const expires = "2026-10-16T10:05:00.000Z";
  assert(declineText(job, expires).startsWith("agents-multi job decline v1\n{"));
  assertEquals(await declineChallenge(job, expires), await sha(declineText(job, expires)));
  assert(b64u(await declineChallenge(job, expires)) !== b64u(await jobChallenge(job, expires)));
});

Deno.test("web: the challenge of accepting a job is SHA-256 of the text the desktop signs", async () => {
  const job = {
    id: "j-1",
    node: "hetzner",
    kind: "routine" as const,
    spec: { name: "Backup", repo: "git@x:me/b.git", path: "", action: { kind: "child" } },
  };
  const expires = "2026-10-15T10:05:00.000Z";
  assertEquals(await jobChallenge(job, expires), await sha(signedText({ ...job, expires } as never)));
});

Deno.test("web: an answer expires five minutes ahead, inside the contract's ten", () => {
  assertEquals(expiryFrom(new Date("2026-10-15T10:00:00.000Z")), "2026-10-15T10:05:00.000Z");
});

Deno.test("web: the creation options of the service become the bytes WebAuthn takes, bare or inside publicKey", () => {
  const raw = {
    challenge: b64u(Uint8Array.from([1, 2, 3])),
    rp: { name: "Agents Multi" },
    user: { id: b64u(Uint8Array.from([9, 8])), name: "me" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ id: b64u(Uint8Array.from([7])), type: "public-key" }],
  };
  for (const input of [raw, { publicKey: raw }]) {
    const o = creationOptions(input);
    assertEquals(o.challenge, Uint8Array.from([1, 2, 3]));
    assertEquals(o.user.id, Uint8Array.from([9, 8]));
    assertEquals(o.user.displayName, "me");
    assertEquals(o.excludeCredentials[0].id, Uint8Array.from([7]));
    assertEquals(o.rp, { name: "Agents Multi" });
  }
});

Deno.test("gesture: sideways wins only when it clearly does; a short move says nothing", () => {
  assertEquals(intentOf(3, 2), null);
  assertEquals(intentOf(30, 5), "h");
  assertEquals(intentOf(-30, 5), "h");
  assertEquals(intentOf(20, 20), "v");
  assertEquals(intentOf(4, 40), "v");
});

Deno.test("gesture: a drag commits past a third of the width or with a flick; otherwise it comes back", () => {
  assertEquals(settle(-150, 0, 390), "forward");
  assertEquals(settle(150, 0, 390), "back");
  assertEquals(settle(-60, 0, 390), "stay");
  assertEquals(settle(-60, -0.8, 390), "forward");
  // a flick against the drag does not count
  assertEquals(settle(-60, 0.8, 390), "stay");
});

Deno.test("gesture: past the last tab the view resists, and a tab has a neighbour only where there is one", () => {
  assert(Math.abs(rubber(-400, 80)) < 80);
  assert(Math.abs(rubber(-100, 80)) < 100);
  assertEquals(Math.sign(rubber(-50, 80)), -1);
  const tabs = ["a", "b", "c"];
  assertEquals(neighbour(tabs, "b", -10), "c");
  assertEquals(neighbour(tabs, "b", 10), "a");
  assertEquals(neighbour(tabs, "c", -10), null);
  assertEquals(neighbour(tabs, "a", 10), null);
  assertEquals(neighbour(tabs, "x", -10), null);
});

Deno.test("gesture: a row follows only toward an action and acts past its distance or on a flick", () => {
  assertEquals(rowFollow(80, false, true, 390), 0);
  assertEquals(rowFollow(-80, false, true, 390), -80);
  assert(rowFollow(300, true, false, 390) < 300);
  assert(rowFollow(300, true, false, 390) > 120);
  assertEquals(rowCommits(100, 0, 390), true);
  assertEquals(rowCommits(50, 0, 390), false);
  assertEquals(rowCommits(50, 0.9, 390), true);
  assertEquals(rowCommits(50, -0.9, 390), false);
});

Deno.test("gesture: speed is read from the last 100 ms of the drag, and the spring ends where it is sent", () => {
  assertEquals(velocityOf([{ x: 0, t: 0 }]), 0);
  assertEquals(velocityOf([{ x: 0, t: 0 }, { x: 100, t: 400 }, { x: 150, t: 450 }, { x: 200, t: 500 }]), 1);
  let x = 120, v = 0;
  for (let i = 0; i < 200 && !springDone(x, v, 0); i++) [x, v] = springStep(x, v, 0, 1 / 60);
  assert(springDone(x, v, 0));
  // it overshoots a little when it is thrown, and does not run away
  let y = 0, w = -3000, low = 0;
  for (let i = 0; i < 300; i++) {
    [y, w] = springStep(y, w, 0, 1 / 60);
    low = Math.min(low, y);
  }
  assert(low > -400 && Math.abs(y) < 1);
});

Deno.test("voice: Opus in WebM first, AAC in MP4 on iOS, nothing when the browser says none", () => {
  assertEquals(pickRecorderType(() => true), { mime: "audio/webm;codecs=opus", ext: "webm" });
  assertEquals(pickRecorderType((m) => m.startsWith("audio/mp4")), { mime: "audio/mp4;codecs=mp4a.40.2", ext: "m4a" });
  assertEquals(pickRecorderType(() => false), null);
  assertEquals([extOf("audio/mp4"), extOf("audio/webm;codecs=opus"), extOf("audio/ogg")], ["m4a", "webm", "ogg"]);
  assertEquals([MAX_SECONDS, MAX_BYTES], [300, 10 * 1024 * 1024]);
});

Deno.test("voice: the clock, the meter and the slide to cancel", () => {
  assertEquals([clock(0), clock(7.9), clock(65), clock(299)], ["0:00", "0:07", "1:05", "4:59"]);
  assertEquals(levelOf(new Uint8Array([128, 128, 128])), 0);
  assert(levelOf(new Uint8Array([0, 255, 0, 255])) > 0.9);
  assertEquals(levelOf([]), 0);
  assertEquals(pushLevel([1, 2, 3], 4, 3), [2, 3, 4]);
  assertEquals([slidCancel(-100, 0), slidCancel(-20, 0), slidCancel(0, -150), slidCancel(0, -20)], [
    true,
    false,
    true,
    false,
  ]);
});

Deno.test("voice: dictation listens in the app's language and joins the words after what was written", () => {
  assertEquals(speechLang("it", "it-IT"), "it-IT");
  assertEquals(speechLang("it", "en-GB"), "it-IT");
  assertEquals(speechLang("en", "en_GB"), "en-GB");
  assertEquals(speechLang("en", "it-IT"), "en-US");
  assertEquals(joinDictation("", "hello there"), "hello there");
  assertEquals(joinDictation("Remind me ", "to call"), "Remind me to call");
  assertEquals(joinDictation("kept", "  "), "kept");
});
