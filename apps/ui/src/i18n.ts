// i18n.ts — the strings of the new interface, English and Italian, one dictionary per area in ./i18n/
// (the frame, then each page). The type makes Italian carry every English key: a string added in one
// language only does not compile. Keys move here from apps/cli/dashboard/i18n.js as their page moves.
// The language: the viewer's pick (the same localStorage key as the old console), else the machine's,
// else the browser's, else English. Both are signals, so a page redraws when either changes.

import { signal } from "@preact/signals";
import { machineLang } from "./state.ts";
import * as shell from "./i18n/shell.ts";
import * as today from "./i18n/today.ts";
import * as tasks from "./i18n/tasks.ts";
import * as brain from "./i18n/brain.ts";
import * as connections from "./i18n/connections.ts";
import * as system from "./i18n/system.ts";
import * as plugins from "./i18n/plugins.ts";
import * as updates from "./i18n/updates.ts";
import * as pick from "./i18n/pick.ts";

const en = { ...shell.en, ...today.en, ...tasks.en, ...brain.en, ...connections.en, ...system.en, ...plugins.en, ...updates.en, ...pick.en };

export type Key = keyof typeof en;

const it: Record<Key, string> = {
  ...shell.it,
  ...today.it,
  ...tasks.it,
  ...brain.it,
  ...connections.it,
  ...system.it,
  ...plugins.it,
  ...updates.it,
  ...pick.it,
};

const DICTS: Record<string, Record<Key, string>> = { en, it };
export const LANGS = Object.keys(DICTS);

function stored(): string {
  try {
    return localStorage.getItem("cm-lang") || "auto";
  } catch {
    return "auto";
  }
}

/** "auto" or a language the viewer picked. */
export const langPref = signal<string>(stored());

export function setLangPref(p: string): void {
  langPref.value = p;
  try {
    localStorage.setItem("cm-lang", p);
  } catch { /* not remembered, still applied */ }
}

export function lang(): string {
  const p = langPref.value;
  if (p !== "auto" && DICTS[p]) return p;
  if (DICTS[machineLang.value]) return machineLang.value;
  const nav = navigator.language.slice(0, 2);
  return DICTS[nav] ? nav : "en";
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return DICTS[lang()][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A key built at run time (`health.area.${a}`): checked against the dictionary, else shown as is. */
export function tk(key: string, vars: Record<string, string | number> = {}): string {
  return key in en ? t(key as Key, vars) : key;
}
