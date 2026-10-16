// agents.ts — the hub's children: Claude Code sessions of any profile, started without a terminal in a
// project's folder, that ask the hub for every permission their profile's rules do not already give.
// A child keeps its profile's permission mode (auto: a classifier lets the safe steps through), never
// a bypass: each request left over arrives here (stream-json, `--permission-prompt-tool stdio`) and
// waits until someone answers it — in practice the owner, through the coordinator. An answer can allow
// the one call, or a rule for the rest of the child's session (`sessionRule`).
//
// A child lives in files, so it outlives whoever started it and anyone on the machine can follow it:
//   <runs>/<id>/meta.json     who, where, what it was asked, whose (the coordinator's project and session)
//   <runs>/<id>/in            a fifo: its stdin (user messages, answers to its requests)
//   <runs>/<id>/out.jsonl     its events (stream-json)
//   <runs>/<id>/answers.jsonl the requests answered, and how
//   <runs>/<id>/child.pid, holder.pid, err.log
// Closing the fifo's holder ends the session after its current turn.
//
// A provider is what differs between children: Claude Code, or Codex (OpenAI). Both speak these files:
// a Codex child's process is `agents/codex-driver.ts`, which runs `codex exec` turn by turn and writes
// `out.jsonl` in Claude's stream-json, so sending, reading its state and stopping are the same code.
// What a provider adds is how its process starts (`Provider`, providers.ts). (`child.pid` is the child's
// process, whichever provider; a child started before the rename has `claude.pid`, read all the same.)

import { configDir } from "./owner.ts";
import { myCoordinator, type Proc, procAlive, type ProcReader, procReader, sameStart } from "./proc.ts";
import { spawnDetached } from "./platform.ts";
import { launcherOf, type ProviderName, providers } from "./providers.ts";
import { childEnv, childSettings } from "./headless.ts";

export { launcherOf, type ProviderName };

interface Meta {
  id: string;
  profile: string;
  /** the launcher it runs: the profile's command */
  command: string;
  /** the project's folder */
  dir: string;
  task: string;
  started: string;
  /** which provider runs it; absent in a child older than the second one (Claude) */
  provider?: ProviderName;
  model?: string;
  /** the permission mode it runs in (`childMode`) */
  mode?: ChildMode;
  /** the workflow run and step it is (runs.ts), when it is one */
  run?: { id: string; step: string };
  /** whose it is (`Owned`). Absent in a child older than this: `readChild` gives it the project of its folder. */
  project?: string;
  owner?: Coordinator;
}

/** The coordinator that owns a child or a run: its `claude` process (pid and start time, proc.ts) and, as
 *  a note, the session id the environment gave it. */
export interface Coordinator extends Proc {
  session?: string;
}

/** What says whose a child or a run is: the project of the coordinator that started it (the main
 *  repository's root) and the coordinator. Without an `owner` it is an orphan of its project. */
export interface Owned {
  project?: string;
  owner?: Coordinator;
}

/** Who starts a child or a run: a project always, a coordinator when there is one. A coordinator with no
 *  folder (Desktop) gives "": the project is then that of the child's or the run's folder. */
export interface Owner {
  project: string;
  owner?: Coordinator;
}

/** What a caller may see and touch. By default its own session's children (and the orphans of its project,
 *  which it can adopt); `project` also shows the project's other live coordinators' (read-only); `all` every
 *  project's (read-only). `me` is the caller's coordinator; without one (a plain terminal) the person is
 *  the coordinator of every child of the project. A Claude Desktop app has no folder: its `project` is ""
 *  (`folderless`) and it owns what it started in any project. */
export interface Scope {
  project: string;
  me?: Coordinator;
  view?: "mine" | "project" | "all";
}

/** How something is related to a caller: `own` its own, `orphan` its project's with no live owner,
 *  `peer` its project's under another live coordinator, `other` another project's. */
export type Access = "own" | "orphan" | "peer" | "other";

/** Pure: the main repository's root from a `.git` file's text (a linked worktree or a submodule), given
 *  the folder that holds it. A worktree's gitdir is `<main>/.git/worktrees/<name>`; a submodule's is
 *  inside its parent's `.git/modules`, and that folder is its own root. */
