"""console.py — the console (`claude-multi serve`) in a window of its own.

The page is the one the browser gets from 127.0.0.1: nothing is rebuilt here. What the window adds
is being an application — its own icon and entry in the menu — and a clear answer when the console
is not running, with a button that starts it.

Links that leave the console open in the system browser: this window only ever shows the console.
The web engine keeps its storage (the page's theme, say) under DATA_DIR.
"""

from __future__ import annotations

from PySide6.QtCore import QProcess, QTimer, QUrl, Qt, Signal
from PySide6.QtGui import QDesktopServices, QIcon
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QHBoxLayout, QLabel, QMainWindow, QPushButton, QStackedWidget, QVBoxLayout, QWidget

from common import CONSOLE_UNIT, CONSOLE_URL, DATA_DIR, NAME, PORT

KEEP_MS = 20 * 60 * 1000


def _is_console(url: QUrl) -> bool:
    return url.scheme() == "http" and url.host() == "127.0.0.1" and url.port() == PORT


class ConsolePage(QWebEnginePage):
    def acceptNavigationRequest(self, url, _type, is_main_frame) -> bool:
        if _is_console(url) or not is_main_frame:
            return True
        QDesktopServices.openUrl(url)
        return False

    def createWindow(self, _type):
        # target="_blank": a throwaway page whose first navigation goes to the system browser
        return _External(self.profile(), self)


class _External(QWebEnginePage):
    def acceptNavigationRequest(self, url, _type, _main) -> bool:
        QDesktopServices.openUrl(url)
        self.deleteLater()
        return False


def web_profile(parent) -> QWebEngineProfile:
    """One per process, owned by the application: a page must be gone before its profile is, so the
    profile outlives every window that is opened and destroyed."""
    profile = QWebEngineProfile(NAME, parent)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    profile.setPersistentStoragePath(str(DATA_DIR))
    profile.setCachePath(str(DATA_DIR / "cache"))
    return profile


class ConsoleWindow(QMainWindow):
    closed = Signal()

    def __init__(self, profile: QWebEngineProfile) -> None:
        super().__init__()
        self.setWindowTitle(NAME)
        self.setWindowIcon(QIcon.fromTheme("claude-desktop"))
        self.resize(1280, 860)
        # Closed, the window is hidden and kept a while: reopening is instant, where building the
        # web engine again takes seconds on a slower machine. After KEEP_MS unused it is destroyed,
        # so the tray alone stays light. `keep` is off without a tray: then closing means leaving.
        self.keep = True
        self._reap = QTimer(self, singleShot=True, interval=KEEP_MS)
        self._reap.timeout.connect(self._destroy)

        self.view = QWebEngineView(self)
        self.view.setPage(ConsolePage(profile, self.view))
        self.view.loadFinished.connect(self._loaded)

        self.stack = QStackedWidget(self)
        self.stack.addWidget(self.view)
        self.stack.addWidget(self._offline())
        self.setCentralWidget(self.stack)

    def _offline(self) -> QWidget:
        w = QWidget(self)
        col = QVBoxLayout(w)
        col.addStretch(1)
        title = QLabel("The console is not answering")
        title.setStyleSheet("font-size: 16pt; font-weight: 600;")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        col.addWidget(title)
        hint = QLabel(f"Nothing on {CONSOLE_URL}. It runs as the systemd user unit {CONSOLE_UNIT}.")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setWordWrap(True)
        col.addWidget(hint)
        row = QHBoxLayout()
        row.addStretch(1)
        start = QPushButton("Start the console")
        start.clicked.connect(self._start_console)
        row.addWidget(start)
        retry = QPushButton("Retry")
        retry.clicked.connect(lambda: self.open())
        row.addWidget(retry)
        row.addStretch(1)
        col.addLayout(row)
        col.addStretch(2)
        return w

    def _start_console(self) -> None:
        QProcess.startDetached("systemctl", ["--user", "start", CONSOLE_UNIT])
        QTimer.singleShot(1500, self.open)

    def _loaded(self, ok: bool) -> None:
        self.stack.setCurrentIndex(0 if ok else 1)

    def open(self, view: str | None = None) -> None:
        """Show the console on a view (#today, #system/health…): Today unless another is asked for,
        as an application opens on its start page."""
        self._reap.stop()
        view = view or "today"
        current = self.view.url()
        if _is_console(current) and self.stack.currentIndex() == 0:
            # already showing it: no reload, and a view is a hashchange the page follows
            if view:
                self.view.page().runJavaScript(f"location.hash = {view!r}")
        else:
            self.view.setUrl(QUrl(f"{CONSOLE_URL}/" + (f"#{view}" if view else "")))
        self.show()
        self.raise_()
        self.activateWindow()

    def closeEvent(self, event) -> None:
        if self.keep:
            event.ignore()
            self.hide()
            self._reap.start()
            return
        self._destroy()
        super().closeEvent(event)

    def _destroy(self) -> None:
        self.closed.emit()
        self.deleteLater()
