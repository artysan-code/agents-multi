"""gate.py — il gate di aggiornamento di Claude, con approvazione esplicita.

Una finestra dell'app (app.py), aperta per due strade:

  app.py --gate --profile <nome>  dal launcher `claude-launch`, prima di aprire l'app: si aggiorna
                                  ciò che spunti, poi il launcher apre Claude. Processo a sé,
                                  bloccante, con i codici di uscita sotto
  app.py --updates / il tray      ad app già in uso (standalone): non apre nulla a fine corsa, e
                                  se Claude è in esecuzione offre di chiuderlo prima

Niente si aggiorna senza che tu lo abbia spuntato: le due voci (Claude Desktop e Claude Code)
sono indipendenti e puoi aggiornarne una sola, o nessuna.

La GUI è una VISTA della CLI: lo stato del setup (versioni, doctor, istanze) arriva da
`claude-multi status --json` in un thread dopo che la finestra è comparsa, le azioni passano da
`claude-multi update`. Qui non c'è logica di setup, solo presentazione.
In standalone senza aggiornamenti la finestra si apre lo stesso come pannello di stato.

Fasi eseguite, in base alla selezione:
  Desktop → claude-desktop-update --no-install  (repack del .deb ufficiale, nessun privilegio)
          → pkexec pacman -U <pkg>              (dialogo polkit di Plasma per la password)
          → claude-desktop-rebuild <profilo>    (riapplica il patch app_id a una variante)
  Code    → claude-update --cli                 (userspace: nessuna password)

Perché Desktop va aggiornato ad app chiusa: l'install sostituisce /usr/lib/claude-desktop e il
rebuild ricopia il binario — con l'app aperta si crasha al primo lazy-load di risorse.

Exit code di --gate (contratto con claude-launch):
    0   aggiornamento eseguito   → lancia l'app
    10  "avvia com'è"            → lancia l'app senza aggiornare
    20  "salta queste versioni"  → lancia l'app, e non richiedere più per quelle versioni
    1   errore inatteso          → il launcher lancia comunque l'app
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Qt, QProcess, QThread, QTimer, Signal
from PySide6.QtGui import QFont, QIcon, QPalette
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDialog, QFrame, QHBoxLayout, QLabel,
    QPlainTextEdit, QProgressBar, QPushButton, QScrollArea, QSizePolicy, QVBoxLayout, QWidget,
)

from common import BIN, repo as _repo

EXIT_UPDATED, EXIT_LAUNCH_ASIS, EXIT_SKIP_VERSION, EXIT_ERROR = 0, 10, 20, 1

ACCENT = "#D97757"          # arancione Anthropic, usato per il pulsante primario
ACCENT_HOVER = "#C86647"
DANGER = "#d64545"
SKIP_FILE = Path.home() / ".config" / "claude-update" / "skipped"

def desktop_variants() -> list[tuple[str, str]]:
    """(profile, app_id) for every profile that has its own Desktop build — the ones whose
    user-data-dir is not Desktop's own ~/.config/Claude. Mirrors cm_desktop_appid in bash."""
    out: list[tuple[str, str]] = []
    default_dir = str(Path.home() / ".config" / "Claude")
    for manifest in sorted((_repo() / "profiles").glob("*/profile.json")):
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = manifest.parent.name
        raw = str(data.get("desktopDir") or "")
        if raw.startswith("~/"):
            raw = str(Path.home() / raw[2:])
        if not raw:
            suffixed = Path.home() / ".config" / f"Claude-{name.capitalize()}"
            raw = str(suffixed) if suffixed.is_dir() else default_dir
        if raw != default_dir:
            out.append((name, f"claude-desktop-{name}"))
    return out


# Pattern dei binari Claude Desktop: quello di sistema più una variante per profilo.
# Volutamente path completi: un pkill su "claude" colpirebbe anche le sessioni Claude Code.
DESKTOP_PROCS = (
    "/usr/lib/claude-desktop/claude-desktop",
    *(f"{Path.home()}/.local/lib/{appid}/{appid}" for _, appid in desktop_variants()),
)


