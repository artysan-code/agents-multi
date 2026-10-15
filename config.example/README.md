# Your Agents Multi configuration

This folder is yours: `agents init <folder>` copied it here and linked `~/.agents-multi/config`
to it. Keep it in step between your machines (Syncthing, or a private git repository); the code
stays in the Agents Multi repository.

- `owner.json` — who you are: `id` (the owner written in your tasks: choose it once), `name`,
  `language` (the one Claude answers in).
- `profiles/<name>/` — one folder per Claude account: `profile.json` (the command that launches it,
  a separate Desktop if any), `CLAUDE.md`, `settings.json` (that profile's differences), and its own
  `skills/`, `agents/`, `commands/`.
- `settings.json` — what every profile gets, over the repository's `shared/settings.json` (a JSON
  Merge Patch: objects merge, anything else replaces, `null` removes).
- `servers.json` — your choices over the MCP servers of `shared/mcp/servers.json`, the same kind of
  patch. Those are templates, all off: an account-backed one turns on with an account in
  `accounts.json`, any other with `"<server>": { "_profiles": null }` here (every profile; or a list).
  Servers of your own go here too, `"<name>": { "command": …, "args": … }`, and stay yours.
- `gateway.json` — optional: the lazy MCP gateway (docs/adr/0008). `{ "enabled": false }` is the kill switch
  (on by default in the desktop app, off in a checkout), `idleMinutes` (default 10) and `port` (default 7332).
- `reviewer.json` — the rules for what unattended runs (routines) ask for: `deny`, `ask`, `allow` and
  `review` (a judge decides by your criterion), in Claude Code's permission syntax (docs/adr/0011). The
  example denies deletes and publishing and asks for the rest; `agents review rules` shows what a project gets.
- `accounts.json` — the accounts those servers use (no secrets: those go in the vault,
  `agents vault set <service> <account>`).
- `rules/` — your rules, imported by each profile's `CLAUDE.md`.
- `icons/<size>/claude-desktop-<profile>.png` — the icon of a profile with its own Desktop.
