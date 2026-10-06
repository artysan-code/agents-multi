---
title: Profiles
description: One folder per Claude account, discovered from its manifest.
---

A profile is a directory under your configuration's `profiles/` containing a `profile.json`. That is
the whole definition: there is no list of profile names anywhere in the code, so adding one is a
matter of adding a directory.

```json
{
  "description": "Research profile.",
  "command": "claude-research",
  "alias": "cr",
  "desktopDir": "~/.config/Claude-Research",
  "skills": ["graphify"],
  "agents": "all",
  "commands": "all"
}
```

- **`command`** is the launcher name. There is one launcher script, linked once per profile; it
  works out which profile to start from the name it was invoked as. The profile whose command is
  plain `claude` is the machine default.
- **`skills`, `agents`, `commands`** — `"all"` mounts the whole shared directory, a list mounts only
  those entries, plus whatever the profile owns. Owning a skill is how work that must not leak into
  another profile stays put: the doctor fails if it shows up somewhere else.
- **`desktopDir`** gives the profile its own Claude Desktop build: its own app id, taskbar icon,
  tray tooltip and tinted tray icons, so two Desktops are never mistaken for each other.
- **`disableAccountMcp`** switches off the connectors and plugins the account's organisation brings in.

## Settings

Each profile's `settings.json` is generated: the shared settings, then yours, then the profile's,
merged as JSON Merge Patches. What Claude writes into it at run time is adopted back into the
profile's own file on the next regeneration, so nothing is lost.
