// api.ts — the console's HTTP API, typed. A POST carries the anti-CSRF header the server requires.
// The types come from the server's own modules where those have no Deno imports (lib/output.ts);
// the rest is the part of a response the pages read. A page that reads more of the report, or an
// endpoint only it calls, declares that beside itself (pages/<page>/api.ts), not here.

import type { Check, RepairStep, Status } from "../../cli/lib/output.ts";
import { askToEnterAgain } from "./lib/window.ts";
import { errorText } from "./lib/http-error.ts";

export type { Check, RepairStep, Status };

export interface ProfileView {
  dir: string;
  exists: boolean;
  desktopDir: string | null;
  account: string | null;
  mcp: string[];
  plugins?: string[];
  [more: string]: unknown;
}

interface RunningCli {
  pid: number;
  profile: string;
  cwd: string;
  embedded: boolean;
  version: string;
  session: string | null;
  model: string | null;
  lastActivity: string | null;
}

interface VersionState {
  current: string | null;
  latest: string | null;
  outdated: boolean;
}

/** The part of /api/status the pages read. */
export interface StatusView {
  generatedAt: string;
  language: string;
  machine: {
    hostname: string;
    graphical: boolean;
    desktopVersion: string | null;
    desktopStaged: string | null;
    desktopPrevious: string | null;
    embeddedCode: Record<string, string | null>;
    cliVersion: string | null;
    deno: string | null;
    [more: string]: unknown;
  };
  repo: {
    path: string;
    isRepo: boolean;
    branch: string;
    ahead: number;
    behind: number;
    dirty: number;
    head: string;
    headDate: string;
    version: string;
    [more: string]: unknown;
  };
  update: { cli?: VersionState; desktop?: VersionState; checked_at?: number };
  updateLog: { at: string; component: string; event: string; from?: string; to?: string; detail?: string }[];
  shared: {
    skills: Record<string, unknown>;
    agents: Record<string, unknown>;
    commands: Record<string, unknown>;
    hooks: string[];
    rules: string[];
    [more: string]: unknown;
  };
  profiles: Record<string, ProfileView>;
  running: { cli: RunningCli[]; desktop: { pid: number; variant: string; [more: string]: unknown }[] };
  brain: { url: string | null; [more: string]: unknown };
  doctor: Check[];
}

/** /api/summary: the tray's verdict on the same report (summarize() in apps/cli/status.ts). */
export interface Summary {
  level: "ok" | "fail";
  fails: string[];
  warns: string[];
  staged: string | null;
  running: { cli: number; desktop: number };
  generatedAt: string;
}

/** /api/owner: whose console this is; the chat greets them. */
export interface Owner {
  id: string;
  name: string;
  language?: string;
}

/** What most POSTs answer: ok, or a message to show. */
export interface Result {
  ok: boolean;
  message?: string;
  [more: string]: unknown;
}

/** The one place that names the anti-CSRF header the server requires on every write. The page's
 *  token is a cookie the browser sends by itself (apps/cli/console/token.ts). */
const CSRF = { "x-claude-multi": "1" };

/** `fetch`, noticing that the console no longer knows the page's token (it restarted under an open
 *  window): the app, if it holds the window, enters again. */
async function send(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(path, init);
  if (r.status === 401) askToEnterAgain();
  return r;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await send(path, init);
  if (!r.ok) throw new Error(errorText(r.status, await r.text().catch(() => "")));
  return r.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return call<T>(path);
}

/** The init of a POST the server accepts: JSON with the anti-CSRF header. */
function postInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...CSRF },
    body: JSON.stringify(body),
    signal,
  };
}

export function post<T = Result>(path: string, body: unknown): Promise<T> {
  return call<T>(path, postInit(body));
}

/** A POST whose Response the caller reads itself, whatever the status: a stream, or a refusal that is
 *  an answer. Aborting `signal` ends the request. */
export function postRaw(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return send(path, postInit(body, signal));
}