# --------------------------------------------------------------------------- helpers
def is_dark(app: QApplication) -> bool:
    return app.palette().color(QPalette.ColorRole.Window).lightness() < 128


def remember_skip(entries: list[tuple[str, str]]) -> None:
    SKIP_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing = SKIP_FILE.read_text().splitlines() if SKIP_FILE.exists() else []
    for component, version in entries:
        line = f"{component} {version}"
        if version and line not in existing:
            existing.append(line)
    SKIP_FILE.write_text("\n".join(existing).strip() + "\n")


def skipped_versions() -> set[str]:
    """Righe "<componente> <versione>" già messe da parte: quelle non si ripropongono più."""
    if not SKIP_FILE.exists():
        return set()
    return {line.strip() for line in SKIP_FILE.read_text().splitlines() if line.strip()}


def drop_skipped(state: dict) -> dict:
    """Azzera l'`outdated` dei componenti la cui versione è già stata saltata dall'utente.

    Sta qui e non nel launcher perché il gate viene aperto da due strade (avvio dell'app e
    notifica del timer): un solo posto che decide, nessuna divergenza fra le due.
    """
    skip = skipped_versions()
    for comp in ("desktop", "cli"):
        info = state.get(comp, {})
        if info.get("outdated") and f"{comp} {info.get('latest', '')}" in skip:
            info["outdated"] = False
    return state


def running_desktop_pids() -> list[int]:
    """PID delle istanze Claude Desktop attive (solo i processi main, non gli helper zygote)."""
    pids: list[int] = []
    for pattern in DESKTOP_PROCS:
        out = subprocess.run(["pgrep", "-f", f"^{pattern}$"], capture_output=True, text=True).stdout
        pids += [int(p) for p in out.split()]
    return pids


class Card(QFrame):
    """Riga selezionabile 'componente: da → a'. La checkbox È il consenso all'aggiornamento."""

    def __init__(self, name: str, current: str, latest: str, note: str = ""):
        super().__init__()
        self.setObjectName("card")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(12, 10, 14, 10)
        lay.setSpacing(10)

        self.check = QCheckBox()
        self.check.setChecked(True)
        lay.addWidget(self.check, 0, Qt.AlignmentFlag.AlignVCenter)

        col = QVBoxLayout()
        col.setSpacing(2)
        title = QLabel(name)
        f = title.font()
        f.setBold(True)
        title.setFont(f)
        col.addWidget(title)

        sub = QLabel(f"{current}  →  {latest}")
        sub.setObjectName("muted")
        col.addWidget(sub)

        if note:
            n = QLabel(note)
            n.setObjectName("muted")
            n.setWordWrap(True)
            col.addWidget(n)

        lay.addLayout(col, 1)

    @property
    def selected(self) -> bool:
        return self.check.isChecked()


# --------------------------------------------------------------------------- stato dalla CLI
class StatusWorker(QThread):
    """`claude-multi status --json` fuori dal thread UI: la finestra compare subito, lo stato arriva dopo."""
    done = Signal(dict)
    failed = Signal(str)

    def run(self) -> None:
        try:
            out = subprocess.run([str(BIN / "claude-multi"), "status", "--json"],
                                 capture_output=True, text=True, timeout=60)
            if out.returncode != 0 and not out.stdout.strip():
                raise RuntimeError(out.stderr.strip()[:200] or f"codice {out.returncode}")
            self.done.emit(json.loads(out.stdout))
        except Exception as exc:  # noqa: BLE001 — il pannello lo mostra, il gate resta usabile
            self.failed.emit(str(exc))


DEMO_STATUS = {
    "machine": {"cliVersion": "2.1.220", "cliVersions": ["2.1.219", "2.1.220"], "desktopVersion": "1.24012.9",
                "embeddedCode": {"personal": ["2.1.218"], "work": ["2.1.218"]}},
    "repo": {"isRepo": True, "branch": "release", "head": "abc1234 demo", "behind": 0, "ahead": 1, "dirty": 0},
    "running": {"cli": [{"profile": "personal", "embedded": True}], "desktop": [{"variant": "personal"}]},
    "doctor": [
        {"id": "repo.sync", "status": "warn", "msg": "1 commit locali non pushati", "fix": "git -C ~/.local/src/claude-multi push"},
        {"id": "mcp.wiki", "status": "fail", "msg": "MCP wiki-claude: llama-server non risponde", "fix": "systemctl --user start llama-embed-shim.service"},
        {"id": "ok1", "status": "ok", "msg": "~/.claude-multi/shared → repo"},
        {"id": "ok2", "status": "ok", "msg": "Claude Desktop + variante Work allineata"},
    ],
}


