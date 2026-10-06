// updatelock.ts — A claude-update run holding its lock for too long.

import { stat } from "../../lib/fs.ts";
import { HOME } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** A claude-update run holding its lock for too long. */
export async function updateLockChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // The lock file outlives every run (flock, not presence, is the lock): it only means something
  // when a process still holds it, and holds it for longer than any update takes.
  const lockPath = `${HOME}/.cache/claude-update/update.lock`;
  const lock = await stat(lockPath);
  if (lock && (await run("flock", ["-n", lockPath, "true"])).code !== 0) {
    const age = (Date.now() - (lock.mtime?.getTime() ?? 0)) / 60000;
    if (age > 30) {
      add(
        "update.lock",
        "warn",
        `an update has held its lock for ${Math.round(age)} min`,
        "pgrep -af claude-update — kill it if it hangs",
      );
    }
  }
  return c;
}
