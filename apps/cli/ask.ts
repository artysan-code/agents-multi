// ask.ts — the console talks to Claude: the one field at the bottom of the page, the morning debrief,
// and the hand-over to a terminal (resume a session, continue a conversation, open Claude Code in a
// project) and to a session's own window.
//
// The answer comes from `claude -p` in the machine's default profile, as Hey's does, and streams
// back to the page as NDJSON on the response of the POST that asked: one request, one answer, no
// polling. The tools are a fixed list per kind of request and `--permission-mode dontAsk` refuses
// everything else, whatever the profile's own mode: from here Claude reads and keeps the tasks; it
// never sends mail or creates events. A change asked from the Brain page gets the brain's tools and
// nothing else: it writes only there.

import { readJson } from "./lib/fs.ts";
import { BIN, expandHome, HOME, STATE } from "./lib/paths.ts";
import { has } from "./lib/proc.ts";
import { running } from "./lib/processes.ts";
import { launchers } from "./lib/profiles.ts";
import { dayOf } from "../../shared/mcp/lib/tasks.ts";
import { BRAIN as WIKI } from "./brain.ts";
import { owner } from "../../shared/mcp/lib/owner.ts";
import { recordLogin } from "./login.ts";
import { choiceSignature, listCalendars, loadChoice } from "./calendars.ts";

type Json = (v: unknown, code?: number) => Response;
export type AskKind = "ask" | "newtask" | "debrief" | "brain";

// The owner's brain, read only: the claude.ai connector "Brain" of the personal profile, as the CLI names it
const BRAIN_READ = [
  "mcp__claude_ai_Brain__brain_search",
  "mcp__claude_ai_Brain__brain_read",
  "mcp__claude_ai_Brain__brain_list",
];
// what a change to the brain may use: its writing tools, never deletion (brain_delete stays out)
const BRAIN_WRITE = [
  "brain_write",
  "brain_edit",
  "brain_append",
  "brain_move",
  "brain_inbox_clear",
  "brain_check",
  "brain_history",
  "brain_restore",
]
  .map((t) => `mcp__claude_ai_Brain__${t}`);
const READ = [
  "mcp__google__calendar_list",
  "mcp__google__calendar_events",
  "mcp__google__gmail_search",
  "mcp__google__gmail_thread",
  "mcp__google__drive_search",
  "mcp__google__drive_read",
  ...BRAIN_READ,
];
export const TOOLS: Record<AskKind, string[]> = {
  ask: ["mcp__tasks", ...READ],
  newtask: ["mcp__tasks", ...BRAIN_READ],
  debrief: ["mcp__tasks__tasks_brief", "mcp__google__calendar_events", "mcp__google__calendar_list"],
  // and the old wiki, read only, for what is brought over from the Archive
  brain: [...BRAIN_READ, ...BRAIN_WRITE, `Read(/${WIKI}/**)`],
};
/** Claude Code's own tools a kind may use at all (the rules above narrow them): none, except reading the old wiki. */
const BUILTIN: Record<AskKind, string> = { ask: "", newtask: "", debrief: "", brain: "Read" };

const BASE = (now: string, o = owner()) =>
  `You answer inside ${o.name}'s console (agents-multi), in a panel above the field they typed in. Answer in ${o.language} ` +
  `unless they write in another language. No preamble, no closing question. Now: ${now}.`;

