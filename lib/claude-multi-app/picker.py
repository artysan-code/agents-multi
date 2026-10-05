"""picker.py — «Claude» in the menu: one entry for every profile, a small window to choose which.

The profiles come from their manifests (common.manifests), so the window opens even with the console
down; the console's /api/status then adds what it knows — the account each profile is signed in to,
and whether its Claude Desktop is already open. Choosing one runs claude-launch, which starts that
Desktop or, when it is already open, brings its window forward (Electron keeps one instance per
user-data-dir).

Keys: ↑ ↓ or 1–9 to choose, Enter to open, Esc to close. The machine's default profile (plain
`claude`) is selected first.
"""

from __future__ import annotations

import json

from PySide6.QtCore import QSize, Qt, QUrl, Signal
from PySide6.QtGui import QIcon, QKeyEvent
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest
from PySide6.QtWidgets import QLabel, QListWidget, QListWidgetItem, QVBoxLayout, QWidget

from common import CONSOLE_URL, default_profile, manifests


class Picker(QWidget):
    closed = Signal()
    chosen = Signal(str)

    def __init__(self) -> None:
        super().__init__(None, Qt.WindowType.Dialog)
        self.setWindowTitle("Claude")
        self.setWindowIcon(QIcon.fromTheme("claude-desktop"))
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        self.setMinimumWidth(360)

        head = QLabel("Which Claude?")
        head.setStyleSheet("font-size: 15px; font-weight: 600; padding: 2px 2px 6px;")
        self.list = QListWidget()
        self.list.setIconSize(QSize(32, 32))
        self.list.setSpacing(2)
        self.list.setStyleSheet("QListWidget { border: none; } QListWidget::item { padding: 8px 6px; border-radius: 6px; }")
        self.list.itemActivated.connect(lambda it: self._choose(it.data(Qt.ItemDataRole.UserRole)))
        hint = QLabel("Enter to open · Esc to close")
        hint.setStyleSheet("color: palette(placeholder-text); font-size: 11px; padding: 6px 2px 0;")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 10)
        lay.addWidget(head)
        lay.addWidget(self.list)
        lay.addWidget(hint)

        self.profiles = list(manifests())
        self._fill({})
        self.net = QNetworkAccessManager(self)
        req = QNetworkRequest(QUrl(f"{CONSOLE_URL}/api/status"))
        req.setTransferTimeout(5000)
        self.reply = self.net.get(req)
        self.reply.finished.connect(self._got_status)

    def _fill(self, status: dict) -> None:
        current = self.list.currentItem().data(Qt.ItemDataRole.UserRole) if self.list.currentItem() else default_profile()
        open_ = {d.get("variant") for d in status.get("running", {}).get("desktop", [])}
        self.list.clear()
        for i, p in enumerate(self.profiles, 1):
            account = (status.get("profiles", {}).get(p) or {}).get("account")
            sub = " · ".join(x for x in [account, "open" if p in open_ else None] if x)
            icon = QIcon.fromTheme(f"claude-desktop-{p}")
            if icon.isNull():
                icon = QIcon.fromTheme("claude-desktop")
            it = QListWidgetItem(icon, f"{p.capitalize()}\n{sub}" if sub else p.capitalize())
            it.setData(Qt.ItemDataRole.UserRole, p)
            it.setToolTip(f"{i} · claude-launch {p}")
            self.list.addItem(it)
            if p == current:
                self.list.setCurrentItem(it)
        self.list.setFixedHeight(self.list.sizeHintForRow(0) * max(1, len(self.profiles)) + 8 * len(self.profiles) + 4)

    def _got_status(self) -> None:
        reply, self.reply = self.reply, None
        try:
            if reply.error() == QNetworkReply.NetworkError.NoError:
                self._fill(json.loads(bytes(reply.readAll()).decode()))
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
        elif k in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and self.list.currentItem():
            self._choose(self.list.currentItem().data(Qt.ItemDataRole.UserRole))
        elif Qt.Key.Key_1 <= k <= Qt.Key.Key_9 and k - Qt.Key.Key_1 < len(self.profiles):
            self._choose(self.profiles[k - Qt.Key.Key_1])
        else:
            super().keyPressEvent(e)

    def closeEvent(self, e) -> None:
        self.closed.emit()
        super().closeEvent(e)

