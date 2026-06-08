#!/usr/bin/env bash
# Claude Code status line
# Segments: folder │ branch+state @hash │ model │ ctx bar % tokens │ cost

input=$(cat)

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
  pct_int=$(printf "%.0f" "$used_pct")
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

# --- cost ---
cost_part=""
if [ -n "$cost" ]; then
  is_zero=$(awk -v c="$cost" 'BEGIN{ print (c+0 == 0) ? 1 : 0 }')
  if [ "$is_zero" = "0" ]; then
    cost_str=$(awk -v c="$cost" 'BEGIN{ printf "$%.2f", c }')
    cost_part="${SEP}${DIM}${CYAN}${cost_str}${RESET}"
  fi
fi

printf "${folder_part}${git_part}${model_part}${ctx_part}${cost_part}"
