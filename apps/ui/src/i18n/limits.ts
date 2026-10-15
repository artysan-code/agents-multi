// limits.ts — the strings of Accounts & limits, English and Italian: Italian carries every English key.

export const en = {
  "lm.sub":
    "Each account's usage windows, as its sessions report them: Claude Code's at every turn, Codex's in its logs. A reading older than half an hour is stale: nothing is decided on it. «Ask for the limits now» asks Anthropic with each profile's own login.",
  "lm.p.claude": "Claude",
  "lm.p.codex": "Codex",
  "lm.stale": "stale",
  "lm.stale.hint": "Read more than half an hour ago: the limits manager does not act on it",
  "lm.noCodex": "Limits show once Codex has worked in this profile",
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
    "Le finestre d'uso di ogni account, come le riportano le sue sessioni: Claude Code a ogni turno, Codex nei suoi log. Una lettura più vecchia di mezz'ora è scaduta: non ci si decide niente. «Chiedi i limiti adesso» le chiede ad Anthropic con il login di ciascun profilo.",
  "lm.p.claude": "Claude",
  "lm.p.codex": "Codex",
  "lm.stale": "scaduta",
  "lm.stale.hint": "Letta più di mezz'ora fa: il gestore dei limiti non ci agisce",
  "lm.noCodex": "I limiti arrivano quando Codex ha lavorato in questo profilo",
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
