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
# State, per session, in ~/.local/state/agents-multi/brain-checkpoint/: the byte offset the transcript
# was scanned to and what was counted so far, so each Stop reads only the lines added since the last
# one (it read the whole transcript every time, which grew with the session).
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


def tool_uses(path, offset):
    """(tool name, input) for every tool call in the transcript after `offset`, and the offset of the
    end of the last complete line (a line still being written is read next time)."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1
    calls = []
    for raw in data[:end].split(b"\n"):
        if b'"tool_use"' not in raw:
            continue
        try:
            entry = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            continue
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for c in content:
            if isinstance(c, dict) and c.get("type") == "tool_use":
                calls.append((str(c.get("name", "")), c.get("input") or {}))
    return calls, offset + end


def work_profile():
    """A profile with brainScope in its manifest has no brain memory, on purpose: nothing to ask."""
    # the config dir is <runtime>/<profile>, and the person's profiles are in <runtime>/config/profiles
    cfg = os.environ.get("CLAUDE_CONFIG_DIR", "").rstrip("/")
    runtime, name = os.path.dirname(cfg), os.path.basename(cfg)
    manifest = os.path.join(runtime, "config", "profiles", name, "profile.json")
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
    state_dir = os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "agents-multi", "brain-checkpoint")
    state_file = os.path.join(state_dir, f"{session}.json")
    try:
        with open(state_file) as f:
            prev = json.load(f)
        offset, asked = int(prev.get("offset", 0)), float(prev.get("at", 0))
        edited, shipped = set(prev.get("edited", [])), int(prev.get("shipped", 0))
    except (OSError, ValueError, TypeError):
        offset, asked, edited, shipped = 0, 0.0, set(), 0
    if offset > os.path.getsize(transcript):
        offset, edited, shipped = 0, set(), 0  # a transcript rewritten from the start

    calls, offset = tool_uses(transcript, offset)
    for name, inp in calls:
        if BRAIN_WRITE.search(name):
            edited, shipped = set(), 0  # the brain was written: count again from here
        elif name in EDIT_TOOLS:
            edited.add(inp.get("file_path") or inp.get("notebook_path") or "")
        elif name == "Bash" and SHIPPED.search(str(inp.get("command", ""))):
            shipped += 1
        elif name.endswith("coolify_deploy"):
            shipped += SHIPS  # a deploy is a change of state on its own

    remind = (len(edited) >= EDITS or shipped >= SHIPS) and time.time() - asked >= GAP * 60
    what = " and ".join(filter(None, [
        f"you edited {len(edited)} files" if len(edited) >= EDITS else "",
        "you made commits, pushes or deploys" if shipped >= SHIPS else "",
    ]))
    if remind:
        asked, edited, shipped = time.time(), set(), 0  # asked: count again from here
    os.makedirs(state_dir, exist_ok=True)
    with open(state_file, "w") as f:
        json.dump({"offset": offset, "at": asked, "edited": sorted(edited), "shipped": shipped}, f)
    if remind:
        print(json.dumps({"decision": "block", "reason": REASON.format(what=what)}))


try:
    main()
except Exception:
    pass
sys.exit(0)
