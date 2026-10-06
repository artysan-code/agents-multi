// Tests for shared/mcp/lib/tasks.ts: the file format, repeats, the brief and the reminders, with a
// fixed clock; the store on a throwaway directory.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

const dir = await Deno.makeTempDir();
Deno.env.set("CLAUDE_MULTI_TASKS", dir);
Deno.env.set("CLAUDE_MULTI_OWNER_ID", "alice"); // whose tasks these are (owner.ts), whatever this machine's config says
const T = await import("../../../shared/mcp/lib/tasks.ts");

const at = (s: string) => new Date(s); // local time, no Z
const task = (over: Partial<import("../../../shared/mcp/lib/tasks.ts").Task>) => ({
  id: "t-x",
  title: "x",
  status: "todo" as const,
  created: "2026-09-29T08:00:00.000Z",
  updated: "2026-09-29T08:00:00.000Z",
  owner: "alice",
  ...over,
});

Deno.test("file format: round trip, quoting, notes after the title", () => {
  const t = task({
    id: "t-20260930-abcdef",
    title: 'Chiamare "Mario": fattura',
    due: "2026-10-01",
    time: "10:30",
    priority: 1,
    notes: "riga uno\n\nriga due",
  });
  const back = T.fromFile(T.toFile(t));
  assertEquals(back, t);
  assertEquals(T.fromFile("not a task"), null);
});

Deno.test("nextDue: daily, weekly, monthly clamped to the month's end, weekdays skip the weekend", () => {
  assertEquals(T.nextDue("2026-09-30", "daily"), "2026-10-01");
  assertEquals(T.nextDue("2026-09-30", "weekly"), "2026-10-07");
  assertEquals(T.nextDue("2026-01-31", "monthly"), "2026-02-28");
  assertEquals(T.nextDue("2026-10-02", "weekdays"), "2026-10-05"); // Friday → Monday
});

Deno.test("applyInput: checks what it is given, null clears", () => {
  const now = at("2026-09-30T10:00:00");
  assertThrows(() => T.applyInput(task({}), { due: "2026-02-30" }, now), Error, "due");
  assertThrows(() => T.applyInput(task({}), { time: "25:00", due: "2026-10-01" }, now), Error, "time");
  assertThrows(() => T.applyInput(task({}), { time: "10:00" }, now), Error, "needs a day");
  assertEquals(T.applyInput(task({ due: "2026-10-01" }), { due: null }, now).due, undefined);
  assertEquals(T.applyInput(task({}), { status: "done" }, now).done, now.toISOString());
});

Deno.test("brief: overdue, missed, the rest of today by time, tomorrow, waiting on others", () => {
  const now = at("2026-09-30T11:00:00");
  const b = T.brief([
    task({ id: "a", title: "old", due: "2026-09-28" }),
    task({ id: "b", title: "at 9", due: "2026-09-30", time: "09:00" }),
    task({ id: "c", title: "at 15", due: "2026-09-30", time: "15:00" }),
    task({ id: "d", title: "sometime today", due: "2026-09-30" }),
    task({ id: "e", title: "tomorrow", due: "2026-10-01" }),
    task({ id: "f", title: "in two days", due: "2026-10-02" }),
    task({ id: "g", title: "Luca sends the quote", owner: "luca" }),
    task({ id: "h", title: "done", status: "done", done: at("2026-09-30T09:30:00").toISOString() }),
  ], now);
  assertEquals(b.overdue.map((t) => t.id), ["a"]);
  assertEquals(b.missed.map((t) => t.id), ["b"]);
  assertEquals(b.today.map((t) => t.id), ["c", "d"]);
  assertEquals(b.tomorrow.map((t) => t.id), ["e"]);
  assertEquals(b.upcoming.map((t) => t.id), ["f"]);
  assertEquals(b.waiting.map((t) => t.id), ["g"]);
  assertEquals(b.doneToday, 1);
  assertEquals(b.moment, "morning");
});

Deno.test("reminders: from the warning time, once, never more than an hour late", () => {
  const t = task({ id: "r", due: "2026-09-30", time: "15:00", remind: 10 });
  assertEquals(T.dueReminders([t], at("2026-09-30T14:49:00"), new Set(), 15).length, 0);
  const due = T.dueReminders([t], at("2026-09-30T14:51:00"), new Set(), 15);
  assertEquals(due.length, 1);
  assertEquals(T.dueReminders([t], at("2026-09-30T14:55:00"), new Set([due[0].key]), 15).length, 0);
  assertEquals(T.dueReminders([t], at("2026-09-30T16:30:00"), new Set(), 15).length, 0);
});

