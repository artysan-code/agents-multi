// updates.ts — Self-update outcomes and the age of the cached update check.

import { readJson, stat } from "../../lib/fs.ts";
import { HOME } from "../../lib/paths.ts";
import { updateLog } from "../../lib/versions.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";
import { actionStep, verifyStep } from "../repair.ts";
import { variantProfiles } from "../../lib/profiles.ts";

type LogEntry = Awaited<ReturnType<typeof updateLog>>[number];

/** The variants a failed Desktop update left unbuilt (`variant rebuild failed: <profile>: <why>; …`),
 *  minus those a «rebuilt» entry logged since (the console's repair), and only profiles in `known`.
 *  `log` is newest first. Empty when the failure was not about variants. */
export function failedVariants(log: LogEntry[], known: string[]): { profile: string; why: string }[] {
  const i = log.findIndex((e) => e.component === "desktop" && e.event !== "waiting" && e.event !== "rebuilt");
  const last = log[i];
  const head = "variant rebuild failed: ";
  if (last?.event !== "failed" || !last.detail.startsWith(head)) return [];
  const rebuilt = new Set(
    log.slice(0, i).filter((e) => e.component === "desktop" && e.event === "rebuilt").map((e) => e.detail),
  );
  return last.detail.slice(head.length).split(";").map((s) => s.trim()).flatMap((s) => {
    const [profile, ...why] = s.split(": ");
    return known.includes(profile) && !rebuilt.has(profile) ? [{ profile, why: why.join(": ") }] : [];
  });
}

/** Self-update outcomes and the age of the cached update check. */
export async function updateChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- updates: they install themselves (claude-update --auto, from the timer), so a newer version
  // is not news. What is: the last attempt for a component failed, or verification refused one.
  const upd = await readJson<unknown>(`${HOME}/.cache/claude-update/check.json`);
  const log = await updateLog(50);
  for (const comp of ["cli", "desktop"]) {
    const last = log.find((e) => e.component === comp && e.event !== "waiting" && e.event !== "rebuilt");
    const name = comp === "cli" ? "Claude Code" : "Claude Desktop";
    if (last?.event === "verify-failed") {
      add(
        `update.${comp}`,
        "fail",
        `${name}: the last update failed verification (${last.detail}) — nothing was installed`,
        "agents-multi update --auto",
        [actionStep("update-now"), verifyStep],
      );
    } else if (last?.event === "failed") {
      // a Desktop update that failed only in rebuilding variants is repaired by rebuilding just those
      const variants = comp === "desktop" ? failedVariants(log, await variantProfiles()) : [];
      if (comp === "desktop" && last.detail.startsWith("variant rebuild failed: ") && !variants.length) continue;
      add(
        `update.${comp}`,
        "warn",
        `${name}: the last update failed (${last.detail || "see the journal"})`,
        "agents-multi update --auto",
        [
          ...(variants.length
            ? variants.map((v) => actionStep("desktop-rebuild", { profile: v.profile }))
            : [actionStep("update-now")]),
          verifyStep,
        ],
      );
    }
  }
  if (!upd) {
    add("update.check", "warn", "no update check cached", "agents-multi update --check", [
      actionStep("update-check"),
      verifyStep,
    ]);
  } else {
    const ageH = (Date.now() - ((await stat(`${HOME}/.cache/claude-update/check.json`))?.mtime?.getTime() ?? 0)) / 36e5;
    if (ageH > 24) {
      add(
        "update.check",
        "warn",
        `update check is ${Math.round(ageH)} h old (timer stopped?)`,
        "agents-multi update --check",
        [actionStep("update-check"), verifyStep],
      );
    }
  }
  return c;
}
