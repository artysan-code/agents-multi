// pick.ts — the strings of «Which Claude?», the profile picker (/#pick), English and Italian.

export const en = {
  "pick.title": "Which Claude?",
  "pick.hint": "↑ ↓ or the number to choose · Enter to open",
  "pick.open": "open",
  "pick.none": "No profile is declared in this configuration.",
  "pick.opening": "Opening {p}…",
  "pick.failed": "Could not open {p}: {e}",
};

export const it: Record<keyof typeof en, string> = {
  "pick.title": "Quale Claude?",
  "pick.hint": "↑ ↓ o il numero per scegliere · Invio per aprire",
  "pick.open": "aperto",
  "pick.none": "Questa configurazione non dichiara nessun profilo.",
  "pick.opening": "Apro {p}…",
  "pick.failed": "Impossibile aprire {p}: {e}",
};
