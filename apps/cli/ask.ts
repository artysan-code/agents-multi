// ask.ts — the console talks to Claude: the Chat page and the Hey window (one conversation each, kept
// by chats.ts), and the hand-over to a terminal (resume a session, continue a conversation, open Claude
// Code in a project) and to a session's own window.
//
// The answer comes from `claude -p` in the machine's default profile and streams back to the page as
// NDJSON on the response of the POST that asked: one request, one answer, no polling. The tools are a
// fixed list and `--permission-mode dontAsk` refuses everything else, whatever the profile's own mode:
// from here Claude reads and keeps the tasks and the brain, and creates or moves calendar events (the
// server sends no invitation unless asked: the prompt forbids asking without the owner's word); it
// never sends mail or deletes.

import { readJson } from "./lib/fs.ts";
import { BIN, expandHome, HOME, shortHome, STATE } from "./lib/paths.ts";
import { has } from "./lib/proc.ts";
import { running } from "./lib/processes.ts";
import { launchers } from "./lib/profiles.ts";
import { owner } from "../../shared/mcp/lib/owner.ts";
import { parentPid } from "../../shared/mcp/lib/platform.ts";
import { recordLogin } from "./login.ts";
import { type Act, CHAT_ID, readChat, saveTurn } from "./chats.ts";
import { serviceChats } from "./svc-chat.ts";

type Json = (v: unknown, code?: number) => Response;

// The owner's brain, read only: the claude.ai connector "Brain" of the personal profile, as the CLI names it
const BRAIN_READ = [
  "mcp__claude_ai_Brain__brain_search",
  "mcp__claude_ai_Brain__brain_read",
  "mcp__claude_ai_Brain__brain_list",
];
// what a chat may write in the brain on its own: a line in the diary, a page changed or added; never a move or a deletion
const BRAIN_KEEP = ["brain_append", "brain_edit", "brain_write"].map((t) => `mcp__claude_ai_Brain__${t}`);
// Events created or moved from a chat: never deleted, never with an invitation sent unless asked (the prompt)
const CALENDAR_WRITE = ["mcp__google__calendar_create", "mcp__google__calendar_update"];
const READ = [
  "mcp__google__calendar_list",
  "mcp__google__calendar_events",
  "mcp__google__gmail_search",
  "mcp__google__gmail_thread",
  "mcp__google__drive_search",
  "mcp__google__drive_read",
  ...BRAIN_READ,
];
/** What a chat may use: the tasks, the calendar, mail and Drive to read, the brain. Claude Code's own
 *  tools (files, shell) are none of it: work in a project's files goes to a terminal. */
export const TOOLS = ["mcp__tasks", ...READ, ...CALENDAR_WRITE, ...BRAIN_KEEP];

/** Pure but for the owner (owner.ts, passed in tests): the instructions of a chat. */
export function promptFor(now: string, o = owner()): string {
  const who = o.name;
  return `You answer in ${who}'s chat in their console (agents-multi). Answer in ${o.language} unless they write in ` +
    `another language. No preamble, no closing question. Now: ${now}.\n` +
    `Be brief unless they ask for more: a short answer, Markdown when it helps (lists, tables, code). You keep ${who}'s ` +
    `tasks and memory without being asked to: work out ` +
    `from what they write what it is, and act. Something to do, even said in passing (no need for "add a task"): create ` +
    `it with tasks_add, with the project (the folder under ~, from tasks_list or the brain) when you can tell, the day, ` +
    `and a time whenever one fits: theirs if they gave it, else a plausible slot that day that does not overlap their ` +
    `calendar. Done, moved or waiting on someone: tasks_done or tasks_update. A durable fact worth remembering (a ` +
    `decision, a person, a preference, how something works): into the brain, a line in the diary with brain_append or ` +
    `the right page with brain_edit (search first; never invent, never delete). A question: answer it, reading what you ` +
    `need. Then say what you did, one short line per action (the time you chose included). Tools: tasks; their calendar ` +
    `(read it, create or move events they ask for); mail and Drive read only; their brain. An event gets no attendees and sendUpdates "none" ` +
    `unless they explicitly ask to invite someone; a reminder they ask for goes in reminders (minutes before). Never send mail or delete an event from ` +
    `here: say it is for a conversation. When the request needs work inside a project's files (code, changes, looking ` +
    `through a repository), do not start it here: say in one line what you would do, then end with a line of its own ` +
    `[[code:PATH]] where PATH is the project's folder under ~ (for example ~/work/acme/site) if you know it or can find ` +
    `it in the brain, otherwise [[code:~]].`;
}

/** The user's text as a positional argument: a leading "-" would read as an option. */
export const asArg = (s: string) => s.startsWith("-") ? ` ${s}` : s;

/** The models a request can be asked of, by Claude Code's aliases; the first is the default: most of
 *  what is asked here (a summary, a question on the day, a task to add) is light work. */
