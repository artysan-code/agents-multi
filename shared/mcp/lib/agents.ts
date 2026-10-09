// agents.ts — the hub's children: Claude Code sessions of any profile, started without a terminal in a
// project's folder, that ask the hub for every permission their profile's rules do not already give.
// A child keeps its profile's permission mode (auto: a classifier lets the safe steps through), never
// a bypass: each request left over arrives here (stream-json, `--permission-prompt-tool stdio`) and
// waits until someone answers it — in practice the owner, through the coordinator. An answer can allow
// the one call, or a rule for the rest of the child's session (`sessionRule`).
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
  /** the permission mode it runs in (`childMode`) */
  mode?: ChildMode;
  /** the workflow run and step it is (runs.ts), when it is one */
  run?: { id: string; step: string };
}

/** The modes a child may run in: the ones where whatever is not allowed comes back as a request. */
export type ChildMode = "auto" | "acceptEdits" | "default";

/** Pure: a child's mode from its profile's `defaultMode`. A bypass, `dontAsk` (which denies without
 *  asking) or `plan` (which acts on nothing) would leave the owner out, so they become `default`. */
export function childMode(defaultMode: unknown): ChildMode {
  return defaultMode === "auto" || defaultMode === "acceptEdits" ? defaultMode : "default";
}

/** A rule the owner can allow for the rest of a child's session, as Claude Code's settings write it. */
export interface Rule {
  toolName: string;
  ruleContent?: string;
}

/** Pure: the rule "yes for this session" adds for a request. Bash: the program, when the command is one
 *  simple command (`curl:*`), else the command exactly; WebFetch: the domain; any other tool: the tool. */
