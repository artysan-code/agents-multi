// events.ts — live updates. The page holds one EventSource on /api/events; the console watches the
// files it displays and the brain, and sends a topic when something it shows has changed.

import { lstat } from "../lib/fs.ts";
import { HOME, REPO, RUNTIME, STATE } from "../lib/paths.ts";
import { vaultDir } from "../../../shared/mcp/lib/vault.ts";
import { listTasks, tasksRoot } from "../../../shared/mcp/lib/tasks.ts";
import { memoryVersion } from "../memory.ts";

export const TOPICS = ["usage", "state", "brain", "tasks", "app-update"] as const;
export type Topic = typeof TOPICS[number];
/** A usage event carries which sessions wrote, so the page can light up the one that is working
 *  rather than repainting every row as busy. */
const clients = new Set<(topic: Topic, sessions?: string[]) => void>();
/** The open pages alone (clients also holds the server's own listeners): nobody looking, nothing to poll. */
const pages = new Set<unknown>();

/** Sends a topic to every open page. */
export function broadcast(topic: Topic, sessions: string[] = []) {
  for (const send of clients) {
    try {
      send(topic, sessions);
    } catch { /* client gone, the reader removes it */ }
  }
}

/** Calls `fn` on every topic sent, for the server's own caches. */
export function onTopic(fn: (topic: Topic) => void) {
  clients.add(fn);
}

/** What Claude Code writes in a profile's folder while it works — at every turn, every tool call, every
 *  hook — and the console shows none of: a change there is no `state`. Without this list a working
 *  session sent `state` every second, and each one recomputed the report (the doctor) for the tray. */
const CHURN = new Set([
  ".claude.json",
  ".cc-writes",
  ".last-cleanup",
  "backups",
  "cache",
  "daemon",
  "daemon.log",
  "debug",
  "file-history",
  "history.jsonl",
  "ide",
  "jobs",
  "mcp-needs-auth-cache.json",
  "paste-cache",
  "plans",
  "projects",
  "security",
  "session-env",
  "sessions",
  "shell-snapshots",
  "state",
  "stats-cache.json",
  "statsig",
  "telemetry",
  "todos",
  "uploads",
]);
/** The state folder's parts that move with every turn: the agents hub's children and the status line. */
const STATE_CHURN = new Set(["agents", "live"]);

/** Pure: the topic a changed path is news for, or null when the console shows nothing of it. */
export function topicOf(
  p: string,
  roots: { runtime: string; state: string; tasks: string },
): { topic: Topic; session?: string } | null {
  if (p.endsWith(".tmp") || p.includes("/.git/") || p.includes("/.obsidian/")) return null;
  if (p.startsWith(`${roots.tasks}/`)) return { topic: "tasks" };
  if (p.includes("/projects/") && p.endsWith(".jsonl")) {
    // the file is named after the session, which is what the page needs to mark it as working
    const id = p.slice(p.lastIndexOf("/") + 1, -6);
    return /^[0-9a-f-]{36}$/.test(id) ? { topic: "usage", session: id } : { topic: "usage" };
  }
  if (p.startsWith(`${roots.runtime}/`)) {
    // <runtime>/<profile>/<entry>/…: a Claude Code file, or one of ours (credentials, settings, plugins)
    const [, entry = ""] = p.slice(roots.runtime.length + 1).split("/");
    if (CHURN.has(entry) || entry.startsWith(".claude.json.")) return null;
  }
  if (p.startsWith(`${roots.state}/`) && STATE_CHURN.has(p.slice(roots.state.length + 1).split("/")[0])) return null;
  return { topic: "state" };
}

/**
 * Watch what the console displays and say which half moved (`app-update` is the app's own word,
 * relayed by app-update.ts).
 * `usage`  new transcript lines — running and recent sessions
 * `state`  runtime config, credentials, MCP registry — profiles, doctor, plan windows
 * `brain`  a page of the brain changed (anywhere: watchBrain asks it every half minute)
 * `tasks`  a task changed: a chat, another machine, the console
 *
 * Events are coalesced: a busy session writes its transcript continuously, and one redraw per
 * second is plenty for a dashboard.
 */
