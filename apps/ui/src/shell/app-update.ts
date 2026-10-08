// app-update.ts — the desktop app's own update, as the console's backend relays it
// (apps/cli/console/app-update.ts): GET /api/app/update says what runs, what is available and where an
// update stands; POST starts a check, the install (download if needed, install, relaunch), or
// dismisses the «Updated» screen a relaunch opens. The state moves on the "app-update" topic of the
// server's events, never by polling. Where no app answers (`app` false: a console run by hand), where
// the app does not update itself (`off`), or where the backend has no such endpoint (an older one),
// the update screen does the console's own steps only.

import { signal } from "@preact/signals";
import { get, post, type Result } from "../api.ts";

export type AppUpdateState =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "installing"
  | "restarting"
  | "error";

export interface AppUpdate {
  /** whether an app answers */
  app: boolean;
  current: string | null;
  channel: "stable" | "beta" | null;
  state: AppUpdateState;
  available: { version: string; notes: string; date: string | null } | null;
  /** 0..1, while downloading */
  progress?: number;
  error?: string;
  /** why the app does not update itself: build, not-configured, not-packaged, package-manager:<name> */
  off?: string;
  /** this run of the app is an update from `from`: the «Updated» screen shows until it is dismissed */
  updated?: { from: string; to: string };
  checkedAt?: number;
}

export const appUpdate = signal<AppUpdate | null>(null);

/** The app's status when the app updates itself here, else null. */
export const appUpdater = (): AppUpdate | null => {
  const a = appUpdate.value;
  return a?.app && !a.off ? a : null;
};

export async function loadAppUpdate(): Promise<void> {
  appUpdate.value = await get<AppUpdate>("/api/app/update").catch(() => null);
}

export async function appUpdateAction(
  action: "check" | "install" | "dismiss",
): Promise<Result> {
  const r = await post("/api/app/update", { action }).catch((
    e: Error,
  ): Result => ({ ok: false, message: e.message }));
  await loadAppUpdate();
  return r;
}

/** The first `n` points of release notes written as a Markdown list (or its first lines). */
export function notePoints(notes: string, n = 3): string[] {
  const lines = notes.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => /^[-*] /.test(l)).map((l) => l.slice(2));
  return (items.length ? items : lines.filter((l) => !l.startsWith("#"))).slice(
    0,
    n,
  )
    .map((l) =>
      l.replace(/\*\*([^*]+)\*\*:?\s*/g, "$1: ").replace(
        /\s*\([0-9a-f]{7,}\)$/,
        "",
      )
    );
}
