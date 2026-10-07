// i18n.ts — the strings of the new interface, English and Italian. The type makes Italian carry every
// English key: a string added in one language only does not compile. Keys move here from
// apps/cli/dashboard/i18n.js as their page moves. The language: the viewer's pick (the same
// localStorage key as the old console), else the machine's, else the browser's, else English.

import { machineLang } from "./state.ts";

const en = {
  "nav.system": "System",
  "health.checks": "Checks",
  "health.rerun": "Re-run",
  "health.sum": "{ok} pass · {w} warn · {f} fail",
  "health.checking": "checking…",
  "health.allGood": "All good: {n} checks pass.",
  "health.areaOk": "{n} pass",
  "health.area.brain": "Brain and tasks",
  "health.area.mcp": "MCP servers and vault",
  "health.area.desktop": "Claude Desktop and the app",
  "health.area.profiles": "Profiles and launchers",
  "health.area.setup": "Agents Multi",
  "live.live": "live",
  "live.busy": "refreshing",
  "live.down": "reconnecting",
} as const;

export type Key = keyof typeof en;

const it: Record<Key, string> = {
  "nav.system": "Sistema",
  "health.checks": "Controlli",
  "health.rerun": "Ricontrolla",
  "health.sum": "{ok} ok · {w} avvisi · {f} errori",
  "health.checking": "controllo…",
  "health.allGood": "Tutto in ordine: {n} controlli superati.",
  "health.areaOk": "{n} ok",
  "health.area.brain": "Brain e task",
  "health.area.mcp": "Server MCP e archivio",
  "health.area.desktop": "Claude Desktop e l'app",
  "health.area.profiles": "Profili e launcher",
  "health.area.setup": "Agents Multi",
  "live.live": "in diretta",
  "live.busy": "aggiorno",
  "live.down": "riconnessione",
};

const DICTS: Record<string, Record<Key, string>> = { en, it };

function pref(): string {
  try {
    return localStorage.getItem("cm-lang") || "auto";
  } catch {
    return "auto";
  }
}

export function lang(): string {
  const p = pref();
  if (p !== "auto" && DICTS[p]) return p;
  if (DICTS[machineLang.value]) return machineLang.value;
  const nav = navigator.language.slice(0, 2);
  return DICTS[nav] ? nav : "en";
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return DICTS[lang()][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
