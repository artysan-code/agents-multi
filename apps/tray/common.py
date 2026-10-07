"""common.py — what every module of the app shares: who the app is, and where things live."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

# The app's identity in one place: desktop file, window class, socket and data directory all
# derive from it, so renaming it is a change here (plus the .desktop file's name). It stays the old
# name until the internal rename, which moves those files with a migration; TITLE is what people see.
NAME = "claude-multi"
TITLE = "Agents Multi"

HOME = Path.home()
BIN = HOME / ".local" / "bin"
PORT = int(os.environ.get("AGENTS_MULTI_PORT") or os.environ.get("CLAUDE_MULTI_PORT", "7331"))
CONSOLE_URL = f"http://127.0.0.1:{PORT}"


def owner() -> dict:
    """Whose setup this is (shared/mcp/lib/owner.ts reads the same file): name and language for the prompts."""
    o = {"name": "the user", "language": "English"}
    path = config_dir() / "owner.json"
    try:
        data = json.loads(path.read_text())
        o.update({k: v.strip() for k, v in data.items() if k in o and isinstance(v, str) and v.strip()})
    except (OSError, ValueError):
        pass
    return o
CONSOLE_UNIT = f"{NAME}-console.service"
APP_UNIT = f"{NAME}-app.service"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local" / "share")) / NAME / "app"
STATE_FILE = Path(os.environ.get("XDG_STATE_HOME", HOME / ".local" / "state")) / NAME / "app.json"
SOCKET = f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/{NAME}-app.sock"


def repo() -> Path:
    """The checkout this module lives in: apps/tray/common.py → the repository root."""
    return Path(__file__).resolve().parent.parent.parent


def config_dir() -> Path:
    """The person's configuration: ~/.claude-multi/config, a link to their own folder."""
    return Path(os.environ.get("AGENTS_MULTI_CONFIG") or os.environ.get("CLAUDE_MULTI_CONFIG") or Path.home() / ".claude-multi" / "config")


def manifests() -> dict[str, dict]:
    """profile name → its profile.json, for every profile the configuration declares."""
    out: dict[str, dict] = {}
    for m in sorted((config_dir() / "profiles").glob("*/profile.json")):
        try:
            out[m.parent.name] = json.loads(m.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return out


def default_profile() -> str:
    """The profile whose launcher is plain `claude` (the machine default), else the first one."""
    ms = manifests()
    return next((p for p, m in ms.items() if m.get("command") == "claude"), next(iter(ms), ""))


def write_state(**fields) -> None:
    """What the app observed about this session, for the doctor (e.g. whether a tray exists)."""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({**fields, "at": int(time.time())}) + "\n")
    except OSError:
        pass
