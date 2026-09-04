#!/usr/bin/env python3
"""Sincronizza il registry MCP condiviso nei .claude.json dei profili claude-multi.

Sorgente di verita': shared/mcp/servers.json
Destinazione:       ~/.claude-multi/<profilo>/.claude.json  (chiave "mcpServers")

Il merge e' non distruttivo: tocca solo i server gestiti dal registry. I server
aggiunti a mano in un profilo restano dove sono, a meno che non siano stati
gestiti dal registry in un run precedente e poi rimossi (allora vengono puliti).

Uso:
    mcp-sync.py            applica
    mcp-sync.py --dry-run  mostra il diff senza scrivere
    mcp-sync.py --check    exit 1 se i profili sono fuori sync (per hook/CI)
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_MULTI_ROOT", Path.home() / ".claude-multi"))
REGISTRY = ROOT / "shared" / "mcp" / "servers.json"
STATE = ROOT / "shared" / "mcp" / ".sync-state.json"
META_KEY = "_profiles"


def load_registry():
    reg = json.loads(REGISTRY.read_text())
    profiles = reg.get("profiles") or []
    if not profiles:
        sys.exit(f"registry senza 'profiles': {REGISTRY}")
    servers = reg.get("servers") or {}
    out = {}
    for profile in profiles:
        out[profile] = {
            name: {k: v for k, v in cfg.items() if k != META_KEY}
            for name, cfg in servers.items()
            if profile in cfg.get(META_KEY, profiles)
        }
    return profiles, out


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {}


def desired_state(managed):
    return {p: sorted(s) for p, s in managed.items()}


def claude_running():
    """True se gira un binario Claude (CLI o Desktop) che potrebbe riscrivere .claude.json.

    Il pattern deve essere stretto: 'claude' secco matcherebbe anche questo script,
    che vive sotto ~/.claude-multi/.
    """
    pattern = r"(claude/versions/|claude-desktop|/claude-bin)"
    try:
        res = subprocess.run(
            ["pgrep", "-af", pattern], capture_output=True, text=True, check=False
        )
    except FileNotFoundError:
        return False
    mine = {str(os.getpid()), str(os.getppid())}
    for line in res.stdout.splitlines():
        pid, _, cmd = line.partition(" ")
        if pid in mine or "mcp-sync.py" in cmd:
            continue
        return True
    return False


BACKUP_DIR = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "claude-multi" / "mcp-sync-backups"
BACKUP_KEEP = 5


def backup(profile: str, conf_path: Path):
    """Copia di sicurezza di .claude.json PRIMA della scrittura.

    Fuori dalla dir del profilo: il file contiene oauthAccount e i backup lasciati li'
    sono finiti su Syncthing una volta (set 2026) e il doctor li segnala. Qui: XDG state,
    dir 700, file 600, si tengono solo gli ultimi BACKUP_KEEP per profilo.
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o700)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = BACKUP_DIR / f"{profile}.claude.json.{stamp}"
    shutil.copy2(conf_path, dest)
    os.chmod(dest, 0o600)
    old = sorted(BACKUP_DIR.glob(f"{profile}.claude.json.*"))[:-BACKUP_KEEP]
    for f in old:
        f.unlink()


def write_atomic(path: Path, data: dict):
    tmp = path.with_suffix(path.suffix + ".mcp-sync.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def sync(profile: str, wanted: dict, previously_managed: list, apply: bool):
    """Ritorna la lista delle modifiche (stringhe) per questo profilo."""
    conf_path = ROOT / profile / ".claude.json"
    if not conf_path.exists():
        return [f"  ! {conf_path} assente — profilo saltato"]

    conf = json.loads(conf_path.read_text())
    current = conf.get("mcpServers") or {}
    changes = []

    for name, cfg in wanted.items():
        if name not in current:
            changes.append(f"  + {name} (aggiunto)")
        elif current[name] != cfg:
            changes.append(f"  ~ {name} (aggiornato)")

    # server gestiti in passato, ora fuori dal registry per questo profilo
    for name in previously_managed:
        if name not in wanted and name in current:
            changes.append(f"  - {name} (rimosso: non piu' nel registry)")

    if not changes:
        return []

    if apply:
        merged = dict(current)
        for name in previously_managed:
            if name not in wanted:
                merged.pop(name, None)
        merged.update(wanted)
        conf["mcpServers"] = merged

        backup(profile, conf_path)
        write_atomic(conf_path, conf)

    return changes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="mostra il diff, non scrive")
    ap.add_argument("--check", action="store_true", help="exit 1 se fuori sync")
    ap.add_argument(
        "--force", action="store_true", help="scrive anche con Claude in esecuzione"
    )
    args = ap.parse_args()
    apply = not (args.dry_run or args.check)

    profiles, managed = load_registry()
    state = load_state()

    if apply and not args.force and claude_running():
        print(
            "! Claude Code risulta in esecuzione: puo' riscrivere .claude.json e "
            "annullare il sync.\n  Chiudi tutte le istanze (CLI e Desktop) e rilancia.",
            file=sys.stderr,
        )
        return 2

    total = 0
    for profile in profiles:
        changes = sync(profile, managed[profile], state.get(profile, []), apply)
        if changes:
            total += len(changes)
            print(f"{profile}:")
            print("\n".join(changes))

    if args.check:
        if total:
            print(f"\nfuori sync: {total} modifiche pendenti — lancia mcp-sync.py")
            return 1
        print("in sync")
        return 0

    if apply:
        # Va scritto anche a zero modifiche: registra l'adozione dei server che
        # gia' esistevano nei profili, senza la quale una futura restrizione via
        # _profiles non saprebbe da dove rimuoverli.
        STATE.write_text(json.dumps(desired_state(managed), indent=2) + "\n")

    if not total:
        print("gia' in sync, nulla da fare")
        return 0

    if apply:
        print(f"\n{total} modifiche applicate su {len(profiles)} profili.")
        print("Riavvia le istanze Claude per caricare i server aggiornati.")
    else:
        print(f"\n{total} modifiche pendenti (dry-run, nulla scritto).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
