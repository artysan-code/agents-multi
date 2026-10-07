#!/usr/bin/env bash
# ui.sh — how claude-update speaks: one row per component (an icon, its name, its version, what
# happened) and, under it, dimmed, only the details worth knowing. Colours only on a terminal and
# never with NO_COLOR. The language is the machine's, as the console picks it (uiLanguage() in
# apps/cli/lib.ts: LC_ALL, LC_MESSAGES, LC_TIME, LANG): Italian or English. apps/cli/selfupdate.ts prints its
# row in the same shape, so the three line up.

cm_ui_lang() {
  local v code
  for v in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LC_TIME:-}" "${LANG:-}"; do
    code="${v:0:2}"; code="${code,,}"
    [[ "$code" == it || "$code" == en ]] && [[ "${v:2:1}" =~ ^[_.@-]?$ ]] && { echo "$code"; return; }
  done
  echo en
}
CM_LANG="${CM_LANG:-$(cm_ui_lang)}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_OK=$'\e[32m' C_WARN=$'\e[33m' C_BAD=$'\e[31m' C_DIM=$'\e[2m' C_B=$'\e[1m' C_X=$'\e[0m' CM_TTY=1
else
  C_OK="" C_WARN="" C_BAD="" C_DIM="" C_B="" C_X="" CM_TTY=""
fi

# cm_t <key> [args…] → the sentence in this machine's language (printf-style %s)
cm_t() {
  local k="$1"; shift
  local it en
  case "$k" in
    title)        it="Aggiornamento di Claude Code, Claude Desktop e agents-multi"; en="Updating Claude Code, Claude Desktop and agents-multi" ;;
    checking)     it="controllo…"; en="checking…" ;;
    latest)       it="già all'ultima versione"; en="already the latest" ;;
    updated)      it="aggiornata dalla %s"; en="updated from %s" ;;
    available)    it="c'è la %s"; en="%s is out" ;;
    keep)         it="la %s resta per tornare indietro (agents update --rollback)"; en="%s is kept to roll back to (agents update --rollback)" ;;
    pruned)       it="tolte le versioni vecchie: %s"; en="old versions removed: %s" ;;
    wrapper)      it="il comando claude passa di nuovo da agents-multi"; en="the claude command goes through agents-multi again" ;;
    handler)      it="i link claude-cli:// aprono di nuovo claude-bin"; en="claude-cli:// links open claude-bin again" ;;
    failed)       it="aggiornamento non riuscito"; en="update failed" ;;
    desk_wait)    it="la %s è pronta: entra in uso quando chiudi Claude Desktop"; en="%s is ready: it switches once Claude Desktop is closed" ;;
    desk_verify)  it="la firma non torna: non è stato installato niente"; en="the signature does not check out: nothing was installed" ;;
    busy)         it="c'è già un aggiornamento in corso"; en="another update is already running" ;;
    rolled)       it="tornata alla %s"; en="back to %s" ;;
    forward)      it="la %s resta: agents update --cli per tornare avanti"; en="%s stays: agents update --cli to go forward again" ;;
    end_ok)       it="Tutto aggiornato."; en="Everything is up to date." ;;
    end_fail)     it="Qualcosa non è andato: i dettagli sono sopra."; en="Something went wrong: the details are above." ;;
    end_avail)    it="C'è qualcosa da aggiornare: agents update"; en="Something can be updated: agents update" ;;
    *)            it="$k"; en="$k" ;;
  esac
  # shellcheck disable=SC2059
  if [[ "$CM_LANG" == it ]]; then printf "$it" "$@"; else printf "$en" "$@"; fi
}

# cm_working <name> — a placeholder row while a component is checked (a terminal only: it is
# replaced by the real row)
cm_working() {
  [[ -n "$CM_TTY" ]] || return 0
  printf "  %s· %-15s %s%s" "$C_DIM" "$1" "$(cm_t checking)" "$C_X"
}

# cm_row <ok|new|wait|fail> <name> <version> <text>
cm_row() {
  local icon col
  case "$1" in
    ok)   icon="✓"; col="$C_OK" ;;
    new)  icon="↑"; col="$C_OK" ;;
    wait) icon="!"; col="$C_WARN" ;;
    *)    icon="✗"; col="$C_BAD" ;;
  esac
  [[ -n "$CM_TTY" ]] && printf "\r\e[K"
  printf "  %s%s%s %s%-15s%s %-10s %s\n" "$col" "$icon" "$C_X" "$C_B" "$2" "$C_X" "${3:-—}" "$4"
}

# cm_note <text> — a detail under the row above, dimmed and aligned with its text
cm_note() { printf "%31s%s%s%s\n" "" "$C_DIM" "$1" "$C_X"; }