/** Pure but for the owner (owner.ts, passed in tests): the instructions for a kind of request. */
export function promptFor(
  kind: AskKind,
  now: string,
  project?: string | null,
  noProject = false,
  o = owner(),
  calendars = "",
): string {
  const base = BASE(now, o), who = o.name;
  if (kind === "newtask") {
    const where = project
      ? `the project "${project}"`
      : noProject
      ? `no project (a simple thing to do)`
      : `a project you work out from what they say`;
    const set = project
      ? `project "${project}"`
      : noProject
      ? "no project"
      : `project: the folder under ~ it belongs to (work/acme/site, ` +
        `personal/blog: look at the existing tasks' projects with tasks_list, or the brain), or none for a simple thing`;
    return `${base}\n${who} is describing a new task for ${where}. Create it with tasks_add: a short, clear title in their ` +
      `words, ${set}, a day and time only if they gave them (resolve "tomorrow", "Friday" ` +
      `from today), and in notes what they explained, as a short description. If it takes more than one action, add the steps ` +
      `with tasks_steps. Then answer with one line: what you created, and when it is due if it is. If what they wrote is too ` +
      `vague to be a task, ask one short question instead of creating it.`;
  }
  if (kind === "brain") {
    const on = project
      ? `They are looking at the page ${project}: "this page" means it; read it first (brain_read).`
      : "They are looking at the brain as a whole.";
    return `${base}\n${who} asks for a change to their brain, from its page in the console. ${on} Make the change with the ` +
      `brain tools, by the brain's rules (they refuse what breaks them: fix and try again). You can only write in the brain, ` +
      `nothing else. Prefer brain_edit to rewriting a page; read before changing; never invent facts they did not give or ` +
      `that the brain does not already hold: if something is missing, ask one short question instead. The old wiki ` +
      `(${WIKI}, an archive) can be read with Read, never written: to bring a subject over, rewrite what still holds ` +
      `into the right page (search first: update rather than copy). Then answer ` +
      `in one or two lines: what you changed, page by page.`;
  }
  if (kind === "debrief") {
    return `${base}\nWrite ${who}'s debrief for today from tasks_brief and today's calendar events: at most three short ` +
      `lines, plain sentences, no headings, no bullets. First what matters today, with times; then anything late; then ` +
      `what they are waiting for from others, if anything. If the day is empty say so in one line.` +
      (calendars
        ? ` Calendar events: read only these calendars (calendar_events, one call each, with its account and ` +
          `calendarId), and never mention any other: ${calendars}.`
        : "");
  }
  return `${base}\nBe brief: one to four lines. Use the tools: tasks (add, close, move, the day's brief: when they say ` +
    `something to do, add it), their calendar, mail and Drive read only, their brain (memory: projects, people, notes) read only. Never send mail or create events from ` +
    `here: say it is for a conversation. When the request needs work inside a project's files (code, changes, looking ` +
    `through a repository), do not start it here: say in one line what you would do, then end with a line of its own ` +
    `[[code:PATH]] where PATH is the project's folder under ~ (for example ~/work/acme/site) if you know it or can find ` +
    `it in the brain, otherwise [[code:~]].`;
}

/** The user's text as a positional argument: a leading "-" would read as an option. */
export const asArg = (s: string) => s.startsWith("-") ? ` ${s}` : s;

/** The models a request can be asked of, by Claude Code's aliases; the first is the default: most of
 *  what is asked here (a summary, a question on the day, a task to add) is light work. The debrief is
 *  not among the choices: it always runs on the light model, at low effort. */
export const ASK_MODELS = ["haiku", "sonnet", "opus"] as const;
export type AskModel = typeof ASK_MODELS[number];
/** The effort each model is asked with: enough for the work it is chosen for, no more. */
export const ASK_EFFORT: Record<AskModel, "low" | "medium" | "high"> = { haiku: "low", sonnet: "medium", opus: "high" };
const DEBRIEF_MODEL: AskModel = "haiku";
const ASK_MODEL_FILE = `${STATE}/ask-model.json`;
export const isAskModel = (m: unknown): m is AskModel => ASK_MODELS.includes(m as AskModel);
/** The model chosen last, in the console or in the Hey window: one choice for both. */
export async function askModel(): Promise<AskModel> {
  const m = (await readJson<{ model?: string }>(ASK_MODEL_FILE))?.model;
  return isAskModel(m) ? m : ASK_MODELS[0];
}
async function setAskModel(model: AskModel) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(ASK_MODEL_FILE, JSON.stringify({ model }) + "\n");
}

/** Pure: the arguments of `claude -p` for one request. */
export function askArgs(
  kind: AskKind,
  text: string,
  now: string,
  opts: {
    session?: string | null;
    project?: string | null;
    noProject?: boolean;
    model?: AskModel;
    calendars?: string;
  } = {},
) {
  const args = [
    "-p",
    asArg(text),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    BUILTIN[kind],
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...TOOLS[kind],
    "--append-system-prompt",
    promptFor(kind, now, opts.project, opts.noProject, undefined, opts.calendars),
  ];
  if (opts.session) args.push("--resume", opts.session);
  const model = kind === "debrief" ? DEBRIEF_MODEL : opts.model;
  if (model) args.push("--model", model, "--effort", ASK_EFFORT[model]);
  return args;
}

/** What the page receives, one JSON object per line. */
export type Out =
  | { t: "session"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; k: "tasks" | "calendar" | "mail" | "drive" | "brain" | "work" }
  | { t: "done"; text: string; code: string | null; error?: string };

