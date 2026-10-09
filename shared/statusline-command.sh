#!/usr/bin/env bash
# Claude Code status line: reads the session JSON on stdin and prints one ANSI-coloured line.
# Segments: folder │ branch+state @hash │ model │ ctx bar % tokens │ 5h limit │ cost │ cfg (repo agents-multi) │ ⬆ update
# It also keeps a snapshot of the session for the console's «Claude now» (apps/cli/live.ts): the context
# and the account's rate limits Claude Code hands it, in <state>/agents-multi/live/<session>.json.

input=$(cat)

# --- the snapshot: written beside and renamed over, never half a file; nothing printed ---
live_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agents-multi/live"
sid=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$sid" ] && [[ "$sid" =~ ^[A-Za-z0-9-]+$ ]] && mkdir -p "$live_dir" 2>/dev/null; then
  profile=$(basename "${CLAUDE_CONFIG_DIR:-personal}")
  echo "$input" | jq -c --arg p "$profile" '{
    at: now | floor, profile: $p, session: .session_id,
    cwd: (.workspace.current_dir // .cwd), model: .model.display_name,
    context: { used: .context_window.used_percentage, size: .context_window.context_window_size,
               tokens: .context_window.total_input_tokens },
    limits: (.rate_limits // null | if . == null then null else {
      five_hour: (.five_hour // null | if . == null then null else { used: .used_percentage, resets: .resets_at } end),
      seven_day: (.seven_day // null | if . == null then null else { used: .used_percentage, resets: .resets_at } end)
    } | with_entries(select(.value != null)) end),
    cost: .cost.total_cost_usd, source: "statusline"
  } | with_entries(select(.value != null))' > "$live_dir/.$sid.tmp" 2>/dev/null \
    && mv -f "$live_dir/.$sid.tmp" "$live_dir/$sid.json"
fi

cwd=$(echo "$input"      | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input"    | jq -r '.model.display_name // ""')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
used_tok=$(echo "$input" | jq -r '.context_window.used_tokens // empty')
tot_tok=$(echo "$input"  | jq -r '.context_window.total_tokens // empty')
cost=$(echo "$input"     | jq -r '.cost.total_cost_usd // empty')

# ANSI
RESET="\033[0m"; BOLD="\033[1m"; DIM="\033[2m"
CYAN="\033[36m"; YELLOW="\033[33m"; MAGENTA="\033[35m"
GREEN="\033[32m"; RED="\033[31m"; GREY="\033[90m"

SEP=" ${GREY}│${RESET} "

# --- folder: basename only ---
folder=$(basename "$cwd")
folder_part="${BOLD}${YELLOW}${folder}${RESET}"

# --- git: branch ↑N↓M +X -Y ---
git_part=""
if [ -n "$cwd" ] && git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null)
  hash=$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null)

  ahead_behind=""
  if [ -n "$branch" ]; then
    counts=$(git -C "$cwd" rev-list --left-right --count "@{u}...HEAD" 2>/dev/null)
    if [ -n "$counts" ]; then
      behind=$(echo "$counts" | awk '{print $1}')
      ahead=$(echo "$counts"  | awk '{print $2}')
      [ "$ahead"  -gt 0 ] 2>/dev/null && ahead_behind="${ahead_behind} ${CYAN}↑${ahead}${RESET}"
      [ "$behind" -gt 0 ] 2>/dev/null && ahead_behind="${ahead_behind} ${CYAN}↓${behind}${RESET}"
    fi
  fi

  # Uncommitted diff: staged + unstaged tracked changes vs HEAD
  shortstat=$(git -C "$cwd" diff --shortstat HEAD 2>/dev/null)
  ins=$(echo "$shortstat" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+')
  del=$(echo "$shortstat" | grep -oE '[0-9]+ deletion'  | grep -oE '[0-9]+')
  [ -z "$ins" ] && ins=0
  [ -z "$del" ] && del=0
  ins_color=$GREEN; [ "$ins" -eq 0 ] && ins_color=$DIM
  del_color=$RED;   [ "$del" -eq 0 ] && del_color=$DIM
  diff_part=" ${ins_color}+${ins}${RESET} ${del_color}-${del}${RESET}"

  if [ -n "$branch" ]; then
    git_part="${SEP}${GREEN}${branch}${RESET}${ahead_behind}${diff_part}"
  elif [ -n "$hash" ]; then
    git_part="${SEP}${DIM}@${hash}${RESET}${diff_part}"
  fi
fi

# --- model: strip leading "Claude " ---
model_part=""
if [ -n "$model" ]; then
  short_model="${model#Claude }"
  model_part="${SEP}${MAGENTA}${short_model}${RESET}"
fi

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
    used_h=$(awk -v t="$used_tok" 'BEGIN{ if(t>=1000) printf "%.1fk", t/1000; else printf "%d", t }')
    tot_h=$(awk  -v t="$tot_tok"  'BEGIN{ if(t>=1000) printf "%.0fk", t/1000; else printf "%d", t }')
    tok_str=" ${DIM}${used_h}/${tot_h}${RESET}"
  fi

  ctx_part="${SEP}${ctx_color}[${bar}${RESET}${GREY}${bar_empty}${ctx_color}]${RESET} ${ctx_color}${pct_int}%%${RESET}${tok_str}"
fi

# --- the account's five-hour limit, when Claude Code gives it ---
limit_part=""
five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
if [ -n "$five" ]; then
  five_int=$(LC_NUMERIC=C printf "%.0f" "$five")
  five_color="$DIM"
  [ "$five_int" -ge 50 ] && five_color="$YELLOW"
  [ "$five_int" -ge 80 ] && five_color="$RED"
  limit_part="${SEP}${five_color}5h ${five_int}%%${RESET}"
fi

# --- cost ---
cost_part=""
if [ -n "$cost" ]; then
  is_zero=$(awk -v c="$cost" 'BEGIN{ print (c+0 == 0) ? 1 : 0 }')
  if [ "$is_zero" = "0" ]; then
    cost_str=$(awk -v c="$cost" 'BEGIN{ printf "$%.2f", c }')
    cost_part="${SEP}${DIM}${CYAN}${cost_str}${RESET}"
  fi
fi

# --- agents-multi: config repo state + available updates ---
# Reads only local caches written by prelaunch.sh and claude-update --check: no network.
cm_part=""
cm_sync="${XDG_CACHE_HOME:-$HOME/.cache}/agents-multi/sync.json"
if [ -f "$cm_sync" ]; then
  cm=$(jq -r '[.behind,.ahead,.dirty,.fetch_ok,.upstream] | @tsv' "$cm_sync" 2>/dev/null)
  cm_behind=$(echo "$cm" | cut -f1); cm_ahead=$(echo "$cm" | cut -f2); cm_dirty=$(echo "$cm" | cut -f3)
  cm_fetch=$(echo "$cm" | cut -f4); cm_up=$(echo "$cm" | cut -f5)
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
  upd=$(jq -r '[(.cli.outdated|tostring),.cli.latest,(.desktop.outdated|tostring),.desktop.latest,.cli.current,.desktop.current] | @tsv' "$cm_upd" 2>/dev/null)
  u_cli=$(echo "$upd" | cut -f1); u_cli_v=$(echo "$upd" | cut -f2)
  u_desk=$(echo "$upd" | cut -f3); u_desk_v=$(echo "$upd" | cut -f4)
  # the cache goes stale after an update: it only counts if the remote version differs from the one installed NOW
  cur_cli=$(basename "$(readlink -f "$HOME/.local/bin/claude-bin" 2>/dev/null)" 2>/dev/null)
  cur_desk=$(pacman -Q claude-desktop 2>/dev/null | awk '{print $2}' | cut -d- -f1)
  [ -n "$cur_cli" ] && [ "$u_cli_v" = "$cur_cli" ] && u_cli=false
  [ -n "$cur_desk" ] && [ "$u_desk_v" = "$cur_desk" ] && u_desk=false
  u_str=""
  [ "$u_cli" = "true" ]  && u_str="${YELLOW}⬆ code ${u_cli_v}${RESET}"
  [ "$u_desk" = "true" ] && u_str="${u_str}${u_str:+ }${YELLOW}⬆ desktop ${u_desk_v}${RESET}"
  [ -n "$u_str" ] && cm_part="${cm_part}${SEP}${u_str}"
fi

printf "${folder_part}${git_part}${model_part}${ctx_part}${limit_part}${cost_part}${cm_part}"
