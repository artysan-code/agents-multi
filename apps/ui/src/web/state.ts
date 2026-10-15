// state.ts — what every view shares: whether the device is online, what waits for the person's yes (the tab
// bar's badge and the Waiting view read the same), and the machine a chat is pinned to.

import { computed, signal } from "@preact/signals";
import { loadWaiting } from "./api.ts";
import { type WaitingState, waitingCount } from "./lib.ts";

export const offline = signal(!navigator.onLine);
addEventListener("online", () => (offline.value = false));
addEventListener("offline", () => (offline.value = true));

/** A wide screen: the rail and the list beside the conversation, no swiping between tabs. */
const wideQuery = matchMedia("(min-width: 900px)");
export const wide = signal(wideQuery.matches);
wideQuery.addEventListener("change", () => (wide.value = wideQuery.matches));

export const waiting = signal<WaitingState | null>(null);
export const waitingError = signal("");
export const pendingCount = computed(() => waitingCount(waiting.value));

export async function refreshWaiting(): Promise<void> {
  try {
    waiting.value = await loadWaiting();
    waitingError.value = "";
  } catch (e) {
    waitingError.value = (e as Error).message;
  }
}

/** Reads what waits now and again every 20 s while the app is in view, and when it comes back into view. */
export function watchWaiting(): void {
  void refreshWaiting();
  setInterval(() => document.visibilityState === "visible" && !offline.value && void refreshWaiting(), 20_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void refreshWaiting());
}

// ---- the machine a new turn is pinned to (null: the account's choice), kept on this device
const PIN = "am-pin";
export const pinned = signal<string | null>(read());
function read(): string | null {
  try {
    return localStorage.getItem(PIN) || null;
  } catch {
    return null;
  }
}
export function pin(node: string | null): void {
  pinned.value = node;
  try {
    if (node) localStorage.setItem(PIN, node);
    else localStorage.removeItem(PIN);
  } catch { /* storage blocked */ }
}

/** Bumped when a chat changes (a turn written or ended), so the list beside a conversation reads again. */
export const chatsTick = signal(0);
