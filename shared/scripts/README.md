# shared/scripts: portable QA tools

Reusable validation scripts, synced by Syncthing (folder `agents-multi`) to every machine.

## `validate_agents.py`

Validates the frontmatter of agent files: `name:` and `description:` present, `tools:` a valid JSON array, `model:` one of `opus|sonnet|haiku|inherit`. Takes the agents **directory** as its argument.

```sh
python3 ~/.claude-multi/shared/scripts/validate_agents.py ~/.claude-multi/shared/agents
```

## MCP registry

Syncing the MCP registry (`shared/mcp/servers.json`) is done in Deno: `agents-multi mcp check|sync|health`. It applies the registry both to each profile's `.claude.json` (`cli` surface) and to the `claude_desktop_config.json` of the Desktop instances (`desktop` surface), with backups in the XDG state directory and per-machine state.

## `vault_lint.py`

Lints the LLM Wiki vault at `~/brains/claude`: required frontmatter (`title`, `category`, `tags`, `summary`, `base_confidence`, `lifecycle`), `summary` length <= 200, orphan pages (no incoming wikilink), data rows in `references/`, bullets under `## Steps` in `skills/`. No arguments (fixed path `~/brains/claude`). Exits 1 if it finds problems, so it works in a hook or CI.

```sh
python3 ~/.claude-multi/shared/scripts/vault_lint.py
```
