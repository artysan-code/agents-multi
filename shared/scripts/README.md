# shared/scripts — tool QA portabili

Script di validazione riusabili, sincronizzati via Syncthing (folder `claude-multi`) su tutte le macchine. Spostati qui dalla working dir di ottimizzazione (`~/claude-multi-optimization/`, scratch non-syncata) il 2026-06-08.

## `validate_agents.py`
Valida il frontmatter dei file agente: presenza di `name:`/`description:`, `tools:` come array JSON valido, `model:` tra `opus|sonnet|haiku|inherit`. Prende la **directory** degli agenti come argomento.

```sh
python3 ~/.claude-multi/shared/scripts/validate_agents.py ~/.claude-multi/shared/agents
```

## MCP registry

Il sync del registry MCP (`shared/mcp/servers.json`) è passato in Deno: `claude-multi mcp check|sync|health`. Applica il registry sia ai `.claude.json` dei profili (superficie `cli`) sia ai `claude_desktop_config.json` delle istanze Desktop (superficie `desktop`), con backup in XDG state e stato per-macchina.

## `vault_lint.py`
Linta il vault LLM Wiki in `~/brains/claude`: frontmatter richiesto (`title`, `category`, `tags`, `summary`, `base_confidence`, `lifecycle`), lunghezza `summary` ≤200, pagine orfane (nessun wikilink entrante), righe-dato nelle `references/`, bullet nelle `## Steps` delle `skills/`. Nessun argomento (path fisso `~/brains/claude`). Exit code 1 se trova problemi → utilizzabile in hook/CI.

```sh
python3 ~/.claude-multi/shared/scripts/vault_lint.py
```
