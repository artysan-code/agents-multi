// app-update.ts — the desktop app's own updates, relayed (docs/adr/0004). The app owns the updater
// (apps/desktop/src-tauri/src/updater.rs); the console reaches it over the app's unix socket, never
// from the page: it follows the app's status on one long connection and says `app-update` on the event
// stream when it changes, and passes the page's `check`, `install`, `dismiss` and `channel` on.
//
//   GET  /api/app/update   the status: { app, current, channel, state, available, progress?, error?,
//                          off?, updated?, checkedAt? }; `app` is false where no app answers (a
//                          headless `agents serve`, the app not running)
//   POST /api/app/update   { action: "check" | "install" | "dismiss" } or { action: "channel",
//                          channel: "stable" | "beta" }, behind the anti-CSRF header; `install` downloads
//                          when needed, installs and relaunches the app; `channel` follows that channel
//                          from now on and looks at once
//
// The socket is AGENTS_MULTI_APP_SOCKET, which the app sets for the backend it starts, else the
// app's default in the runtime folder; bin/agents allows both.

import type { Route } from "./server.ts";
import { json } from "./http.ts";

const SOCKET_VAR = "AGENTS_MULTI_APP_SOCKET";
export const NOT_RUNNING = "the desktop app is not running";
const ACTIONS = ["check", "install", "dismiss", "channel"] as const;
const CHANNELS = ["stable", "beta"] as const;
/** A request to the app, as its socket reads it (updater/socket.rs). */
export type AppRequest =
  | { op: "check" | "install" | "dismiss" }
  | { op: "channel"; channel: typeof CHANNELS[number] };
const STATES = [
  "idle",
  "checking",
  "downloading",
  "ready",
  "installing",
  "restarting",
  "error",
] as const;
export type AppUpdateState = typeof STATES[number];

export interface AppUpdate {
  /** whether an app answers */
  app: boolean;
  current: string | null;
  channel: "stable" | "beta" | null;
  state: AppUpdateState;
  available: { version: string; notes: string; date: string | null } | null;
  /** the download, 0 to 1 */
  progress?: number;
  error?: string;
  /** why the app does not update itself: build, not-configured, not-packaged, package-manager:<name> */
  off?: string;
  /** this run of the app is an update from `from`: the console shows it until it dismisses it */
  updated?: { from: string; to: string };
  checkedAt?: number;
}

export const NO_APP: AppUpdate = {
  app: false,
  current: null,
  channel: null,
  state: "idle",
  available: null,
};

/** The socket's path: the app's word, else its default (updater/socket.rs). */
export function appSocket(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env[SOCKET_VAR] ||
    `${env.XDG_RUNTIME_DIR || "/tmp"}/agents-multi-app.sock`;
}

const str = (v: unknown): v is string => typeof v === "string";

/** Pure: a status line from the app, checked field by field, or null for anything else. */
export function parseStatus(line: string): AppUpdate | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !raw || typeof raw !== "object" || !str(raw.current) ||
    !STATES.includes(raw.state as AppUpdateState)
  ) {
    return null;
  }
  const a = raw.available as Record<string, unknown> | null;
  const u = raw.updated as Record<string, unknown> | undefined;
  const out: AppUpdate = {
    app: true,
    current: raw.current,
    channel: raw.channel === "beta" ? "beta" : "stable",
    state: raw.state as AppUpdateState,
    available: a && str(a.version)
      ? {
        version: a.version,
        notes: str(a.notes) ? a.notes : "",
        date: str(a.date) ? a.date : null,
      }
      : null,
  };
  if (typeof raw.progress === "number") {
    out.progress = Math.min(1, Math.max(0, raw.progress));
  }
  if (str(raw.error)) out.error = raw.error;
  if (str(raw.off)) out.off = raw.off;
  if (u && str(u.from) && str(u.to)) out.updated = { from: u.from, to: u.to };
  if (typeof raw.checkedAt === "number") out.checkedAt = raw.checkedAt;
  return out;
}