export const toolKind = (name: string): Extract<Out, { t: "tool" }>["k"] =>
  /tasks/.test(name)
    ? "tasks"
    : /calendar/.test(name)
    ? "calendar"
    : /gmail/.test(name)
    ? "mail"
    : /drive/.test(name)
    ? "drive"
    : /brain_/.test(name)
    ? "brain"
    : "work";

const CODE = /\[\[code:([^\]]+)\]\]/;

/** Pure: the stream-json of `claude -p` turned into what the page needs. Text arrives as deltas
 *  when the CLI streams them, else whole in the assistant message, else only in the result. */
export class AskStream {
  text = "";
  session: string | null = null;
  private streamed = false;
  /** a run that ended in an error the CLI reports as its result (an expired login, an API error) */
  private failure: string | null = null;

  line(raw: string): Out[] {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw);
    } catch {
      return [];
    }
    const out: Out[] = [];
    if (typeof ev.session_id === "string" && ev.session_id !== this.session) {
      this.session = ev.session_id;
      out.push({ t: "session", id: this.session });
    }
    const add = (d: string) => {
      if (d) {
        this.text += d;
        out.push({ t: "text", d });
      }
    };
    if (ev.type === "stream_event") {
      const d = (ev.event as { delta?: { type?: string; text?: string } } | undefined)?.delta;
      if (d?.type === "text_delta") {
        this.streamed = true;
        add(d.text ?? "");
      }
    } else if (ev.type === "assistant") {
      const blocks = ((ev.message as { content?: { type: string; name?: string; text?: string }[] })?.content) ?? [];
      for (const b of blocks) {
        if (b.type === "tool_use") {
          out.push({ t: "tool", k: toolKind(b.name ?? "") });
          // text before a tool call and text after it are separate paragraphs
          if (this.text && !this.text.endsWith("\n\n")) add("\n\n");
        } else if (b.type === "text" && !this.streamed) add(b.text ?? "");
      }
    } else if (ev.type === "result" && ev.is_error) {
      // `claude -p` puts the error where an answer goes, and may still exit 0: never show it as one
      this.failure = typeof ev.result === "string" && ev.result ? ev.result : "error";
    } else if (ev.type === "result" && !this.text.trim() && typeof ev.result === "string") add(ev.result);
    return out;
  }

  end(code: number, stderr: string): Extract<Out, { t: "done" }> {
    const m = this.text.match(CODE);
    const text = this.text.replace(CODE, "").trim();
    // the CLI may also have sent the error as an assistant message: the run failed, whatever came before
    if (this.failure) return { t: "done", text: "", code: null, error: this.failure };
    if (code !== 0 && !text) {
      const last = stderr.trim().split("\n").pop();
      return { t: "done", text: "", code: null, error: last || `exit ${code}` };
    }
    return { t: "done", text, code: m ? m[1].trim() : null };
  }
}

/** The machine's default profile: the one whose launcher is plain `claude`, else the first. */
export async function defaultLauncher() {
  const ls = await launchers();
  return ls.find((l) => l.command === "claude") ?? ls[0];
}

const DEBRIEF = `${STATE}/debrief.json`;
/** Today's debrief, if one was written under the calendars chosen now: another choice makes it out of date. */
async function cachedDebrief(): Promise<{ day: string; text: string } | null> {
  const d = await readJson<{ day: string; text: string; calendars?: string }>(DEBRIEF);
  return d && d.day === dayOf(new Date()) && (d.calendars ?? "") === choiceSignature(await loadChoice()) ? d : null;
}

/** The calendars the debrief may read, for its prompt: the shown ones of each account. */
async function shownCalendars(): Promise<string> {
  return (await listCalendars()).filter((a) => a.state === "ok").map((a) =>
    a.calendars.filter((c) => c.shown).map((c) => `account ${a.account}: "${c.name}" (calendarId ${c.id})`).join("; ")
  ).filter(Boolean).join("; ");
}

