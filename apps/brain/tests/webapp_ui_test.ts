// Tests for the web app's pure helpers (apps/ui/src/web/lib.ts): the chat stream applied to a conversation,
// the day groups, the task sections, the hash routes, the node order and the notification advice.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applyEvent,
  deviceName,
  groupByDay,
  hashOf,
  isIos,
  keyBytes,
  localDay,
  moved,
  online,
  orderOf,
  parseHash,
  parseTasks,
  pushAdvice,
  taskSections,
  tidyCode,
  type Turn,
} from "../../ui/src/web/lib.ts";
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

Deno.test("web: a pairing code is tidied as it is typed", () => {
  assertEquals(tidyCode("abcd"), "ABCD");
  assertEquals(tidyCode("abcde"), "ABCD-E");
  assertEquals(tidyCode("ab cd-23 45"), "ABCD-2345");
  assertEquals(tidyCode("ABCD-2345-9999"), "ABCD-2345");
  assertEquals(tidyCode("!?"), "");
});
