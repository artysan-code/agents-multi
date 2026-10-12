#!/usr/bin/env bash
# Claude Code status line: reads the session JSON on stdin and prints one ANSI-coloured line.
# Segments: folder │ branch+state @hash │ model │ ctx bar % tokens │ 5h limit │ cost │ cfg (repo agents-multi) │ ⬆ update
# It also keeps a snapshot of the session for the console's «Claude now» (apps/cli/live.ts): the context
# and the account's rate limits Claude Code hands it, in <state>/agents-multi/live/<session>.json.
#
# It runs at every refresh of the prompt: one jq for the payload, two git calls, bash for the rest
# (it took about 200 ms with a jq per field, five git calls and pacman -Q; now a few tens).

input=$(cat)
profile=$(basename "${CLAUDE_CONFIG_DIR:-personal}")

# One jq: the snapshot on the first line, the fields on the second, separated by US (an IFS that is not
# whitespace keeps empty fields)
{
  IFS= read -r snapshot
  IFS=$'\x1f' read -r sid cwd model used_pct used_tok tot_tok cost five
} < <(printf '%s' "$input" | jq -r --arg p "$profile" '
  ({
    at: now | floor, profile: $p, session: .session_id,
    cwd: (.workspace.current_dir // .cwd), model: .model.display_name,
    context: { used: .context_window.used_percentage, size: .context_window.context_window_size,
               tokens: .context_window.total_input_tokens },
    limits: (.rate_limits // null | if . == null then null else {
      five_hour: (.five_hour // null | if . == null then null else { used: .used_percentage, resets: .resets_at } end),
      seven_day: (.seven_day // null | if . == null then null else { used: .used_percentage, resets: .resets_at } end)
    } | with_entries(select(.value != null)) end),
    cost: .cost.total_cost_usd, source: "statusline"
  } | with_entries(select(.value != null)) | tojson),
  ([.session_id, (.workspace.current_dir // .cwd), .model.display_name, .context_window.used_percentage,
    .context_window.used_tokens, .context_window.total_tokens, .cost.total_cost_usd,
    .rate_limits.five_hour.used_percentage] | map(if . == null then "" else tostring end) | join("\u001f"))
' 2>/dev/null)

# --- the snapshot: written beside and renamed over, never half a file; nothing printed ---
live_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agents-multi/live"
if [ -n "$sid" ] && [[ "$sid" =~ ^[A-Za-z0-9-]+$ ]] && mkdir -p "$live_dir" 2>/dev/null; then
  printf '%s\n' "$snapshot" >"$live_dir/.$sid.tmp" 2>/dev/null && mv -f "$live_dir/.$sid.tmp" "$live_dir/$sid.json"
fi

# ANSI, as real escape characters: the line is printed with %s, so a % or a \ in a folder or a branch
# name is printed as it is
RESET=$'\033[0m' BOLD=$'\033[1m' DIM=$'\033[2m'
CYAN=$'\033[36m' YELLOW=$'\033[33m' MAGENTA=$'\033[35m'
GREEN=$'\033[32m' RED=$'\033[31m' GREY=$'\033[90m'

SEP=" ${GREY}│${RESET} "

# --- folder: basename only ---
folder_part="${BOLD}${YELLOW}${cwd##*/}${RESET}"

# --- git: branch ↑N↓M +X -Y (status --porcelain=v2 --branch: branch, commit and upstream in one call) ---
git_part=""
if [ -n "$cwd" ] && status=$(git -C "$cwd" status --porcelain=v2 --branch --untracked-files=no 2>/dev/null); then
  branch="" hash="" ahead=0 behind=0
  while IFS= read -r line; do
    case "$line" in
      "# branch.oid "*) hash=${line#\# branch.oid } ;;
      "# branch.head "*) branch=${line#\# branch.head } ;;
      "# branch.ab "*)
        read -r _ _ a b <<<"$line"
        ahead=${a#+} behind=${b#-}
        ;;
      "# "*) ;;
      *) break ;;
    esac
  done <<<"$status"
  [ "$branch" = "(detached)" ] && branch=""
  [ "$hash" = "(initial)" ] && hash=""

  ahead_behind=""
  [ "$ahead" -gt 0 ] 2>/dev/null && ahead_behind="${ahead_behind} ${CYAN}↑${ahead}${RESET}"
  [ "$behind" -gt 0 ] 2>/dev/null && ahead_behind="${ahead_behind} ${CYAN}↓${behind}${RESET}"

  # Uncommitted diff: staged + unstaged tracked changes vs HEAD
  shortstat=$(git -C "$cwd" diff --shortstat HEAD 2>/dev/null)
  ins=0 del=0
  [[ $shortstat =~ ([0-9]+)\ insertion ]] && ins=${BASH_REMATCH[1]}
  [[ $shortstat =~ ([0-9]+)\ deletion ]] && del=${BASH_REMATCH[1]}
  ins_color=$GREEN; [ "$ins" -eq 0 ] && ins_color=$DIM
  del_color=$RED;   [ "$del" -eq 0 ] && del_color=$DIM
  diff_part=" ${ins_color}+${ins}${RESET} ${del_color}-${del}${RESET}"

  if [ -n "$branch" ]; then
    git_part="${SEP}${GREEN}${branch}${RESET}${ahead_behind}${diff_part}"
  elif [ -n "$hash" ]; then
    git_part="${SEP}${DIM}@${hash:0:7}${RESET}${diff_part}"
  fi
fi

# --- model: strip leading "Claude " ---
model_part=""
[ -n "$model" ] && model_part="${SEP}${MAGENTA}${model#Claude }${RESET}"

# k for thousands: 634123 → 634.1k (decimals 1) or 634k (decimals 0); under a thousand, the number
kilo() { # <tokens> <decimals>
  if [ "$1" -ge 1000 ] 2>/dev/null; then LC_NUMERIC=C printf "%.${2}fk" "${1}e-3"; else printf '%s' "$1"; fi
}

# --- context: bar + % + tokens ---
ctx_part=""
if [ -n "$used_pct" ]; then
  pct_int=$(LC_NUMERIC=C printf "%.0f" "$used_pct")
  if [ "$pct_int" -ge 80 ]; then
    ctx_color="$RED"
  elif [ "$pct_int" -ge 50 ]; then
    ctx_color="$YELLOW"
  else
    ctx_color="$GREEN"
  fi

  bar_width=10
  filled=$(( (pct_int * bar_width + 50) / 100 ))
  [ $filled -gt $bar_width ] && filled=$bar_width
  [ $filled -lt 0 ] && filled=0
  empty=$(( bar_width - filled ))

  bar=""
  for ((i=0; i<filled; i++)); do bar="${bar}█"; done
  bar_empty=""
  for ((i=0; i<empty;  i++)); do bar_empty="${bar_empty}░"; done

  tok_str=""
  if [ -n "$used_tok" ] && [ -n "$tot_tok" ]; then
    tok_str=" ${DIM}$(kilo "$used_tok" 1)/$(kilo "$tot_tok" 0)${RESET}"
  fi

  ctx_part="${SEP}${ctx_color}[${bar}${RESET}${GREY}${bar_empty}${ctx_color}]${RESET} ${ctx_color}${pct_int}%${RESET}${tok_str}"
fi

# --- the account's five-hour limit, when Claude Code gives it ---
limit_part=""
if [ -n "$five" ]; then
  five_int=$(LC_NUMERIC=C printf "%.0f" "$five")
  five_color="$DIM"
  [ "$five_int" -ge 50 ] && five_color="$YELLOW"
  [ "$five_int" -ge 80 ] && five_color="$RED"
  limit_part="${SEP}${five_color}5h ${five_int}%${RESET}"
fi

# --- cost ---
cost_part=""
if [ -n "$cost" ] && ! [[ $cost =~ ^[0.]*$ ]]; then
  cost_part="${SEP}${DIM}${CYAN}\$$(LC_NUMERIC=C printf '%.2f' "$cost")${RESET}"
fi

# --- agents-multi: config repo state + available updates ---
# Reads only local caches written by prelaunch.sh and claude-update --check: no network.
cm_part=""
cm_sync="${XDG_CACHE_HOME:-$HOME/.cache}/agents-multi/sync.json"
if [ -f "$cm_sync" ]; then
  IFS=$'\x1f' read -r cm_behind cm_ahead cm_dirty cm_fetch cm_up < <(
    jq -r '[.behind,.ahead,.dirty,.fetch_ok,.upstream] | map(if . == null then "" else tostring end) | join("\u001f")' "$cm_sync" 2>/dev/null
  )
  cm_str=""
  if [ "$cm_up" = "false" ]; then
    cm_str="${RED}cfg no-remote${RESET}"
  elif [ "${cm_behind:-0}" -gt 0 ] && [ "${cm_ahead:-0}" -gt 0 ]; then
    cm_str="${RED}cfg ≠${RESET}"
  else
    [ "${cm_behind:-0}" -gt 0 ] && cm_str="${YELLOW}cfg ↓${cm_behind}${RESET}"
    [ "${cm_ahead:-0}" -gt 0 ]  && cm_str="${cm_str}${cm_str:+ }${CYAN}cfg ↑${cm_ahead}${RESET}"
    [ "${cm_dirty:-0}" -gt 0 ]  && cm_str="${cm_str}${cm_str:+ }${YELLOW}cfg ✎${cm_dirty}${RESET}"
  fi
  [ "$cm_fetch" = "false" ] && cm_str="${cm_str}${cm_str:+ }${DIM}cfg offline${RESET}"
  [ -n "$cm_str" ] && cm_part="${SEP}${cm_str}"
fi
cm_upd="$HOME/.cache/claude-update/check.json"
if [ -f "$cm_upd" ]; then
  IFS=$'\x1f' read -r u_cli u_cli_v u_desk u_desk_v < <(
    jq -r '[(.cli.outdated|tostring),.cli.latest,(.desktop.outdated|tostring),.desktop.latest] | map(if . == null then "" else tostring end) | join("\u001f")' "$cm_upd" 2>/dev/null
  )
  # the cache goes stale after an update: it only counts if the remote version differs from the one installed NOW
  cur_cli=$(readlink -f "$HOME/.local/bin/claude-bin" 2>/dev/null)
  cur_cli=${cur_cli##*/}
  # the installed Desktop from pacman's own database (claude-desktop-<version>-<release>), not pacman -Q (100 ms)
  cur_desk=""
  for d in /var/lib/pacman/local/claude-desktop-[0-9]*; do
    [ -d "$d" ] || continue
    cur_desk=${d#/var/lib/pacman/local/claude-desktop-}
    cur_desk=${cur_desk%%-*}
  done
  [ -n "$cur_cli" ] && [ "$u_cli_v" = "$cur_cli" ] && u_cli=false
  [ -n "$cur_desk" ] && [ "$u_desk_v" = "$cur_desk" ] && u_desk=false
  u_str=""
  [ "$u_cli" = "true" ]  && u_str="${YELLOW}⬆ code ${u_cli_v}${RESET}"
  [ "$u_desk" = "true" ] && u_str="${u_str}${u_str:+ }${YELLOW}⬆ desktop ${u_desk_v}${RESET}"
  [ -n "$u_str" ] && cm_part="${cm_part}${SEP}${u_str}"
fi

printf '%s' "${folder_part}${git_part}${model_part}${ctx_part}${limit_part}${cost_part}${cm_part}"