const ASK_MODELS = ["haiku", "sonnet", "opus"] as const;
type AskModel = typeof ASK_MODELS[number];
/** The effort each model is asked with: enough for the work it is chosen for, no more. */
const ASK_EFFORT: Record<AskModel, "low" | "medium" | "high"> = { haiku: "low", sonnet: "medium", opus: "high" };
const ASK_MODEL_FILE = `${STATE}/ask-model.json`;
const isAskModel = (m: unknown): m is AskModel => ASK_MODELS.includes(m as AskModel);
/** The model chosen last, in the Chat page or in the Hey window: one choice for both. */
async function askModel(): Promise<AskModel> {
  const m = (await readJson<{ model?: string }>(ASK_MODEL_FILE))?.model;
  return isAskModel(m) ? m : ASK_MODELS[0];
}
async function setAskModel(model: AskModel) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(ASK_MODEL_FILE, JSON.stringify({ model }) + "\n");
}

/** Pure: the arguments of `claude -p` for one request. */
export function askArgs(
  text: string,
  now: string,
  opts: { session?: string | null; model?: AskModel; settings?: Record<string, unknown> } = {},
) {
  const args = [
    "-p",
    asArg(text),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...TOOLS,
    "--append-system-prompt",
    promptFor(now),
  ];
  if (opts.session) args.push("--resume", opts.session);
  if (opts.model) args.push("--model", opts.model, "--effort", ASK_EFFORT[opts.model]);
  if (opts.settings) args.push("--settings", JSON.stringify(opts.settings));
  return args;
}

/** What a chat turn remembers of the turns before it, for a machine that has no session of the chat. */
export interface Earlier {
  q: string;
  a: string;
}

/** Pure: the request with the chat's earlier turns in front of it, compactly, when there is no session to
 *  resume (the chat last ran on another machine). */
