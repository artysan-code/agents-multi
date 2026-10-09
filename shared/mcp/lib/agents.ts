// agents.ts — the hub's children: Claude Code sessions of any profile, started without a terminal in a
// project's folder, that ask the hub for every permission their profile's rules do not already give.
// Nothing runs in bypass: each permission request arrives here (stream-json, `--permission-prompt-tool
// stdio`) and waits until someone answers it — in practice the owner, through the coordinator.
//
// A child lives in files, so it outlives whoever started it and anyone on the machine can follow it:
//   <runs>/<id>/meta.json     who, where, what it was asked
//   <runs>/<id>/in            a fifo: its stdin (user messages, answers to its requests)
//   <runs>/<id>/out.jsonl     its events (stream-json)
//   <runs>/<id>/answers.jsonl the requests answered, and how
//   <runs>/<id>/claude.pid, holder.pid, err.log
// Closing the fifo's holder ends the session after its current turn.

import { configDir } from "./owner.ts";

export interface Meta {
  id: string;
  profile: string;
  /** the launcher it runs: the profile's command */
  command: string;
  /** the project's folder */
  dir: string;
  task: string;
  started: string;
  model?: string;
}

/** A permission the child is waiting for. */
export interface Pending {
  request: string;
  tool: string;
  /** what it wants to do, in a line: the command, the file, the URL */
  what: string;
  description?: string;
  input: Record<string, unknown>;
  at: number;
}

export type Phase = "working" | "waiting" | "idle" | "ended";

export interface ChildState {
  phase: Phase;
  session: string | null;
  pending: Pending[];
  /** the last things it said, newest last */
  said: string[];
  /** turns finished, and how the last one ended */
  turns: number;
  lastResult: string | null;
  error: string | null;
  costUsd: number;
}

const ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
export const validId = (id: string) => ID.test(id);

/** Where the children live: the runtime's state folder. */
// only the variables it reads: the server may read no others (servers.json, --allow-env)
export function runsDir(
  env: Record<string, string | undefined> = {
    HOME: Deno.env.get("HOME"),
    XDG_STATE_HOME: Deno.env.get("XDG_STATE_HOME"),
  },
): string {
  const state = env.XDG_STATE_HOME || `${env.HOME}/.local/state`;
  return `${state}/agents-multi/agents`;
}

/** Pure: a request's input in one line, for a person deciding on it. */
export function whatOf(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => typeof input[k] === "string" ? input[k] as string : "";
  const one = s("command") || s("file_path") || s("path") || s("url") || s("pattern") || s("query") ||
    JSON.stringify(input);
  return `${tool}: ${one.replace(/\s+/g, " ").slice(0, 300)}`;
}

/** Pure: a child's state from its events, the requests already answered, and whether it still runs. */
export function stateOf(lines: string[], answered: Set<string>, alive: boolean, now = Date.now()): ChildState {
  const st: ChildState = {
    phase: "working",
    session: null,
    pending: [],
    said: [],
    turns: 0,
    lastResult: null,
    error: null,
    costUsd: 0,
  };
  const open = new Map<string, Pending>();
  let busy = true;
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const type = e.type;
    if (type === "system" && e.subtype === "init" && typeof e.session_id === "string") st.session = e.session_id;
    else if (type === "assistant") {
      busy = true;
      const content = (e.message as { content?: unknown[] })?.content ?? [];
      for (const c of content as Record<string, unknown>[]) {
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) st.said.push(c.text.trim());
      }
    } else if (type === "control_request") {
      const r = e.request as Record<string, unknown>;
      const id = String(e.request_id ?? "");
      if (r?.subtype === "can_use_tool" && id && !answered.has(id)) {
        const input = (r.input ?? {}) as Record<string, unknown>;
        const tool = String(r.tool_name ?? "?");
        open.set(id, {
          request: id,
          tool,
          what: whatOf(tool, input),
          description: typeof r.description === "string" ? r.description : undefined,
          input,
          at: now,
        });
      }
    } else if (type === "control_cancel_request") open.delete(String(e.request_id ?? ""));
    else if (type === "result") {
      busy = false;
      st.turns++;
      st.lastResult = typeof e.result === "string" ? e.result : String(e.subtype ?? "");
      if (e.is_error) st.error = st.lastResult;
      if (typeof e.total_cost_usd === "number") st.costUsd = e.total_cost_usd;
    } else if (type === "user") busy = true;
  }
  st.pending = [...open.values()];
  st.said = st.said.slice(-5);
  st.phase = !alive ? "ended" : st.pending.length ? "waiting" : busy ? "working" : "idle";
  return st;
}

/** What needs the owner: a request to answer, a turn finished, a child gone. */
export interface Attention {
  id: string;
  kind: "request" | "done" | "ended";
  detail: string;
}

