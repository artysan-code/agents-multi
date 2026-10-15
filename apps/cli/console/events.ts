// events.ts — live updates. The page holds one EventSource on /api/events; the console watches the
// files it displays, and sends a topic when something it shows has changed.

import { lstat } from "../lib/fs.ts";
import { HOME, NON_PROFILE_DIRS, REPO, RUNTIME, STATE } from "../lib/paths.ts";
import { vaultDir } from "../../../shared/mcp/lib/vault.ts";
import { listTasks } from "../../../shared/mcp/lib/tasks.ts";
import { memoryVersion } from "../memory.ts";

export const TOPICS = ["usage", "state", "agents", "chats", "brain", "app-update"] as const;
export type Topic = typeof TOPICS[number];
/** A usage event carries which sessions wrote, so the page can light up the one that is working
 *  rather than repainting every row as busy. */
const clients = new Set<(topic: Topic, sessions?: string[]) => void>();
/** The open pages alone (clients also holds the server's own listeners): nobody looking, nothing to ask the brain. */
const pages = new Set<unknown>();

/** The transcripts the watcher saw change since the usage ingest last asked; null when nothing watches
 *  them (the watcher failed or has not started), which means every transcript must be looked at. */
let changed: Set<string> | null = null;
export function takeChangedTranscripts(): string[] | null {
  if (!changed) return null;
  const out = [...changed];
  changed.clear();
  return out;
}

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
/** The state folder's parts that are news of their own: the agents hub's children and runs, the chats. */
const STATE_TOPIC: Record<string, Topic> = { agents: "agents", chats: "chats" };

/** Pure: the topic a changed path is news for, or null when the console shows nothing of it. */
export function topicOf(
  p: string,
  roots: { runtime: string; state: string },
): { topic: Topic; session?: string } | null {
  if (p.endsWith(".tmp") || p.includes("/.git/") || p.includes("/.obsidian/")) return null;
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
  if (p.startsWith(`${roots.state}/`)) {
    // the status line writes at every turn, and the page reads it on `usage`
    const [entry] = p.slice(roots.state.length + 1).split("/");
    if (entry === "live") return null;
    if (STATE_TOPIC[entry]) return { topic: STATE_TOPIC[entry] };
  }
  return { topic: "state" };
}

/** Pure: what to watch. The runtime is mostly Claude Code's own churn (plugin caches, file history,
 *  shell snapshots: thousands of directories, each an inotify watch), and the console shows only
 *  the configuration, each profile's settings and credentials (the files of its folder) and its
 *  plugin list (the files of plugins/), and the transcripts under projects/. So: those deep, the
 *  folders that hold the rest shallow. */
export function watchPlan(runtime: string, profiles: string[]): { deep: string[]; flat: string[] } {
  return {
    deep: [`${runtime}/config`, ...profiles.map((p) => `${runtime}/${p}/projects`)],
    flat: [runtime, ...profiles.flatMap((p) => [`${runtime}/${p}`, `${runtime}/${p}/plugins`])],
  };
}

/** Profile folders under the runtime: every directory that is not one of the runtime's own. */
async function profileDirs(): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(RUNTIME)) {
      if (e.isDirectory && !e.name.startsWith(".") && !NON_PROFILE_DIRS.has(e.name)) out.push(e.name);
    }
  } catch { /* no runtime yet */ }
  return out.sort();
}

/**
 * Watch what the console displays and say which half moved (`app-update` is the app's own word,
 * relayed by app-update.ts).
 * `usage`  new transcript lines — running and recent sessions
 * `state`  runtime config, credentials, MCP registry — profiles, doctor, plan windows
 * `agents` the agents hub's children and runs — the Runs page
 * `chats`  a chat kept a turn, or was forgotten — the Chat page
 * `brain`  a task or a page of the brain changed, anywhere (watchBrain asks it every half minute) — Tasks, Brain
 *
 * Events are coalesced: a busy session writes its transcript continuously, and one redraw per
 * second is plenty for a dashboard.
 */
export async function watchTree(signal: AbortSignal) {
  const plan = watchPlan(RUNTIME, await profileDirs());
  // The update check's cache, and the state directory where every update result is logged
  // (updates.jsonl): the Updates tab follows both. watchFs refuses a path that does not exist, so
  // those are watched only where they are.
  // the vault too: Syncthing bringing a secret from another machine changes what Connections shows
  const deep = [...plan.deep, `${REPO}/shared`, `${HOME}/.cache/claude-update`, STATE, vaultDir()];
  const exists = async (paths: string[]) => {
    const out: string[] = [];
    for (const d of paths) if (await lstat(d)) out.push(d);
    return out;
  };
  const watchers: Deno.FsWatcher[] = [];
  try {
    const [d, f] = [await exists(deep), await exists(plan.flat)];
    if (d.length) watchers.push(Deno.watchFs(d, { recursive: true }));
    if (f.length) watchers.push(Deno.watchFs(f, { recursive: false }));
  } catch {
    for (const w of watchers) w.close();
    return;
  }
  signal.addEventListener("abort", () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch { /* already closed */ }
    }
  });
  const roots = { runtime: RUNTIME, state: STATE };
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
  // every profile's projects/ is under a recursive watch: from here on the changed transcripts are known
  if (plan.deep.length > 1) changed = new Set();
  const follow = async (watcher: Deno.FsWatcher) => {
    try {
      for await (const e of watcher) {
        if (e.kind === "access") continue;
        for (const p of e.paths) {
          const t = topicOf(p, roots);
          if (!t) continue;
          if (t.topic === "usage" && p.endsWith(".jsonl")) changed?.add(p);
          pending.add(t.topic);
          if (t.session) sessions.add(t.session);
        }
        if (pending.size && timer == null) timer = setTimeout(flush, 1000);
      }
    } catch { /* closed on shutdown */ }
  };
  await Promise.all(watchers.map(follow));
  changed = null;
}

/** The SSE response for one page. `code` is the fingerprint of the code serving it: a page loaded
 *  from an older console reloads itself. `only`: the topics a listener follows (the tray: `state`);
 *  it gets nothing else. */
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

/** The brain changes elsewhere (the phone, a chat on another machine) and touches no file here: every
 *  half minute, while a page is open, its tasks and its memory version are read, and a `brain` event goes
 *  out when one differs. The console's own task write broadcasts at once. */
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
    let moved = false;
    if (tasks) {
      try {
        const now = JSON.stringify((await listTasks()).map((t) => [t.id, t.updated]).sort());
        if (lastTasks && now !== lastTasks) moved = true;
        lastTasks = now;
      } catch { /* the brain is away: the views say so when they ask */ }
    }
    const memory = await memoryVersion().catch(() => null);
    if (memory && lastMemory && memory !== lastMemory) moved = true;
    if (memory) lastMemory = memory;
    if (moved) broadcast("brain");
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
