// updates.ts — Self-update outcomes and the age of the cached update check.

import { readJson, stat } from "../../lib/fs.ts";
import { HOME } from "../../lib/paths.ts";
import { updateLog } from "../../lib/versions.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** Self-update outcomes and the age of the cached update check. */
export async function updateChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- updates: they install themselves (claude-update --auto, from the timer), so a newer version
  // is not news. What is: the last attempt for a component failed, or verification refused one.
  const upd = await readJson<unknown>(`${HOME}/.cache/claude-update/check.json`);
  const log = await updateLog(50);
  for (const comp of ["cli", "desktop"]) {
    const last = log.find((e) => e.component === comp && e.event !== "waiting");
    const name = comp === "cli" ? "Claude Code" : "Claude Desktop";
    if (last?.event === "verify-failed") {
      add(
        `update.${comp}`,
        "fail",
        `${name}: the last update failed verification (${last.detail}) — nothing was installed`,
        "claude-multi update --auto",
      );
    } else if (last?.event === "failed") {
      add(
        `update.${comp}`,
        "warn",
        `${name}: the last update failed (${last.detail || "see the journal"})`,
        "claude-multi update --auto",
      );
    }
  }
  if (!upd) add("update.check", "warn", "no update check cached", "claude-multi update --check");
  else {
    const ageH = (Date.now() - ((await stat(`${HOME}/.cache/claude-update/check.json`))?.mtime?.getTime() ?? 0)) / 36e5;
    if (ageH > 24) {
      add(
        "update.check",
        "warn",
        `update check is ${Math.round(ageH)} h old (timer stopped?)`,
        "claude-multi update --check",
      );
    }
  }
  return c;
}
