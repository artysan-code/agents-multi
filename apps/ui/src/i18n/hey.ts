// hey.ts — the strings of «Hey Claude», the quick entry (/#hey), English and Italian. What it shares
// with the console's field (the tools, the follow-up, the hand-over) is in shell.ts under ask.*.

export const en = {
  "hey.title": "Hey Claude",
  "hey.ph": "Ask Claude, or say what needs doing…",
  "hey.ph.more": "Continue…",
};

export const it: Record<keyof typeof en, string> = {
  "hey.title": "Hey Claude",
  "hey.ph": "Chiedi a Claude, o di' cosa c'è da fare…",
  "hey.ph.more": "Continua…",
};
