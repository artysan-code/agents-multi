#!/usr/bin/env python3
"""claude-multi-app — the desktop app: tray icon and console window.

A view of the CLI, like everything that is not the CLI: state comes from the console server
(`claude-multi serve`, its own systemd unit, still reachable from a browser or over ssh), actions go
through the same commands a terminal would run. There is no setup logic here.

  claude-multi-app              open the console window (starting the app if it is not running)
  claude-multi-app --tray       start in the tray, no window: what the login unit runs
  claude-multi-app --hey        «Hey Claude»: the quick entry (bind it to a global shortcut)

Updates need no window: the timer installs them (bin/claude-update --auto) and the console's
System › Updates shows what happened.

One instance per session: a second start hands its request to the first over a local socket and
exits.

Without a system tray (GNOME without the AppIndicator extension) the app still opens its windows and
quits when the last one closes; `--tray` gives up after a minute and says so to the doctor.
"""

from __future__ import annotations

import subprocess
import sys
import time

from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QSystemTrayIcon

from common import BIN, CONSOLE_UNIT, CONSOLE_URL, NAME, SOCKET, write_state

TRAY_WAIT_S = 60  # at login the tray host can come up after us


class Controller(QObject):
    def __init__(self, app: QApplication) -> None:
        super().__init__()
        self.app = app
        self.tray = None
        self.window = None
        self.hey = None
        self._profile = None

    # ------------------------------------------------------------------ requests
    def handle(self, cmd: str) -> None:
        if cmd.startswith("hey"):
            self.show_hey(cmd.partition(":")[2])
        elif cmd.startswith("show"):
            self.show_console(cmd.partition(":")[2] or None)
        # "tray": already running, nothing to do

    def enable_tray(self) -> None:
        from tray import Tray
        self.tray = Tray(self)

    def toggle_console(self) -> None:
        if self.window and self.window.isVisible() and self.window.isActiveWindow():
            self.window.close()
        else:
            self.show_console()

    def show_console(self, view: str | None = None) -> None:
        # Imported on first use: the web engine is the heavy part, and a tray that is never
        # clicked should not pay for it.
        from console import ConsoleWindow, web_profile
        if self.window is None:
            if self._profile is None:
                self._profile = web_profile(self.app)
            self.window = ConsoleWindow(self._profile)
            self.window.closed.connect(self._window_closed)
        self.window.open(view)

    def show_hey(self, text: str = "") -> None:
        """The quick entry. `text` arrives base64-encoded (the console's Today bar prefills it)."""
        import base64
        from hey import HeyPanel
        try:
            text = base64.b64decode(text).decode() if text else ""
        except ValueError:
            text = ""
        if self.hey is None:
            self.hey = HeyPanel(recent_folders(), text)
            self.hey.closed.connect(self._hey_closed)
        elif text:
            self.hey.set_text(text)
        self.hey.show()
        self.hey.raise_()
        self.hey.activateWindow()
        self.hey.text.setFocus()

    def _hey_closed(self) -> None:
        self.hey.deleteLater()
        self.hey = None
        QTimer.singleShot(0, self._maybe_quit)

    def _window_closed(self) -> None:
        self.window = None
        QTimer.singleShot(0, self._maybe_quit)

    def launch(self, profile: str) -> None:
        subprocess.Popen([str(BIN / "claude-launch"), profile], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def start_console(self) -> None:
        subprocess.Popen(["systemctl", "--user", "start", CONSOLE_UNIT], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if self.tray:
            QTimer.singleShot(1500, self.tray.refresh)

    def _maybe_quit(self) -> None:
        """Without a tray nothing keeps the app alive but its windows."""
        if not self.tray and not self.window and not self.hey:
            self.app.quit()

    def quit(self) -> None:
        self.app.quit()


def recent_folders() -> list[str]:
    """The folders of the last sessions, for the panel's folder list (the console knows them)."""
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(f"{CONSOLE_URL}/api/sessions?since=14d&limit=60", timeout=2) as r:
            rows = json.loads(r.read())
    except (OSError, ValueError):
        return []
    seen: list[str] = []
    for row in rows:
        if row.get("cwd") and row["cwd"] not in seen:
            seen.append(row["cwd"])
    return seen[:12]


# ---------------------------------------------------------------------- single instance
def forward(cmd: str) -> bool:
    """Hand the request to a running instance. False when there is none."""
    s = QLocalSocket()
    s.connectToServer(SOCKET)
    if not s.waitForConnected(500):
        return False
    s.write(cmd.encode() + b"\n")
    s.flush()
    s.waitForBytesWritten(500)
    s.disconnectFromServer()
    return True


def listen(ctl: Controller) -> QLocalServer:
    QLocalServer.removeServer(SOCKET)  # a stale socket left by a crash
    srv = QLocalServer(ctl)
    srv.listen(SOCKET)

    def accept() -> None:
        conn = srv.nextPendingConnection()

        def read() -> None:
            while conn.canReadLine():
                ctl.handle(bytes(conn.readLine()).decode().strip())
        conn.readyRead.connect(read)
        conn.disconnected.connect(lambda: (read(), conn.deleteLater()))
        read()  # what arrived before the connection was wired up
    srv.newConnection.connect(accept)
    return srv


# ---------------------------------------------------------------------- entry points
def main() -> int:
    cmd = "tray" if "--tray" in sys.argv[1:] else "hey" if "--hey" in sys.argv[1:] else "show"

    app = QApplication(sys.argv)
    app.setApplicationName(NAME)
    app.setDesktopFileName(NAME)
    app.setWindowIcon(QIcon.fromTheme("claude-desktop"))
    app.setQuitOnLastWindowClosed(False)
    if forward(cmd):
        return 0

    ctl = Controller(app)
    _srv = listen(ctl)  # noqa: F841 — kept alive for the app's lifetime

    deadline = time.monotonic() + (TRAY_WAIT_S if cmd == "tray" else 0)

    def attach_tray() -> None:
        if QSystemTrayIcon.isSystemTrayAvailable():
            write_state(tray=True)
            ctl.enable_tray()
        elif time.monotonic() < deadline:
            QTimer.singleShot(1000, attach_tray)
        else:
            write_state(tray=False)
            if cmd == "tray":
                print(f"{NAME}-app: no system tray in this session", file=sys.stderr)
            ctl._maybe_quit()

    attach_tray()
    if cmd == "show":
        ctl.show_console()
    elif cmd == "hey":
        ctl.show_hey()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