function ask(
  kind: AskKind,
  text: string,
  opts: { session?: string | null; project?: string | null; noProject?: boolean },
) {
  const enc = new TextEncoder();
  // the page going away cancels the response's stream: that, and nothing else, stops claude -p
  // (Deno.serve's request.signal also fires once a response has been delivered, and is changing)
  const stop = new AbortController();
  const signal = stop.signal;
  const now = new Date().toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (o: Out) => {
        try {
          ctl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch { /* the page went away */ }
      };
      const launcher = await defaultLauncher();
      if (!launcher) {
        send({ t: "done", text: "", code: null, error: "no profile" });
        return ctl.close();
      }
      // the debrief reads the calendars chosen now, and is kept under that choice
      const calendars = kind === "debrief" ? await shownCalendars().catch(() => "") : "";
      const choice = kind === "debrief" ? choiceSignature(await loadChoice()) : "";
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(`${BIN}/${launcher.command}`, {
          // a change to the brain runs in the old wiki: Claude Code lets a session read its own folder
          // whatever the rules, so that folder must be the only one it may read
          args: askArgs(kind, text, now, { ...opts, model: await askModel(), calendars }),
          cwd: kind === "brain" ? WIKI : HOME,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          signal,
        }).spawn();
      } catch (e) {
        send({ t: "done", text: "", code: null, error: (e as Error).message });
        return ctl.close();
      }
      const stream = new AskStream();
      const errText = new Response(child.stderr).text();
      let rest = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        rest += chunk;
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) stream.line(l).forEach(send);
      }
      if (rest) stream.line(rest).forEach(send);
      const { code } = await child.status;
      const done = stream.end(code, await errText);
      if (done.error || done.text) await recordLogin(launcher.profile, launcher.command, done.error ?? null);
      if (kind === "debrief" && done.text && !done.error) {
        await Deno.mkdir(STATE, { recursive: true }).catch(() => {});
        await Deno.writeTextFile(
          DEBRIEF,
          JSON.stringify({ day: dayOf(new Date()), text: done.text, calendars: choice }),
        ).catch(() => {});
      }
      send(done);
      ctl.close();
    },
    cancel() {
      stop.abort();
    },
  });
}

/** A terminal running argv in workdir: Konsole on this setup, the usual others as fallbacks. */
async function terminalArgv(workdir: string, argv: string[]): Promise<string[] | null> {
  if (await has("konsole")) return ["konsole", "--workdir", workdir, "-e", ...argv];
  for (const [t, flag] of [["kitty", "--directory"], ["alacritty", "--working-directory"]]) {
    if (await has(t)) return [t, flag, workdir, "-e", ...argv];
  }
  if (await has("wezterm")) return ["wezterm", "start", "--cwd", workdir, "--", ...argv];
  return null;
}

/** Pure: the graphical session's variables out of `systemctl --user show-environment`. The console
 *  service can start before the desktop exports them, and a terminal started without them dies at
 *  once: they are read when a terminal is opened, not when the service started. */
export function sessionEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const l of text.split("\n")) {
    const m = l.match(
      /^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|DBUS_SESSION_BUS_ADDRESS)=(.*)$/,
    );
    if (m) env[m[1]] = m[2].replace(/^\$?'(.*)'$/, "$1");
  }
  return env;
}