export function rootFromGitFile(text: string, holder: string): string {
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return holder;
  const given = m[1].trim();
  const parts: string[] = [];
  for (const seg of (given.startsWith("/") ? given : `${holder}/${given}`).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const w = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(`/${parts.join("/")}`);
  return w ? w[1] : holder;
}

/** A folder's project: the main repository's root (a worktree resolves to the repository it hangs from),
 *  or the folder itself when no repository holds it. Real paths, symlinks resolved. */
export async function projectOf(folder: string): Promise<string> {
  const given = folder.replace(/^~(?=\/|$)/, Deno.env.get("HOME") ?? "");
  const start = await Deno.realPath(given).catch(() => given.replace(/\/+$/, "") || "/");
  for (let d = start;; d = d.slice(0, d.lastIndexOf("/")) || "/") {
    const st = await Deno.stat(`${d}/.git`).catch(() => null);
    if (st?.isDirectory) return d;
    if (st?.isFile) {
      const file = await Deno.readTextFile(`${d}/.git`).catch(() => "");
      return rootFromGitFile(file, await Deno.realPath(d).catch(() => d));
    }
    if (d === "/") return start;
  }
}

/** A caller's scope: its folder's project, the coordinator it runs under, and what it asks to see. Under the
 *  Desktop app the folder means nothing (its MCP servers run in the home folder): no project. */
export async function scopeOf(
  opts: { all?: boolean; project?: boolean; cwd?: string; me?: Coordinator | null; session?: string } = {},
): Promise<Scope> {
  const found = opts.me === undefined ? myCoordinator() : opts.me;
  const session = opts.session ?? (Deno.env.get("CLAUDE_CODE_SESSION_ID") || undefined);
  return {
    project: found?.desktop ? "" : await projectOf(opts.cwd ?? Deno.cwd()),
    me: found ? { ...found, ...(session ? { session } : {}) } : undefined,
    view: opts.all ? "all" : opts.project ? "project" : "mine",
  };
}

/** The owner a caller's children and runs get. */
export const ownerOf = (s: Scope): Owner => s.me ? { project: s.project, owner: s.me } : { project: s.project };

/** Pure: whether the caller has no project folder (Claude Desktop): one app for all its conversations, and
 *  the coordinator of what it started in any project. */
export const folderless = (scope: Scope): boolean => !scope.project;

/** Pure: whether a project's records that no coordinator owns (routines, account proposals) are within the
 *  caller's reach: its own project's; every project's for a caller with no folder, as for the console. */
export const reaches = (project: string | undefined, scope: Scope): boolean =>
  folderless(scope) || project === scope.project;

/** Pure: how something owned by `o` relates to the caller. A thing with no live owner process (none
 *  recorded, pid gone, or the pid reused: another start time) is an orphan. For a caller with no folder
 *  every project is its own: what it started is `own` wherever, the rest `peer` or `orphan`. */
export function accessOf(o: Owned | undefined, scope: Scope, read: ProcReader = procReader): Access {
  if (!o?.project || (o.project !== scope.project && !folderless(scope))) return "other";
  if (!procAlive(o.owner, read)) return "orphan";
  if (!scope.me) return "own";
  return o.owner!.pid === scope.me.pid && sameStart(o.owner!.start, scope.me.start) ? "own" : "peer";
}

/** Pure: whether the caller may see it: its own and its project's orphans by default, with `project` the
 *  other coordinators' of the project too, with `all` everything. A caller with no folder sees its own by
 *  default (every project's orphans would bury them) and, with `project` or `all`, everything. */
export function inScope(o: Owned | undefined, scope: Scope, read: ProcReader = procReader): boolean {
  if (scope.view === "all") return true;
  const a = accessOf(o, scope, read);
  if (folderless(scope)) return a === "own" || (a !== "other" && scope.view === "project");
  return a === "own" || a === "orphan" || (a === "peer" && scope.view === "project");
}

/** Pure: whether the caller may act on it (answer, say, stop): what is its own — and, for a person at a
 *  plain terminal (no coordinator), any child of the project, an orphan included. An orphan is adopted first. */
export function mayAct(o: Owned | undefined, scope: Scope, read: ProcReader = procReader): boolean {
  const a = accessOf(o, scope, read);
  return a === "own" || (!scope.me && a === "orphan");
}

/** Why a caller may not act on something. */
export function refusal(what: string, o: Owned | undefined, scope: Scope, read: ProcReader = procReader): string {
  switch (accessOf(o, scope, read)) {
    case "other":
      return `${what} belongs to another project (${o?.project ?? "unknown"}), this session is in ${scope.project}: ` +
        "only the coordinator of its project may act on it";
    case "peer":
      return `${what} belongs to another live session${folderless(scope) ? "" : " of this project"} ` +
        `(pid ${o?.owner?.pid}): only that session ` +
        "may act on it";
    default:
      return `${what} is an orphan (its coordinator is gone): adopt it first (\`agents agent adopt\`, or the ` +
        "adopt tool), then act on it";
  }
}

/** Pure: an orphan of the caller's own project is adoptable by a caller that has a coordinator. Adoption
 *  never crosses projects; a caller with no folder (Desktop) is in none, so it adopts any project's orphan. */
export const mayAdopt = (o: Owned | undefined, scope: Scope, read: ProcReader = procReader): boolean =>
  !!scope.me && accessOf(o, scope, read) === "orphan";

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

/** Programs that only read and print: "yes for the session" on one covers the program (`ls:*`). Left out on
 *  purpose, because a flag makes them run or write anything: find (-exec, -delete), rg (--pre), sort (-o),
 *  uniq and tee (an output file), date (-s), sed and awk. Every other program (interpreters, shells, env,
 *  xargs, sudo, curl, ssh, git, docker, deno, npx…) is allowed one exact command at a time. */
const SAFE_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "pwd",
  "echo",
  "diff",
  "stat",
  "du",
  "df",
  "which",
  "whoami",
  "uname",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "cut",
]);

