"""hey.py — «Hey Claude»: a quick entry that hands what you say to Claude, three ways.

Opened by `claude-multi-app --hey` (bind it to a global shortcut), by the tray menu, and by the bar
on the console's Today page. The text is typed for now; the local ear (wake word + whisper.cpp,
from Virgil) will fill the same field.

  Enter        open in Claude Code: a terminal in the chosen folder, `claude "<text>"` with the
               chosen profile's command
  Ctrl+Enter   open in Claude Desktop: a new chat through the claude:// link, the text prefilled
               (and on the clipboard, in case this Desktop version does not take it)
  Alt+Enter    answer here: `claude -p` in the chosen profile, the answer streamed into the panel
  Esc          close

A view like the rest of the app: every action is a command a terminal would run.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from urllib.parse import quote

from PySide6.QtCore import QProcess, Qt, Signal
from PySide6.QtGui import QGuiApplication, QKeySequence, QShortcut, QTextCursor
from PySide6.QtWidgets import (
    QComboBox, QHBoxLayout, QLabel, QPlainTextEdit, QPushButton, QTextBrowser, QVBoxLayout, QWidget,
)

from common import BIN, HOME, NAME, default_profile, manifests

STYLE = """
QWidget#hey { background: palette(window); }
QPlainTextEdit { font-size: 17px; padding: 8px; border-radius: 8px; }
QPushButton { padding: 9px 14px; border-radius: 8px; }
QPushButton#primary { font-weight: 600; }
QLabel#hint { color: palette(placeholder-text); font-size: 12px; }
"""


def command_of(profile: str) -> str:
    """The launcher a profile runs under (claude, claude-agency…), from its manifest."""
    return manifests().get(profile, {}).get("command") or f"claude-{profile}"


def terminal_argv(workdir: str, argv: list[str]) -> list[str] | None:
    """A terminal running argv in workdir: Konsole on this setup, the usual others as fallbacks."""
    if shutil.which("konsole"):
        return ["konsole", "--workdir", workdir, "-e", *argv]
    for t, flag in (("kitty", "--directory"), ("alacritty", "--working-directory"), ("wezterm", "--cwd")):
        if shutil.which(t):
            return [t, flag, workdir, "-e", *argv] if t != "wezterm" else [t, "start", flag, workdir, "--", *argv]
    return None


class PromptEdit(QPlainTextEdit):
    """The text field: Enter variants choose the action, Shift+Enter is a new line."""
    submitted = Signal(str)

    def keyPressEvent(self, e) -> None:
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            mods = e.modifiers()
            if mods & Qt.KeyboardModifier.ShiftModifier:
                return super().keyPressEvent(e)
            self.submitted.emit("desktop" if mods & Qt.KeyboardModifier.ControlModifier else "here" if mods & Qt.KeyboardModifier.AltModifier else "code")
            return
        super().keyPressEvent(e)


class HeyPanel(QWidget):
    closed = Signal()

    def __init__(self, folders: list[str] | None = None, text: str = "") -> None:
        super().__init__()
        self.setObjectName("hey")
        self.setWindowTitle(f"Hey Claude — {NAME}")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint)
        self.setStyleSheet(STYLE)
        self.resize(680, 300)
        self.proc: QProcess | None = None

        col = QVBoxLayout(self)
        col.setContentsMargins(20, 18, 20, 16)
        col.setSpacing(12)

        self.text = PromptEdit()
        self.text.setPlaceholderText("Cosa c'è da fare? — What should Claude do?")
        self.set_text(text)
        self.text.setFixedHeight(96)
        col.addWidget(self.text)

        row = QHBoxLayout()
        self.profile = QComboBox()
        for p in manifests():
            self.profile.addItem(p)
        self.profile.setCurrentText(default_profile())
        self.folder = QComboBox()
        self.folder.setEditable(True)
        for f in [str(HOME), *(folders or [])]:
            if self.folder.findText(f) < 0:
                self.folder.addItem(f)
        self.folder.setMinimumWidth(280)
        row.addWidget(QLabel("Profilo"))
        row.addWidget(self.profile)
        row.addSpacing(12)
        row.addWidget(QLabel("Cartella"))
        row.addWidget(self.folder, 1)
        col.addLayout(row)

        buttons = QHBoxLayout()
        self.b_code = QPushButton("Apri in Claude Code  ↵")
        self.b_code.setObjectName("primary")
        self.b_desk = QPushButton("Apri in Desktop  Ctrl ↵")
        self.b_here = QPushButton("Rispondi qui  Alt ↵")
        for b in (self.b_code, self.b_desk, self.b_here):
            buttons.addWidget(b)
        col.addLayout(buttons)

        self.answer = QTextBrowser()
        self.answer.setOpenExternalLinks(True)
        self.answer.hide()
        col.addWidget(self.answer, 1)

        self.hint = QLabel("La voce arriverà qui: per ora scrivi. Esc chiude.")
        self.hint.setObjectName("hint")
        col.addWidget(self.hint)

        self.b_code.clicked.connect(self.open_code)
        self.b_desk.clicked.connect(self.open_desktop)
        self.b_here.clicked.connect(self.answer_here)
        QShortcut(QKeySequence(Qt.Key.Key_Escape), self, activated=self.close)
        self.text.submitted.connect(lambda mode: {"code": self.open_code, "desktop": self.open_desktop, "here": self.answer_here}[mode]())

    def set_text(self, text: str) -> None:
        self.text.setPlainText(text)
        self.text.moveCursor(QTextCursor.MoveOperation.End)

    # ------------------------------------------------------------------ actions
    def _prompt(self) -> str | None:
        t = self.text.toPlainText().strip()
        if not t:
            self.hint.setText("Scrivi prima qualcosa.")
            return None
        return t

    def open_code(self) -> None:
        t = self._prompt()
        if t is None:
            return
        folder = self.folder.currentText().strip() or str(HOME)
        if not Path(folder).expanduser().is_dir():
            self.hint.setText(f"La cartella non esiste: {folder}")
            return
        argv = terminal_argv(str(Path(folder).expanduser()), [str(BIN / command_of(self.profile.currentText())), t])
        if not argv or not QProcess.startDetached(argv[0], argv[1:]):
            self.hint.setText("Nessun terminale trovato (konsole, kitty, alacritty, wezterm).")
            return
        self.close()

    def open_desktop(self) -> None:
        t = self._prompt()
        if t is None:
            return
        QGuiApplication.clipboard().setText(t)
        QProcess.startDetached(str(BIN / "claude-launch"), [self.profile.currentText(), f"claude://claude.ai/new?q={quote(t)}"])
        self.close()

    def answer_here(self) -> None:
        t = self._prompt()
        if t is None or (self.proc and self.proc.state() != QProcess.ProcessState.NotRunning):
            return
        self.answer.show()
        self.answer.setPlainText("…")
        self.resize(self.width(), max(self.height(), 520))
        self._buf = ""
        self.proc = QProcess(self)
        self.proc.setWorkingDirectory(str(HOME))
        self.proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        self.proc.readyReadStandardOutput.connect(self._read)
        self.proc.finished.connect(self._done)
        self.proc.start(str(BIN / command_of(self.profile.currentText())), ["-p", t])

    def _read(self) -> None:
        self._buf += bytes(self.proc.readAllStandardOutput()).decode(errors="replace")
        self.answer.setMarkdown(self._buf)
        self.answer.verticalScrollBar().setValue(self.answer.verticalScrollBar().maximum())

    def _done(self, code: int, _status) -> None:
        if code != 0 and not self._buf.strip():
            self.answer.setPlainText(f"Claude non ha risposto (uscita {code}).")
        self.hint.setText("Fatto. Esc chiude, oppure apri la conversazione in Code o Desktop.")

    def closeEvent(self, event) -> None:
        if self.proc and self.proc.state() != QProcess.ProcessState.NotRunning:
            self.proc.kill()
            self.proc.waitForFinished(2000)
        self.closed.emit()
        super().closeEvent(event)