export function withHistory(text: string, history: Earlier[] = []): string {
  const cut = (s: string, n: number) => {
    const t = s.trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const turns = history.filter((h) => h.q?.trim());
  if (!turns.length) return text;
  const lines = turns.slice(-10).map((h) => `Q: ${cut(h.q, 600)}\nA: ${cut(h.a ?? "", 1200)}`);
  return `This conversation went on before; what was said so far:\n${lines.join("\n")}\n\nNow they write:\n${text}`;
}

/** What the page receives, one JSON object per line. */
export type Out =
  | { t: "chat"; id: string }
  | { t: "session"; id: string }
  | { t: "text"; d: string }
  | {
    t: "tool";
    k: "tasks" | "calendar" | "mail" | "drive" | "brain" | "work";
    /** the tool's own name, without its server (tasks_add) */
    n: string;
    /** what it was called on, for a call that changes something: the task's title, the page, the event */
    d?: string;
  }
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

/** The calls that change something, and what each was called on, as the page shows them. */
const WRITES: Record<string, (i: Record<string, unknown>) => unknown> = {
  tasks_add: (i) => i.title,
  tasks_done: (i) => i.id,
  tasks_update: (i) => i.title ?? i.id,
  tasks_steps: (i) => i.id,
  tasks_note: (i) => i.text,
  tasks_edit: (i) => i.id,
  tasks_attach: (i) => i.id,
  brain_append: (i) => i.text,
  brain_edit: (i) => i.path,
  brain_write: (i) => i.path,
  calendar_create: (i) => i.summary,
  calendar_update: (i) => i.summary ?? i.eventId,
};

/** Pure: a tool call as the page shows it — what kind, which tool, and for a change what it was on. */
export function toolCall(name: string, input: Record<string, unknown> = {}): Extract<Out, { t: "tool" }> {
  const n = name.replace(/^mcp__.+?__/, "");
  const on = WRITES[n]?.(input);
  const d = typeof on === "string" && on.trim() ? on.trim().replace(/\s+/g, " ").slice(0, 90) : undefined;
  return d ? { t: "tool", k: toolKind(name), n, d } : { t: "tool", k: toolKind(name), n };
}

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
      const blocks = ((ev.message as {
        content?: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[];
      })?.content) ?? [];
      for (const b of blocks) {
        if (b.type === "tool_use") {
          out.push(toolCall(b.name ?? "", b.input));
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
async function defaultLauncher() {
  const ls = await launchers();
  return ls.find((l) => l.command === "claude") ?? ls[0];
}

/** What runTurn needs besides the text. */
export interface TurnOpts {
  /** the Claude Code session to resume, when the chat has one on this machine */
  session?: string | null;
  /** the chat's earlier turns, put in front of the request when there is no session */
  history?: Earlier[];
  /** default: the model chosen in the console */
  model?: AskModel;
  /** the page going away, the console stopping: kills `claude -p` */
  signal?: AbortSignal;
  /** settings and the whole environment of the child for the profile it runs as: a headless node's sandbox and
   *  token (node/turns.ts); none on a desktop, whose child has its `/login` */
  prepare?: (profile: string) => Promise<{ env?: Record<string, string>; settings?: Record<string, unknown> }>;
}

const nowText = () =>
  new Date().toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** One answer from `claude -p` in the machine's default profile: what it says reaches `onEvent` as it comes
 *  (session, text, tool) and the end is returned. Rejects when the run could not start (no profile, no
 *  program). Shared by the console's /api/ask and the node answering a chat of the service (node/turns.ts). */
export async function runTurn(
  text: string,
  opts: TurnOpts,
  onEvent: (o: Out) => void,
): Promise<Extract<Out, { t: "done" }>> {
  const launcher = await defaultLauncher();
  if (!launcher) throw new Error("no profile");
  const model = opts.model ?? await askModel();
  const extra = await opts.prepare?.(launcher.profile);
  const prompt = opts.session ? text : withHistory(text, opts.history);
  const child = new Deno.Command(`${BIN}/${launcher.command}`, {
    args: askArgs(prompt, nowText(), { session: opts.session, model, settings: extra?.settings }),
    cwd: HOME,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
    ...(extra?.env ? { env: extra.env, clearEnv: true } : {}),
  }).spawn();
  const stream = new AskStream();
  const errText = new Response(child.stderr).text();
  let rest = "";
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    rest += chunk;
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) stream.line(l).forEach(onEvent);
  }
  if (rest) stream.line(rest).forEach(onEvent);
  const { code } = await child.status;
  const done = stream.end(code, await errText);
  if (done.error || done.text) await recordLogin(launcher.profile, launcher.command, done.error ?? null);
  return done;
}

/** One request of a chat: the answer streams to the page and, once it ends, is kept as the chat's next
 *  turn (`saved` then tells the open pages). A request without `chat` starts a new one. */
function ask(text: string, chat: string | null, saved: () => void) {
  const enc = new TextEncoder();
  // the page going away cancels the response's stream: that, and nothing else, stops claude -p
  // (Deno.serve's request.signal also fires once a response has been delivered, and is changing)
  const stop = new AbortController();
  return new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (o: Out) => {
        try {
          ctl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch { /* the page went away */ }
      };
      const known = chat ? await readChat(chat) : null;
      const id = known?.id ?? crypto.randomUUID();
      send({ t: "chat", id });
      const model = await askModel();
      const acts: Act[] = [];
      let session: string | null = null;
      const pass = (o: Out) => {
        if (o.t === "tool") acts.push(o.d ? { k: o.k, n: o.n, d: o.d } : { k: o.k, n: o.n });
        if (o.t === "session") session = o.id;
        send(o);
      };
      let done: Extract<Out, { t: "done" }>;
      try {
        done = await runTurn(text, { session: known?.session, model, signal: stop.signal }, pass);
      } catch (e) {
        send({ t: "done", text: "", code: null, error: (e as Error).message });
        return ctl.close();
      }
      // kept even when the page went away mid-answer: the chat shows what was said, as far as it went
      await saveTurn(id, session ?? known?.session ?? null, {
        q: text,
        a: done.text,
        acts,
        ...(done.error ? { error: done.error } : {}),
        ...(done.code ? { code: done.code } : {}),
        model,
        at: new Date().toISOString(),
      }).then(saved, () => {});
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
  const r = await openTerminalNow(workdir, argv);
  return r.ok ? r : { ...r, message: `${r.message}. By hand, in a terminal: ${byHand(workdir, argv)}` };
}

/** Pure: the command line that does what a terminal the console could not open would have done. */
export function byHand(workdir: string, argv: string[]): string {
  const q = (s: string) => /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
  return `cd ${q(shortHome(workdir))} && ${argv.map((a) => q(shortHome(a))).join(" ")}`;
}

async function openTerminalNow(workdir: string, argv: string[]): Promise<{ ok: boolean; message?: string }> {
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

/** The longest message a chat takes: a pasted page, not a book. */
const MAX_TEXT = 16000;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pure: the process ids from pid up to init. */
export function ancestry(pid: number, parentOf: (pid: number) => number | null): number[] {
  const out: number[] = [];
  for (let p: number | null = pid; p && p > 1 && out.length < 64; p = parentOf(p)) out.push(p);
  return out;
}

const parentOf = parentPid;

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

/** The console's routes for talking to Claude. `saved`: a chat changed (a turn kept), for the open pages. */
export async function askApi(req: Request, u: URL, json: Json, saved: () => void = () => {}): Promise<Response | null> {
  const p = u.pathname;
  if (!["/api/ask", "/api/ask/model", "/api/terminal", "/api/focus"].includes(p)) return null;
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

  if (p === "/api/ask") {
    const text = String(b.text ?? "").trim().slice(0, MAX_TEXT);
    if (!text) return json({ error: "empty" }, 400);
    const given = typeof b.chat === "string" ? b.chat : null;
    const chat = given && CHAT_ID.test(given) ? given : null;
    const headers = { "content-type": "application/x-ndjson", "cache-control": "no-store" };
    // a new chat, or one of the service's, goes to the service when this machine is a node of it (svc-chat.ts, ADR
    // 0014 G1b); a local chat stays local, and so does everything when there is no service or it does not answer
    if (!chat) {
      const own = given && /^[\w-]{1,64}$/.test(given) ? given : null;
      const relayed = await serviceChats.ask(text, own, new AbortController().signal, saved);
      if (relayed) return new Response(relayed, { headers });
    }
    return new Response(ask(text, chat, saved), { headers });
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
