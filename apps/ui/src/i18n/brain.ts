// brain.ts — the strings of the Brain view, English and Italian: Italian carries every English key.

export const en = {
  "bn.sub": "Search the brain and read a page. Read only: changes are made by Claude, in a chat.",
  "bn.ph": "Search the brain…",
  "bn.search": "Search",
  "bn.hint": "Type a few words to find a page.",
  "bn.none": "Nothing found.",
  "bn.searching": "Searching…",
  "bn.back": "Back to the results",
  "bn.links": "Links out",
  "bn.backlinks": "Linked from",
  "bn.updated": "updated {d}",
  "bn.board": "Open the brain's board",
  "bn.err": "Could not read the brain: {e}",
} as const;

export const it: Record<keyof typeof en, string> = {
  "bn.sub": "Cerca nel brain e leggi una pagina. Solo lettura: le modifiche le fa Claude, in una chat.",
  "bn.ph": "Cerca nel brain…",
  "bn.search": "Cerca",
  "bn.hint": "Scrivi qualche parola per trovare una pagina.",
  "bn.none": "Non ho trovato niente.",
  "bn.searching": "Cerco…",
  "bn.back": "Torna ai risultati",
  "bn.links": "Collegamenti in uscita",
  "bn.backlinks": "Collegata da",
  "bn.updated": "aggiornata {d}",
  "bn.board": "Apri la bacheca del brain",
  "bn.err": "Non riesco a leggere il brain: {e}",
};
