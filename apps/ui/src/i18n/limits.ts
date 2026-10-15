// limits.ts — the strings of Accounts & limits, English and Italian: Italian carries every English key.

export const en = {
  "lm.sub":
    "Each profile's usage windows, as its Claude Code sessions report them at every turn. «Ask for the limits now» asks Anthropic with each profile's own login.",
  "lm.noAccount": "not signed in",
  "lm.read": "read {d}",
  "now.refresh": "Ask for the limits now",
  "now.tokens": "{n} tokens today",
  "now.5h": "5 h",
  "now.7d": "week",
  "now.resets": "back {w}",
  "now.noLimits": "Limits show once one of its sessions works",
  "now.ctx": "Context used",
  "run.open": "Open Claude Desktop",
  "run.focus": "Bring it forward",
} as const;

export const it: Record<keyof typeof en, string> = {
  "lm.sub":
    "Le finestre d'uso di ogni profilo, come le riportano le sue sessioni di Claude Code a ogni turno. «Chiedi i limiti adesso» le chiede ad Anthropic con il login di ciascun profilo.",
  "lm.noAccount": "non collegato",
  "lm.read": "letto {d}",
  "now.refresh": "Chiedi i limiti adesso",
  "now.tokens": "{n} token oggi",
  "now.5h": "5 h",
  "now.7d": "settimana",
  "now.resets": "riparte {w}",
  "now.noLimits": "I limiti arrivano quando lavora una sua sessione",
  "now.ctx": "Contesto usato",
  "run.open": "Apri Claude Desktop",
  "run.focus": "Portalo in primo piano",
};
