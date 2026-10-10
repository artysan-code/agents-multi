// state.ts — what the pages share, as signals: the status report and its summary, whose console this
// is, the live connection, and one counter per topic of the server's events (SSE on /api/events).
// A page reads `status.value` and redraws on its own; a page with data of its own reloads it when its
// topic's counter moves (`useTopic`), never from a polling loop of its own.

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { api, type Owner, type StatusView, type Summary } from "./api.ts";

type Live = "live" | "busy" | "down";
type Topic = "state" | "usage" | "tasks" | "brain" | "app-update";

export const status = signal<StatusView | null>(null);
export const summary = signal<Summary | null>(null);
export const owner = signal<Owner>({ id: "me", name: "" });
export const live = signal<Live>("busy");
export const machineLang = signal<string>("");

/** One counter per topic: it moves when the server says that part changed. */
export const topics = {
  state: signal(0),
  usage: signal(0),
  tasks: signal(0),
  brain: signal(0),
  "app-update": signal(0),
} satisfies Record<Topic, unknown>;

/** The sessions the last usage event named: they are writing right now. */
export const working = signal<{ ids: string[]; at: number }>({ ids: [], at: 0 });

/** Bumps a topic from the page itself: after an action that changed it, without waiting for the event. */
export function touch(topic: Topic): void {
  topics[topic].value++;
}

/** Runs `load` now and again each time one of the topics moves; the latest call wins. */
export function useTopic(load: () => unknown, on: Topic[], deps: unknown[] = []): void {
  // reading the counters here subscribes the component: their values are the effect's dependency
  const seq = on.map((t) => topics[t].value).join(",");
  useEffect(() => {
    void load();
  }, [seq, ...deps]);
}

export async function loadStatus(fresh = false): Promise<void> {
  const [s, sum] = await Promise.all([api.status(fresh), api.summary(fresh)]);
  status.value = s;
  summary.value = sum;
  machineLang.value = s.language;
}

export async function loadOwner(): Promise<void> {
  owner.value = await api.owner().catch(() => owner.value);
}

/** The start screen is back over the page, which reloads under it (shell/boot.tsx): new code shows up
 *  the way the console first did, never as a page torn down. */
export const leaving = signal(false);

export function reloadSoftly(): void {
  leaving.value = true;
  setTimeout(() => location.reload(), 320);
}

/** A reload, but not under someone's fingers: while a field has focus, or a drawer with a form is
 *  open, it waits and asks again. */
function reloadWhenIdle(): void {
  const busy = document.activeElement?.matches?.("input, textarea, select, [contenteditable]") ||
    document.querySelector(".drawer form, dialog[open]");
  if (busy) setTimeout(reloadWhenIdle, 5000);
  else reloadSoftly();
}

/** Listens to the server's events. A burst of state or usage events is coalesced into one refresh;
 *  another code version after a restart reloads the page. */
export function connect(): void {
  let es: EventSource | null = null;
  let boot = "", timer: number | undefined, retry = 0, last = 0;
  let pending: "state" | "usage" | null = null;

  const refresh = async () => {
    const topic = pending;
    pending = null;
    live.value = "busy";
    if (topic === "state") await loadStatus().catch(() => {});
    if (topic) topics[topic].value++;
    live.value = es?.readyState === 1 ? "live" : "down";
  };
  // a busy session fires events continuously, and the pages only need the latest
  const coalesce = (topic: "state" | "usage") => {
    pending = pending === "state" || topic === "state" ? "state" : "usage";
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  };

  const open = () => {
    es?.close();
    es = new EventSource("/api/events");
    es.onopen = () => {
      retry = 0;
      last = Date.now();
      live.value = "live";
    };
    es.onerror = () => {
      live.value = "down";
      // EventSource retries on its own, but a server gone for good would leave the page silently
      // stale; a bounded backoff makes the reconnection visible instead
      if (retry < 6) setTimeout(open, Math.min(30000, 2000 * 2 ** retry++));
    };
    es.addEventListener("hello", (e) => {
      last = Date.now();
      let code = "";
      try {
        code = (JSON.parse((e as MessageEvent).data || "{}") as { code?: string }).code ?? "";
      } catch { /* an old console says nothing */ }
      if (!boot) boot = code;
      else if (code && code !== boot) reloadWhenIdle();
    });
    es.addEventListener("usage", (e) => {
      last = Date.now();
      try {
        const ids = (JSON.parse((e as MessageEvent).data) as { sessions?: string[] }).sessions ?? [];
        if (ids.length) working.value = { ids, at: Date.now() };
      } catch { /* an event without a body is still a change */ }
      coalesce("usage");
    });
    es.addEventListener("state", () => {
      last = Date.now();
      coalesce("state");
    });
    es.addEventListener("tasks", () => {
      last = Date.now();
      topics.tasks.value++;
    });
    es.addEventListener("brain", () => {
      last = Date.now();
      topics.brain.value++;
    });
    // the desktop app's own update (shell/app-update.ts): its state moves while it downloads and installs
    es.addEventListener("app-update", () => {
      last = Date.now();
      topics["app-update"].value++;
    });
  };
  open();
  // the server pings every 25s: nothing for well over that and the stream is dead, even though
  // EventSource still says open
  setInterval(() => {
    if (es?.readyState === 1 && last && Date.now() - last > 70000) {
      live.value = "down";
      open();
    }
  }, 15000);
}