/** Pure: what changed for the worse or the finished between two looks at the same children. */
export function attentionBetween(
  before: Map<string, ChildState>,
  after: Map<string, ChildState>,
): Attention[] {
  const out: Attention[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    const known = new Set(was?.pending.map((p) => p.request) ?? []);
    for (const p of now.pending) if (!known.has(p.request)) out.push({ id, kind: "request", detail: p.what });
    if (now.turns > (was?.turns ?? 0)) out.push({ id, kind: "done", detail: (now.lastResult ?? "").slice(0, 300) });
    if (now.phase === "ended" && was && was.phase !== "ended") out.push({ id, kind: "ended", detail: now.error ?? "" });
  }
  return out;
}

/** Pure: the line a user message is on the child's stdin. */
export const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });

/** Pure: the line that answers a permission request. */
export function answerLine(p: Pending, allow: boolean, message?: string): string {
  const response = allow
    ? { behavior: "allow", updatedInput: p.input }
    : { behavior: "deny", message: message?.trim() || "The owner said no." };
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: p.request, response },
  });
}

// ---------------------------------------------------------------- the files

/** Pure: whether `ps -o stat=` says a process runs: a line, and not a zombie (Z), which is an ended
 *  child nobody has reaped yet (a container whose first process does not reap orphans). */
export const runsBy = (stat: string) => stat.trim() !== "" && !stat.trim().startsWith("Z");

// `ps` on the one pid, not /proc: Deno lets only --allow-all read /proc
const alive = async (pidFile: string) => {
  const pid = Number((await Deno.readTextFile(pidFile).catch(() => "")).trim());
  if (!(pid > 0)) return false;
  const r = await new Deno.Command("ps", { args: ["-o", "stat=", "-p", String(pid)], stdout: "piped", stderr: "null" })
    .output().catch(() => null);
  return !!r?.success && runsBy(new TextDecoder().decode(r.stdout));
};

async function lines(file: string): Promise<string[]> {
  return (await Deno.readTextFile(file).catch(() => "")).split("\n").filter(Boolean);
}

async function answeredOf(dir: string): Promise<Set<string>> {
  const s = new Set<string>();
  for (const l of await lines(`${dir}/answers.jsonl`)) {
    try {
      s.add(JSON.parse(l).request);
    } catch { /* a torn line */ }
  }
  return s;
}

export interface Child {
  meta: Meta;
  state: ChildState;
}

export async function readChild(id: string, runs = runsDir()): Promise<Child | null> {
  if (!validId(id)) return null;
  const dir = `${runs}/${id}`;
  const meta = await Deno.readTextFile(`${dir}/meta.json`).then(JSON.parse).catch(() => null) as Meta | null;
  if (!meta) return null;
  const state = stateOf(await lines(`${dir}/out.jsonl`), await answeredOf(dir), await alive(`${dir}/claude.pid`));
  const err = (await Deno.readTextFile(`${dir}/err.log`).catch(() => "")).trim();
  if (state.phase === "ended" && !state.turns && err) state.error = err.split("\n").slice(-3).join(" ");
  return { meta, state };
}

export async function listChildren(runs = runsDir()): Promise<Child[]> {
  const out: Child[] = [];
  try {
    for await (const e of Deno.readDir(runs)) {
      if (!e.isDirectory) continue;
      const c = await readChild(e.name, runs);
      if (c) out.push(c);
    }
  } catch { /* no child yet */ }
  return out.sort((a, b) => a.meta.started.localeCompare(b.meta.started));
}

/** Writes a line on a child's stdin; refused when the child is gone (a fifo with no reader would block). */
async function send(dir: string, line: string): Promise<void> {
  if (!(await alive(`${dir}/claude.pid`))) throw new Error("the child is not running");
  const f = await Deno.open(`${dir}/in`, { write: true });
  try {
    await f.write(new TextEncoder().encode(`${line}\n`));
  } finally {
    f.close();
  }
}

/** The launcher of a profile, from its manifest (`command`), else `claude-<profile>`. */
export async function launcherOf(profile: string, config = configDir()): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) return null;
  const m = await Deno.readTextFile(`${config}/profiles/${profile}/profile.json`).then(JSON.parse).catch(() => null);
  if (!m) return null;
  return (typeof m.command === "string" && m.command.trim()) || `claude-${profile}`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/** Pure: a child's id from its profile, folder and start time, with a few random letters. */
export function childId(profile: string, dir: string, at: Date, rand: string): string {
  const stamp = at.toISOString().slice(5, 16).replace(/[-T:]/g, "");
  return `${slug(profile)}-${slug(dir.split("/").filter(Boolean).pop() ?? "x")}-${stamp}-${rand}`;
}

