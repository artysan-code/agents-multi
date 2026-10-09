// sysstate.ts — the machine's state as the rail and Today tell it: the checks that need someone,
// what an update would take now, and the word for the rail's update button. Read from the shared report;
// nothing here asks the server.

import { computed } from "@preact/signals";
import type { Check } from "../api.ts";
import { live, status } from "../state.ts";
import { pendingUpdates, type Report } from "../pages/system/updates-lib.tsx";
import { appUpdater } from "./app-update.ts";

export type Level = "ok" | "warn" | "crit" | "up" | "down";

export interface SysState {
  /** the worst news first: unreachable, a failing check, an update, a warning, else all good */
  level: Level;
  /** the checks that are not ok, failures first */
  problems: Check[];
  ok: number;
  total: number;
  /** what an update would take now, one line per component */
  pending: string[];
  /** the word for an update: «Update ready», or «Close Claude to finish» when all that is left
   *  is the install of code already here, waiting for every Claude to be closed */
  upWord: "pill.up" | "pill.settle";
}

const ORDER: Record<string, number> = { fail: 0, warn: 1 };

export const sys = computed<SysState>(() => {
  const s = status.value;
  const checks = s?.doctor ?? [];
  const problems = checks.filter((c) => c.status !== "ok").sort((a, b) =>
    ORDER[a.status] - ORDER[b.status]
  );
  const app = appUpdater();
  const pending = [
    ...(app?.available
      ? [`Agents Multi ${app.current ?? "—"} → ${app.available.version}`]
      : []),
    ...pendingUpdates(s as Report | null),
  ];
  const settling = !!(s as Report | null)?.selfInstall && pending.length === 1;
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
  return {
    level,
    problems,
    ok: checks.length - problems.length,
    total: checks.length,
    pending,
    upWord: settling ? "pill.settle" : "pill.up",
  };
});
