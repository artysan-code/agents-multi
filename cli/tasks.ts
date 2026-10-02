// tasks.ts — `claude-multi tasks …`: the task list from the terminal, the desktop reminders the
// timer sends (claude-tasks.timer → `tasks remind`, every five minutes), and `migrate`, which moves
// the old task files into the brain.
//
// The list itself is shared/mcp/lib/tasks.ts; the MCP server `tasks` is how Claude reads and keeps
// it in every chat. Here: a brief to read, a quick add, done, and the reminders — the briefs at the
// times in ~/brains/tasks/settings.json, and a warning before each timed task. Which notifications
// went out is per machine (XDG state): each machine that is on reminds, none of them twice.

import { ANSI, readJson, STATE, uiLanguage } from "./lib.ts";
import { desktopNotify } from "./notify.ts";
import { calendarAsTasks } from "./agenda.ts";
import {
  addTask, brief, dayOf, dueBriefs, dueReminders, fromFile, listTasks, loadSettings, type Task, tasksRoot, updateTask,
} from "../shared/mcp/lib/tasks.ts";
import { brainAccount, brainStore, connectTasks } from "../shared/mcp/lib/brain-tasks.ts";
import { getSecret } from "../shared/mcp/lib/vault.ts";

const SENT = `${STATE}/tasks-sent.json`;
const it = uiLanguage(Deno.env.toObject()) === "it";

const line = (t: Task) => [t.time, t.title, t.project ? `[${t.project}]` : null].filter(Boolean).join(" ");

/** Pure: the brief as a notification body, a few lines at most. */
export function briefText(b: ReturnType<typeof brief>, lang: "it" | "en"): { title: string; body: string; empty: boolean } {
  const L = lang === "it"
    ? { morning: "Buongiorno", afternoon: "Pomeriggio", evening: "Stasera", nothing: "niente in agenda", overdue: "in ritardo", missed: "saltate", later: "da fare", tomorrow: "domani", waiting: "in attesa di altri" }
    : { morning: "Good morning", afternoon: "This afternoon", evening: "This evening", nothing: "nothing planned", overdue: "overdue", missed: "missed", later: "to do", tomorrow: "tomorrow", waiting: "waiting on others" };
  const parts: string[] = [];
  const list = (xs: Task[], n = 4) => xs.slice(0, n).map(line).join(" · ") + (xs.length > n ? ` · +${xs.length - n}` : "");
  if (b.overdue.length) parts.push(`${L.overdue}: ${list(b.overdue, 2)}`);
  if (b.missed.length) parts.push(`${L.missed}: ${list(b.missed, 2)}`);
  const ahead = b.moment === "evening" ? b.tomorrow : b.today;
  if (ahead.length) parts.push(`${b.moment === "evening" ? L.tomorrow : L.later}: ${list(ahead)}`);
  if (b.waiting.length) parts.push(`${L.waiting}: ${b.waiting.length}`);
  return { title: `claude-multi — ${L[b.moment]}`, body: parts.join("\n") || L.nothing, empty: !parts.length };
}

async function remind(dry: boolean): Promise<number> {
  const now = new Date();
  const [own, settings, cal] = await Promise.all([listTasks(), loadSettings(), calendarAsTasks()]);
  // the day is tasks and appointments: calendar events brief and remind like timed tasks
  const tasks = [...own, ...cal.tasks];
  const state = await readJson<{ sent: string[] }>(SENT) ?? { sent: [] };
  const sent = new Set(state.sent);
  let n = 0;
  for (const b of dueBriefs(settings, now, sent)) {
    const t = briefText(brief(tasks, now), it ? "it" : "en");
    // a brief with nothing in it is not sent: silence says the same, without interrupting
    if (!t.empty) await desktopNotify(t.title, t.body, { dryRun: dry });
    sent.add(`brief@${dayOf(now)}T${b}`);
    n++;
  }
  for (const r of dueReminders(tasks, now, sent, settings.remind)) {
    await desktopNotify(`${r.task.time} · ${r.task.title}`, [r.task.source === "calendar" ? (it ? "calendario" : "calendar") : null, r.task.project, it ? "tra poco" : "coming up"].filter(Boolean).join(" · "), { dryRun: dry });
    sent.add(r.key);
    n++;
  }
  if (!dry && n) {
    // only the last week of keys is worth keeping: older ones can never be due again
    const week = dayOf(new Date(now.getTime() - 7 * 864e5));
    const keep = [...sent].filter((k) => (k.match(/@(\d{4}-\d{2}-\d{2})/)?.[1] ?? "") >= week);
    await Deno.mkdir(STATE, { recursive: true });
    await Deno.writeTextFile(SENT, JSON.stringify({ sent: keep }, null, 2) + "\n");
  }
  return 0;
}

