# shared/scripts: portable QA tools

Validation scripts. `validate_agents.py` runs in the gate (`scripts/ci.sh`).

## `validate_agents.py`

Validates the frontmatter of agent files: `name:` and `description:` present, `tools:` a valid JSON array, `model:` one of `opus|sonnet|haiku|inherit`. Takes the agents **directory** as its argument.

```sh
python3 ~/.agents-multi/shared/scripts/validate_agents.py ~/.agents-multi/shared/agents
```

## MCP registry

Syncing the MCP registry (`shared/mcp/servers.json`) is done in Deno: `agents mcp check|sync|health`. It applies the registry both to each profile's `.claude.json` (`cli` surface) and to the `claude_desktop_config.json` of the Desktop instances (`desktop` surface), with backups in the XDG state directory and per-machine state.