Deno.test("dueBriefs: reached today, within the hour, once", () => {
  const s = { briefs: ["08:30", "13:30", "bad"], remind: 15 };
  assertEquals(T.dueBriefs(s, at("2026-09-30T08:40:00"), new Set()), ["08:30"]);
  assertEquals(T.dueBriefs(s, at("2026-09-30T08:40:00"), new Set(["brief@2026-09-30T08:30"])), []);
  assertEquals(T.dueBriefs(s, at("2026-09-30T12:00:00"), new Set()), []);
});

Deno.test("store: add, complete a repeating task and get the next one, drop instead of delete", async () => {
  const now = at("2026-09-30T10:00:00");
  const t = await T.addTask({ title: "Backup", due: "2026-09-30", repeat: "weekly" }, now);
  assertEquals(t.owner, "alice");
  const { task: done, next } = await T.updateTask(t.id, { status: "done" }, now);
  assertEquals(done.status, "done");
  assertEquals(next?.due, "2026-10-07");
  assertEquals(next?.status, "todo");
  await T.updateTask(next!.id, { status: "dropped" }, now);
  const all = await T.listTasks();
  assertEquals(all.length, 2);
  assert(all.every((x) => x.status === "done" || x.status === "dropped"));
});

Deno.test("briefText: evening looks at tomorrow; nothing to say is marked empty", async () => {
  const { briefText } = await import("../tasks.ts");
  const evening = T.brief(
    [task({ id: "e", title: "Dentista", due: "2026-10-01", time: "09:00" })],
    at("2026-09-30T19:00:00"),
  );
  const t = briefText(evening, "it");
  assertEquals(t.title, "claude-multi — Stasera");
  assertEquals(t.body, "domani: 09:00 Dentista");
  assertEquals(briefText(T.brief([], at("2026-09-30T08:30:00")), "it").empty, true);
});

Deno.test("eventAsTask: timed and all-day events; cancelled and declined ones are not on the agenda", async () => {
  const { eventAsTask } = await import("../agenda.ts");
  const timed = eventAsTask({ id: "e1", summary: "Call", start: { dateTime: "2026-09-30T17:30:00+02:00" } }, "acme")!;
  assertEquals([timed.title, timed.source, timed.project, timed.due], ["Call", "calendar", "acme", "2026-09-30"]);
  assert(/^\d\d:\d\d$/.test(timed.time!));
  assertEquals(eventAsTask({ id: "e2", summary: "Ferie", start: { date: "2026-10-02" } }, "personal")!.time, undefined);
  assertEquals(eventAsTask({ id: "e3", status: "cancelled", start: { date: "2026-10-02" } }, "p"), null);
  assertEquals(
    eventAsTask(
      { id: "e4", start: { date: "2026-10-02" }, attendees: [{ self: true, responseStatus: "declined" }] },
      "p",
    ),
    null,
  );
  // a past appointment is not "missed": it is just past
  const past = { ...timed, due: "2026-09-30", time: "09:00" };
  assertEquals(T.brief([past], at("2026-09-30T11:00:00")).missed.length, 0);
});

Deno.test("steps: read anywhere in the notes, progress, tick by index", () => {
  const notes = "Descrizione.\n\n## Steps\n\n- [ ] uno\n- [x] due\n* [X] tre\n\nfine\n- [ ] quattro";
  assertEquals(T.steps(notes).map((s) => [s.text, s.done]), [["uno", false], ["due", true], ["tre", true], [
    "quattro",
    false,
  ]]);
  assertEquals(T.progress(notes), { done: 2, total: 4, pct: 50 });
  assertEquals(T.progress("niente"), null);
  const ticked = T.setStep(notes, 3);
  assertEquals(T.steps(ticked)[3].done, true);
  assertEquals(T.steps(T.setStep(ticked, 1, false))[1].done, false);
  // the rest of the text is left alone
  assertEquals(T.setStep(notes, 0).replace("- [x] uno", "- [ ] uno"), notes);
});

Deno.test("addStep: a Steps section is created, before the attachments when they are there", () => {
  assertEquals(T.addStep("", "primo"), "## Steps\n\n- [ ] primo\n");
  assertEquals(T.addStep("Testo.", "primo"), "Testo.\n\n## Steps\n\n- [ ] primo\n");
  const two = T.addStep(T.addStep("Testo.", "primo"), "secondo");
  assertEquals(T.steps(two).map((s) => s.text), ["primo", "secondo"]);
  const withAtt = "Testo.\n\n## Allegati\n\n- [a](https://a.it)\n";
  const out = T.addStep(withAtt, "primo");
  assert(out.indexOf("## Steps") < out.indexOf("## Allegati"));
  assertEquals(T.attachments(out).length, 1);
  assertThrows(() => T.addStep("", "  "));
});

