"""picker.py — «Claude» in the menu: one entry for every profile, a small window to choose which.

The profiles come from their manifests (common.manifests), so the window opens even with the console
down; the console's /api/status then adds what it knows — the account each profile is signed in to,
and whether its Claude Desktop is already open. Choosing one runs claude-launch, which starts that
Desktop or, when it is already open, brings its window forward (Electron keeps one instance per
user-data-dir).

It looks like the console and Hey Claude: a floating card in the design system's colours (the
console's tokens, cli/dashboard/style.css), the title in the serif, one row per profile.

Keys: ↑ ↓ or 1–9 to choose, Enter to open, Esc to close; a click opens too, and the window closes
when it loses focus, like a launcher. The machine's default profile (plain `claude`) is selected first.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QSize, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QColor, QFontDatabase, QIcon, QKeyEvent, QMouseEvent
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest
from PySide6.QtWidgets import QFrame, QGraphicsDropShadowEffect, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from common import CONSOLE_URL, HOME, default_profile, manifests, repo

# the console's tokens (cli/dashboard/style.css), light and dark
TOKENS = {
    False: {"surface": "#ffffff", "raised": "#f4f3ef", "line": "#e4e3df", "fg": "#0b0b0b", "dim": "#52514e",
            "faint": "#75736d", "accent": "#c6613f", "ok": "#4f7a3a", "ok_wash": "#e6eedf"},
    True: {"surface": "#1a1a19", "raised": "#232322", "line": "#2c2c2a", "fg": "#f0efec", "dim": "#c3c2b7",
           "faint": "#929089", "accent": "#d97757", "ok": "#94bd7f", "ok_wash": "rgba(148,189,127,0.14)"},
}

STYLE = """
QFrame#card {{ background: {surface}; border: 1px solid {line}; border-radius: 14px; }}
QLabel {{ color: {fg}; font-family: "{sans}"; }}
QLabel#title {{ font-family: "{serif}"; font-size: 21px; }}
QLabel#kbd {{ color: {faint}; border: 1px solid {line}; border-radius: 5px; padding: 1px 6px; font-size: 11px; }}
QFrame#row {{ background: transparent; border: 1px solid transparent; border-radius: 10px; }}
QFrame#row:hover {{ background: {raised}; }}
QFrame#row[sel="true"] {{ background: {raised}; border-color: {accent}; }}
QLabel#name {{ font-size: 15px; font-weight: 600; }}
QLabel#account {{ color: {dim}; font-size: 12.5px; }}
QLabel#open {{ color: {ok}; background: {ok_wash}; border-radius: 9px; padding: 1px 8px; font-size: 11.5px; font-weight: 500; }}
QLabel#hint {{ color: {faint}; font-size: 12px; }}
"""


def _fonts() -> tuple[str, str]:
    """The console's faces (DM Sans, Source Serif 4, SIL OFL) from the repository, else the system's."""
    found = {}
    for file, key in (("dm-sans.woff2", "sans"), ("source-serif-4.woff2", "serif")):
        fid = QFontDatabase.addApplicationFont(str(repo() / "cli" / "dashboard" / "fonts" / file))
        fam = QFontDatabase.applicationFontFamilies(fid) if fid >= 0 else []
        found[key] = fam[0] if fam else ("sans-serif" if key == "sans" else "serif")
    return found["sans"], found["serif"]


def _icon(profile: str) -> QIcon:
    """The profile's Desktop icon: from the theme, else the file install put in hicolor, else Claude's."""
    for name in (f"claude-desktop-{profile}", "claude-desktop"):
        icon = QIcon.fromTheme(name)
        if icon.isNull():
            f = HOME / ".local" / "share" / "icons" / "hicolor" / "48x48" / "apps" / f"{name}.png"
            icon = QIcon(str(f)) if f.exists() else icon
        if not icon.isNull():
            return icon
    return QIcon()


class Row(QFrame):
    """One profile: its icon, its name and account, whether its Desktop is open, its number key."""
    clicked = Signal(str)

    def __init__(self, profile: str, n: int) -> None:
        super().__init__(objectName="row")
        self.profile = profile
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("sel", False)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(12, 10, 12, 10)
        lay.setSpacing(12)
        icon = _icon(profile)
        pic = QLabel()
        pic.setPixmap(icon.pixmap(QSize(34, 34)))
        pic.setFixedSize(34, 34)
        lay.addWidget(pic)
        text = QVBoxLayout()
        text.setSpacing(1)
        text.addWidget(QLabel(profile.capitalize(), objectName="name"))
        self.account = QLabel("", objectName="account")
        self.account.hide()
        text.addWidget(self.account)
        lay.addLayout(text, 1)
        self.open = QLabel("aperto", objectName="open")
        self.open.hide()
        lay.addWidget(self.open, 0, Qt.AlignmentFlag.AlignVCenter)
        lay.addWidget(QLabel(str(n), objectName="kbd"), 0, Qt.AlignmentFlag.AlignVCenter)

    def show_status(self, account: str | None, is_open: bool) -> None:
        self.account.setText(account or "")
        self.account.setVisible(bool(account))
        self.open.setVisible(is_open)

    def select(self, on: bool) -> None:
        self.setProperty("sel", on)
        self.style().unpolish(self)
        self.style().polish(self)

    def mouseReleaseEvent(self, e: QMouseEvent) -> None:
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.profile)


class Picker(QWidget):
    closed = Signal()
    chosen = Signal(str)

    def __init__(self) -> None:
        super().__init__(None, Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        self.setWindowTitle("Claude")
        self.setWindowIcon(QIcon.fromTheme("claude-desktop"))

        dark = self.palette().window().color().lightness() < 128
        sans, serif = _fonts()
        self.setStyleSheet(STYLE.format(**TOKENS[dark], sans=sans, serif=serif))

        outer = QVBoxLayout(self)
        outer.setContentsMargins(28, 24, 28, 34)  # room for the shadow
        card = QFrame(objectName="card")
        shadow = QGraphicsDropShadowEffect(blurRadius=44, xOffset=0, yOffset=12)
        shadow.setColor(QColor(0, 0, 0, 110 if dark else 60))
        card.setGraphicsEffect(shadow)
        outer.addWidget(card)

        col = QVBoxLayout(card)
        col.setContentsMargins(18, 16, 18, 14)
        col.setSpacing(4)
        head = QHBoxLayout()
        head.setContentsMargins(4, 0, 0, 8)
        head.addWidget(QLabel("Quale Claude?", objectName="title"), 1)
        head.addWidget(QLabel("Esc", objectName="kbd"), 0, Qt.AlignmentFlag.AlignVCenter)
        col.addLayout(head)

        self.profiles = list(manifests())
        self.rows: list[Row] = []
        for i, p in enumerate(self.profiles, 1):
            row = Row(p, i)
            row.clicked.connect(self._choose)
            self.rows.append(row)
            col.addWidget(row)
        hint = QLabel("↑ ↓ o il numero per scegliere · Invio per aprire", objectName="hint")
        hint.setContentsMargins(4, 8, 0, 0)
        col.addWidget(hint)

        default = default_profile()
        self.current = self.profiles.index(default) if default in self.profiles else 0
        self._select(self.current)
        self.setFixedWidth(480)

        self.net = QNetworkAccessManager(self)
        req = QNetworkRequest(QUrl(f"{CONSOLE_URL}/api/status"))
        req.setTransferTimeout(5000)
        self.reply = self.net.get(req)
        self.reply.finished.connect(self._got_status)

    def _select(self, i: int) -> None:
        if not self.rows:
            return
        self.current = i % len(self.rows)
        for j, r in enumerate(self.rows):
            r.select(j == self.current)

    def _got_status(self) -> None:
        reply, self.reply = self.reply, None
        try:
            if reply.error() == QNetworkReply.NetworkError.NoError:
                status = json.loads(bytes(reply.readAll()).decode())
                open_ = {d.get("variant") for d in status.get("running", {}).get("desktop", [])}
                for r in self.rows:
                    r.show_status((status.get("profiles", {}).get(r.profile) or {}).get("account"), r.profile in open_)
        except ValueError:
            pass  # the console is a nicety here: without it the names are enough
        reply.deleteLater()

    def _choose(self, profile: str) -> None:
        self.chosen.emit(profile)
        self.close()

    def keyPressEvent(self, e: QKeyEvent) -> None:
        k = e.key()
        if k == Qt.Key.Key_Escape:
            self.close()
        elif k in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and self.rows:
            self._choose(self.profiles[self.current])
        elif k in (Qt.Key.Key_Down, Qt.Key.Key_Tab):
            self._select(self.current + 1)
        elif k in (Qt.Key.Key_Up, Qt.Key.Key_Backtab):
            self._select(self.current - 1)
        elif Qt.Key.Key_1 <= k <= Qt.Key.Key_9 and k - Qt.Key.Key_1 < len(self.profiles):
            self._choose(self.profiles[k - Qt.Key.Key_1])
        else:
            super().keyPressEvent(e)

    def changeEvent(self, e) -> None:
        # a launcher: clicking elsewhere puts it away — only once it has had the focus (on Wayland it
        # may never get it), and later, not inside the event: closing deletes it (WA_DeleteOnClose)
        if e.type() == e.Type.ActivationChange:
            if self.isActiveWindow():
                self._had_focus = True
            elif getattr(self, "_had_focus", False) and self.isVisible():
                QTimer.singleShot(0, self.close)
        super().changeEvent(e)

    def closeEvent(self, e) -> None:
        self.closed.emit()
        super().closeEvent(e)