export async function watchTree(signal: AbortSignal) {
  // The update check's cache, and the state directory where every update result is logged
  // (updates.jsonl): the Updates tab follows both. watchFs refuses a path that does not exist, so
  // those two are watched only where they are.
  const paths = [RUNTIME, `${REPO}/shared`];
  // the vault too: Syncthing bringing a secret from another machine changes what Connections shows
  for (const d of [`${HOME}/.cache/claude-update`, STATE, vaultDir(), tasksRoot()]) if (await lstat(d)) paths.push(d);
  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(paths, { recursive: true });
  } catch {
    return;
  }
  signal.addEventListener("abort", () => {
    try {
      watcher.close();
    } catch { /* already closed */ }
  });
  const roots = { runtime: RUNTIME, state: STATE, tasks: tasksRoot() };
  const pending = new Set<Topic>();
  const sessions = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const ids = [...sessions];
    for (const t of pending) broadcast(t, t === "usage" ? ids : []);
    pending.clear();
    sessions.clear();
  };
  try {
    for await (const e of watcher) {
      if (e.kind === "access") continue;
      for (const p of e.paths) {
        const t = topicOf(p, roots);
        if (!t) continue;
        pending.add(t.topic);
        if (t.session) sessions.add(t.session);
      }
      if (pending.size && timer == null) timer = setTimeout(flush, 1000);
    }
  } catch { /* closed on shutdown */ }
}

/** The SSE response for one page. `code` is the fingerprint of the code serving it: a page loaded
 *  from an older console reloads itself. `only`: the topics a listener follows (the tray: `state`);
 *  it gets nothing else, and it is not a page — the brain is not watched for it. */
export function eventStream(code: string, only?: Topic[]): Response {
  let send: ((topic: Topic, sessions?: string[]) => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (ping != null) {
      clearInterval(ping);
      ping = null;
    }
    if (send) {
      clients.delete(send);
      pages.delete(send);
      send = null;
    }
  };
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          close();
        }
      };
      write("retry: 2000\n\n");
      // first, which code is serving: a page loaded from an older console reloads itself
      write(`event: hello\ndata: ${JSON.stringify({ code })}\n\n`);
      send = (topic, ids = []) => {
        if (!only || only.includes(topic)) {
          write(`event: ${topic}\ndata: ${JSON.stringify({ at: Date.now(), sessions: ids })}\n\n`);
        }
      };
      clients.add(send);
      if (!only) pages.add(send);
      // A proxy or a sleeping laptop can drop a silent connection: a comment every 25s keeps it
      // alive and gives the page a heartbeat to time its "last update" indicator against.
      ping = setInterval(() => write(`: ping ${Date.now()}\n\n`), 25000);
    },
    cancel: close,
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" },
  });
}

/** The brain changes elsewhere (the phone, a chat on another machine) and touches no file here:
 *  every half minute its tasks and its memory version are read, and a `tasks` or `brain` event goes
 *  out when one differs. The console's own task writes broadcast at once, through taskApi. */
export async function watchBrain(signal: AbortSignal, tasks: boolean) {
  let lastTasks = "", lastMemory: string | null = null;
  while (!signal.aborted) {
    // with no page open there is nobody to tell: the next look after one opens sets the baseline again
    if (!pages.size) {
      lastTasks = "";
      lastMemory = null;
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (tasks) {
      try {
        const now = JSON.stringify((await listTasks()).map((t) => [t.id, t.updated]).sort());
        if (lastTasks && now !== lastTasks) broadcast("tasks");
        lastTasks = now;
      } catch { /* the brain is away: the panels say so when they ask */ }
    }
    const memory = await memoryVersion().catch(() => null);
    if (memory && lastMemory && memory !== lastMemory) broadcast("brain");
    if (memory) lastMemory = memory;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
