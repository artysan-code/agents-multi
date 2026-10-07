// prefs.ts — the viewer's theme and language, kept in this browser (the same keys as the old console).

import { effect, signal } from "@preact/signals";
import { LANGS, langPref, setLangPref } from "../i18n.ts";

export type Theme = "auto" | "dark" | "light";

function storedTheme(): Theme {
  try {
    const v = localStorage.getItem("cm-theme");
    return v === "dark" || v === "light" ? v : "auto";
  } catch {
    return "auto";
  }
}

export const theme = signal<Theme>(storedTheme());

effect(() => {
  const v = theme.value;
  if (v === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", v);
  try {
    localStorage.setItem("cm-theme", v);
  } catch { /* not remembered, still applied */ }
});

export function cycleTheme(): void {
  theme.value = theme.value === "auto" ? "dark" : theme.value === "dark" ? "light" : "auto";
}

export function cycleLang(): void {
  const order = ["auto", ...LANGS];
  setLangPref(order[(order.indexOf(langPref.value) + 1) % order.length]);
}
