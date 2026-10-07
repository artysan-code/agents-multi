// app.ts — The desktop app (tray and console window): dependencies, units, tray availability, timers.

import { readJson } from "../../lib/fs.ts";
import { STATE } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** The desktop app (tray and console window): dependencies, units, tray availability, timers. */
export async function appChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  if (m.desktopVersion) {
    // The desktop app (tray and console window). WebEngine is only an optional
    // dependency of pyside6 on Arch: present here by accident of KDE, missing on a bare install.
    const qt = await run("pacman", ["-Q", "pyside6", "qt6-webengine"]);
    const missing = ["pyside6", "qt6-webengine"].filter((p) => !qt.out.split("\n").some((l) => l.startsWith(`${p} `)));
    if (missing.length) {
      add(
        "app.deps",
        "fail",
        `the desktop app needs ${missing.join(" and ")}`,
        `sudo pacman -S --needed ${missing.join(" ")}`,
      );
    }
    if (m.systemd && m.graphical) {
      const u = await run("systemctl", ["--user", "is-enabled", "claude-multi-app.service"]);
      if (u.out !== "enabled") {
        add(
          "app.unit",
          "warn",
          `claude-multi-app.service: ${u.out || "not installed"} — no tray icon at login`,
          "agents install",
        );
      }
    }
    const app = await readJson<{ tray?: boolean }>(`${STATE}/app.json`);
    if (app?.tray === false) {
      add(
        "app.tray",
        "warn",
        "the desktop app found no system tray in this session: it runs without its icon",
        "GNOME: enable the AppIndicator extension, then systemctl --user restart claude-multi-app",
      );
    }
    if (!missing.length && app?.tray !== false) {
      add("app", "ok", "desktop app: pyside6 + qt6-webengine" + (app?.tray ? ", tray available" : ""));
    }
    if (m.systemd && m.graphical) {
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
  }
  return c;
}