function print(title: string, xs: Task[]) {
  if (!xs.length) return;
  console.log(`\n  ${ANSI.b}${title}${ANSI.x}`);
  for (const t of xs) console.log(`    ${t.due && t.due !== dayOf(new Date()) ? `${ANSI.d}${t.due}${ANSI.x} ` : ""}${t.time ? `${ANSI.c}${t.time}${ANSI.x} ` : ""}${t.title}${t.project ? ` ${ANSI.d}[${t.project}]${ANSI.x}` : ""}${t.owner && t.owner !== "samuel" ? ` ${ANSI.y}(${t.owner})${ANSI.x}` : ""}  ${ANSI.d}#${t.id}${ANSI.x}`);
}

/** The task files of ~/brains/tasks/items copied into the brain, once: those it already has are
 *  left alone, then the folder is renamed so that nothing reads the old list by mistake. */
async function migrate(dry: boolean): Promise<number> {
  const account = brainAccount();
  const token = account && await getSecret("brain", account.name).catch(() => null);
  if (!account || !token) {
    console.error(account ? `no token for the brain on this machine: make one on ${account.url}/account and put it in the console, Connections` : "no brain account in shared/mcp/accounts.json");
    return 1;
  }
  const items = `${tasksRoot()}/items`;
  const local: Task[] = [];
  try {
    for await (const e of Deno.readDir(items)) {
      if (!e.isFile || !/^t-[\w-]+\.md$/.test(e.name)) continue;
      const t = fromFile(await Deno.readTextFile(`${items}/${e.name}`));
      if (t) local.push(t);
    }
  } catch {
    console.log("no local tasks to move");
    return 0;
  }
  const store = brainStore(account.url!, token);
  const there = new Set((await store.list()).map((t) => t.id));
  const todo = local.filter((t) => !there.has(t.id));
  for (const t of todo) {
    console.log(`${dry ? "would move" : "moved"}  ${t.id}  ${t.title}`);
    if (!dry) await store.write(t);
  }
  console.log(`${todo.length} moved, ${local.length - todo.length} already in the brain`);
  if (dry) return 0;
  const aside = `${items}-moved-to-brain-${dayOf(new Date())}`;
  await Deno.rename(items, aside);
  console.log(`the old files are in ${aside}`);
  return 0;
}

export async function tasksCommand(args: string[]): Promise<number> {
  await connectTasks();
  const [sub = "brief", ...rest] = args;
  const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  switch (sub) {
    case "brief": {
      const b = brief([...await listTasks(), ...(await calendarAsTasks()).tasks], new Date());
      console.log(`${ANSI.b}claude-multi tasks${ANSI.x} — ${b.day}`);
      print(it ? "In ritardo" : "Overdue", b.overdue);
      print(it ? "Saltate oggi" : "Missed today", b.missed);
      print(it ? "Oggi" : "Today", b.today);
      print(it ? "Domani" : "Tomorrow", b.tomorrow);
      print(it ? "Prossimi giorni" : "Next days", b.upcoming);
      print(it ? "In attesa di altri" : "Waiting on others", b.waiting);
      print(it ? "Senza data" : "No date", b.undated.slice(0, 10));
      return 0;
    }
    case "add": {
      const title = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--")).join(" ");
      const t = await addTask({ title, due: opt("--due"), time: opt("--time"), project: opt("--project"), owner: opt("--owner") });
      console.log(`added #${t.id}`);
      return 0;
    }
    case "done": {
      if (!rest[0]) { console.error("usage: claude-multi tasks done <id>"); return 2; }
      const r = await updateTask(rest[0].replace(/^#/, ""), { status: "done" });
      console.log(`done: ${r.task.title}${r.next ? ` — next on ${r.next.due}` : ""}`);
      return 0;
    }
    case "remind": return await remind(rest.includes("--dry-run"));
    case "migrate": return await migrate(rest.includes("--dry-run"));
    default:
      console.error("usage: claude-multi tasks [brief|add <title> [--due D] [--time HH:MM] [--project P] [--owner O]|done <id>|remind [--dry-run]|migrate [--dry-run]]");
      return 2;
  }
}
