// t.ts — the web app's strings (../i18n/web.ts): the language of the browser, or the one the console's
// language picker saved (the same localStorage key), English otherwise.

import * as base from "../i18n/web.ts";
import * as agents from "../i18n/web-agents.ts";

// the Agents view's strings live in their own file (ADR 0014, third round)
const web = { en: { ...base.en, ...agents.en }, it: { ...base.it, ...agents.it } };

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

/** A string whose key is built at run time (`act.tasks_add`); undefined when there is none. */
export function tk(key: string): string | undefined {
  return (LANG === "it" ? web.it : web.en)[key as Key];
}

/** The language picker: `auto` follows the browser. The page reloads so every string is read again. */
export function setLang(l: "auto" | "en" | "it"): void {
  try {
    if (l === "auto") localStorage.removeItem("cm-lang");
    else localStorage.setItem("cm-lang", l);
  } catch { /* storage blocked */ }
  location.reload();
}

export function langPref(): "auto" | "en" | "it" {
  try {
    const s = localStorage.getItem("cm-lang");
    if (s === "en" || s === "it") return s;
  } catch { /* storage blocked */ }
  return "auto";
}

export const LANGUAGE = LANG;
