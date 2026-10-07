#!/usr/bin/env bash
# profiles.sh — read the profile manifests from bash, so the launchers derive what they need
# instead of hardcoding it. Sourced by bin/claude, bin/claude-launch and the Desktop rebuild.
#
# The manifests are small, flat JSON: a sed for one key is enough and keeps jq off the launch path
# (the setup does not depend on jq, and a wrapper must work on a machine without it).

# Repository root, from this file's real location.
cm_repo() { cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd; }

# The runtime: ~/.agents-multi, or ~/.claude-multi on a machine that has not moved it yet (agents migrate).
cm_runtime() {
  local root="${AGENTS_MULTI_ROOT:-${CLAUDE_MULTI_ROOT:-}}"
  if [[ -n "$root" ]]; then printf '%s\n' "$root"
  elif [[ -e "$HOME/.agents-multi" || ! -e "$HOME/.claude-multi" ]]; then printf '%s\n' "$HOME/.agents-multi"
  else printf '%s\n' "$HOME/.claude-multi"; fi
}

# The installation's mode, as apps/cli/lib/mode.ts decides it: "app" when ~/.agents-multi/shared is the
# app's copy (app/current/shared), "dev" when it is a checkout's — or when there is none yet.
cm_mode() {
  local rt link
  rt="$(cm_runtime)"
  link="$(readlink "$rt/shared" 2>/dev/null || true)"
  if [[ "$link" == "app/current/shared" || "$link" == "$rt/app/current/shared" ]]; then echo app; else echo dev; fi
}

# The person's configuration (profiles, accounts, rules): ~/.agents-multi/config, a link to their folder.
cm_config() { printf '%s\n' "${AGENTS_MULTI_CONFIG:-${CLAUDE_MULTI_CONFIG:-$(cm_runtime)/config}}"; }

# Every declared profile, one per line.
cm_profiles() {
  local m
  for m in "$(cm_config)/profiles"/*/profile.json; do
    [[ -e "$m" ]] || continue
    basename "$(dirname "$m")"
  done
}

# cm_has_profile <name> — is this a declared profile? Deliberately not `cm_profiles | grep -q`:
# grep -q exits at the first match, cm_profiles dies of SIGPIPE, and under `set -o pipefail` the
# pipeline then reports failure even though the name matched.
cm_has_profile() {
  local p
  while read -r p; do [[ "$p" == "$1" ]] && return 0; done < <(cm_profiles)
  return 1
}

# cm_field <profile> <key> — a string value from the manifest, empty when absent.
cm_field() {
  local f
  f="$(cm_config)/profiles/$1/profile.json"
  [[ -f "$f" ]] || return 0
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$f" | head -n1
}

# cm_flag <profile> <key> — succeeds when the manifest sets this boolean key to true.
cm_flag() {
  local f
  f="$(cm_config)/profiles/$1/profile.json"
  [[ -f "$f" ]] && grep -Eq "\"$2\"[[:space:]]*:[[:space:]]*true" "$f"
}

# cm_account_mcp_settings <config dir> — the --settings overlay for a profile with
# disableAccountMcp: the claude.ai connectors off, and every plugin the organisation syncs into
# the account (`<name>@synced`, read from the sync manifests under plugins/synced/) disabled.
# Rebuilt at every launch, so a plugin the organisation adds later is caught on the next start.
# Mirrors syncedPlugins() on the TypeScript side.
cm_account_mcp_settings() {
  local m names=""
  for m in "$1"/plugins/synced/*/manifest.json; do
    [[ -f "$m" ]] || continue
    # `|| true`: a manifest with no plugin is not an error, and the launcher runs under set -e.
    names+="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$m" | sed 's/.*"\([^"]*\)"$/\1/' || true)"$'\n'
  done
  local entries
  entries="$(printf '%s' "$names" | sed '/^$/d' | sort -u | sed 's/.*/"&@synced": false/' | paste -sd, -)"
  printf '{"disableClaudeAiConnectors": true, "enabledPlugins": {%s}}\n' "$entries"
}

# cm_command <profile> — launcher name; claude-<profile> when the manifest does not say.
cm_command() {
  local c; c="$(cm_field "$1" command)"
  printf '%s' "${c:-claude-$1}"
}

# cm_profile_for <command> — which profile answers to this launcher name, empty if none.
# Returns 0 even when nothing matches: the caller runs under `set -e` and has to be able to test
# the empty result itself, rather than being killed before it can report anything.
cm_profile_for() {
  local p
  while read -r p; do
    [[ -z "$p" ]] && continue
    [[ "$(cm_command "$p")" == "$1" ]] && { printf '%s' "$p"; return 0; }
  done < <(cm_profiles)
  return 0
}

# cm_desktop_dir <profile> — Claude Desktop's user-data-dir. Manifest wins; otherwise
# ~/.config/Claude-<Name> when it exists, else Desktop's own ~/.config/Claude. Mirrors desktopDir()
# on the TypeScript side.
cm_desktop_dir() {
  local d; d="$(cm_field "$1" desktopDir)"
  if [[ -n "$d" ]]; then
    printf '%s' "${d/#\~\//$HOME/}"
    return 0
  fi
  local name="${1^}" suffixed
  suffixed="$HOME/.config/Claude-$name"
  [[ -d "$suffixed" ]] && printf '%s' "$suffixed" || printf '%s' "$HOME/.config/Claude"
}

# cm_desktop_appid <profile> — the Wayland app_id of this profile's Desktop build, empty when the
# profile uses the system-wide `claude-desktop` (the one whose data dir is Desktop's own default).
# A distinct app_id needs a separate executable: see bin/claude-desktop-rebuild.
cm_desktop_appid() {
  [[ "$(cm_desktop_dir "$1")" == "$HOME/.config/Claude" ]] && return 0
  printf 'claude-desktop-%s' "$1"
}
