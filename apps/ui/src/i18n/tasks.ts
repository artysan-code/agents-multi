// tasks.ts — the strings of the Tasks view, English and Italian: Italian carries every English key.

export const en = {
  "tk.sub": "Today with its times, what is late, then the open tasks by project. Marking one done is the only change made here.",
  "tk.today": "Today",
  "tk.nothingToday": "Nothing planned today.",
  "tk.overdue": "Overdue",
  "tk.open": "Open",
  "tk.noProject": "No project",
  "tk.none": "No open task.",
  "tk.done": "Mark done",
  "tk.doneToast": "Done: {t}",
  "tk.late": "since {d}",
  "tk.waiting": "waiting",
  "tk.board": "Open the brain's board",
  "tk.loading": "Reading the tasks…",
  "tk.err": "Could not read the tasks: {e}",
} as const;

export const it: Record<keyof typeof en, string> = {
  "tk.sub": "Oggi con i suoi orari, quello che è in ritardo, poi le task aperte per progetto. Segnarne una come fatta è l'unica modifica che si fa da qui.",
  "tk.today": "Oggi",
  "tk.nothingToday": "Niente in programma oggi.",
  "tk.overdue": "In ritardo",
  "tk.open": "Aperte",
  "tk.noProject": "Senza progetto",
  "tk.none": "Nessuna task aperta.",
  "tk.done": "Segna come fatta",
  "tk.doneToast": "Fatta: {t}",
  "tk.late": "dal {d}",
  "tk.waiting": "in attesa",
  "tk.board": "Apri la bacheca del brain",
  "tk.loading": "Leggo le task…",
  "tk.err": "Non riesco a leggere le task: {e}",
};
