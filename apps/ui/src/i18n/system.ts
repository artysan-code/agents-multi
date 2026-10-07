// system.ts — the strings of the System page and its tabs, English and Italian: Italian carries every
// English key.

export const en = {
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
} as const;

export const it: Record<keyof typeof en, string> = {
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
};