async function graphicalEnv(): Promise<Record<string, string>> {
  const out = await new Deno.Command("systemctl", {
    args: ["--user", "show-environment"],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  return out?.success ? sessionEnv(new TextDecoder().decode(out.stdout)) : {};
}

/** Opens a terminal in `workdir` running `argv` (/api/terminal, and the first-run wizard's sign-in). */
export async function openTerminal(workdir: string, argv: string[]): Promise<{ ok: boolean; message?: string }> {
  const cmd = await terminalArgv(workdir, argv);
  if (!cmd) return { ok: false, message: "no terminal found (konsole, kitty, alacritty, wezterm)" };
  const env = await graphicalEnv();
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return { ok: false, message: "no graphical session to open a terminal in" };
  const child = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: workdir,
    env,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  // a terminal that cannot open its window exits at once: say so, instead of a button that does nothing
  const early = await Promise.race([child.status, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  if (early && !early.success) return { ok: false, message: `${cmd[0]} did not start (exit ${early.code})` };
  child.unref();
  return { ok: true };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure: the process ids from pid up to init, read from /proc stat lines. */
export function ancestry(pid: number, parentOf: (pid: number) => number | null): number[] {
  const out: number[] = [];
  for (let p: number | null = pid; p && p > 1 && out.length < 64; p = parentOf(p)) out.push(p);
  return out;
}

const parentOf = (pid: number): number | null => {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    // the command name is in parentheses and may contain spaces: the fields start after the last ")"
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
};

/** Bring forward the window that holds a process: on KWin, a one-shot script that activates the
 *  first window whose pid is the process or one of its ancestors (the terminal, Claude Desktop). */
async function focusWindow(pid: number): Promise<boolean> {
  const pids = ancestry(pid, parentOf);
  const file = await Deno.makeTempFile({ prefix: "claude-multi-focus-", suffix: ".js" });
  const name = `claude-multi-focus-${pid}`;
  await Deno.writeTextFile(
    file,
    `const pids = ${JSON.stringify(pids)};
const ws = workspace.windowList();
for (const p of pids) { const w = ws.find((x) => x.pid === p && x.normalWindow); if (w) { if (w.minimized) w.minimized = false; workspace.activeWindow = w; break; } }`,
  );
  const q = (...a: string[]) =>
    new Deno.Command("qdbus6", { args: ["org.kde.KWin", ...a], stdout: "piped", stderr: "null" }).output();
  try {
    await q("/Scripting", "org.kde.kwin.Scripting.unloadScript", name);
    const id = new TextDecoder().decode((await q("/Scripting", "org.kde.kwin.Scripting.loadScript", file, name)).stdout)
      .trim();
    if (!/^\d+$/.test(id) || id === "-1") return false;
    await q(`/Scripting/Script${id}`, "org.kde.kwin.Script.run");
    await q("/Scripting", "org.kde.kwin.Scripting.unloadScript", name);
    return true;
  } catch {
    return false;
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

export async function askApi(req: Request, u: URL, json: Json): Promise<Response | null> {
  const p = u.pathname;
  if (!["/api/ask", "/api/ask/model", "/api/debrief", "/api/terminal", "/api/focus"].includes(p)) return null;
  if (p === "/api/debrief" && req.method === "GET") {
    return json({ today: dayOf(new Date()), debrief: await cachedDebrief() });
  }
  if (p === "/api/ask/model" && req.method === "GET") {
    return json({ model: await askModel(), models: ASK_MODELS, efforts: ASK_EFFORT, default: ASK_MODELS[0] });
  }
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
  const b = await req.json().catch(() => ({})) as Record<string, unknown>;

  if (p === "/api/ask/model") {
    if (!isAskModel(b.model)) return json({ ok: false, message: `model: one of ${ASK_MODELS.join(", ")}` }, 400);
    await setAskModel(b.model);
    return json({ ok: true, model: b.model });
  }

  if (p === "/api/ask" || p === "/api/debrief") {
    const kind: AskKind = p === "/api/debrief"
      ? "debrief"
      : b.kind === "newtask"
      ? "newtask"
      : b.kind === "brain"
      ? "brain"
      : "ask";
    const text = kind === "debrief" ? "debrief" : String(b.text ?? "").trim().slice(0, 4000);
    if (!text) return json({ error: "empty" }, 400);
    const session = typeof b.session === "string" && SESSION_ID.test(b.session) ? b.session : null;
    const project = typeof b.project === "string" && /^[\w./ -]{1,200}$/.test(b.project) && !b.project.includes("..")
      ? b.project
      : null;
    return new Response(ask(kind, text, { session, project, noProject: b.noProject === true }), {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  }

  if (p === "/api/terminal") {
    // resume a session, continue the console's conversation, or open Claude Code on a request
    const ls = await launchers();
    const launcher = ls.find((l) => l.profile === b.profile) ?? await defaultLauncher();
    if (!launcher) return json({ ok: false, message: "no profile" });
    const cwd = expandHome(String(b.cwd ?? "~").replace(/^~$/, "~/"));
    let real: string;
    try {
      real = await Deno.realPath(cwd);
    } catch {
      return json({ ok: false, message: `no such folder: ${cwd}` });
    }
    if (real !== HOME && !real.startsWith(`${HOME}/`)) return json({ ok: false, message: "outside home" }, 403);
    if (!(await Deno.stat(real)).isDirectory) return json({ ok: false, message: "not a folder" });
    const argv = [`${BIN}/${launcher.command}`];
    if (typeof b.resume === "string") {
      if (!SESSION_ID.test(b.resume)) return json({ ok: false, message: "bad session" }, 400);
      argv.push("--resume", b.resume);
    } else if (typeof b.ask === "string" && b.ask.trim()) argv.push(asArg(b.ask.trim().slice(0, 4000)));
    return json(await openTerminal(real, argv));
  }

  // /api/focus: only a process the console itself lists as a running session
  const pid = Number(b.pid);
  const r = await running();
  const known = [...r.cli.map((c) => c.pid), ...r.desktop.map((d) => d.pid)];
  if (!Number.isInteger(pid) || !known.includes(pid)) return json({ ok: false, message: "not a running session" }, 400);
  return json({ ok: await focusWindow(pid) });
}
