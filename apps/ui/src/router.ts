// router.ts — where the console is: the three views, #chat · #runs · #limits, and behind «More»
// #connections · #system/<tab>. The tray opens a view by setting the hash. And the intents: a request
// from one place (the palette, the rail) to another page to do something once it is on screen — "start
// a new chat" — which that page takes with `useIntent`, so no page reaches into another's markup.

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

const VIEWS = ["chat", "runs", "limits", "connections", "system"] as const;
export const TABS = ["profiles", "permissions", "updates", "health"] as const;
export type View = typeof VIEWS[number];
export type Tab = typeof TABS[number];

/** The three views the rail shows; the others are behind «More». */
export const MAIN = ["chat", "runs", "limits"] as const satisfies readonly View[];

export const view = signal<View>("chat");
export const tab = signal<Tab>("profiles");

export function go(hash: string): void {
  const [v, s] = String(hash).replace(/^#/, "").split("/");
  view.value = (VIEWS as readonly string[]).includes(v) ? v as View : "chat";
  if (view.value === "system" && (TABS as readonly string[]).includes(s)) tab.value = s as Tab;
  const want = view.value === "system" ? `system/${tab.value}` : view.value;
  if (location.hash.slice(1) !== want) history.replaceState(null, "", `#${want}`);
}

addEventListener("hashchange", () => go(location.hash.slice(1)));

type IntentName =
  | "chat.new" // start a new chat
  | "profiles.new" // open the form for a new profile
  | "update.wizard" // start the update wizard (on any page: the wizard is a drawer)
  | "health.rerun"; // run the health checks again

export const intent = signal<{ name: IntentName; at: number; arg?: string } | null>(null);

/** Goes to `hash` (when given) and asks the page there to do `name`. */
export function request(name: IntentName, hash?: string, arg?: string): void {
  if (hash) go(hash);
  intent.value = { name, at: Date.now(), arg };
}

/** Calls `run` once for each request of `name`, the one pending when the page appears included. */
export function useIntent(name: IntentName, run: (arg?: string) => void): void {
  const i = intent.value;
  useEffect(() => {
    if (i?.name !== name) return;
    intent.value = null;
    run(i.arg);
  }, [i]);
}
