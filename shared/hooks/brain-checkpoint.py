#!/usr/bin/env python3
# Stop hook: chiede a Claude di scrivere "il giusto" nel brain dopo un blocco di lavoro vero.
#
# Scatta solo quando, dall'ultima scrittura nel brain o dall'ultima volta che ha chiesto, la
# sessione ha modificato almeno EDITS file oppure ha fatto un commit, un push o un deploy. Allora
# ferma la chiusura del turno una volta, con una domanda breve: Claude scrive la riga di diario,
# aggiorna la pagina o le task, oppure non scrive niente se non c'è niente che conti. Su
# chiacchiere, domande e letture non dice niente; non scatta due volte di fila (stop_hook_active).
#
# Lo stato (fin dove ha già guardato, per sessione) è in ~/.local/state/claude-multi/brain-checkpoint/.
# Robustezza: exit 0 SEMPRE; su qualunque errore non decide niente.
import json, os, re, sys, time

EDITS = 8
SHIPS = 3
GAP = 60  # minutes between two reminders in one session
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# a write in the brain: memory or tasks, from the connector (claude_ai_Brain), the brain server or the local tasks server
BRAIN_WRITE = re.compile(r"(brain_(append|edit|write|move|restore|inbox_clear)|tasks_(add|update|done|steps|attach))$")
SHIPPED = re.compile(r"\bgit\s+(commit|push)\b")

REASON = (
    "Prima di chiudere, il brain: {what}, e nel brain non hai ancora scritto niente. "
    "Scrivi il giusto, se c'è: una riga di diario (brain_append) con il link al progetto per ciò che conta "
    "(una decisione, un risultato, un cambio di stato); la pagina del progetto (brain_edit) se sono cambiati "
    "stato o prossimi passi; tasks_add / tasks_update / tasks_done per ciò che resta aperto o è chiuso. "
    "Niente passi di lavoro, niente dati dei clienti. Se non c'è niente che valga, non scrivere niente. "
    "Poi chiudi come avresti fatto, senza ripetere il riepilogo."
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
    what = " e ".join(filter(None, [
        f"hai modificato {len(edited)} file" if len(edited) >= EDITS else "",
        "hai fatto commit, push o deploy" if shipped >= SHIPS else "",
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
