// sysstate.ts — the machine's state as the frame and Today tell it: the checks that need someone,
// what an update would take now, and the one word for the header's pill. Read from the shared report;
// nothing here asks the server.

import { computed, signal } from "@preact/signals";
import type { Check } from "../api.ts";
import { live, status } from "../state.ts";
import { pendingUpdates, type Report } from "../pages/system/updates-lib.tsx";
import { appUpdate } from "./app-update.ts";

export type Level = "ok" | "warn" | "crit" | "up" | "down";

export interface SysState {
  /** the pill's word: the worst problem, else an update, else all good */
  level: Level;
  /** the checks that are not ok, failures first */
  problems: Check[];
  ok: number;
  total: number;
  /** what an update would take now, one line per component */
  pending: string[];
}

const ORDER: Record<string, number> = { fail: 0, warn: 1 };

export const sys = computed<SysState>(() => {
  const s = status.value;
  const checks = s?.doctor ?? [];
  const problems = checks.filter((c) => c.status !== "ok").sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const app = appUpdate.value;
  const pending = [
    ...(app?.available ? [`Agents Multi ${app.current ?? "—"} → ${app.available.version}`] : []),
    ...pendingUpdates(s as Report | null),
  ];
  const fails = problems.some((c) => c.status === "fail");
  const level: Level = live.value === "down" && s
    ? "down"
    : fails
    ? "crit"
    : pending.length
    ? "up"
    : problems.length
    ? "warn"
    : "ok";
  return { level, problems, ok: checks.length - problems.length, total: checks.length, pending };
});

/* «Later» on the update card: the card folds into the header's pill until something new is pending. */

const LATER = "cm.updateLater";
const stored = (): string => {
  try {
    return localStorage.getItem(LATER) ?? "";
  } catch {
    return "";
  }
};
const laterFor = signal(stored());

export const updateLater = computed(() => sys.value.pending.length > 0 && laterFor.value === sys.value.pending.join("|"));

export function setUpdateLater(on: boolean): void {
  laterFor.value = on ? sys.value.pending.join("|") : "";
  try {
    localStorage.setItem(LATER, laterFor.value);
  } catch { /* not remembered: the card comes back at the next visit */ }
}
