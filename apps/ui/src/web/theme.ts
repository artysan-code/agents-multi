// theme.ts — light, dark, or the device's: the choice is kept on this device and set on <html> before the app
// draws, so the first paint is already the right one. The style sheet reads `data-theme`.

import { type ThemePref, themeOf } from "./lib.ts";

const KEY = "am-theme";

export function themePref(): ThemePref {
  try {
    return themeOf(localStorage.getItem(KEY));
  } catch {
    return "system";
  }
}

const COLORS = { light: "#fcfcfb", dark: "#151515" };

export function applyTheme(pref: ThemePref = themePref()): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  // the browser's bar follows the theme: one tag, replacing the two that follow the device
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = dark ? COLORS.dark : COLORS.light;
  document.head.append(meta);
}

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch { /* storage blocked: the choice holds until the page closes */ }
  applyTheme(pref);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themePref() === "system" && applyTheme("system"));
