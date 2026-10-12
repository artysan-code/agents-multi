// desktop-entry.ts — the desktop app's place on the desktop: its executable, its menu entry for an
// AppImage and its autostart entry. Shared by install (which writes them) and the doctor (which
// checks them), so neither imports the other.

import { stat } from "./fs.ts";
import { RUNTIME } from "./paths.ts";
import { which } from "./proc.ts";

/** The login entry that starts the app in the tray (XDG autostart). */
export const AUTOSTART = "agents-multi.desktop";

/** The desktop app's executable: the runtime's link to the package's (appcopy.ts), else on PATH. */
export async function appExecutable(): Promise<string | null> {
  const own = `${RUNTIME}/bin/agents-multi-desktop`;
  return (await stat(own)) ? own : await which("agents-multi-desktop");
}

/** The app's menu entry, named after its window's app_id so the panel groups the two. */
export const APP_ENTRY = "me.artysan.agents.desktop";
/** Pure: the menu entry install writes for an AppImage, which brings none (a deb or an rpm does). */
export const appImageEntry = (app: string) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Agents Multi",
    `Exec=${app}`,
    "Icon=claude-multi",
    "StartupWMClass=me.artysan.agents",
    "StartupNotify=true",
    "Terminal=false",
    "Categories=Development;",
    "",
  ].join("\n");

/** Pure: the autostart entry, from desktop/autostart.desktop.in. */
export const autostartEntry = (template: string, bin: string) =>
  template.slice(template.indexOf("[Desktop Entry]")).replaceAll("@BIN@", bin);
