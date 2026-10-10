// api.ts — the console's HTTP API, typed. A POST carries the anti-CSRF header the server requires.
// The types come from the server's own modules where those have no Deno imports (lib/output.ts);
// the rest is the part of a response the pages read. A page that reads more of the report, or an
// endpoint only it calls, declares that beside itself (pages/<page>/api.ts), not here.

import type { Check, RepairStep, Status } from "../../cli/lib/output.ts";

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

/** /api/owner: whose console this is; their tasks are "mine". */
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim());
  return r.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return call<T>(path);
}

/** The init of a POST the server accepts: JSON with the anti-CSRF header. */
export function postInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-multi": "1" },
    body: JSON.stringify(body),
    signal,
  };
}

export function post<T = Result>(path: string, body: unknown): Promise<T> {
  return call<T>(path, postInit(body));
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

export const api = {
  status: (fresh = false) => get<StatusView>(`/api/status${fresh ? "?fresh" : ""}`),
  summary: (fresh = false) => get<Summary>(`/api/summary${fresh ? "?fresh" : ""}`),
  owner: () => get<Owner>("/api/owner"),
};
