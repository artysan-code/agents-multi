// console.ts — The console: served by the desktop app (its backend), whether it runs the current code,
// the units it replaced, and its interface's build.

import { codeVersion } from "../../codeversion.ts";
import { RETIRED_UNITS } from "../../install.ts";
import { lstat } from "../../lib/fs.ts";
import { HOME, PORT, REPO } from "../../lib/paths.ts";
import { has } from "../../lib/proc.ts";
import { uiStatus } from "../../ui.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** The console: who serves it, whether it runs the current code, and its interface's build. */
export async function consoleChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  // --- the units the app replaced: install removes them (docs/adr/0003)
  const left = [];
  for (const u of RETIRED_UNITS) if (await lstat(`${HOME}/.config/systemd/user/${u}`)) left.push(u);
  if (left.length) {
    add(
      "console.unit",
      "warn",
      `${left.join(" and ")} still installed: the desktop app replaced them`,
      "agents install",
    );
  }
  // --- the console on its port: the app's backend (or `agents serve` by hand on a headless box)
  const running = await fetch(`http://127.0.0.1:${PORT}/api/code`, { signal: AbortSignal.timeout(3000) })
    .then(async (r): Promise<{ code?: string }> => r.ok ? await r.json() : (await r.body?.cancel(), {})).catch(() =>
      null
    );
  if (!running) {
    add(
      "console",
      ctx.m.graphical ? "warn" : "ok",
      `no console on http://127.0.0.1:${PORT}${ctx.m.graphical ? ": the desktop app is not running" : ""}`,
      ctx.m.graphical ? "start Agents Multi" : "agents serve, when you want it",
    );
  } else {
    // a console started before an update or an edit runs old code: its pages show what that code knew.
    // It runs the installed code or the app's package (the same build), or a development checkout.
    const now = [await codeVersion()];
    if (ctx.installed !== REPO) now.push(await codeVersion(ctx.installed));
    if (!now.includes(running.code ?? "")) {
      add(
        "console.code",
        "warn",
        "the console runs older code than the installed one (started before an update or an edit)",
        "restart Agents Multi",
      );
    } else add("console", "ok", `console on http://127.0.0.1:${PORT}`);
  }
  // --- the interface: built from the tree the checkout is on; without a build there is no console page.
  // A build without the stamp (`pnpm build` in apps/ui, as a developer does) serves the page all the
  // same, but which code it was built from is unknown: fine in a development checkout, a warning in the
  // installed one.
  const ui = await uiStatus();
  if (ui === "unstamped") {
    add(
      "console.ui",
      ctx.installed === REPO ? "warn" : "ok",
      "the console's interface is built, outside `agents ui build`: which code it was built from is unknown",
      "agents ui build",
    );
  } else if (ui !== "built") {
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
