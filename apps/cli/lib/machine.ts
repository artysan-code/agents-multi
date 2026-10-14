// machine.ts — What this machine is: graphical session, KDE, systemd, and the Claude versions installed.

import { listDir, lstat } from "./fs.ts";
import { BIN, HOME, LIB } from "./paths.ts";
import { has, run } from "./proc.ts";
import { desktopDir, profileNames } from "./profiles.ts";
import { desktopVersions } from "./versions.ts";

/** Pure: the user manager's HOME, from `systemctl --user show-environment`. Units are ours to manage
 *  only when it is this HOME: in another (a test's, a sandbox's) the links land where the manager never
 *  looks, while enabling or stopping a unit would act on the real user's. */
export function managerHome(environment: string): string | null {
  return environment.match(/^HOME=(.*)$/m)?.[1] ?? null;
}

export async function machine() {
  // Over ssh the session variables are absent: without this check install would think it is on a
  // headless box and silently skip systemd units and menu entries.
  const rt = Deno.env.get("XDG_RUNTIME_DIR");
  const graphical =
    !!(Deno.env.get("WAYLAND_DISPLAY") || Deno.env.get("DISPLAY") || Deno.env.get("XDG_CURRENT_DESKTOP")) ||
    !!(rt && await lstat(`${rt}/wayland-0`)) || !!(await lstat("/tmp/.X11-unix/X0"));
  // Claude Desktop lives in user space (bin/claude-desktop-update); the system package is what a
  // machine had before the migration, and what the doctor asks to remove.
  const droot = `${LIB}/claude-desktop`;
  const names = await profileNames();
  // the probes do not depend on each other: they start together
  const [cur, droots, desktopPkg, systemdEnv, kbuild, cliBin, cliDirs, embeddedDirs] = await Promise.all([
    run("readlink", ["-f", `${droot}/current`]),
    listDir(`${droot}/versions`),
    run("pacman", ["-Q", "claude-desktop"]),
    has("systemctl").then((ok) => ok ? run("systemctl", ["--user", "show-environment"]) : null),
    has("kbuildsycoca6"),
    run("readlink", ["-f", `${BIN}/claude-bin`]),
    listDir(`${HOME}/.local/share/claude/versions`),
    Promise.all(names.map(async (p) => listDir(`${await desktopDir(p)}/claude-code`))),
  ]);
  const desktop = desktopVersions(droots, cur.code === 0 ? cur.out.split("/").pop() ?? null : null);
  const desktopSystem = desktopPkg.code === 0 ? desktopPkg.out.split(/\s+/)[1]?.split("-")[0] ?? null : null;
  const desktopVersion = desktop.current ?? desktopSystem;
  const systemd = !!systemdEnv && managerHome(systemdEnv.out) === HOME;
  const kde = (Deno.env.get("XDG_CURRENT_DESKTOP") ?? "").toUpperCase().includes("KDE") || kbuild;
  const cliVersion = cliBin.code === 0 ? cliBin.out.split("/").pop() ?? null : null;
  const cliVersions = cliDirs.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const embedded: Record<string, string[]> = {};
  names.forEach((p, i) => {
    const v = embeddedDirs[i].filter((x) => /^\d+\.\d+\.\d+$/.test(x));
    if (v.length) embedded[p] = v;
  });
  return {
    hostname: Deno.hostname(),
    graphical,
    kde,
    systemd,
    desktopVersion,
    desktopStaged: desktop.staged,
    desktopPrevious: desktop.previous,
    desktopSystem,
    embeddedCode: embedded,
    cliVersion,
    cliVersions,
    deno: Deno.version.deno,
  };
}