Deno.test("attachments: urls, local paths, stored files, wiki pages; add and remove", () => {
  let n = T.addAttachment("Testo.", "https://docs.google.com/x", "Specifiche");
  n = T.addAttachment(n, "/home/someone/work/acme/site/Documento finale.pdf");
  n = T.addAttachment(n, "files/t-1/foto.png");
  n = T.addAttachment(n, "[[projects/claude-multi/visione-assistente]]");
  assertEquals(T.attachments(n), [
    { label: "Specifiche", target: "https://docs.google.com/x", kind: "url" },
    { label: "Documento finale.pdf", target: "/home/someone/work/acme/site/Documento finale.pdf", kind: "path" },
    { label: "foto.png", target: "files/t-1/foto.png", kind: "file" },
    { label: "visione-assistente", target: "projects/claude-multi/visione-assistente", kind: "page" },
  ]);
  const less = T.removeAttachment(n, 1);
  assertEquals(T.attachments(less).map((a) => a.label), ["Specifiche", "foto.png", "visione-assistente"]);
  assertEquals(
    T.attachments("## Allegati\n\n- ~/doc.txt\n\n## Altro\n- non un allegato").map((a) => [a.target, a.kind]),
    [["~/doc.txt", "path"]],
  );
});

Deno.test("updateTask: an editor holding an older version is refused, not overwritten", async () => {
  const t = await T.addTask({ title: "concorrenza" }, at("2026-09-30T09:00:00"));
  await T.updateTask(t.id, { notes: "dalla chat" }, at("2026-09-30T09:05:00"));
  let err: unknown;
  try {
    await T.updateTask(t.id, { notes: "dalla console" }, at("2026-09-30T09:06:00"), t.updated);
  } catch (e) {
    err = e;
  }
  assert(err instanceof T.StaleError);
  assertEquals((await T.getTask(t.id))?.notes, "dalla chat");
});

Deno.test("updateTask: concurrent changes to the notes in one process are all kept", async () => {
  const t = await T.addTask({ title: "in fila" }, at("2026-09-30T10:00:00"));
  await Promise.all([
    T.updateTask(t.id, (c) => ({ notes: T.addStep(c.notes ?? "", "uno") })),
    T.updateTask(t.id, (c) => ({ notes: T.addAttachment(c.notes ?? "", "https://x.it") })),
    T.updateTask(t.id, (c) => ({ notes: T.addStep(c.notes ?? "", "due") })),
  ]);
  const got = await T.getTask(t.id);
  assertEquals(T.steps(got?.notes).map((s) => s.text), ["uno", "due"]);
  assertEquals(T.attachments(got?.notes).length, 1);
});

Deno.test("attachments: names with parentheses and spaces survive a round trip; line breaks are refused", () => {
  const n = T.addAttachment("", "files/t-1/Screenshot (1).png");
  assertEquals(T.attachments(n), [{
    label: "Screenshot (1).png",
    target: "files/t-1/Screenshot (1).png",
    kind: "file",
  }]);
  assertEquals(T.attachments(T.addAttachment("", "report(1).pdf"))[0].target, "report(1).pdf");
  assertThrows(() => T.addAttachment("", "a\nb"));
  assertThrows(() => T.addAttachment("", "a<b>"));
});

Deno.test("fromFile: CRLF files keep their steps; unknown frontmatter keys are written back", () => {
  const crlf =
    '---\r\nid: "t-1"\r\ntitle: "x"\r\nstatus: "todo"\r\ntags: ["a","b"]\r\ncreated: "c"\r\nupdated: "u"\r\n---\r\n\r\n# x\r\n\r\n- [ ] uno\r\n- [x] due\r\n';
  const t = T.fromFile(crlf)!;
  assertEquals(T.progress(t.notes), { done: 1, total: 2, pct: 50 });
  assert(T.toFile(t).includes('tags: ["a","b"]'));
});

Deno.test("applyInput: null clears project, owner and notes", () => {
  const base = task({ project: "work/acme", owner: "ariel", notes: "testo" });
  const t = T.applyInput(base, { project: null, owner: null, notes: null }, at("2026-09-30T10:00:00"));
  assertEquals([t.project, t.owner, t.notes], [undefined, undefined, undefined]);
});

