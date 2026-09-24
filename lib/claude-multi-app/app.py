#!/usr/bin/env python3
"""claude-multi-app — the desktop app: tray icon, console window, update gate.

A view of the CLI, like everything that is not the CLI: state comes from the console server
(`claude-multi serve`, its own systemd unit, still reachable from a browser or over ssh), actions go
through the same commands a terminal would run. There is no setup logic here.

  claude-multi-app              open the console window (starting the app if it is not running)
  claude-multi-app --tray       start in the tray, no window: what the login unit runs
  claude-multi-app --updates    open the update gate (the timer's notification uses this)
  claude-multi-app --gate --profile <p> [--state <json>]
                                the gate before Claude Desktop opens, as a process of its own:
                                blocking, with the exit codes claude-launch reads (see gate.py)
  claude-multi-app --gate --demo [--demo-uptodate] [--standalone]
                                the gate with invented versions, to look at it

One instance per session: a second start hands its request to the first over a local socket and
exits. `--gate` is the exception — claude-launch waits on that process and reads its exit code.

Without a system tray (GNOME without the AppIndicator extension) the app still opens its windows and
quits when the last one closes; `--tray` gives up after a minute and says so to the doctor.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

from PySide6.QtCore import QObject, QThread, QTimer, Signal
from PySide6.QtGui import QIcon
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWidgets import QApplication, QMessageBox, QSystemTrayIcon

from common import BIN, CONSOLE_UNIT, NAME, SOCKET, default_profile, write_state
from gate import EXIT_ERROR, EXIT_LAUNCH_ASIS, UpdateGate, drop_skipped

TRAY_WAIT_S = 60  # at login the tray host can come up after us


def load_state(argv: list[str]) -> dict:
    """Versions: from the caller via --state (saves a second network round), or checked here."""
    if "--state" in argv:
        return json.loads(argv[argv.index("--state") + 1])
    out = subprocess.run([str(BIN / "claude-update"), "--check", "--json"],
                         capture_output=True, text=True, timeout=40).stdout
    return json.loads(out)


class CheckWorker(QThread):
    """The update check takes seconds of network: off the UI thread, or the tray freezes."""
    done = Signal(dict)
    failed = Signal(str)

    def run(self) -> None:
        try:
            self.done.emit(drop_skipped(load_state([])))
        except Exception as exc:  # noqa: BLE001 — shown to the user, the app stays up
            self.failed.emit(str(exc))


class Controller(QObject):
    def __init__(self, app: QApplication) -> None:
        super().__init__()
        self.app = app
        self.tray = None
        self.window = None
        self.gate: UpdateGate | None = None
        self.worker: CheckWorker | None = None
        self._profile = None
        self._closing: list[UpdateGate] = []  # closed gates whose status thread is still running
        # Qt aborts the process if a QThread is destroyed while it runs, and quitting destroys
        # everything: the threads still out finish first (a status read takes a few seconds).
        app.aboutToQuit.connect(self._drain)

    # ------------------------------------------------------------------ requests
    def handle(self, cmd: str) -> None:
        if cmd == "updates":
            self.show_updates()
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

    def _window_closed(self) -> None:
        self.window = None
        QTimer.singleShot(0, self._maybe_quit)

    def show_updates(self) -> None:
        if self.gate:
            self.gate.raise_()
            self.gate.activateWindow()
            return
        if self.worker:
            return  # a check is already running
        if self.tray:
            self.tray.icon.showMessage(NAME, "Checking for updates…", QSystemTrayIcon.MessageIcon.NoIcon, 3000)
        self.worker = CheckWorker(self)
        self.worker.done.connect(self._open_gate)
        self.worker.failed.connect(self._check_failed)
        self.worker.start()

    def _open_gate(self, state: dict) -> None:
        self.worker = None
        self.gate = UpdateGate(state, default_profile(), standalone=True, on_console=self.show_console)
        self.gate.finished.connect(self._gate_closed)
        self.gate.show()
        self.gate.raise_()
        self.gate.activateWindow()

    def _check_failed(self, msg: str) -> None:
        self.worker = None
        QMessageBox.warning(None, NAME, f"The update check failed (offline?).\n\n{msg}")
        self._maybe_quit()

    def _gate_closed(self) -> None:
        # The gate reads `claude-multi status` in a thread of its own. Closed before that returns,
        # deleting it would destroy a running QThread, and Qt aborts the whole process for that.
        gate, self.gate = self.gate, None
        worker = getattr(gate, "worker", None)
        if worker is not None and worker.isRunning():
            gate.hide()
            self._closing.append(gate)
            worker.finished.connect(lambda: (self._closing.remove(gate), gate.deleteLater()))
        else:
            gate.deleteLater()
        if self.tray:
            self.tray.refresh()
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
        if not self.tray and not self.window and not self.gate and not self.worker:
            self.app.quit()

    def _drain(self) -> None:
        for t in (self.worker, getattr(self.gate, "worker", None), *(g.worker for g in self._closing)):
            if t is not None and t.isRunning():
                t.wait(60000)

    def quit(self) -> None:
        self.app.quit()


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
def run_gate(argv: list[str]) -> int:
    """The gate before Claude Desktop opens: a process of its own, its exit code is the answer."""
    demo = "--demo" in argv
    profile = argv[argv.index("--profile") + 1] if "--profile" in argv else default_profile()
    app = QApplication(sys.argv)
    app.setApplicationName(NAME)
    app.setDesktopFileName(NAME)
    if demo:
        outdated = "--demo-uptodate" not in argv
        state = {
            "cli": {"current": "2.1.220", "latest": "2.1.221", "outdated": outdated},
            "desktop": {"current": "1.24012.9", "latest": "1.24013.0", "outdated": outdated},
        }
    else:
        try:
            state = drop_skipped(load_state(argv))
        except Exception as exc:  # noqa: BLE001 — any error here means "open Claude anyway"
            print(f"{NAME}-app: update check failed ({exc})", file=sys.stderr)
            return EXIT_ERROR
        if not (state.get("desktop", {}).get("outdated") or state.get("cli", {}).get("outdated")):
            return EXIT_LAUNCH_ASIS
    gate = UpdateGate(state, profile, demo=demo, standalone="--standalone" in argv)
    gate.show()
    gate.raise_()
    gate.activateWindow()
    app.exec()
    # The answer is known and claude-launch is waiting for it. Closed quickly, the gate may still
    # be reading `claude-multi status` in a thread, and tearing down a running QThread aborts the
    # process (a core dump, and exit 134 instead of the answer): leave without the teardown.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(gate.result_code)


def main() -> int:
    argv = sys.argv[1:]
    if "--gate" in argv:
        return run_gate(argv)
    cmd = "updates" if "--updates" in argv else "tray" if "--tray" in argv else "show"

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
    elif cmd == "updates":
        ctl.show_updates()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
