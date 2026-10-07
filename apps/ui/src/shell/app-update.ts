// app-update.ts — the desktop app's own update, as the console's backend relays it: GET /api/app/update
// says what is installed, what is available and where an update stands; POST starts a check or the
// install (download if needed, install, relaunch). The state moves on the "app-update" topic of the
// server's events, never by polling. Where the backend has no such endpoint (an older console, or no
// desktop app), `appUpdate` stays null and the update wizard does the console's own steps only.

import { signal } from "@preact/signals";
import { get, post, type Result } from "../api.ts";

export type AppUpdateState = "idle" | "checking" | "downloading" | "ready" | "installing" | "restarting" | "error";

export interface AppUpdate {
  current: string | null;
  available: { version: string; notes: string; date: string } | null;
  state: AppUpdateState;
  /** 0..1, while downloading */
  progress?: number;
  error?: string;
  channel?: string;
}

export const appUpdate = signal<AppUpdate | null>(null);

export async function loadAppUpdate(): Promise<void> {
  appUpdate.value = await get<AppUpdate>("/api/app/update").catch(() => null);
}

export async function appUpdateAction(action: "check" | "install"): Promise<Result> {
  const r = await post("/api/app/update", { action }).catch((e: Error): Result => ({ ok: false, message: e.message }));
  await loadAppUpdate();
  return r;
}

/** The first `n` points of release notes written as a Markdown list (or its first lines). */
export function notePoints(notes: string, n = 3): string[] {
  const lines = notes.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => /^[-*] /.test(l)).map((l) => l.slice(2));
  return (items.length ? items : lines.filter((l) => !l.startsWith("#"))).slice(0, n)
    .map((l) => l.replace(/\*\*([^*]+)\*\*:?\s*/g, "$1: ").replace(/\s*\([0-9a-f]{7,}\)$/, ""));
}
