// console.ts — The console systemd unit, whether it runs the current code, and its new interface's build.

import { codeVersion } from "../../codeversion.ts";
import { PORT } from "../../lib/paths.ts";
import { has, run } from "../../lib/proc.ts";
import { uiStatus } from "../../ui.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** The console systemd unit, whether it runs the current code, and its new interface's build. */
export async function consoleChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  // --- console: serving itself is the point of the unit
  if (m.systemd) {
    const en = (await run("systemctl", ["--user", "is-enabled", "claude-multi-console.service"])).out;
    const act = (await run("systemctl", ["--user", "is-active", "claude-multi-console.service"])).out;
    if (en !== "enabled") {
      // no guided repair: install restarts the console, which would cut the repair's own stream
      add("console.unit", "warn", `claude-multi-console.service: ${en || "not installed"}`, "agents install");
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
  // --- the interface: built from the tree the checkout is on; without a build there is no console page
  const ui = await uiStatus();
  if (ui !== "built") {
    const pnpm = await has("pnpm");
    add(
      "console.ui",
      ui === "missing" ? "fail" : "warn",
      `the console's interface is ${ui === "missing" ? "not built" : "built from older code"}${
        pnpm ? "" : ", and pnpm is not installed"
      }`,
      pnpm ? "agents ui build" : "install pnpm (https://pnpm.io/installation), then agents ui build",
    );
  } else add("console.ui", "ok", "the console's interface is built");
  return c;
}
