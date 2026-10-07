// events.ts — live updates. The page holds one EventSource on /api/events; the console watches the
// files it displays and the brain, and sends a topic when something it shows has changed.

import { lstat } from "../lib/fs.ts";
import { HOME, REPO, RUNTIME, STATE } from "../lib/paths.ts";
import { vaultDir } from "../../../shared/mcp/lib/vault.ts";
import { listTasks, tasksRoot } from "../../../shared/mcp/lib/tasks.ts";
import { memoryVersion } from "../memory.ts";

export type Topic = "usage" | "state" | "brain" | "tasks" | "app-update";
/** A usage event carries which sessions wrote, so the page can light up the one that is working
 *  rather than repainting every row as busy. */
const clients = new Set<(topic: Topic, sessions?: string[]) => void>();

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
        if (p.endsWith(".tmp") || p.includes("/.git/") || p.includes("/.obsidian/")) continue;
        if (p.startsWith(`${tasksRoot()}/`)) {
          pending.add("tasks");
          continue;
        }
        const transcript = p.includes("/projects/") && p.endsWith(".jsonl");
        pending.add(transcript ? "usage" : "state");
        // the file is named after the session, which is what the page needs to mark it as working
        if (transcript) {
          const id = p.slice(p.lastIndexOf("/") + 1, -6);
          if (/^[0-9a-f-]{36}$/.test(id)) sessions.add(id);
        }
      }
      if (pending.size && timer == null) timer = setTimeout(flush, 1000);
    }
  } catch { /* closed on shutdown */ }
}

/** The SSE response for one page. `code` is the fingerprint of the code serving it: a page loaded
 *  from an older console reloads itself. */
export function eventStream(code: string): Response {
  let send: ((topic: Topic, sessions?: string[]) => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (ping != null) {
      clearInterval(ping);
      ping = null;
    }
    if (send) {
      clients.delete(send);
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
      send = (topic, ids = []) =>
        write(`event: ${topic}\ndata: ${JSON.stringify({ at: Date.now(), sessions: ids })}\n\n`);
      clients.add(send);
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