export function sessionRule(tool: string, input: Record<string, unknown>): Rule {
  if (tool === "Bash" && typeof input.command === "string") {
    const command = input.command.trim();
    const program = command.split(/\s+/)[0];
    const simple = !/[;&|<>`$(){}\n]/.test(command) && /^[A-Za-z0-9._\/-]+$/.test(program) && !program.includes("=");
    return { toolName: tool, ruleContent: simple ? `${program}:*` : command };
  }
  if (tool === "WebFetch" && typeof input.url === "string") {
    const host = URL.parse(input.url)?.hostname;
    if (host) return { toolName: tool, ruleContent: `domain:${host}` };
  }
  return { toolName: tool };
}

/** Pure: a rule as a person reads it, `Bash(curl:*)`. */
export const ruleText = (r: Rule) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;

/** A question a child asks with `AskUserQuestion`, as Claude Code writes it. */
export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** What a child is waiting for: a permission its mode did not grant, or the owner's answers to the
 *  questions it asked (`AskUserQuestion` reaches the hub as a permission request for that tool). */
export interface Pending {
  request: string;
  kind: "request" | "question";
  tool: string;
  /** what it wants to do, in a line: the command, the file, the URL */
  what: string;
  description?: string;
  input: Record<string, unknown>;
  /** what "yes for this session" would allow from now on; empty for a question */
  session: string;
  /** a question's questions, with their options */
  questions?: Question[];
  at: number;
}

/** Pure: the questions of an `AskUserQuestion` input, or null when it is not one. */
export function questionsOf(tool: string, input: Record<string, unknown>): Question[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input.questions)) return null;
  const qs = (input.questions as Record<string, unknown>[]).filter((q) => typeof q?.question === "string");
  return qs.length ? qs as unknown as Question[] : null;
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
        const questions = questionsOf(tool, input);
        open.set(id, {
          request: id,
          kind: questions ? "question" : "request",
          tool,
          what: questions ? `Question: ${questions.map((q) => q.question).join(" / ")}` : whatOf(tool, input),
          description: typeof r.description === "string" ? r.description : undefined,
          input,
          session: questions ? "" : ruleText(sessionRule(tool, input)),
          ...(questions ? { questions } : {}),
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

/** What needs the owner: a request or a question to answer, a turn finished, a child gone. */
export interface Attention {
  id: string;
  kind: "request" | "question" | "done" | "ended" | "run-confirm" | "run-failed" | "run-done" | "run-stopped";
  detail: string;
  /** for a run's own events: the run, and the step it is about */
  run?: string;
  step?: string;
  /** for a request or a question: its id, to answer it with */
  request?: string;
  /** for a request: the rule "yes for the session" would add */
  session?: string;
  questions?: Question[];
}

/** Pure: a pending request as something that needs the owner. */
export const attentionOf = (id: string, p: Pending): Attention =>
  p.kind === "question"
    ? { id, kind: "question", detail: p.what, request: p.request, questions: p.questions }
    : { id, kind: "request", detail: p.what, request: p.request, session: p.session };

/** Pure: what changed for the worse or the finished between two looks at the same children. */
export function attentionBetween(
  before: Map<string, ChildState>,
  after: Map<string, ChildState>,
): Attention[] {
  const out: Attention[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    const known = new Set(was?.pending.map((p) => p.request) ?? []);
    for (const p of now.pending) if (!known.has(p.request)) out.push(attentionOf(id, p));
    if (now.turns > (was?.turns ?? 0)) out.push({ id, kind: "done", detail: (now.lastResult ?? "").slice(0, 300) });
    if (now.phase === "ended" && was && was.phase !== "ended") out.push({ id, kind: "ended", detail: now.error ?? "" });
  }
  return out;
}

/** Pure: the line a user message is on the child's stdin. */
export const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });

/** How the owner answers a request: this call, this call and the like for the session, or no. */
export type Verdict = "allow" | "session" | "deny";

/** Pure: the line that answers a permission request. "session" adds `sessionRule` to the child's
 *  session only: it ends with the child, nothing is written in a settings file. A question is answered
 *  by allowing it with the owner's `answers` (question → chosen label, several joined by ", "), which
 *  Claude Code hands back to the child as the tool's result; "deny" leaves it unanswered. */
export function answerLine(
  p: Pending,
  verdict: Verdict,
  message?: string,
  answers?: Record<string, string>,
): string {
  if (p.kind === "question" && verdict !== "deny") {
    const missing = (p.questions ?? []).filter((q) => !answers?.[q.question]?.trim()).map((q) => q.question);
    if (missing.length) throw new Error(`no answer for: ${missing.join(" / ")}`);
  }
  const response = verdict === "deny"
    ? { behavior: "deny", message: message?.trim() || "The owner said no." }
    : p.kind === "question"
    ? { behavior: "allow", updatedInput: { ...p.input, answers } }
    : verdict === "session"
    ? {
      behavior: "allow",
      updatedInput: p.input,
      updatedPermissions: [{
        type: "addRules",
        rules: [sessionRule(p.tool, p.input)],
        behavior: "allow",
        destination: "session",
      }],
    }
    : { behavior: "allow", updatedInput: p.input };
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
  run?: { id: string; step: string };
  /** more MCP servers for this child (`--mcp-config`, JSON), and tools it may use without asking */
  mcpConfig?: string;
  allowedTools?: string[];
}

/** The mode a profile's sessions start in: `defaultMode` in its built settings (`<runtime>/<profile>`,
 *  what the launcher points CLAUDE_CONFIG_DIR at), as `childMode` lets a child have it. */
export async function modeOf(profile: string, runtime: string): Promise<ChildMode> {
  const s = await Deno.readTextFile(`${runtime}/${profile}/settings.json`).then(JSON.parse).catch(() => null);
  return childMode(s?.permissions?.defaultMode);
}

/** Starts a child: its folder, the fifo held open, the session detached from whoever asked. */
export async function startChild(
  i: StartInput,
  runs = runsDir(),
  home = Deno.env.get("HOME") ?? "",
  config = configDir(),
  runtime = `${home}/.agents-multi`,
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
  const mode = await modeOf(i.profile, runtime);
  const meta: Meta = { id, profile: i.profile, command, dir, task: i.task, started: new Date().toISOString(), mode };
  if (i.model) meta.model = i.model;
  if (i.run) meta.run = i.run;
  await Deno.writeTextFile(`${run}/meta.json`, JSON.stringify(meta, null, 2));
  const fifo = await new Deno.Command("mkfifo", { args: [`${run}/in`] }).output();
  if (!fifo.success) throw new Error("could not make the child's stdin");
  // values reach the shell as variables, never inside the script's text
  const script = [
    'sleep infinity > "$R/in" & echo $! > "$R/holder.pid"',
    'cd "$W" || exit 1',
    'echo $$ > "$R/claude.pid"',
    'exec "$L" -p ${M:+--model "$M"} ${C:+--mcp-config "$C"} ${T:+--allowedTools "$T"} ' +
    "--input-format stream-json --output-format stream-json --verbose " +
    '--permission-mode "$P" --permission-prompt-tool stdio < "$R/in" > "$R/out.jsonl" 2> "$R/err.log"',
  ].join("\n");
  const env: Record<string, string> = { R: run, W: dir, L: command, P: mode };
  if (i.model) env.M = i.model;
  if (i.mcpConfig) env.C = i.mcpConfig;
  if (i.allowedTools?.length) env.T = i.allowedTools.join(",");
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

/** Answers one of a child's requests or questions; refused when it is not one it is waiting on. */
export async function answer(
  id: string,
  request: string,
  verdict: Verdict,
  message?: string,
  runs = runsDir(),
  answers?: Record<string, string>,
) {
  const c = await readChild(id, runs);
  if (!c) throw new Error(`no child ${id}`);
  const p = c.state.pending.find((x) => x.request === request);
  if (!p) throw new Error(`${id} is not waiting on ${request}`);
  await send(`${runs}/${id}`, answerLine(p, verdict, message, answers));
  const rule = verdict === "session" && p.kind === "request" ? p.session : null;
  await Deno.writeTextFile(
    `${runs}/${id}/answers.jsonl`,
    JSON.stringify({
      request,
      verdict,
      rule,
      answers: answers ?? null,
      message: message ?? null,
      at: new Date().toISOString(),
    }) + "\n",
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

const look = async (runs: string) => new Map((await listChildren(runs)).map((c) => [c.meta.id, c.state] as const));

/** Waits until something needs the owner (a request, a finished turn, a child gone), or `timeoutMs`. */
export async function waitForAttention(timeoutMs: number, runs = runsDir(), everyMs = 2000): Promise<Attention[]> {
  const before = await look(runs);
  for (let t = 0; t < timeoutMs; t += everyMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    const found = attentionBetween(before, await look(runs));
    if (found.length) return found;
  }
  return [];
}
