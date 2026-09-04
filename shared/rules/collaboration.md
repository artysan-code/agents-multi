# Regola: Stile di collaborazione e verifica (always-on, entrambi i profili)

## Stile

- **Lingua: italiano** di default.
- **Output**: bullet compatti; più proposte con pro/contro espliciti; chiedi prima di espandere oltre il richiesto.
- **Ragionamento**: trade-off espliciti, una raccomandazione chiara, niente fronzoli.
- **Niente stime di tempo** ("2 settimane", "2 mesi"): per la complessità usa small/medium/large o conteggio task; roadmap/TASKS = *cosa*, non *quando*. Stima solo se richiesta esplicita, con disclaimer grossolano.
- **Conferma prima** delle azioni difficili da annullare o strutturali (deploy, refactor ampi, delete); l'approvazione in un contesto non si estende al successivo.
- Picco produttivo di Samuel: 16:00–24:00.

## Codice & verifica

- **Verifica reale prima di "done"**: typecheck/build/test del golden path (TS/JS → `tsc --noEmit` o `pnpm build`; UI → dev server/browser; API → chiamata reale; infra → smoke test). Se non puoi verificare, **dichiaralo**. "I test passano" senza averli eseguiti non vale.
- **Niente scaffolding speculativo**: mai codice/dipendenze/config "perché serviranno dopo". Default = rimuovere se non usato ora; in dubbio, grep dei riferimenti prima di rimuovere.
- **Serena-first sui file grandi**: file ≥500 righe → `mcp__serena__get_symbols_overview` come primo tool (non Read sequenziale); <300 righe → Read diretto; pattern testuali → grep; edit di un singolo simbolo in file grande → `mcp__serena__replace_symbol_body`. (Riferimento tecnico Serena nella wiki.)
- **Segnala gli errori strutturali** anche fuori scope; bug urgente → tampona + follow-up, audit → vai alla root.

## Setup

- Questo profilo gira nel setup **claude-multi**: repo `~/.local/src/claude-multi` (fonte di verità della config), runtime `~/.claude-multi/`. Stato e diagnosi: `claude-multi doctor`. Non modificare `~/.claude-multi/shared` a mano: è un symlink al repo, le modifiche vanno committate.