class StatusPanel(QFrame):
    """Vista compatta di `claude-multi status --json`: versioni, doctor con fix copiabili, istanze."""

    def __init__(self, expanded: bool):
        super().__init__()
        self.setObjectName("card")
        self._status: dict | None = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 10, 14, 10)
        lay.setSpacing(6)

        head = QHBoxLayout()
        title = QLabel("Stato del setup")
        f = title.font(); f.setBold(True); title.setFont(f)
        head.addWidget(title)
        self.summary = QLabel("lettura in corso…")
        self.summary.setObjectName("muted")
        head.addWidget(self.summary, 1)
        self.toggle = QCheckBox("Dettagli")
        self.toggle.setChecked(expanded)
        self.toggle.toggled.connect(self._refresh_visibility)
        head.addWidget(self.toggle)
        lay.addLayout(head)

        self.versions = QLabel("")
        self.versions.setObjectName("muted")
        self.versions.setWordWrap(True)
        lay.addWidget(self.versions)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll.setMaximumHeight(220)
        self.rows_host = QWidget()
        self.rows = QVBoxLayout(self.rows_host)
        self.rows.setContentsMargins(0, 0, 0, 0)
        self.rows.setSpacing(3)
        self.scroll.setWidget(self.rows_host)
        lay.addWidget(self.scroll)
        self._refresh_visibility()

    def _refresh_visibility(self) -> None:
        self.scroll.setVisible(self.toggle.isChecked() and self._status is not None)
        self.versions.setVisible(self.toggle.isChecked() and self._status is not None)

    def set_error(self, msg: str) -> None:
        self.summary.setText(f"stato non disponibile: {msg}")

    def set_status(self, st: dict) -> None:
        self._status = st
        m = st.get("machine", {}); r = st.get("repo", {}); run = st.get("running", {})
        checks = st.get("doctor", [])
        n = {k: sum(1 for c in checks if c.get("status") == k) for k in ("ok", "warn", "fail")}
        if n["fail"]:
            self.summary.setText(f"doctor: {n['fail']} problem{'a' if n['fail'] == 1 else 'i'}, {n['warn']} avvisi")
            self.summary.setStyleSheet(f"color: {DANGER};")
        elif n["warn"]:
            self.summary.setText(f"doctor: {n['warn']} avvis{'o' if n['warn'] == 1 else 'i'}, nessun problema")
            self.summary.setStyleSheet(f"color: {ACCENT};")
        else:
            self.summary.setText(f"doctor: tutto ok ({n['ok']} controlli)")
            self.summary.setStyleSheet("")
        emb = " · ".join(f"{k} {', '.join(v)}" for k, v in (m.get("embeddedCode") or {}).items())
        sess = run.get("cli", [])
        active = f"{sum(1 for c in sess if not c.get('embedded'))} cli + {sum(1 for c in sess if c.get('embedded'))} desktop"
        repo = ""
        if r.get("isRepo"):
            repo = f" · repo ↓{r.get('behind', 0)} ↑{r.get('ahead', 0)} ✎{r.get('dirty', 0)}"
        self.versions.setText(
            f"Claude Code {m.get('cliVersion') or '?'} · Claude Desktop {m.get('desktopVersion') or 'assente'}"
            f"{' · embedded ' + emb if emb else ''}{repo} · sessioni {active}"
        )
        while self.rows.count():
            item = self.rows.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        order = {"fail": 0, "warn": 1, "ok": 2}
        for c in sorted(checks, key=lambda x: order.get(x.get("status"), 3)):
            self.rows.addWidget(self._row(c))
        self.rows.addStretch(1)
        self._refresh_visibility()

    def _row(self, c: dict) -> QWidget:
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(8)
        st = c.get("status", "ok")
        mark = QLabel({"ok": "✓", "warn": "!", "fail": "✗"}.get(st, "?"))
        mark.setFixedWidth(14)
        mark.setStyleSheet({"ok": "color: #3fb950;", "warn": f"color: {ACCENT};", "fail": f"color: {DANGER};"}.get(st, ""))
        h.addWidget(mark)
        msg = QLabel(c.get("msg", ""))
        msg.setWordWrap(True)
        if st == "ok":
            msg.setObjectName("muted")
        h.addWidget(msg, 1)
        fix = c.get("fix")
        if fix and st != "ok":
            b = QPushButton("Copia fix")
            b.setObjectName("flat")
            b.setToolTip(fix)
            b.clicked.connect(lambda _=False, t=fix: QApplication.clipboard().setText(t))
            h.addWidget(b)
        return w

    @property
    def can_rollback(self) -> bool:
        return len((self._status or {}).get("machine", {}).get("cliVersions", [])) > 1


