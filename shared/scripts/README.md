# shared/scripts — tool QA portabili

Script di validazione riusabili, sincronizzati via Syncthing (folder `claude-multi`) su tutte le macchine. Spostati qui dalla working dir di ottimizzazione (`~/claude-multi-optimization/`, scratch non-syncata) il 2026-06-08.

## `validate_agents.py`
Valida il frontmatter dei file agente: presenza di `name:`/`description:`, `tools:` come array JSON valido, `model:` tra `opus|sonnet|haiku|inherit`. Prende la **directory** degli agenti come argomento.

```sh
python3 ~/.claude-multi/shared/scripts/validate_agents.py ~/.claude-multi/shared/agents
```

## `mcp-sync.py`
Sincronizza il registry MCP condiviso (`shared/mcp/servers.json`) nella chiave `mcpServers` dei `.claude.json` di ogni profilo — un unico posto da editare invece di due, e vale sia per la CLI che per l'embedded Claude Code del Desktop (leggono lo stesso file).

Merge non distruttivo: tocca solo i server del registry. I server aggiunti a mano in un profilo restano; quelli gestiti dal registry e poi rimossi vengono puliti (tracciati in `shared/mcp/.sync-state.json`). Backup del `.claude.json` prima di ogni scrittura in `~/.local/state/claude-multi/mcp-sync-backups/` (600, ultimi 5): mai nella dir del profilo. Il campo opzionale `_profiles` limita un server a un sottoinsieme di profili.

Rifiuta di scrivere se rileva un'istanza Claude attiva (riscriverebbe `.claude.json` annullando il sync) — `--force` per bypassare.

```sh
python3 ~/.claude-multi/shared/scripts/mcp-sync.py --dry-run   # diff
python3 ~/.claude-multi/shared/scripts/mcp-sync.py             # applica
python3 ~/.claude-multi/shared/scripts/mcp-sync.py --check     # exit 1 se fuori sync
```

## `vault_lint.py`
Linta il vault LLM Wiki in `~/brains/claude`: frontmatter richiesto (`title`, `category`, `tags`, `summary`, `base_confidence`, `lifecycle`), lunghezza `summary` ≤200, pagine orfane (nessun wikilink entrante), righe-dato nelle `references/`, bullet nelle `## Steps` delle `skills/`. Nessun argomento (path fisso `~/brains/claude`). Exit code 1 se trova problemi → utilizzabile in hook/CI.

```sh
python3 ~/.claude-multi/shared/scripts/vault_lint.py
```