export interface StartInput {
  profile: string;
  dir: string;
  task: string;
  model?: string;
}

/** Starts a child: its folder, the fifo held open, the session detached from whoever asked. */
export async function startChild(
  i: StartInput,
  runs = runsDir(),
  home = Deno.env.get("HOME") ?? "",
  config = configDir(),
): Promise<Meta> {
  const command = await launcherOf(i.profile, config);
  if (!command) throw new Error(`no profile ${i.profile}`);
  const dir = i.dir.replace(/^~(?=\/|$)/, home);
  if (!dir.startsWith(`${home}/`) || dir.includes("/../")) throw new Error("the folder must be under the home folder");
  if (!(await Deno.stat(dir).catch(() => null))?.isDirectory) throw new Error(`no folder ${dir}`);
  if (!i.task.trim()) throw new Error("say what the child has to do");
  if (i.model && !/^[a-z0-9.\[\]-]+$/i.test(i.model)) throw new Error("not a model name");
  const id = childId(i.profile, dir, new Date(), crypto.randomUUID().slice(0, 4));
  const run = `${runs}/${id}`;
  await Deno.mkdir(run, { recursive: true });
  const meta: Meta = { id, profile: i.profile, command, dir, task: i.task, started: new Date().toISOString() };
  if (i.model) meta.model = i.model;
  await Deno.writeTextFile(`${run}/meta.json`, JSON.stringify(meta, null, 2));
  const fifo = await new Deno.Command("mkfifo", { args: [`${run}/in`] }).output();
  if (!fifo.success) throw new Error("could not make the child's stdin");
  // values reach the shell as variables, never inside the script's text
  const script = [
    'sleep infinity > "$R/in" & echo $! > "$R/holder.pid"',
    'cd "$W" || exit 1',
    'echo $$ > "$R/claude.pid"',
    'exec "$L" -p ${M:+--model "$M"} --input-format stream-json --output-format stream-json --verbose ' +
    '--permission-mode default --permission-prompt-tool stdio < "$R/in" > "$R/out.jsonl" 2> "$R/err.log"',
  ].join("\n");
  const env: Record<string, string> = { R: run, W: dir, L: command };
  if (i.model) env.M = i.model;
  await new Deno.Command("setsid", {
    args: ["-f", "bash", "-c", script],
    env,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  for (let t = 0; t < 50 && !(await alive(`${run}/claude.pid`)); t++) await new Promise((r) => setTimeout(r, 100));
  await send(run, userLine(i.task));
  return meta;
}

export async function sayTo(id: string, text: string, runs = runsDir()): Promise<void> {
  if (!validId(id) || !(await readChild(id, runs))) throw new Error(`no child ${id}`);
  if (!text.trim()) throw new Error("nothing to say");
  await send(`${runs}/${id}`, userLine(text));
}

/** Answers one of a child's requests; refused when it is not one it is waiting on. */
export async function answer(id: string, request: string, allow: boolean, message?: string, runs = runsDir()) {
  const c = await readChild(id, runs);
  if (!c) throw new Error(`no child ${id}`);
  const p = c.state.pending.find((x) => x.request === request);
  if (!p) throw new Error(`${id} is not waiting on ${request}`);
  await send(`${runs}/${id}`, answerLine(p, allow, message));
  await Deno.writeTextFile(
    `${runs}/${id}/answers.jsonl`,
    JSON.stringify({ request, allow, message: message ?? null, at: new Date().toISOString() }) + "\n",
    { append: true },
  );
}

/** Ends a child after its current turn (its stdin closes), or at once with `force`. */
export async function stopChild(id: string, force = false, runs = runsDir()): Promise<void> {
  if (!validId(id)) throw new Error(`no child ${id}`);
  const dir = `${runs}/${id}`;
  for (const f of force ? ["holder.pid", "claude.pid"] : ["holder.pid"]) {
    const pid = Number((await Deno.readTextFile(`${dir}/${f}`).catch(() => "")).trim());
    // the `kill` command, not Deno.kill: that needs --allow-run for every program, the server has three
    if (pid > 0) {
      await new Deno.Command("kill", { args: ["-TERM", String(pid)], stdout: "null", stderr: "null" }).output()
        .catch(() => null);
    }
  }
}

/** Waits until something needs the owner (a request, a finished turn, a child gone), or `timeoutMs`. */
export async function waitForAttention(timeoutMs: number, runs = runsDir(), everyMs = 2000): Promise<Attention[]> {
  const look = async () => new Map((await listChildren(runs)).map((c) => [c.meta.id, c.state] as const));
  const before = await look();
  for (let t = 0; t < timeoutMs; t += everyMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    const found = attentionBetween(before, await look());
    if (found.length) return found;
  }
  return [];
}
