// console.ts — The console systemd unit and whether it runs the current code.

import { codeVersion } from "../../codeversion.ts";
import { PORT } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";
import { actionStep, verifyStep } from "../repair.ts";

/** The console systemd unit and whether it runs the current code. */
export async function consoleChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  // --- console: serving itself is the point of the unit
  if (m.systemd) {
    const en = (await run("systemctl", ["--user", "is-enabled", "claude-multi-console.service"])).out;
    const act = (await run("systemctl", ["--user", "is-active", "claude-multi-console.service"])).out;
    if (en !== "enabled") {
      add("console.unit", "warn", `claude-multi-console.service: ${en || "not installed"}`, "claude-multi install", [
        actionStep("install"),
        verifyStep,
      ]);
    } else if (act !== "active") {
      add(
        "console.unit",
        "warn",
        `claude-multi-console.service is ${act}`,
        "systemctl --user restart claude-multi-console.service",
      );
    } else {
      // a console started before a pull or an edit runs old code: its pages show what that code knew
      const running = await fetch(`http://127.0.0.1:${PORT}/api/code`, { signal: AbortSignal.timeout(3000) })
        .then(async (r): Promise<{ code?: string }> => r.ok ? await r.json() : (await r.body?.cancel(), {})).catch(() =>
          null
        );
      const now = await codeVersion();
      if (running && running.code !== now) {
        add(
          "console.code",
          "warn",
          "the console runs older code than the repository (started before a pull or an edit)",
          "systemctl --user restart claude-multi-console.service",
        );
      } else add("console.unit", "ok", `console on http://127.0.0.1:${PORT} (systemd user unit)`);
    }
  }
  return c;
}
