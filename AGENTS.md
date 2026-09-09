# AGENTS.md — claude-multi

## Profilo repo
- visibilità: agenti           # solo-io | agenti | co-autore | cliente | pubblico
- ramo stabile: release
- lingua: italiano             # codice, commit, docs
- layer MCP: codice

## Cos'è

Il setup multi-profilo di Claude Code e Claude Desktop di Samuel (work + personal sulla stessa macchina). **Questo repo è la fonte di verità**; `~/.claude-multi/` è runtime materializzato da `claude-multi install`. Dettagli operativi nel [README](README.md).

## Regole per chi lavora qui

- **Non editare `~/.claude-multi/shared` a mano**: è un symlink a `shared/` di questo repo. Si modifica nel repo, si committa, si pusha. Il portatile riceve al prossimo avvio di Claude (`bin/lib/prelaunch.sh`).
- **Il runtime non entra nel repo**: credenziali, `.claude.json`, sessioni, plugin cache, marketplace. Se un file contiene `oauthAccount` o token, non va committato mai. `.gitignore` copre i backup (`*.bak*`, `*.backup`).
- **Ogni invariante nuova va in `cli/doctor.ts`**, non nel README. Il README descrive, il doctor verifica. Le due cose hanno già divergito in passato.
- **Il costo in `usage` è un equivalente a listino, non una spesa.** Tutto ciò che notifica una soglia passa da `cli/budget.ts`, che distingue i profili a solo abbonamento da quelli a extra credits: non aggiungere avvisi di spesa altrove e non far notificare l'uso incluso.
- **Il lancio resta bash puro** (`bin/claude`, `bin/claude-work`, `bin/lib/prelaunch.sh`): niente Deno nel percorso caldo, così un wrapper funziona anche su una macchina senza Deno.
- **Verifica prima di dire fatto**: `deno task check` e `deno task test`, poi `claude-multi doctor`. Se tocchi `install`, prima `claude-multi install --dry-run`. Funzione pura nuova = test nuovo in `cli/tests/`.
- **Modifiche a `~/.claude-multi` mentre una sessione Claude è aperta cambiano il terreno sotto i piedi della sessione.** `install` e `claude-multi mcp sync` vanno lanciati da un terminale a Claude chiuso.
- Commit senza trailer di attribuzione (hook `commit-trailer-guard`).
