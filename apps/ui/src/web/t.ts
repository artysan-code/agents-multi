// t.ts — the web app's strings (../i18n/web.ts): the language of the browser, or the one the console's
// language picker saved (the same localStorage key), English otherwise.

import * as web from "../i18n/web.ts";

export type Key = keyof typeof web.en;

function lang(): "en" | "it" {
  try {
    const s = localStorage.getItem("cm-lang");
    if (s === "en" || s === "it") return s;
  } catch { /* storage blocked: the browser's language */ }
  return navigator.language.toLowerCase().startsWith("it") ? "it" : "en";
}

const LANG = lang();
document.documentElement.lang = LANG;

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return (LANG === "it" ? web.it : web.en)[key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A day or time for the interface language. */
export const dateOf = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString(LANG, opts);