/** Programs whose read-only or test subcommands (the words after the program) are safe to allow for the session. */
const SAFE_SUBCOMMANDS: Record<string, string[][]> = {
  git: [["status"], ["diff"], ["log"], ["show"]],
  deno: [["task", "test"], ["task", "check"], ["task", "ci"]],
  pnpm: [["test"], ["build"]],
};

/** Pure: the command prefix a session may be given a rule for, when the command is one simple command
 *  of a safe program (or a safe subcommand of one); null otherwise. */
function safePrefix(command: string): string | null {
  if (/[;&|<>`$(){}\n\\]/.test(command)) return null;
  const words = command.split(/\s+/);
  const program = words[0];
  if (!/^[A-Za-z0-9._-]+$/.test(program)) return null; // a path, a variable assignment, a quote
  if (SAFE_PROGRAMS.has(program)) return program;
  const sub = SAFE_SUBCOMMANDS[program]?.find((s) => s.every((w, i) => words[i + 1] === w));
  return sub ? [program, ...sub].join(" ") : null;
}

/** Pure: the rule "yes for this session" adds for a request. Bash: the program for a simple command of a
 *  read-only program (`ls:*`) or `git status:*`-like subcommand, else the command exactly — never a rule
 *  that lets a program run anything; WebFetch: the domain; any other tool: the tool. */
export function sessionRule(tool: string, input: Record<string, unknown>): Rule {
  if (tool === "Bash" && typeof input.command === "string") {
    const command = input.command.trim();
    const prefix = safePrefix(command);
    return { toolName: tool, ruleContent: prefix ? `${prefix}:*` : command };
  }
  if (tool === "WebFetch" && typeof input.url === "string") {
    const host = URL.parse(input.url)?.hostname;
    if (host) return { toolName: tool, ruleContent: `domain:${host}` };
  }
  return { toolName: tool };
}

/** Pure: a rule as a person reads it, `Bash(curl:*)`. */
const ruleText = (r: Rule) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;

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

/** What `stateOf` has made of the lines so far: the part that depends on the events only, so a reader
 *  that sees new lines can go on from there instead of from the first one. */
interface Fold {
  st: ChildState;
  open: Map<string, Pending>;
  busy: boolean;
}

const newFold = (): Fold => ({
  st: { phase: "working", session: null, pending: [], said: [], turns: 0, lastResult: null, error: null, costUsd: 0 },
  open: new Map(),
  busy: true,
});

/** Pure: takes more lines of a child's events into a fold. */
function foldLines(f: Fold, lines: string[], answered: Set<string>, now: number) {
  const { st, open } = f;
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
      f.busy = true;
      const content = (e.message as { content?: unknown[] })?.content ?? [];
      for (const c of content as Record<string, unknown>[]) {
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          st.said.push(c.text.trim());
          if (st.said.length > SAID) st.said.shift();
        }
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
      f.busy = false;
      st.turns++;
      st.lastResult = typeof e.result === "string" ? e.result : String(e.subtype ?? "");
      if (e.is_error) st.error = st.lastResult;
      if (typeof e.total_cost_usd === "number") st.costUsd = e.total_cost_usd;
    } else if (type === "user") f.busy = true;
  }
}

/** Pure: the state a fold stands for, with the requests answered since and whether the child still runs. */
function stateOfFold(f: Fold, answered: Set<string>, alive: boolean): ChildState {
  const pending = [...f.open.values()].filter((p) => !answered.has(p.request));
  const phase = !alive ? "ended" : pending.length ? "waiting" : f.busy ? "working" : "idle";
  return { ...f.st, said: [...f.st.said], pending, phase };
}

/** How many of a child's last words a state keeps. */
const SAID = 5;

/** Pure: a child's state from its events, the requests already answered, and whether it still runs. */
export function stateOf(lines: string[], answered: Set<string>, alive: boolean, now = Date.now()): ChildState {
  const f = newFold();
  foldLines(f, lines, answered, now);
  return stateOfFold(f, answered, alive);
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
  /** the child's coordinator is gone: adopt it before answering */
  orphan?: true;
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
const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });

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

/** Whether the process whose pid `pidFile` holds runs (a child, a workflow's runner). `ps` on the one
 *  pid, not /proc: Deno lets only --allow-all read /proc. */
export const pidAlive = async (pidFile: string) => {
  const pid = Number((await Deno.readTextFile(pidFile).catch(() => "")).trim());
  if (!(pid > 0)) return false;
  const r = await new Deno.Command("ps", { args: ["-o", "stat=", "-p", String(pid)], stdout: "piped", stderr: "null" })
    .output().catch(() => null);
  return !!r?.success && runsBy(new TextDecoder().decode(r.stdout));
};

/** Whether a child's process runs: `child.pid`, or `claude.pid` in a child started before the name was
 *  provider-neutral. */
export const childAlive = async (dir: string) =>
  await pidAlive(`${dir}/child.pid`) || await pidAlive(`${dir}/claude.pid`);

/** A file's non-empty lines; none when it is missing. */
export async function lines(file: string): Promise<string[]> {
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
  /** how it relates to the caller, when read through a scope */
  access?: Access;
}

export async function readChild(id: string, runs = runsDir()): Promise<Child | null> {
  if (!validId(id)) return null;
  const dir = `${runs}/${id}`;
  const meta = await Deno.readTextFile(`${dir}/meta.json`).then(JSON.parse).catch(() => null) as Meta | null;
  if (!meta) return null;
  // a child older than the scope belongs to the project of its own folder
  meta.project ??= await projectOf(meta.dir ?? "/").catch(() => undefined);
  const state = stateOfFold(await foldOf(`${dir}/out.jsonl`), await answeredOf(dir), await childAlive(dir));
  if (state.phase === "ended" && !state.turns) {
    const err = (await Deno.readTextFile(`${dir}/err.log`).catch(() => "")).trim();
    if (err) state.error = err.split("\n").slice(-3).join(" ");
  }
  return { meta, state };
}

/** The fold of each child's `out.jsonl` and how far into the file it has read: a reader that comes back
 *  (a watch looks every second) takes only the lines added since, not the whole file again (a long child's
 *  is tens of MB). Small: one state per child. */
const folds = new Map<string, { fold: Fold; offset: number }>();

const looking = new Map<string, Promise<unknown>>();

/** A child's events folded up to now. Looks at one file go one after the other: two readers starting at the
 *  same offset would count its lines twice. */
function foldOf(file: string): Promise<Fold> {
  const turn = (looking.get(file) ?? Promise.resolve()).then(() => foldFrom(file));
  const queued = turn.catch(() => {}).finally(() => {
    if (looking.get(file) === queued) looking.delete(file);
  });
  looking.set(file, queued);
  return turn;
}

/** Reads from where the last look stopped, and only whole lines. */
async function foldFrom(file: string): Promise<Fold> {
  let have = folds.get(file);
  let f: Deno.FsFile;
  try {
    f = await Deno.open(file);
  } catch {
    folds.delete(file);
    return newFold();
  }
  try {
    const size = (await f.stat()).size;
    if (!have || size < have.offset) folds.set(file, have = { fold: newFold(), offset: 0 });
    // in chunks, so a file that grew a lot meanwhile is never held whole
    const buf = new Uint8Array(1 << 20);
    let carry = new Uint8Array(0);
    await f.seek(have.offset, Deno.SeekMode.Start);
    for (let n = await f.read(buf); n; n = await f.read(buf)) {
      const data = new Uint8Array(carry.length + n);
      data.set(carry);
      data.set(buf.subarray(0, n), carry.length);
      const end = data.lastIndexOf(10) + 1; // a line still being written waits for its end
      if (end) {
        foldLines(
          have.fold,
          new TextDecoder().decode(data.subarray(0, end)).split("\n").filter(Boolean),
          new Set(),
          Date.now(),
        );
        have.offset += end;
      }
      carry = data.slice(end);
    }
  } finally {
    f.close();
  }
  return have.fold;
}

export async function listChildren(runs = runsDir(), scope?: Scope): Promise<Child[]> {
  const out: Child[] = [];
  const present = new Set<string>();
  try {
    for await (const e of Deno.readDir(runs)) {
      if (!e.isDirectory) continue;
      present.add(`${runs}/${e.name}/out.jsonl`);
      const c = await readChild(e.name, runs);
      if (!c) continue;
      if (!scope) out.push(c);
      else if (inScope(c.meta, scope)) out.push({ ...c, access: accessOf(c.meta, scope) });
    }
  } catch { /* no child yet */ }
  for (const file of folds.keys()) if (file.startsWith(`${runs}/`) && !present.has(file)) folds.delete(file);
  return out.sort((a, b) => a.meta.started.localeCompare(b.meta.started));
}

/** A child the scope may see; with `act`, one it may also act on (its own): throws otherwise, with why. */
export async function childIn(id: string, scope: Scope | undefined, runs = runsDir(), act = false): Promise<Child> {
  const c = await readChild(id, runs);
  if (!c) throw new Error(`no child ${id}`);
  if (!scope) return c;
  if (!(act ? mayAct(c.meta, scope) : inScope(c.meta, scope))) throw new Error(refusal(id, c.meta, scope));
  return { ...c, access: accessOf(c.meta, scope) };
}

/** Takes an orphan of the caller's project: its owner becomes the caller's coordinator. Never another
 *  project's, never one whose owner is alive. */
export async function adoptChild(id: string, scope: Scope, runs = runsDir()): Promise<Coordinator> {
  const c = await readChild(id, runs);
  if (!c) throw new Error(`no child ${id}`);
  const me = adoptable(id, c.meta, scope);
  const file = `${runs}/${id}/meta.json`;
  const meta = await Deno.readTextFile(file).then(JSON.parse) as Meta;
  meta.project = c.meta.project;
  meta.owner = me;
  await Deno.writeTextFile(file, JSON.stringify(meta, null, 2));
  return me;
}

/** The caller's coordinator when it may adopt `o`; throws with why otherwise. */
export function adoptable(
  what: string,
  o: Owned | undefined,
  scope: Scope,
  read: ProcReader = procReader,
): Coordinator {
  if (!scope.me) throw new Error("only a coordinator's session adopts: this caller runs under no `claude` process");
  if (!mayAdopt(o, scope, read)) {
    const a = accessOf(o, scope, read);
    throw new Error(
      a === "own"
        ? `${what} is already yours`
        : a === "orphan"
        ? `${what} cannot be adopted`
        : a === "peer"
        ? `${what} has a live coordinator (pid ${o?.owner?.pid}): it is not an orphan`
        : `${what} belongs to another project (${o?.project ?? "unknown"}): never adopted across projects`,
    );
  }
  return scope.me;
}

/** Writes a line on a child's stdin; refused when the child is gone (a fifo with no reader would block). */
async function send(dir: string, line: string): Promise<void> {
  if (!(await childAlive(dir))) throw new Error("the child is not running");
  const f = await Deno.open(`${dir}/in`, { write: true });
  try {
    await f.write(new TextEncoder().encode(`${line}\n`));
  } finally {
    f.close();
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/** Pure: a child's id from its profile, folder and start time, with a few random letters. */
export function childId(profile: string, dir: string, at: Date, rand: string): string {
  const stamp = at.toISOString().slice(5, 16).replace(/[-T:]/g, "");
  return `${slug(profile)}-${slug(dir.split("/").filter(Boolean).pop() ?? "x")}-${stamp}-${rand}`;
}

interface StartInput {
  profile: string;
  /** default Claude */
  provider?: ProviderName;
  dir: string;
  task: string;
  model?: string;
  run?: { id: string; step: string };
  /** whose it is; without one, the project of its own folder */
  owner?: Owner;
  /** more MCP servers for this child (`--mcp-config`, JSON), and tools it may use without asking */
  mcpConfig?: string;
  allowedTools?: string[];
  /** rules it is denied whatever its mode (`--disallowedTools`; Claude only) */
  disallowedTools?: string[];
  /** rules it must ask the hub for whatever its mode (a session `ask` rule; Claude only) */
  askTools?: string[];
}

/** The mode a profile's sessions start in: `defaultMode` in its built settings (`<runtime>/<profile>`,
 *  what the launcher points CLAUDE_CONFIG_DIR at), as `childMode` lets a child have it. */
export async function modeOf(profile: string, runtime: string): Promise<ChildMode> {
  const s = await Deno.readTextFile(`${runtime}/${profile}/settings.json`).then(JSON.parse).catch(() => null);
  return childMode(s?.permissions?.defaultMode);
}

/** The variables a Claude Code session sets for what it runs, as an extended regular expression (bash's
 *  `=~` and JavaScript read it alike). Whatever is started from inside one — this server, the console
 *  from a terminal in Claude — inherits them, and a Claude started from there took that session's
 *  profile, permissions and project for its own: with `CLAUDE_PROJECT_DIR` a project's `.mcp.json`
 *  looked for its files in the coordinator's folder, and its servers failed. Agents Multi's own
 *  (AGENTS_MULTI_*) stay. */
const CLAUDE_SESSION_VARS =
  "^(CLAUDECODE|CLAUDE_CONFIG_DIR|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE|CLAUDE_(CODE|AGENT_SDK|PREVIEW)_.*)$";

/** Pure: of these variable names, a Claude session's (CLAUDE_SESSION_VARS). */
export const claudeSessionVars = (names: string[]): string[] =>
  names.filter((n) => new RegExp(CLAUDE_SESSION_VARS).test(n));

/** Pure: whether `path` is `home` itself or inside it; both are real paths (symlinks and `..` resolved). */
export const isUnder = (home: string, path: string) =>
  home !== "" && (path === home || path.startsWith(`${home.replace(/\/$/, "")}/`));

/** Starts a child: its folder, the fifo held open, the session detached from whoever asked. */
export async function startChild(
  i: StartInput,
  runs = runsDir(),
  home = Deno.env.get("HOME") ?? "",
  config = configDir(),
  runtime = `${home}/.agents-multi`,
): Promise<Meta> {
  const name = i.provider ?? "claude";
  const provider = providers[name];
  if (!provider) throw new Error(`no provider ${name}`);
  const command = await provider.command(i.profile, config, runtime);
  const given = i.dir.replace(/^~(?=\/|$)/, home);
  if (!(await Deno.stat(given).catch(() => null))?.isDirectory) throw new Error(`no folder ${given}`);
  const dir = await Deno.realPath(given);
  if (!isUnder(await Deno.realPath(home).catch(() => home), dir)) {
    throw new Error("the folder must be under the home folder");
  }
  if (!i.task.trim()) throw new Error("say what the child has to do");
  if (i.model && !/^[a-z0-9.\[\]-]+$/i.test(i.model)) throw new Error("not a model name");
  const id = childId(i.profile, dir, new Date(), crypto.randomUUID().slice(0, 4));
  const run = `${runs}/${id}`;
  await Deno.mkdir(run, { recursive: true });
  const mode = await modeOf(i.profile, runtime);
  const meta: Meta = { id, profile: i.profile, command, dir, task: i.task, started: new Date().toISOString(), mode };
  if (name !== "claude") meta.provider = name;
  if (i.model) meta.model = i.model;
  if (i.run) meta.run = i.run;
  const owner = i.owner ?? { project: "" };
  // a coordinator with no folder (Desktop) gives its child the project of the child's own folder
  meta.project = owner.project || await projectOf(dir);
  if (owner.owner) meta.owner = owner.owner;
  await Deno.writeTextFile(`${run}/meta.json`, JSON.stringify(meta, null, 2));
  const fifo = await new Deno.Command("mkfifo", { args: [`${run}/in`] }).output();
  if (!fifo.success) throw new Error("could not make the child's stdin");
  // values reach the shell as variables, never inside the script's text
  // a child is a session of its own: none of the variables of the Claude session that started the hub
  const exec = await provider.exec({
    command,
    mode,
    model: i.model,
    profile: i.profile,
    runtime,
    mcpConfig: i.mcpConfig,
    allowedTools: i.allowedTools,
    disallowedTools: i.disallowedTools,
    askTools: i.askTools,
    // on a headless node every child is sandboxed, whoever starts it (ADR 0012)
    settings: await childSettings(home, runtime, config),
  });
  const script = [
    'for n in $(compgen -e); do [[ $n =~ $V ]] && unset "$n"; done',
    // a headless node's (ADR 0013): kept as shell variables, so that only Claude gets them, never the holder
    'T="${AM_CLAUDE_TOKEN:-}"; H="${AM_HEADLESS:-}"; unset AM_CLAUDE_TOKEN AM_HEADLESS',
    'sleep infinity > "$R/in" & echo $! > "$R/holder.pid"',
    'cd "$W" || exit 1',
    'echo $$ > "$R/child.pid"',
    // what outranks the account's token goes; the scrub keeps the token from what the child runs
    "if [[ -n $H ]]; then unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1; fi",
    'if [[ -n $T ]]; then export CLAUDE_CODE_OAUTH_TOKEN="$T"; fi; unset T H',
    exec.line,
  ].join("\n");
  const env: Record<string, string> = {
    R: run,
    W: dir,
    V: CLAUDE_SESSION_VARS,
    ...exec.env,
    ...await childEnv(i.profile, name, config),
  };
  await spawnDetached("bash", ["-c", script], { env });
  for (let t = 0; t < 50 && !(await childAlive(run)); t++) await new Promise((r) => setTimeout(r, 100));
  await send(run, userLine(i.task));
  return meta;
}

export async function sayTo(id: string, text: string, runs = runsDir(), scope?: Scope): Promise<void> {
  await childIn(id, scope, runs, true);
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
  scope?: Scope,
) {
  const c = await childIn(id, scope, runs, true);
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
export async function stopChild(id: string, force = false, runs = runsDir(), scope?: Scope): Promise<void> {
  if (!validId(id)) throw new Error(`no child ${id}`);
  if (scope) await childIn(id, scope, runs, true);
  const dir = `${runs}/${id}`;
  for (const f of force ? ["holder.pid", "child.pid", "claude.pid"] : ["holder.pid"]) {
    const pid = Number((await Deno.readTextFile(`${dir}/${f}`).catch(() => "")).trim());
    // the `kill` command, not Deno.kill: that needs --allow-run for every program, the server has three
    if (pid > 0) {
      await new Deno.Command("kill", { args: ["-TERM", String(pid)], stdout: "null", stderr: "null" }).output()
        .catch(() => null);
    }
  }
}

/** The children a scope sees: their states, and which of them are orphans. */
export async function look(runs: string, scope?: Scope) {
  const children = await listChildren(runs, scope);
  return {
    states: new Map(children.map((c) => [c.meta.id, c.state] as [string, ChildState])),
    orphans: new Set(children.filter((c) => c.access === "orphan").map((c) => c.meta.id)),
  };
}

/** Pure: what needs the owner, with the orphans' marked: their coordinator is gone, adopt before answering. */
export const markOrphans = (found: Attention[], orphans: Set<string>): Attention[] =>
  found.map((a) => orphans.has(a.id) ? { ...a, orphan: true as const } : a);

/** Waits until something needs the owner (a request, a finished turn, a child gone), or `timeoutMs`. */
export async function waitForAttention(
  timeoutMs: number,
  runs = runsDir(),
  everyMs = 2000,
  scope?: Scope,
): Promise<Attention[]> {
  const before = (await look(runs, scope)).states;
  for (let t = 0; t < timeoutMs; t += everyMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    const now = await look(runs, scope);
    const found = attentionBetween(before, now.states);
    if (found.length) return markOrphans(found, now.orphans);
  }
  return [];
}
