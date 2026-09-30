"""hey.py — «Hey Claude»: one field floating on the screen. Say what you want; Claude decides.

Opened by `claude-multi-app --hey` (bind it to a global shortcut), by the tray menu, and by the bar
on the console's Today page. What is typed goes to `claude -p` in the default profile, streamed
back under the field:

  a thing to do, a question on the day, mail, calendar, Drive, the wiki
      answered there, with the tools of those servers (the tasks can be changed; mail, calendar
      and Drive are read only: sending or inviting stays a conversation's job)
  work inside a project's files
      not done there: Claude says so and names the folder, and one button opens Claude Code in it
      with the request

After an answer the field stays: what is typed next continues the same conversation, and
"continue in the terminal" opens it in Claude Code. Esc closes (and stops a running answer).

A view like the rest of the app: every action is a command a terminal would run.
"""

from __future__ import annotations

import codecs
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QEvent, QProcess, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QGuiApplication, QKeySequence, QShortcut, QTextBlockFormat, QTextCursor
from PySide6.QtWidgets import (
    QFrame, QGraphicsDropShadowEffect, QHBoxLayout, QLabel, QLineEdit, QPushButton, QTextBrowser, QVBoxLayout, QWidget,
)

from common import BIN, HOME, NAME, default_profile, manifests

# The only tools the answer may use: the tasks (all of them), and reading the rest. With
# --permission-mode dontAsk anything else — sending mail, creating events, the other servers'
# writes — is refused, whatever the profile's own permission mode.
ALLOWED = [
    "mcp__tasks",
    "mcp__google__calendar_list", "mcp__google__calendar_events",
    "mcp__google__gmail_search", "mcp__google__gmail_thread",
    "mcp__google__drive_search", "mcp__google__drive_read",
    "mcp__wiki-claude__search", "mcp__wiki-claude__read_note",
]

PROMPT = """You are «Hey Claude», Samuel's quick entry from the desktop: one field, one short answer.
Answer in Italian unless he writes in another language. Be brief: one to four lines, no preamble, no
closing question. Today is {today}.
Use the tools: tasks (add, close, move, the day's brief: follow the tasks rule), his calendar, mail and
Drive read only, the wiki. Never send mail or create events from here: say it is for a conversation.
When the request needs work inside a project's files (code, changes, looking through a repository),
do not start it here: say in one line what you would do, then end with a line of its own
[[code:PATH]] where PATH is the project's folder under ~ (for example ~/work/acme/site) if you know it
or can find it in the wiki, otherwise [[code:~]]."""

CODE = re.compile(r"\[\[code:([^\]]+)\]\]")

STYLE = """
QFrame#card {{
  background: {bg};
  border: 1px solid {line};
  border-radius: 18px;
}}
QLabel#mark {{
  background: {accent};
  color: {on_accent};
  border-radius: 15px;
  font-size: 15px;
  font-weight: 700;
}}
QLineEdit#ask {{
  background: transparent;
  border: none;
  font-size: 20px;
  padding: 6px 0;
  color: {fg};
  selection-background-color: {accent};
}}
QLabel#esc {{
  color: {dim};
  border: 1px solid {line};
  border-radius: 5px;
  padding: 1px 6px;
  font-size: 11px;
}}
QFrame#rule {{ background: {line}; max-height: 1px; min-height: 1px; border: none; }}
QLabel#question {{ color: {dim}; font-size: 13px; }}
QTextBrowser#answer {{
  background: transparent;
  border: none;
  font-size: 15px;
  color: {fg};
}}
QLabel#status {{ color: {dim}; font-size: 12.5px; }}
QPushButton#term {{
  background: transparent;
  border: 1px solid {line};
  border-radius: 10px;
  color: {fg};
  font-size: 13px;
  padding: 8px 14px;
}}
QPushButton#term:hover {{ border-color: {dim}; }}
QPushButton#code {{
  background: {accent};
  color: {on_accent};
  border: none;
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
}}
"""


def arg(text: str) -> str:
    """The user's text as a positional argument: a leading "-" would read as an option."""
    return f" {text}" if text.startswith("-") else text