# --------------------------------------------------------------------------- finestra
class UpdateGate(QDialog):
    def __init__(self, state: dict, profile: str, demo: bool = False,
                 standalone: bool = False, on_console=None):
        super().__init__()
        self.on_console = on_console
        self.state = state
        self.profile = profile
        self.demo = demo
        self.standalone = standalone
        self.desktop = state.get("desktop", {})
        self.cli = state.get("cli", {})
        self.result_code = EXIT_LAUNCH_ASIS
        self.pkg_path: str | None = None
        self.phases: list[tuple[str, str]] = []
        self.phase_idx = -1
        self.proc: QProcess | None = None
        self.cards: dict[str, Card] = {}

        self.setWindowTitle("Aggiornamento Claude")
        icon = QIcon.fromTheme("claude-desktop")
        if not icon.isNull():
            self.setWindowIcon(icon)
        self.setMinimumWidth(540)
        self._build_ui()
        self._apply_style()
        self._refresh_primary()

    # ---------------------------------------------------------------- costruzione UI
    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(22, 20, 22, 18)
        root.setSpacing(13)

        head_row = QHBoxLayout()
        head_row.setSpacing(11)
        app_icon = QIcon.fromTheme("claude-desktop")
        if not app_icon.isNull():
            badge = QLabel()
            badge.setPixmap(app_icon.pixmap(34, 34))
            head_row.addWidget(badge, 0, Qt.AlignmentFlag.AlignVCenter)

        self.has_updates = bool(self.desktop.get("outdated") or self.cli.get("outdated"))
        head = QLabel("Aggiornamenti disponibili" if self.has_updates else "Claude è aggiornato")
        hf = head.font()
        hf.setPointSizeF(hf.pointSizeF() + 3.5)
        hf.setWeight(QFont.Weight.DemiBold)
        head.setFont(hf)
        head_row.addWidget(head, 1)
        root.addLayout(head_row)

        sub = QLabel("Scegli cosa aggiornare: niente parte senza la tua spunta."
                     if self.has_updates else "Nessun aggiornamento in attesa. Qui sotto lo stato del setup.")
        sub.setObjectName("muted")
        sub.setWordWrap(True)
        root.addWidget(sub)

        if self.desktop.get("outdated"):
            card = Card(
                "Claude Desktop",
                self.desktop.get("current", "?"),
                self.desktop.get("latest", "?"),
                note="Va fatto con l'app chiusa; chiede la password di sistema.",
            )
            self.cards["desktop"] = card
            root.addWidget(card)

        if self.cli.get("outdated"):
            note = "Non serve password e non tocca le finestre aperte."
            clf = self.cli.get("changelog_file") or ""
            try:
                if clf and Path(clf).is_file():
                    lines = [l.strip() for l in Path(clf).read_text(encoding="utf-8").splitlines() if l.strip().startswith("- ")]
                    if lines:
                        shown = lines[:6]
                        more = f"\n… e altre {len(lines) - 6}" if len(lines) > 6 else ""
                        note = "Novità:\n" + "\n".join((l if len(l) <= 120 else l[:117].rsplit(" ", 1)[0] + "…") for l in shown) + more
            except OSError:
                pass
            card = Card(
                "Claude Code (CLI)",
                self.cli.get("current", "?"),
                self.cli.get("latest", "?"),
                note=note,
            )
            self.cards["cli"] = card
            root.addWidget(card)

        for card in self.cards.values():
            card.check.toggled.connect(self._refresh_primary)

        # --- stato del setup (vista di `claude-multi status --json`), caricato in un thread
        self.status_panel = StatusPanel(expanded=self.standalone or not self.has_updates)
        root.addWidget(self.status_panel)

        # --- avviso "Claude è aperto": solo in standalone, e solo se serve davvero
        self.warn_lbl = QLabel()
        self.warn_lbl.setObjectName("warn")
        self.warn_lbl.setWordWrap(True)
        self.warn_lbl.setVisible(False)
        root.addWidget(self.warn_lbl)

        self.kill_btn = QPushButton("Chiudi Claude e aggiorna")
        self.kill_btn.setObjectName("primary")
        self.kill_btn.setVisible(False)
        self.kill_btn.clicked.connect(self._close_apps_then_update)
        root.addWidget(self.kill_btn)

        # --- area progresso
        self.phase_lbl = QLabel("")
        self.phase_lbl.setObjectName("muted")
        self.phase_lbl.setVisible(False)
        root.addWidget(self.phase_lbl)

        self.bar = QProgressBar()
        self.bar.setTextVisible(False)
        self.bar.setFixedHeight(6)
        self.bar.setVisible(False)
        root.addWidget(self.bar)

        self.details_btn = QCheckBox("Mostra i dettagli")
        self.details_btn.setVisible(False)
        self.details_btn.toggled.connect(self._toggle_log)
        root.addWidget(self.details_btn)

        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setVisible(False)
        self.log.setMinimumHeight(170)
        self.log.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        mono = QFont("monospace")
        mono.setStyleHint(QFont.StyleHint.Monospace)
        mono.setPointSizeF(mono.pointSizeF() - 0.5)
        self.log.setFont(mono)
        root.addWidget(self.log)

        # --- pulsantiera
        btns = QHBoxLayout()
        btns.setSpacing(8)
        self.skip_btn = QPushButton("Salta queste versioni")
        self.skip_btn.setObjectName("flat")
        self.skip_btn.setToolTip(
            "Non chiedere più per le versioni elencate qui sopra.\n"
            "Al prossimo aggiornamento pubblicato la finestra ricompare."
        )
        self.skip_btn.clicked.connect(self._on_skip)
        self.skip_btn.setVisible(self.has_updates)
        btns.addWidget(self.skip_btn)

        self.dash_btn = QPushButton("Console")
        self.dash_btn.setObjectName("flat")
        self.dash_btn.setToolTip("Apre la console di claude-multi.")
        self.dash_btn.clicked.connect(self._open_dashboard)
        btns.addWidget(self.dash_btn)

        self.rollback_btn = QPushButton("Rollback Claude Code")
        self.rollback_btn.setObjectName("flat")
        self.rollback_btn.setToolTip("Torna alla versione precedente di Claude Code ancora in cache (claude-multi update --rollback).")
        self.rollback_btn.setVisible(False)
        self.rollback_btn.clicked.connect(self._rollback)
        btns.addWidget(self.rollback_btn)
        btns.addStretch(1)

        self.asis_btn = QPushButton("Non ora")
        self.asis_btn.setToolTip("Chiude senza aggiornare; te lo richiedo la prossima volta.")
        self.asis_btn.clicked.connect(self._on_asis)
        btns.addWidget(self.asis_btn)

        self.go_btn = QPushButton("Aggiorna")
        self.go_btn.setObjectName("primary")
        self.go_btn.setDefault(True)
        self.go_btn.clicked.connect(self.start_update)
        self.go_btn.setVisible(self.has_updates)
        btns.addWidget(self.go_btn)
        root.addLayout(btns)
        if not self.has_updates:
            self.asis_btn.setText("Chiudi")
            self.asis_btn.setDefault(True)

        # lo stato arriva dopo: la finestra non aspetta la CLI
        if self.demo:
            QTimer.singleShot(600, lambda: self._on_status(DEMO_STATUS))
        else:
            self.worker = StatusWorker(self)
            self.worker.done.connect(self._on_status)
            self.worker.failed.connect(self.status_panel.set_error)
            self.worker.start()

    def _on_status(self, st: dict) -> None:
        self.status_panel.set_status(st)
        self.rollback_btn.setVisible(self.standalone and self.status_panel.can_rollback)
        QTimer.singleShot(0, lambda: self.resize(self.width(), self.sizeHint().height()))

    def _open_dashboard(self) -> None:
        if self.demo:
            return
        if self.on_console:
            self.on_console()
            return
        # Processo a sé (--gate): l'istanza dell'app, se c'è, riceve la richiesta e mostra la console.
        subprocess.Popen([str(BIN / "claude-multi-app")], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _rollback(self) -> None:
        """Rollback della CLI come fase unica: stesso log, stessi esiti."""
        self.phases = [("Rollback di Claude Code alla versione precedente", "rollback")]
        self.rollback_btn.setEnabled(False)
        self.go_btn.setEnabled(False)
        self.skip_btn.setVisible(False)
        self.phase_lbl.setVisible(True)
        self.phase_lbl.setStyleSheet("")
        self.bar.setVisible(True)
        self.details_btn.setVisible(True)
        self.bar.setRange(0, 0)
        self.phase_idx = -1
        self._next_phase()

    def _apply_style(self) -> None:
        dark = is_dark(QApplication.instance())
        card_bg = "rgba(255,255,255,0.05)" if dark else "rgba(0,0,0,0.035)"
        border = "rgba(255,255,255,0.10)" if dark else "rgba(0,0,0,0.10)"
        muted = "#9aa0a6" if dark else "#5f6368"
        warn_bg = "rgba(217,119,87,0.14)"
        self.setStyleSheet(f"""
            QFrame#card {{
                background: {card_bg};
                border: 1px solid {border};
                border-radius: 9px;
            }}
            QLabel#muted {{ color: {muted}; }}
            QLabel#warn {{
                background: {warn_bg};
                border: 1px solid {ACCENT};
                border-radius: 8px;
                padding: 9px 12px;
            }}
            QPushButton {{
                padding: 7px 15px;
                border-radius: 7px;
                border: 1px solid {border};
            }}
            QPushButton:hover {{ background: {card_bg}; }}
            QPushButton#primary {{
                background: {ACCENT};
                color: #ffffff;
                border: 1px solid {ACCENT};
                font-weight: 600;
            }}
            QPushButton#primary:hover {{ background: {ACCENT_HOVER}; border-color: {ACCENT_HOVER}; }}
            QPushButton#primary:disabled {{ background: {muted}; border-color: {muted}; color: #dddddd; }}
            QPushButton#flat {{ border-color: transparent; color: {muted}; }}
            QProgressBar {{ background: {card_bg}; border: none; border-radius: 3px; }}
            QProgressBar::chunk {{ background: {ACCENT}; border-radius: 3px; }}
            QPlainTextEdit {{ border: 1px solid {border}; border-radius: 7px; }}
        """)

    def _toggle_log(self, on: bool) -> None:
        self.log.setVisible(on)
        QTimer.singleShot(0, lambda: self.resize(self.width(), self.sizeHint().height()))

    # ---------------------------------------------------------------- selezione
    def _selected(self) -> list[str]:
        return [k for k, c in self.cards.items() if c.selected]

    def _refresh_primary(self) -> None:
        """Il pulsante primario riflette la selezione: senza spunte non c'è nulla da fare."""
        sel = self._selected()
        if not self.has_updates:
            return
        self.go_btn.setEnabled(bool(sel))
        if len(sel) == 2:
            self.go_btn.setText("Aggiorna entrambi")
        elif sel == ["desktop"]:
            self.go_btn.setText("Aggiorna Claude Desktop")
        elif sel == ["cli"]:
            self.go_btn.setText("Aggiorna Claude Code")
        else:
            self.go_btn.setText("Aggiorna")

        # In standalone, aggiornare Desktop richiede l'app chiusa: se gira, lo si dice e si offre
        # di chiuderla. Il click sul pulsante è il consenso — nessuna chiusura a sorpresa.
        if self.standalone and "desktop" in sel:
            pids = [] if self.demo else running_desktop_pids()
            if pids:
                n = len(pids)
                self.warn_lbl.setText(
                    f"Claude Desktop è in esecuzione ({n} istanz{'a' if n == 1 else 'e'}). "
                    "L'aggiornamento sostituisce i file dell'app mentre gira: va chiusa prima."
                )
                self.warn_lbl.setVisible(True)
                self.kill_btn.setVisible(True)
                self.go_btn.setVisible(False)
                return
        self.warn_lbl.setVisible(False)
        self.kill_btn.setVisible(False)
        self.go_btn.setVisible(True)

    # ---------------------------------------------------------------- azioni utente
    def _on_asis(self) -> None:
        self.result_code = EXIT_LAUNCH_ASIS
        self.accept()

    def _on_skip(self) -> None:
        # In demo le versioni sono inventate: scriverle silenzierebbe una release futura vera.
        if not self.demo:
            remember_skip([
                (key, (self.desktop if key == "desktop" else self.cli).get("latest", ""))
                for key in self.cards
            ])
        self.result_code = EXIT_SKIP_VERSION
        self.accept()

    def _close_apps_then_update(self) -> None:
        """SIGTERM alle istanze Desktop (chiusura garbata Electron), poi parte l'aggiornamento."""
        self.kill_btn.setEnabled(False)
        self.warn_lbl.setText("Chiusura di Claude Desktop in corso…")
        pids = running_desktop_pids()
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._wait_for_exit(pids, attempts=20)

    def _wait_for_exit(self, pids: list[int], attempts: int) -> None:
        alive = [p for p in pids if Path(f"/proc/{p}").exists()]
        if not alive:
            self.warn_lbl.setVisible(False)
            self.kill_btn.setVisible(False)
            self.start_update()
            return
        if attempts <= 0:
            self.warn_lbl.setText(
                f"{len(alive)} istanz{'a' if len(alive) == 1 else 'e'} non si sono chiuse. "
                "Chiudile a mano dalla finestra di Claude, poi riprova."
            )
            self.kill_btn.setEnabled(True)
            return
        QTimer.singleShot(500, lambda: self._wait_for_exit(pids, attempts - 1))

    # ---------------------------------------------------------------- macchina a fasi
    def _plan(self) -> list[tuple[str, str]]:
        """Fasi da eseguire: Desktop prima (è quello che pretende l'app chiusa), poi la CLI."""
        plan: list[tuple[str, str]] = []
        if "desktop" in self._selected():
            plan += [
                ("Ricostruzione del pacchetto dal .deb ufficiale Anthropic", "build"),
                ("Installazione del pacchetto (serve la password)", "install"),
                *[(f"Aggiornamento della variante Desktop del profilo '{prof}'", f"variant:{prof}")
                  for prof, _ in desktop_variants()],
            ]
        if "cli" in self._selected():
            plan.append(("Aggiornamento di Claude Code", "cli"))
        return plan

    def start_update(self) -> None:
        self.phases = self._plan()
        if not self.phases:
            return
        self.go_btn.setEnabled(False)
        self.skip_btn.setVisible(False)
        self.asis_btn.setText("Annulla")
        for card in self.cards.values():
            card.check.setEnabled(False)
        self.phase_lbl.setVisible(True)
        self.phase_lbl.setStyleSheet("")   # su "Riprova": via il rosso dell'errore precedente
        self.bar.setVisible(True)
        self.details_btn.setVisible(True)
        self.bar.setRange(0, 0)  # indeterminata: nessuna fase espone un progresso reale
        self.phase_idx = -1
        self._next_phase()

    def _next_phase(self) -> None:
        self.phase_idx += 1
        if self.phase_idx >= len(self.phases):
            self._finish_ok()
            return
        label, key = self.phases[self.phase_idx]
        self.phase_lbl.setText(f"Fase {self.phase_idx + 1} di {len(self.phases)} · {label}")
        self._append(f"\n=== {label} ===")

        if self.demo:
            QTimer.singleShot(1200, self._next_phase)
            return

        if key == "build":
            self._run(str(BIN / "claude-desktop-update"), ["--no-install"])
        elif key == "install":
            if not self.pkg_path:
                self._fail("Il pacchetto non è stato prodotto dalla fase di build.")
                return
            # pkexec apre il dialogo polkit di Plasma: la password non passa mai da qui.
            self._run("pkexec", ["pacman", "-U", "--noconfirm", self.pkg_path])
        elif key.startswith("variant:"):
            self._run(str(BIN / "claude-desktop-rebuild"), [key.split(":", 1)[1]])
        elif key == "rollback":
            self._run(str(BIN / "claude-multi"), ["update", "--rollback"])
        else:
            self._run(str(BIN / "claude-multi"), ["update", "--cli"])

    def _run(self, program: str, args: list[str]) -> None:
        self.proc = QProcess(self)
        self.proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        self.proc.readyReadStandardOutput.connect(self._on_output)
        self.proc.finished.connect(self._on_finished)
        self.proc.errorOccurred.connect(
            lambda _e: self._fail(f"Impossibile eseguire {os.path.basename(program)}.")
        )
        self.proc.start(program, args)

    def _on_output(self) -> None:
        if not self.proc:
            return
        chunk = bytes(self.proc.readAllStandardOutput()).decode("utf-8", "replace")
        for line in chunk.splitlines():
            # la fase di build annuncia il pacchetto da installare con "PKG=<path>"
            if line.startswith("PKG="):
                self.pkg_path = line[4:].strip()
            self._append(line)

    def _on_finished(self, code: int, _status) -> None:
        if code == 0:
            self._next_phase()
            return
        if code == 126:  # pkexec: autenticazione annullata o negata
            self._fail("Autenticazione annullata: l'aggiornamento non è stato installato.")
        else:
            self._fail(f"«{self.phases[self.phase_idx][0]}» è fallita (codice {code}).")

    def _append(self, text: str) -> None:
        self.log.appendPlainText(text.rstrip())

    def _finish_ok(self) -> None:
        self.bar.setRange(0, 100)
        self.bar.setValue(100)
        self.result_code = EXIT_UPDATED
        done = ", ".join(
            "Claude Desktop" if k == "desktop" else "Claude Code" for k in self._selected()
        ) or "Claude Code"
        if self.phases and self.phases[0][1] == "rollback":
            self.phase_lbl.setText("Rollback eseguito: claude-bin punta alla versione precedente.")
            self.asis_btn.setText("Chiudi")
            self.bar.setRange(0, 100); self.bar.setValue(100)
            self.result_code = EXIT_LAUNCH_ASIS
            return
        if self.standalone:
            # Qui non apriamo niente: la scelta di riaprire (e quando) resta all'utente.
            self.phase_lbl.setText(f"{done} aggiornato. Puoi riaprire Claude quando vuoi.")
            self.asis_btn.setText("Chiudi")
            self.asis_btn.setEnabled(True)
            self.go_btn.setVisible(False)
            self.reopen_btn = QPushButton("Riapri Claude")
            self.reopen_btn.setObjectName("primary")
            self.reopen_btn.clicked.connect(self._reopen)
            self.layout().itemAt(self.layout().count() - 1).layout().addWidget(self.reopen_btn)
        else:
            self.phase_lbl.setText(f"{done} aggiornato — avvio di Claude…")
            QTimer.singleShot(900, self.accept)

    def _reopen(self) -> None:
        subprocess.Popen([str(BIN / "claude-launch"), self.profile],
                         start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.accept()

    def _fail(self, message: str) -> None:
        self.bar.setRange(0, 100)
        self.bar.setValue(0)
        self.phase_lbl.setText(message)
        self.phase_lbl.setStyleSheet(f"color: {DANGER};")
        self.details_btn.setChecked(True)   # in caso di errore il log si apre da solo
        self.go_btn.setText("Riprova")
        self.go_btn.setEnabled(True)
        self.go_btn.setVisible(True)
        self.asis_btn.setText("Chiudi" if self.standalone else "Avvia com'è")
        for card in self.cards.values():
            card.check.setEnabled(True)