Deno.test("project fields: ref, stage, parent, blocked_by, labels, detail checked, cleaned and kept in the file", () => {
  const now = at("2026-10-05T10:00:00");
  const t = T.applyInput(task({ id: "t-20261005-aaaaaa" }), {
    ref: " TASK-495 ",
    stage: "Release  Pending",
    parent: "#t-20261005-bbbbbb",
    blocked_by: ["t-20261005-cccccc", "#t-20261005-cccccc"],
    labels: ["Permessi", "permessi", " BE "],
    detail: "TASKS.md#task-495",
  }, now);
  assertEquals([t.ref, t.stage, t.parent, t.blocked_by, t.labels, t.detail], [
    "TASK-495",
    "release pending",
    "t-20261005-bbbbbb",
    ["t-20261005-cccccc"],
    ["permessi", "be"],
    "TASKS.md#task-495",
  ]);
  assertEquals(T.fromFile(T.toFile(t)), t);
  const cleared = T.applyInput(t, { ref: null, blocked_by: [], labels: null, parent: null }, now);
  assertEquals([cleared.ref, cleared.blocked_by, cleared.labels, cleared.parent], [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  assert(!T.toFile(cleared).includes("blocked_by"));
  assertThrows(() => T.applyInput(t, { parent: "TASK-1" }, now), Error, "task id");
  assertThrows(() => T.applyInput(t, { parent: t.id }, now), Error, "itself");
  assertThrows(() => T.applyInput(t, { blocked_by: [t.id] }, now), Error, "itself");
  assertThrows(() => T.applyInput(t, { ref: "a\nb" }, now), Error, "ref");
});

Deno.test("addNote / notesOf: dated lines in Log and Decisions, before the attachments; editNotes replaces one passage", () => {
  let n = T.addAttachment("Descrizione", "https://x.test/a", "spec");
  n = T.addNote(n, "log", "su dev\ncon la CI verde", "2026-10-05");
  n = T.addNote(n, "decisions", "opzione C (Alice)", "2026-10-05");
  n = T.addNote(n, "log", "in prod", "2026-10-06");
  assert(n.indexOf("## Log") < n.indexOf("## Attachments") && n.indexOf("## Decisions") < n.indexOf("## Attachments"));
  assertEquals(T.notesOf(n, "log"), [{ day: "2026-10-05", text: "su dev con la CI verde" }, {
    day: "2026-10-06",
    text: "in prod",
  }]);
  assertEquals(T.notesOf(n, "decisions"), [{ day: "2026-10-05", text: "opzione C (Alice)" }]);
  assertEquals(T.attachments(n).length, 1);
  assertEquals(T.editNotes("a b a", "b", "c"), "a c a");
  assertThrows(() => T.editNotes("a b a", "a", "c"), Error, "2 times");
  assertThrows(() => T.editNotes("a b a", "z", "c"), Error, "not in the notes");
});

Deno.test("references: by id or ref, the project first, ambiguity said; relations, blocked, loops", () => {
  const a = task({ id: "t-1", ref: "TASK-430", project: "work/x" });
  const b = task({ id: "t-2", ref: "TASK-495", project: "work/x", blocked_by: ["t-1"], parent: "t-4" });
  const c = task({ id: "t-3", ref: "TASK-495", project: "work/y" });
  const d = task({ id: "t-4", ref: "TASK-500", project: "work/x" });
  const all = [a, b, c, d];
  assertEquals(T.resolveTask(all, "#t-3").id, "t-3");
  assertEquals(T.resolveTask(all, "task-430").id, "t-1");
  assertEquals(T.resolveTask(all, "TASK-495", "work/y").id, "t-3");
  assertThrows(() => T.resolveTask(all, "TASK-495"), Error, "2 tasks");
  assertThrows(() => T.resolveTask(all, "TASK-9"), Error, "no task");
  assertEquals(T.refTaken(all, "task-495", "work/x")?.id, "t-2");
  assertEquals(T.refTaken(all, "TASK-495", "work/x", "t-2"), null);
  assert(T.isBlocked(all, b));
  const r = T.relations(all, d);
  assertEquals([r.parts.map((x) => x.id), r.parts_done], [["t-2"], 0]);
  assertEquals(T.relations(all, a).blocking.map((x) => x.id), ["t-2"]);
  assert(!T.isBlocked([{ ...a, status: "done" }, b, c, d], b));
  assert(T.wouldLoop(all, "t-4", "t-2"));
  assert(!T.wouldLoop(all, "t-2", "t-4"));
});
