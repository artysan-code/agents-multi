// route.ts — the web app routes by hash (the service answers every path under /app with the same page).

import { signal } from "@preact/signals";
import { hashOf, parseHash, type Route } from "./lib.ts";

export const route = signal<Route>(parseHash(location.hash));
addEventListener("hashchange", () => (route.value = parseHash(location.hash)));

/** Goes to a route; `replace` takes the place of the current history entry (a new chat becoming a chat). */
export function go(r: Route, replace = false): void {
  if (replace) {
    history.replaceState(null, "", hashOf(r));
    route.value = r;
  } else location.hash = hashOf(r);
}

/** The shell's tab bar and a notification click both ask for a hash: the service worker posts it here. */
export function listenForOpen(): void {
  navigator.serviceWorker?.addEventListener("message", (e: MessageEvent) => {
    const hash = (e.data as { open?: unknown } | null)?.open;
    if (typeof hash === "string" && hash.startsWith("#")) location.hash = hash;
  });
}
