#!/usr/bin/env bash
# Claude Code status line: reads the session JSON on stdin and prints two ANSI-coloured lines.
# Line 1: folder │ branch+state @hash │ the folder's tasks (open, doing, waiting, overdue, P1)
# Line 2: profile │ model │ ctx bar % tokens │ 5h and 7d limits │ cost │ cfg (repo agents-multi) │ ⬆ update
# The tasks come from the brain through a cache that `agents tasks statusline-cache` rewrites in the
# background when it is a minute old: this script never waits for the network.
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
  IFS=$'\x1f' read -r sid cwd model used_pct used_tok tot_tok cost five five_reset seven seven_reset
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
    .rate_limits.five_hour.used_percentage, .rate_limits.five_hour.resets_at,
    .rate_limits.seven_day.used_percentage, .rate_limits.seven_day.resets_at] | map(if . == null then "" else tostring end) | join("\u001f"))
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

TEAL=$'\033[38;5;73m' AMBER=$'\033[38;5;179m' ROSE=$'\033[38;5;174m' LILAC=$'\033[38;5;140m'

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

# --- the account's limits, when Claude Code gives them: 5h and 7d, each with the time it resets ---
limit_part=""
limit() { # <label> <used %> <reset epoch> <with weekday>
  [ -n "$2" ] || return 0
  local n color=$DIM when=""
  n=$(LC_NUMERIC=C printf "%.0f" "$2")
  [ "$n" -ge 50 ] && color=$YELLOW
  [ "$n" -ge 80 ] && color=$RED
  if [[ $3 =~ ^[0-9]+$ ]]; then
    when=" ${DIM}↻ $(date -d "@$3" "+${4:+%a }%H:%M" 2>/dev/null)${RESET}"
  fi
  limit_part="${limit_part}${limit_part:+ }${DIM}$1${RESET} ${color}${n}%${RESET}${when}"
}
limit 5h "$five" "$five_reset" ""
limit 7d "$seven" "$seven_reset" 1
[ -n "$limit_part" ] && limit_part="${SEP}${limit_part}"

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

# --- tasks: the open ones of this folder, from the brain's cache (kept per profile) ---
# A task belongs to a folder under ~ (its `project`): it shows here when its folder contains this one
# or is inside it, so a repo sees its own tasks and its client's, and a parent folder sees all below.
tasks_part=""
rel=${cwd#"$HOME"/}
if [ -n "$cwd" ] && [ "$rel" != "$cwd" ] && [ -n "$rel" ]; then
  tl="${XDG_CACHE_HOME:-$HOME/.cache}/agents-multi/tasks-line-${profile}.json"
  now=$(printf '%(%s)T' -1)
  IFS=$'\x1f' read -r tl_at tl_n tl_doing tl_wait tl_late tl_p1 < <(
    jq -r --arg rel "$rel" --arg today "$(printf '%(%F)T' -1)" '
      def near: . as $p | ($p == $rel or ($p | startswith($rel + "/")) or ($rel | startswith($p + "/")));
      [.tasks[]? | select(.p != null and (.p | near))] as $t
      | [ (.at // 0), ($t | length),
          ([$t[] | select(.s == "doing")] | length),
          ([$t[] | select(.s == "waiting")] | length),
          ([$t[] | select(.d != null and .d < $today and .s != "waiting")] | length),
          ([$t[] | select(.pr == 1 and .s != "waiting") | .r | sub("^TASK-"; "")] | join(" ")) ]
      | map(tostring) | join("\u001f")' "$tl" 2>/dev/null
  )
  tl_at=${tl_at:-0}
  # older than a minute (or never made): ask for a new one without waiting for it, at most once a minute
  if [ $((now - tl_at)) -gt 60 ] && [ -z "$(find "$tl.try" -mmin -1 2>/dev/null)" ]; then
    am=$(command -v agents || echo "$HOME/.local/bin/agents")
    if [ -x "$am" ] && mkdir -p "${tl%/*}" 2>/dev/null; then
      : >"$tl.try"
      (setsid "$am" tasks statusline-cache >/dev/null 2>&1 &)
    fi
  fi
  if [ "${tl_n:-0}" -gt 0 ]; then
    case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
      it*) l_open="da fare" l_doing="in corso" l_wait="aspettano" l_late="in ritardo" l_old="datate" ;;
      *) l_open="todo" l_doing="doing" l_wait="waiting" l_late="overdue" l_old="stale" ;;
    esac
    tl_todo=$((tl_n - tl_doing - tl_wait))
    tparts=("${DIM}${tl_n} task${RESET}")
    [ "$tl_todo" -gt 0 ] && tparts+=("${TEAL}${tl_todo} ${l_open}${RESET}")
    [ "$tl_doing" -gt 0 ] && tparts+=("${AMBER}${tl_doing} ${l_doing}${RESET}")
    [ "$tl_wait" -gt 0 ] && tparts+=("${LILAC}${tl_wait} ${l_wait}${RESET}")
    [ "$tl_late" -gt 0 ] && tparts+=("${ROSE}${tl_late} ${l_late}${RESET}")
    [ -n "$tl_p1" ] && tparts+=("${DIM}P1 ${RESET}${ROSE}${tl_p1}${RESET}")
    # the cache is a minute old at most while the brain answers: much older means it does not
    [ $((now - tl_at)) -gt 1800 ] && tparts+=("${DIM}${l_old}${RESET}")
    tasks_part=$SEP
    for i in "${!tparts[@]}"; do
      [ "$i" -gt 0 ] && tasks_part="${tasks_part} ${GREY}·${RESET} "
      tasks_part="${tasks_part}${tparts[$i]}"
    done
  fi
fi

# --- two lines with an empty one between: braille blank (U+2800), because Claude Code drops lines of
# nothing or of spaces; each line is indented one space ---
profile_part="${LILAC}${profile}${RESET}"
line1="${folder_part}${git_part}${tasks_part}"
line2="${profile_part}${model_part}${ctx_part}${limit_part}${cost_part}${cm_part}"
BLANK=$'\u2800'
printf ' %s\n%s\n %s\n%s' "$line1" "$BLANK" "$line2" "$BLANK"