/** Pure: the wait before following the app again after `failures` in a row: 2 s doubling to 30 s. */
export const backoff = (failures: number): number => Math.min(2000 * 2 ** Math.min(failures, 4), 30_000);

/** A connection to the app, as Deno.connect gives it. */
export interface Conn {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}
export type Dial = () => Promise<Conn>;

export const unixDial = (path: string): Dial => () => Deno.connect({ transport: "unix", path });

async function* lines(r: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of r.pipeThrough(new TextDecoderStream())) {
    rest += chunk;
    let i;
    while ((i = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, i);
      rest = rest.slice(i + 1);
    }
  }
  if (rest.trim()) yield rest;
}

async function writeLine(c: Conn, line: string) {
  const w = c.writable.getWriter();
  await w.write(new TextEncoder().encode(`${line}\n`));
  w.releaseLock();
}

/** The console's side of the app's socket: the last status it heard, and the actions it passes on. */
export class AppLink {
  #last: AppUpdate | null = null;

  constructor(
    private readonly dial: Dial,
    private readonly onChange: () => void,
  ) {}

  view(): AppUpdate {
    return this.#last ?? NO_APP;
  }

  /** One action, and the app's answer to it. */
  async send(request: AppRequest): Promise<{ ok: boolean; error?: string }> {
    let c: Conn;
    try {
      c = await this.dial();
    } catch {
      return { ok: false, error: NOT_RUNNING };
    }
    try {
      await writeLine(c, JSON.stringify(request));
      for await (const line of lines(c.readable)) {
        const r = JSON.parse(line) as { ok?: unknown; error?: unknown };
        return r.ok === true ? { ok: true } : { ok: false, error: str(r.error) ? r.error : "refused" };
      }
      return { ok: false, error: "the app did not answer" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      try {
        c.close();
      } catch { /* closed by the app */ }
    }
  }

  /** Follows the app's status until `signal` aborts, again after the app goes (a relaunch, a quit). */
  async follow(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const c = await this.dial();
        const stop = () => {
          try {
            c.close();
          } catch { /* already closed */ }
        };
        signal.addEventListener("abort", stop, { once: true });
        try {
          await writeLine(c, JSON.stringify({ op: "watch" }));
          for await (const line of lines(c.readable)) {
            const s = parseStatus(line);
            if (!s) continue;
            failures = 0;
            this.#last = s;
            this.onChange();
          }
        } finally {
          signal.removeEventListener("abort", stop);
          stop();
        }
      } catch { /* no app, or it went */ }
      if (this.#last) {
        this.#last = null;
        this.onChange();
      }
      if (signal.aborted) return;
      await new Promise<void>((done) => {
        const wake = () => {
          clearTimeout(t);
          signal.removeEventListener("abort", wake);
          done();
        };
        const t = setTimeout(wake, backoff(failures++));
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
}

/** Pure: the request a page's body asks for, or null for anything else. */
export function appRequest(
  b: { action?: unknown; channel?: unknown },
): AppRequest | null {
  const action = ACTIONS.find((a) => a === b.action);
  if (action !== "channel") return action ? { op: action } : null;
  const channel = CHANNELS.find((c) => c === b.channel);
  return channel ? { op: "channel", channel } : null;
}

/** The route: the status, and the page's actions passed on. */
export function appUpdateRoute(link: Pick<AppLink, "view" | "send">): Route {
  return {
    get: () => json(link.view()),
    post: async ({ req }) => {
      const request = appRequest(await req.json().catch(() => ({})));
      if (!request) {
        return json({
          ok: false,
          error: `action is ${ACTIONS.join(", ")}; a channel is ${CHANNELS.join(" or ")}`,
        }, 400);
      }
      const r = await link.send(request);
      return json(r, r.ok ? 200 : r.error === NOT_RUNNING ? 503 : 409);
    },
  };
}
