// notify.ts — the doctor that comes to you: `agents-multi doctor --notify` compares the verdict with
// the last saved one and sends ONE desktop notification only when a NEW failure appears (or when a
// failure clears, to say things are healthy again). Warnings never notify: every four hours they
// would be noise. Driven by the claude-update-check timer, alongside the update check.

import { type Check } from "./lib/output.ts";
import { STATE } from "./lib/paths.ts";
import { has, run } from "./lib/proc.ts";

const STATE_FILE = `${STATE}/doctor-last.json`;
export interface DoctorDiff {
  newFails: Check[];
  gone: string[];
  stillFails: Check[];
  recovered: boolean;
}

/** Pure: compare previous failure ids with the current ones. `recovered` = there were failures, now none. */
export function diffDoctor(prevFailIds: string[], current: Check[]): DoctorDiff {
  const fails = current.filter((c) => c.status === "fail");
  const prev = new Set(prevFailIds);
  const cur = new Set(fails.map((c) => c.id));
  return {
    newFails: fails.filter((c) => !prev.has(c.id)),
    gone: prevFailIds.filter((id) => !cur.has(id)),
    stillFails: fails.filter((c) => prev.has(c.id)),
    recovered: prevFailIds.length > 0 && fails.length === 0,
  };
}

export function notifyText(d: DoctorDiff): { title: string; body: string } | null {
  if (d.newFails.length) {
    const lines = d.newFails.slice(0, 3).map((c) => `• ${c.msg}${c.fix ? `\n   → ${c.fix}` : ""}`);
    const more = d.newFails.length > 3 ? `\n… and ${d.newFails.length - 3} more` : "";
    const still = d.stillFails.length ? `\n(${d.stillFails.length} already known)` : "";
    return {
      title: `agents-multi: ${d.newFails.length} new problem${d.newFails.length === 1 ? "" : "s"}`,
      body: lines.join("\n") + more + still,
    };
  }
  if (d.recovered) return { title: "agents-multi: all clear", body: `Resolved: ${d.gone.join(", ")}` };
  return null;
}

export async function loadLast(): Promise<string[]> {
  try {
    return JSON.parse(await Deno.readTextFile(STATE_FILE)).fails ?? [];
  } catch {
    return [];
  }
}
export async function saveLast(current: Check[]) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(
    STATE_FILE,
    JSON.stringify(
      { at: new Date().toISOString(), fails: current.filter((c) => c.status === "fail").map((c) => c.id) },
      null,
      2,
    ) + "\n",
  );
}

/** Send the notification when there is something to say. dryRun only prints. True if it notified. */
export async function notifyDoctor(current: Check[], opts: { dryRun?: boolean } = {}) {
  const d = diffDoctor(await loadLast(), current);
  const t = notifyText(d);
  if (!opts.dryRun) await saveLast(current);
  if (!t) return false;
  return await desktopNotify(t.title, t.body, opts);
}

/**
 * The one way agents-multi reaches the desktop. Never `-u critical`: on KDE a critical notification
 * ignores its expiry and stays on screen until dismissed. Eight seconds, then it waits in the notification centre.
 * No --wait: the timer's unit must not hang, so there is no clickable action and the body carries
 * whatever the reader needs to act. True if something was shown (or printed).
 */
export async function desktopNotify(title: string, body: string, opts: { dryRun?: boolean } = {}) {
  if (opts.dryRun || !(await has("notify-send"))) {
    console.log(`[notification${opts.dryRun ? " dry-run" : " (notify-send missing)"}] ${title}\n${body}`);
    return true;
  }
  await run("notify-send", [
    "-a",
    "agents-multi",
    "-i",
    "claude-desktop",
    "-u",
    "normal",
    "--expire-time=8000",
    title,
    body,
  ]);
  return true;
}
