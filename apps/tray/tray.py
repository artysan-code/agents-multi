"""tray.py — the tray icon: the setup's state at a glance, and a menu to act on it.

The state is the console's `/api/summary` (a pure function of `agents status`, tested in
apps/cli/tests/summary_test.ts): this module only draws it. It is refetched when the console says
something changed (`state` on the `/api/events` stream the page also listens to) and when the menu
opens — never on a timer. With the console down the icon turns grey and the stream reconnects with
a bounded backoff.

  no dot   all good (warnings are listed in the menu, they do not colour the icon)
  red      a doctor check fails
  grey     the console is not answering
"""

from __future__ import annotations

import json

from PySide6.QtCore import QObject, QPointF, QTimer, QUrl, Qt
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest
from PySide6.QtWidgets import QMenu, QSystemTrayIcon

from common import CONSOLE_URL, TITLE, manifests

DOTS = {"fail": "#d64545", "down": "#8a8f98"}
HEADLINES = {"ok": "All good", "fail": "Something needs attention", "down": "Console not running"}


def icon_for(level: str) -> QIcon:
    base = QIcon.fromTheme("claude-multi", QIcon.fromTheme("claude-desktop"))
    pm = base.pixmap(64, 64) if not base.isNull() else QPixmap(64, 64)
    if base.isNull():
        pm.fill(QColor("#D97757"))
    colour = DOTS.get(level)
    if colour:
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(0, 0, 0, 90))
        p.drawEllipse(QPointF(48, 48), 16, 16)
        p.setBrush(QColor(colour))
        p.drawEllipse(QPointF(48, 48), 13, 13)
        p.end()
    return QIcon(pm)


class Tray(QObject):
    def __init__(self, ctl) -> None:
        super().__init__(ctl)
        self.ctl = ctl
        self.summary: dict | None = None
        self.net = QNetworkAccessManager(self)
        self.inflight: QNetworkReply | None = None
        self.stream: QNetworkReply | None = None
        self.backoff = 0
        self.shown: tuple | None = None  # what the menu holds now: rebuilt only when it changes

        self.menu = QMenu()
        self.menu.aboutToShow.connect(self.refresh)
        self.icon = QSystemTrayIcon(icon_for("down"))
        self.icon.setToolTip(TITLE)
        self.icon.setContextMenu(self.menu)
        self.icon.activated.connect(self._activated)
        self._rebuild()
        self.icon.show()

        # Coalesce: a burst of state events is one refetch.
        self.debounce = QTimer(self, singleShot=True, interval=1000)
        self.debounce.timeout.connect(self.refresh)
        # The server pings every 25 s: a silent stream for 70 s is a dead one (sleep, restart).
        self.watchdog = QTimer(self, singleShot=True, interval=70000)
        self.watchdog.timeout.connect(self._stream_dead)
        self._listen()
        self.refresh()

    # ------------------------------------------------------------------ data
    def refresh(self) -> None:
        if self.inflight:
            return
        req = QNetworkRequest(QUrl(f"{CONSOLE_URL}/api/summary"))
        req.setTransferTimeout(20000)
        self.inflight = self.net.get(req)
        self.inflight.finished.connect(self._got_summary)

    def _got_summary(self) -> None:
        reply, self.inflight = self.inflight, None
        if reply is None:
            return
        try:
            ok = reply.error() == QNetworkReply.NetworkError.NoError
            self.summary = json.loads(bytes(reply.readAll()).decode()) if ok else None
        except ValueError:
            self.summary = None
        reply.deleteLater()
        self._rebuild()

    def _listen(self) -> None:
        req = QNetworkRequest(QUrl(f"{CONSOLE_URL}/api/events"))
        req.setTransferTimeout(0)
        self.stream = self.net.get(req)
        self.stream.readyRead.connect(self._on_events)
        self.stream.finished.connect(self._stream_closed)
        self.watchdog.start()

    def _on_events(self) -> None:
        self.backoff = 0
        self.watchdog.start()
        chunk = bytes(self.stream.readAll()).decode(errors="replace")
        if "event: state" in chunk:
            self.debounce.start()

    def _stream_dead(self) -> None:
        if self.stream:
            self.stream.abort()  # → finished → reconnect

    def _stream_closed(self) -> None:
        self.watchdog.stop()
        if self.stream:
            self.stream.deleteLater()
            self.stream = None
        self.summary = None
        self._rebuild()
        delay = min(30000, 2000 * 2 ** self.backoff)
        self.backoff = min(self.backoff + 1, 4)
        QTimer.singleShot(delay, self._reconnect)

    def _reconnect(self) -> None:
        self._listen()
        self.refresh()

    # ------------------------------------------------------------------ view
    def _activated(self, reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.ctl.toggle_console()

    def _rebuild(self) -> None:
        s = self.summary
        level = s["level"] if s else "down"
        self.icon.setIcon(icon_for(level))

        lines: list[str] = []
        if s:
            lines += [f"✗ {m}" for m in s["fails"]]
            if s["staged"]:
                lines.append(f"Claude Desktop {s['staged']} is ready: it switches at the next launch")
            if s["warns"]:
                lines.append(f"{len(s['warns'])} warning{'s' if len(s['warns']) != 1 else ''}")
            # always there, 0 · 0 too: the menu keeps its width, and Plasma draws the submenu arrow
            # of "Open Claude Desktop" over the label when that is the widest line (issue #3)
            run = s["running"]
            lines.append(f"Running: {run['cli']} CLI · {run['desktop']} Desktop")
        self.icon.setToolTip("\n".join([f"{TITLE} — {HEADLINES[level]}", *lines]))

        # the menu refetches as it opens: clearing it while it is on screen leaves Plasma a stale
        # layout, so it changes only when what it shows does
        profiles = manifests()
        shown = lines[:-1][:5] + lines[-1:] if s else []  # the Running line survives the cut
        view = (level, tuple(shown), tuple(profiles), bool(s))
        if view == self.shown:
            return
        self.shown = view
        m = self.menu
        m.clear()
        self._label(HEADLINES[level])
        for line in shown:
            self._label(line)
        m.addSeparator()
        m.addAction("Hey Claude…", lambda: self.ctl.show_hey())
        m.addAction("Open console", lambda: self.ctl.show_console())
        launch = m.addMenu("Open Claude Desktop")
        for p in profiles:
            launch.addAction(p, lambda p=p: self.ctl.launch(p))
        m.addAction("Updates", lambda: self.ctl.show_console("system/updates"))
        m.addAction("Health", lambda: self.ctl.show_console("system/health"))
        if not s:
            m.addAction("Start the console", self.ctl.start_console)
        m.addSeparator()
        m.addAction("Quit", self.ctl.quit)

    def _label(self, text: str) -> None:
        a = QAction(text, self.menu)
        a.setEnabled(False)
        self.menu.addAction(a)