/** A GET whose Response the caller reads itself (a stream). */
function getRaw(path: string): Promise<Response> {
  return send(path);
}

/** A POST whose body is a file or text as it is, with headers of its own; the JSON answer. */
export function upload<T = Result>(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<T> {
  return call<T>(path, { method: "POST", headers: { ...CSRF, ...headers }, body });
}

/** The server's event stream (SSE): it carries no headers, and only reads. */
export function openEvents(): EventSource {
  return new EventSource("/api/events");
}

/** Reads an NDJSON response line by line. */
export async function ndjson<T>(res: Response, on: (line: T) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) on(JSON.parse(l) as T);
  }
}

/** What an allowlisted action (/api/action) answers. */
export interface ActionResult {
  output?: string;
  code: number;
  ms: number;
}

/** One line of what /api/ask streams (`Out` in apps/cli/ask.ts). */
export type AskLine =
  | { t: "chat"; id: string }
  | { t: "session"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; k: string; n: string; d?: string }
  | { t: "done"; text: string; code: string | null; error?: string };

/** Asks Claude in the chat `chat`, a new one when null (its id comes first, as a `chat` line); `on` gets
 *  each line as it comes. Aborting `signal` stops claude -p on the server. */
export async function askStream(
  text: string,
  chat: string | null,
  signal: AbortSignal,
  on: (l: AskLine) => void,
): Promise<void> {
  const res = await api.ask({ text, chat }, signal);
  if (!res.ok || !res.body) {
    throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  await ndjson<AskLine>(res, on);
}

/** Who holds the install, as /api/close-claude lists them. */
export interface Blocker {
  key: string;
  pid: number;
  profile: string;
  embedded: boolean;
  busy: boolean | null;
  ageSec: number | null;
  protected: boolean;
}
/** What Claude is closed for: an install waiting, or a repair's «close» step. */
export type ClosePurpose = "install" | Extract<RepairStep, { kind: "close" }>["for"];
export interface Plan {
  offer: boolean;
  /** the build or commit an install is waiting with; null when none is */
  pending: string | null;
  blockers: Blocker[];
}

/** GET /api/ask/model. `efforts` and `default` came later: an older console sends only the names. */
export interface ModelState {
  model: string;
  models: string[];
  efforts?: Record<string, string>;
  default?: string;
}

export const api = {
  status: (fresh = false) => get<StatusView>(`/api/status${fresh ? "?fresh" : ""}`),
  summary: (fresh = false) => get<Summary>(`/api/summary${fresh ? "?fresh" : ""}`),
  owner: () => get<Owner>("/api/owner"),
  /** The build the console is running (it changes on a restart onto other code). */
  code: () => get<{ code?: string }>("/api/code"),
  action: (action: string, opts: string[] = []) => post<ActionResult>("/api/action", { action, opts }),
  /** Starts a job; the Response says whether it began (`ok`, `id`) or why not. */
  jobStart: (action: string, params?: Record<string, string>) => postRaw("/api/job", { action, params }),
  /** A job's output as NDJSON. */
  jobOutput: (id: string) => getRaw(`/api/job?id=${encodeURIComponent(id)}`),
  jobCancel: (id: string) => post("/api/job/cancel", { id }).then(() => {}, () => {}),
  /** Claude Code in a terminal: resuming a session, or in a folder on a request. */
  terminal: (body: Record<string, unknown>) => post<Result>("/api/terminal", body),
  launch: (profile: string) => post<Result>("/api/launch", { profile }),
  /** Asks Claude (NDJSON, `AskLine`s); aborting `signal` stops claude -p on the server. */
  ask: (body: Record<string, unknown>, signal: AbortSignal) => postRaw("/api/ask", body, signal),
  closePlan: (why: ClosePurpose = "install") => get<Plan>(`/api/close-claude?for=${encodeURIComponent(why)}`),
  /** The model Claude answers with, shared by the Chat page and the Hey window. */
  askModel: () => get<ModelState>("/api/ask/model"),
  setAskModel: (model: string) => post("/api/ask/model", { model }),
};
