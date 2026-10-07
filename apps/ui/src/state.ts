// state.ts — what the pages share: the status report and the live connection, as signals. The
// server's events (SSE on /api/events) refresh the report; a page reads `status.value` and redraws
// on its own.

import { signal } from "@preact/signals";
import { api, type StatusView } from "./api.ts";

export type Live = "live" | "busy" | "down";

export const status = signal<StatusView | null>(null);
export const live = signal<Live>("busy");
export const machineLang = signal<string>("");

export async function loadStatus(fresh = false): Promise<void> {
  const s = await api.status(fresh);
  status.value = s;
  machineLang.value = s.language;
}

/** Listens to the server's events. A burst of state events is coalesced into one refresh; another
 *  code version after a restart reloads the page. */
export function connect(): void {
  let boot = "", timer: number | undefined, retry = 0;
  const open = () => {
    const es = new EventSource("/api/events");
    es.onopen = () => {
      retry = 0;
      live.value = "live";
    };
    es.onerror = () => {
      live.value = "down";
      es.close();
      if (retry < 6) setTimeout(open, Math.min(30000, 2000 * 2 ** retry++));
    };
    es.addEventListener("hello", (e) => {
      const code = (JSON.parse((e as MessageEvent).data || "{}") as { code?: string }).code ?? "";
      if (!boot) boot = code;
      else if (code && code !== boot) location.reload();
    });
    es.addEventListener("state", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        live.value = "busy";
        loadStatus().finally(() => (live.value = "live"));
      }, 400);
    });
  };
  open();
}
