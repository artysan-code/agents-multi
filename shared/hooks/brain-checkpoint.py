#!/usr/bin/env python3
# Stop hook: asks Claude to write "the right amount" to the brain after a real block of work.
#
# Fires only when, since the last brain write or the last time it asked, the session has edited at
# least EDITS files or made commits/pushes/deploys worth SHIPS. It then blocks the end of the turn
# once ({"decision": "block", "reason": ...} on stdout) with a short prompt: Claude writes the
# diary line, updates the page or the tasks, or writes nothing if nothing matters. It stays silent
# on chat, questions and reads, and does not fire twice in a row (stop_hook_active) nor within GAP
# minutes of the previous reminder.
#
# State (how far the transcript was already scanned, per session) lives in
# ~/.local/state/claude-multi/brain-checkpoint/.
# Robustness: always exit 0; on any error it decides nothing.
import json, os, re, sys, time

EDITS = 8
SHIPS = 3
GAP = 60  # minutes between two reminders in one session
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# a write in the brain: memory or tasks, from the connector (claude_ai_Brain), the brain server or the local tasks server
BRAIN_WRITE = re.compile(r"(brain_(append|edit|write|move|restore|inbox_clear)|tasks_(add|update|done|steps|attach))$")
SHIPPED = re.compile(r"\bgit\s+(commit|push)\b")

REASON = (
    "Before closing, the brain: {what}, and you have not written anything to the brain yet. "
    "Write the right amount, if anything: a diary line (brain_append) with a link to the project for what matters "
    "(a decision, a result, a change of state); the project page (brain_edit) if state or next steps changed; "
    "tasks_add / tasks_update / tasks_done for what stays open or is now closed. "
    "No work steps, no client data. If nothing is worth recording, write nothing. "
    "Then close as you would have, without repeating the summary."
)


def tool_uses(path):
    """(line number, tool name, input) for every tool call in the transcript."""
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, line in enumerate(f):
            if '"tool_use"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            content = (entry.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    yield n, str(c.get("name", "")), c.get("input") or {}


def work_profile():
    """A profile with brainScope in its manifest has no brain memory, on purpose: nothing to ask."""
    name = os.path.basename(os.environ.get("CLAUDE_CONFIG_DIR", "").rstrip("/"))
    manifest = os.path.expanduser(f"~/.claude-multi/shared/../profiles/{name}/profile.json")
    try:
        with open(manifest) as f:
            return bool(json.load(f).get("brainScope"))
    except (OSError, ValueError):
        return False


def main():
    if work_profile():
        return
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):
        return
    transcript, session = data.get("transcript_path"), str(data.get("session_id", ""))
    if not transcript or not os.path.isfile(transcript) or not re.fullmatch(r"[\w-]+", session):
        return
    state_dir = os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "claude-multi", "brain-checkpoint")
    state_file = os.path.join(state_dir, f"{session}.json")
    try:
        with open(state_file) as f:
            prev = json.load(f)
        since, asked = int(prev.get("line", -1)), float(prev.get("at", 0))
    except (OSError, ValueError):
        since, asked = -1, 0.0
    if time.time() - asked < GAP * 60:
        return

    edited, shipped, last = set(), 0, since
    for n, name, inp in tool_uses(transcript):
        last = max(last, n)
        if n <= since:
            continue
        if BRAIN_WRITE.search(name):
            edited, shipped = set(), 0  # the brain was written: count again from here
        elif name in EDIT_TOOLS:
            edited.add(inp.get("file_path") or inp.get("notebook_path") or "")
        elif name == "Bash" and SHIPPED.search(str(inp.get("command", ""))):
            shipped += 1
        elif name.endswith("coolify_deploy"):
            shipped += SHIPS  # a deploy is a change of state on its own

    if len(edited) < EDITS and shipped < SHIPS:
        return
    what = " and ".join(filter(None, [
        f"you edited {len(edited)} files" if len(edited) >= EDITS else "",
        "you made commits, pushes or deploys" if shipped >= SHIPS else "",
    ]))
    os.makedirs(state_dir, exist_ok=True)
    with open(state_file, "w") as f:
        json.dump({"line": last, "at": time.time()}, f)
    print(json.dumps({"decision": "block", "reason": REASON.format(what=what)}))


try:
    main()
except Exception:
    pass
sys.exit(0)