def command_of(profile: str) -> str:
    """The launcher a profile runs under (claude, claude-agency…), from its manifest."""
    return manifests().get(profile, {}).get("command") or f"claude-{profile}"


def terminal_argv(workdir: str, argv: list[str]) -> list[str] | None:
    """A terminal running argv in workdir: Konsole on this setup, the usual others as fallbacks."""
    if shutil.which("konsole"):
        return ["konsole", "--workdir", workdir, "-e", *argv]
    for t, flag in (("kitty", "--directory"), ("alacritty", "--working-directory")):
        if shutil.which(t):
            return [t, flag, workdir, "-e", *argv]
    if shutil.which("wezterm"):
        return ["wezterm", "start", "--cwd", workdir, "--", *argv]
    return None


class HeyPanel(QWidget):
    closed = Signal()

    def __init__(self, text: str = "") -> None:
        super().__init__(None, Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowTitle(f"Hey Claude — {NAME}")
        self.profile = default_profile()
        self.proc: QProcess | None = None
        self.session: str | None = None
        self.first_ask = ""  # the request that started the conversation, for Claude Code
        self.code_dir: str | None = None
        self.code_ask = ""
        self._buf = self._line = ""
        self._streamed = False

        pal = self.palette()
        dark = pal.window().color().lightness() < 128
        colors = {
            "bg": "rgba(36,35,32,0.97)" if dark else "rgba(255,255,255,0.97)",
            "line": "#3a3833" if dark else "#ddd8cf",
            "fg": "#edeae4" if dark else "#1d1c1a",
            "dim": "#948e84" if dark else "#767067",
            "accent": "#e3845b" if dark else "#a94a24",
            "on_accent": "#1a1917" if dark else "#ffffff",
        }
        self.setStyleSheet(STYLE.format(**colors))

        outer = QVBoxLayout(self)
        outer.setContentsMargins(28, 28, 28, 36)  # room for the shadow
        card = QFrame(objectName="card")
        shadow = QGraphicsDropShadowEffect(blurRadius=48, xOffset=0, yOffset=14)
        shadow.setColor(QColor(0, 0, 0, 120))
        card.setGraphicsEffect(shadow)
        outer.addWidget(card)

        col = QVBoxLayout(card)
        col.setContentsMargins(22, 16, 22, 16)
        col.setSpacing(0)

        row = QHBoxLayout()
        row.setSpacing(14)
        mark = QLabel("✳", objectName="mark")
        mark.setFixedSize(30, 30)
        mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        row.addWidget(mark)
        self.ask = QLineEdit(objectName="ask")
        self.ask.setPlaceholderText("Chiedi a Claude, o di' cosa c'è da fare…")
        self.ask.setText(text)
        self.ask.returnPressed.connect(self.submit)
        row.addWidget(self.ask, 1)
        row.addWidget(QLabel("Esc", objectName="esc"), 0, Qt.AlignmentFlag.AlignVCenter)
        col.addLayout(row)

        # the answer: the question recalled small, then the text with room to breathe
        self.body = QWidget()
        body = QVBoxLayout(self.body)
        body.setContentsMargins(0, 14, 0, 0)
        body.setSpacing(10)
        rule = QFrame(objectName="rule")
        body.addWidget(rule)
        self.question = QLabel("", objectName="question")
        self.question.setWordWrap(True)
        body.addSpacing(4)
        body.addWidget(self.question)
        self.answer = QTextBrowser(objectName="answer")
        self.answer.setOpenExternalLinks(True)
        self.answer.setFrameShape(QFrame.Shape.NoFrame)
        self.answer.document().setDocumentMargin(0)
        body.addWidget(self.answer)
        self.body.hide()
        col.addWidget(self.body)

        self.foot = QWidget()
        foot = QHBoxLayout(self.foot)
        foot.setContentsMargins(0, 14, 0, 2)
        foot.setSpacing(10)
        self.status = QLabel("", objectName="status")
        foot.addWidget(self.status, 1)
        self.b_term = QPushButton("Continua nel terminale", objectName="term")
        self.b_term.setCursor(Qt.CursorShape.PointingHandCursor)
        self.b_term.clicked.connect(self.open_terminal)
        self.b_term.hide()
        foot.addWidget(self.b_term)
        self.b_code = QPushButton(objectName="code")
        self.b_code.setCursor(Qt.CursorShape.PointingHandCursor)
        self.b_code.clicked.connect(self.open_code)
        self.b_code.hide()
        foot.addWidget(self.b_code)
        self.foot.hide()
        col.addWidget(self.foot)

        self.dots = QTimer(self, interval=400)
        self.dots.timeout.connect(self._tick)
        self._dot = 0
        self._state = ""

        QShortcut(QKeySequence(Qt.Key.Key_Escape), self, activated=self.close)
        self.setFixedWidth(760)
        self._place()

    # compatibility with the app's controller
    @property
    def text(self) -> QLineEdit:
        return self.ask

    def set_text(self, text: str) -> None:
        self.ask.setText(text)
        self.ask.setCursorPosition(len(text))

    def _place(self) -> None:
        self.adjustSize()
        screen = QGuiApplication.screenAt(self.cursor().pos()) or QGuiApplication.primaryScreen()
        g = screen.availableGeometry()
        self.move(g.x() + (g.width() - self.width()) // 2, g.y() + int(g.height() * 0.22))

    # ------------------------------------------------------------------ asking
    def submit(self) -> None:
        q = self.ask.text().strip()
        if not q or (self.proc and self.proc.state() != QProcess.ProcessState.NotRunning):
            return
        if not self.session:
            self.first_ask = q
        self.ask.clear()
        self.ask.setPlaceholderText("Continua…")
        self.code_dir = None
        self.b_code.hide()
        self.b_term.hide()
        self._buf = self._line = ""
        self._streamed = False
        self.question.setText(q)
        self.answer.clear()
        self.body.show()
        self.foot.show()
        self._set_state("Ci penso")
        self._resize()

        args = ["-p", arg(q), "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--tools", "", "--permission-mode", "dontAsk", "--allowedTools", *ALLOWED,
                "--append-system-prompt", PROMPT.format(today=datetime.now().strftime("%A %d %B %Y, %H:%M"))]
        if self.session:
            args += ["--resume", self.session]
        self._question = q
        self.proc = QProcess(self)
        self.proc.setWorkingDirectory(str(HOME))
        self.proc.readyReadStandardOutput.connect(self._read)
        self.proc.finished.connect(self._done)
        self.proc.errorOccurred.connect(self._failed)
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.proc.start(str(BIN / command_of(self.profile)), args)

    def _read(self) -> None:
        # incremental: a character split across two reads is not lost
        self._line += self._decoder.decode(bytes(self.proc.readAllStandardOutput()))
        *lines, self._line = self._line.split("\n")
        for raw in lines:
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            kind = ev.get("type")
            if ev.get("session_id"):
                self.session = ev["session_id"]
            if kind == "stream_event":
                d = ev.get("event", {}).get("delta", {})
                if d.get("type") == "text_delta":
                    self._streamed = True
                    self._buf += d.get("text", "")
                    self._render()
            elif kind == "assistant":
                for block in ev.get("message", {}).get("content", []):
                    if block.get("type") == "tool_use":
                        self._set_state(self._tool_label(block.get("name", "")))
                        # text before a tool call and text after it are separate paragraphs
                        if self._buf and not self._buf.endswith("\n\n"):
                            self._buf += "\n\n"
                    elif block.get("type") == "text" and not self._streamed:
                        self._buf += block.get("text", "")
                        self._render()
            elif kind == "result" and not self._buf.strip():
                self._buf = ev.get("result") or ""
                self._render()

    @staticmethod
    def _tool_label(name: str) -> str:
        short = name.split("__")[-1]
        for key, label in (("tasks", "Guardo le task"), ("calendar", "Guardo il calendario"), ("gmail", "Guardo la posta"),
                           ("drive", "Cerco su Drive"), ("search", "Cerco nella wiki"), ("read_note", "Leggo la wiki")):
            if key in short or key in name:
                return label
        return "Lavoro"

    def _render(self) -> None:
        m = CODE.search(self._buf)
        shown = CODE.sub("", self._buf).strip()
        if m:
            self.code_dir = m.group(1).strip()
            self.code_ask = self._question  # the request that asked for the project, not the first one
        self.answer.setMarkdown(shown)
        # Markdown import leaves the lines tight: give every block the same air
        cur = QTextCursor(self.answer.document())
        cur.select(QTextCursor.SelectionType.Document)
        fmt = QTextBlockFormat()
        fmt.setLineHeight(145, QTextBlockFormat.LineHeightTypes.ProportionalHeight.value)
        fmt.setBottomMargin(8)
        cur.mergeBlockFormat(fmt)
        self.answer.verticalScrollBar().setValue(self.answer.verticalScrollBar().maximum())
        self._resize()

    def _done(self, code: int, _status) -> None:
        self.dots.stop()
        if code != 0 and not self._buf.strip():
            err = bytes(self.proc.readAllStandardError()).decode(errors="replace").strip().splitlines()
            self._buf = f"Claude non ha risposto ({err[-1] if err else f'uscita {code}'})."
        self._render()
        self._state = ""
        self.status.setText("Invio per continuare la conversazione")
        if self.code_dir:
            name = Path(self.code_dir).expanduser().name or "~"
            self.b_code.setText(f"Apri Claude Code in {name}  →")
            self.b_code.show()
        self.b_term.setVisible(bool(self.session))
        self.ask.setFocus()
        self._resize()

    def _failed(self, err) -> None:
        # a program that cannot start never emits finished: without this the dots would run forever
        if err == QProcess.ProcessError.FailedToStart:
            self.dots.stop()
            self._state = ""
            self.status.setText(f"Non riesco ad avviare {command_of(self.profile)}.")

    def _set_state(self, s: str) -> None:
        self._state = s
        self._dot = 0
        self._tick()
        self.dots.start()

    def _tick(self) -> None:
        self._dot = (self._dot + 1) % 4
        self.status.setText(self._state + "." * self._dot)

    def _resize(self) -> None:
        if self.body.isVisible():
            doc = self.answer.document()
            doc.setTextWidth(self.answer.viewport().width() or 700)
            self.answer.setFixedHeight(max(24, min(400, int(doc.size().height()) + 6)))
        self.adjustSize()

    # ------------------------------------------------------------------ handing over
    def _launch(self, workdir: str, argv: list[str]) -> None:
        cmd = terminal_argv(workdir, argv)
        if not cmd or not QProcess.startDetached(cmd[0], cmd[1:]):
            self.status.setText("Nessun terminale trovato (konsole, kitty, alacritty, wezterm).")
            return
        self.close()

    def open_code(self) -> None:
        folder = Path(self.code_dir or "~").expanduser()
        if not folder.is_dir():
            self.status.setText(f"La cartella non esiste: {folder}")
            return
        self._launch(str(folder), [str(BIN / command_of(self.profile)), arg(self.code_ask or self.first_ask)])

    def open_terminal(self) -> None:
        if self.session:
            self._launch(str(HOME), [str(BIN / command_of(self.profile)), "--resume", self.session])

    # ------------------------------------------------------------------ closing
    def changeEvent(self, e) -> None:
        # like a launcher: clicking elsewhere closes it, unless there is an answer to keep reading.
        # Only after it has had the focus once: a compositor may open it without activating it.
        if e.type() == QEvent.Type.ActivationChange:
            if self.isActiveWindow():
                self._was_active = True
            elif getattr(self, "_was_active", False) and not self.body.isVisible():
                QTimer.singleShot(0, self.close)
        super().changeEvent(e)

    def closeEvent(self, event) -> None:
        if self.proc and self.proc.state() != QProcess.ProcessState.NotRunning:
            self.proc.kill()
            self.proc.waitForFinished(2000)
        self.closed.emit()
        super().closeEvent(event)
