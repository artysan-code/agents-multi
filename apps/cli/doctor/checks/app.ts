// app.ts — The desktop app: installed, started at login, its tray, and the scheduled jobs (systemd
// timers in dev mode, the app's backend in app mode).

import { appExecutable, AUTOSTART } from "../../install.ts";
import { readJson, readText } from "../../lib/fs.ts";
import { HOME, STATE } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** The desktop app: installed, started at login, its tray, and the scheduled jobs. */
export async function appChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  if (!m.graphical) return c;
  const exe = await appExecutable();
  if (!exe) {
    add(
      "app",
      ctx.mode === "app" ? "fail" : "warn",
      "the desktop app (Agents Multi) is not installed: no console window, tray or scheduled jobs",
      "install the Agents Multi package",
    );
    return c;
  }
  const entry = await readText(`${HOME}/.config/autostart/${AUTOSTART}`);
  if (!entry?.includes("--tray")) {
    add("app.autostart", "warn", "the desktop app does not start at login", "agents install");
  }
  const app = await readJson<{ tray?: boolean }>(`${STATE}/app.json`);
  if (app?.tray === false) {
    add(
      "app.tray",
      "warn",
      "the desktop app found no system tray in this session: it runs without its icon",
      "GNOME: enable the AppIndicator extension, then restart Agents Multi",
    );
  } else {add(
      "app",
      "ok",
      `desktop app: ${exe}${app?.tray ? ", tray available" : ""}${entry ? ", starts at login" : ""}`,
    );}
  // the jobs on a schedule: the app's backend runs them in app mode (console/schedule.ts), the timers in dev
  if (ctx.mode === "dev" && m.systemd) {
    const t = await run("systemctl", ["--user", "is-enabled", "claude-update-check.timer"]);
    if (t.out !== "enabled") {
      add("desktop.timer", "warn", `claude-update-check.timer: ${t.out || "not installed"}`, "agents install");
    }
    const tt = await run("systemctl", ["--user", "is-enabled", "claude-tasks.timer"]);
    if (tt.out !== "enabled") {
      add(
        "tasks.timer",
        "warn",
        `claude-tasks.timer: ${tt.out || "not installed"} — no task reminders on this machine`,
        "agents install",
      );
    }
  }
  return c;
}
