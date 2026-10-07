//! The console's backend, owned by the app (docs/adr/0003): `agents serve` as a child process.
//!
//! On start, a console that already answers `GET /api/code` on the port (the systemd unit during the
//! transition, one started by hand) is used as it is: nothing is spawned, and the app never stops or
//! restarts it. Otherwise the app starts the backend — the compiled sidecar next to its executable,
//! or, in a debug build without one, the checkout's `bin/agents` (Deno) — with its output in
//! `backend.log` in the app's log folder. If it dies, the window goes back to the local page (which
//! waits for the console) and the backend is restarted after a delay that doubles up to a cap; after
//! too many quick failures in a row the app stops trying. On exit the app stops only the process it
//! started: SIGTERM, then SIGKILL after a grace period. On Linux the child also gets SIGTERM when the
//! app dies without exiting cleanly (a signal, a crash), so it never outlives the app.
//!
//! A plugin only to hook into the app's start and exit: it has no commands, so no page can reach it.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Runtime};
use url::Url;

use crate::{console, repo};

/// The sidecar's name next to the app's executable (`bundle.externalBin` without the target triple).
const SIDECAR: &str = "agents-multi-backend";
/// How long a stopped backend has to exit after SIGTERM before it is killed.
const GRACE: Duration = Duration::from_secs(5);
/// A backend that ran this long was healthy: its exit starts the backoff over.
const STABLE: Duration = Duration::from_secs(60);
const FIRST_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(30);
/// Quick failures in a row after which the app stops restarting the backend.
const MAX_FAILURES: u32 = 8;
const POLL: Duration = Duration::from_millis(250);
/// A log larger than this is moved to `backend.log.1` when the backend starts.
const LOG_LIMIT: u64 = 2 * 1024 * 1024;

/// The plugin that starts the backend with the app and stops it on exit.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("agents-multi-backend")
        .setup(|app, _api| {
            app.manage(Backend::start(app.clone(), console::port()));
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Backend>().stop();
            }
        })
        .build()
}

/// The backend the app supervises; `stop` ends it, and only it.
pub struct Backend {
    shared: Arc<Shared>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct Shared {
    /// The running child: taken out by whoever reaps it, so a pid is never signalled after its reaping.
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

impl Shared {
    fn child(&self) -> MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

impl Backend {
    fn start<R: Runtime>(app: AppHandle<R>, port: u16) -> Self {
        let shared = Arc::new(Shared::default());
        let s = shared.clone();
        let supervisor = thread::Builder::new()
            .name("backend".into())
            .spawn(move || supervise(&app, port, &s))
            .map_err(|e| log(&format!("cannot start the backend's supervisor: {e}")))
            .ok();
        Backend {
            shared,
            supervisor: Mutex::new(supervisor),
        }
    }

    /// Stops the backend the app started, if it did, and its supervision. Idempotent.
    pub fn stop(&self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.shared.child().take() {
            log(&format!("stopping the backend (pid {})", child.id()));
            terminate(&mut child, GRACE);
        }
        let handle = self
            .supervisor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

fn log(message: &str) {
    eprintln!("agents-multi: {message}");
}

/// The supervisor's thread: it is also the thread that spawns the child, which matters on Linux, where
/// the parent-death signal follows the spawning thread.
fn supervise<R: Runtime>(app: &AppHandle<R>, port: u16, shared: &Shared) {
    if answers(port) {
        log(&format!(
            "a console already answers on port {port}: using it, no backend started"
        ));
        return;
    }
    let repo = match repo::from_env() {
        Ok(repo) => repo,
        Err(e) => return log(&format!("no backend started: {e}")),
    };
    let sidecar = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join(sidecar_name())))
        .filter(|p| p.is_file());
    let Some(launch) = Launch::choose(sidecar, cfg!(debug_assertions), &repo) else {
        return log(&format!(
            "no backend started: {} is missing next to the app",
            sidecar_name()
        ));
    };
    let log_path = app.path().app_log_dir().map(|dir| dir.join("backend.log"));
    let mut failures = 0;
    loop {
        let started = Instant::now();
        {
            let mut slot = shared.child();
            if shared.stopping() {
                return;
            }
            match spawn(&launch, port, &repo, log_path.as_ref().ok()) {
                Ok(child) => {
                    log(&format!(
                        "backend started (pid {}): {}",
                        child.id(),
                        launch.describe()
                    ));
                    *slot = Some(child);
                }
                Err(e) => log(&format!("cannot start the backend: {e}")),
            }
        }
        match wait(shared) {
            Some(status) => log(&format!("the backend exited ({status})")),
            None if shared.stopping() => return,
            None => {}
        }
        back_to_local_page(app, port);
        if started.elapsed() >= STABLE {
            failures = 0;
        }
        failures += 1;
        let Some(delay) = restart_delay(failures) else {
            return log(&format!(
                "the backend failed {MAX_FAILURES} times in a row: not restarting it (see {})",
                log_path
                    .as_ref()
                    .map_or("its log".into(), |p| p.display().to_string())
            ));
        };
        log(&format!("restarting the backend in {}s", delay.as_secs()));
        if !sleep_unless_stopping(shared, delay) {
            return;
        }
        if answers(port) {
            return log(&format!(
                "another console now answers on port {port}: using it, not restarting the backend"
            ));
        }
    }
}

/// Waits for the child to exit; `None` when there is none to wait for (stopped, never started).
fn wait(shared: &Shared) -> Option<ExitStatus> {
    loop {
        {
            let mut slot = shared.child();
            let child = slot.as_mut()?;
            match child.try_wait() {
                Ok(Some(status)) => {
                    slot.take();
                    return Some(status);
                }
                Ok(None) => {}
                Err(e) => {
                    log(&format!("cannot wait for the backend: {e}"));
                    let mut child = slot.take()?;
                    terminate(&mut child, GRACE);
                    return None;
                }
            }
        }
        thread::sleep(POLL);
    }
}

/// Sleeps `delay`, waking early when the app stops; false when it does.
fn sleep_unless_stopping(shared: &Shared, delay: Duration) -> bool {
    let until = Instant::now() + delay;
    while Instant::now() < until {
        if shared.stopping() {
            return false;
        }
        thread::sleep(POLL.min(until - Instant::now()));
    }
    !shared.stopping()
}

/// The delay before restart number `failures` (1 for the first): doubling from `FIRST_DELAY` up to
/// `MAX_DELAY`, none after `MAX_FAILURES`.
pub fn restart_delay(failures: u32) -> Option<Duration> {
    if failures == 0 || failures > MAX_FAILURES {
        return None;
    }
    let factor = 1u32 << (failures - 1).min(16);
    Some((FIRST_DELAY * factor).min(MAX_DELAY))
}

/// SIGTERM, then SIGKILL when `grace` passes; reaps the child either way.
fn terminate(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    {
        // The child is not reaped yet (we own it), so its pid is still its own.
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        let until = Instant::now() + grace;
        while Instant::now() < until {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        log(&format!(
            "the backend (pid {}) did not stop in {}s: killing it",
            child.id(),
            grace.as_secs()
        ));
    }
    #[cfg(not(unix))]
    let _ = grace;
    let _ = child.kill();
    let _ = child.wait();
}

/// What runs the backend.
#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    program: PathBuf,
    args: Vec<String>,
}

impl Launch {
    /// The sidecar when it is there; in a debug build without one, the repository's `bin/agents`, which
    /// runs the CLI with Deno and its own permissions; else nothing.
    pub fn choose(sidecar: Option<PathBuf>, debug: bool, repo: &Path) -> Option<Self> {
        let program = match sidecar {
            Some(path) => path,
            None if debug => repo.join("bin/agents"),
            None => return None,
        };
        Some(Launch {
            program,
            args: vec!["serve".into(), "--no-open".into()],
        })
    }

    fn describe(&self) -> String {
        format!("{} {}", self.program.display(), self.args.join(" "))
    }
}

fn sidecar_name() -> String {
    format!("{SIDECAR}{}", std::env::consts::EXE_SUFFIX)
}

fn spawn(
    launch: &Launch,
    port: u16,
    repo: &Path,
    log_path: Option<&PathBuf>,
) -> std::io::Result<Child> {
    let (out, err) = match log_path.map(|p| open_log(p, launch)) {
        Some(Ok(file)) => (Stdio::from(file.try_clone()?), Stdio::from(file)),
        Some(Err(e)) => {
            log(&format!("cannot open the backend's log: {e}"));
            (Stdio::inherit(), Stdio::inherit())
        }
        None => (Stdio::inherit(), Stdio::inherit()),
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = child_path(home.as_deref(), std::env::var_os("PATH"));
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .current_dir(repo)
        .env("AGENTS_MULTI_PORT", port.to_string())
        .env("AGENTS_MULTI_REPO", repo)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // the app died before the signal was armed
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("the app is gone"));
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
}

/// The log file, appended to, with a line that marks each start; a large one is moved aside first.
fn open_log(path: &Path, launch: &Launch) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if path.metadata().is_ok_and(|m| m.len() > LOG_LIMIT) {
        std::fs::rename(path, path.with_extension("log.1"))?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    writeln!(file, "--- {now} (unix time) {}", launch.describe())?;
    Ok(file)
}

/// The PATH the backend gets: the app's own, then the folders the systemd unit lists
/// (systemd/user/claude-multi-console.service) that it lacks. A desktop session's PATH often has no
/// `~/.deno/bin`, and the console runs `bin/agents` (Deno), git and Claude.
pub fn child_path(
    home: Option<&Path>,
    current: Option<std::ffi::OsString>,
) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = current
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut wanted: Vec<PathBuf> = home
        .map(|h| {
            [
                ".deno/bin",
                ".local/bin",
                ".local/share/pnpm/bin",
                ".local/share/pnpm",
            ]
            .iter()
            .map(|d| h.join(d))
            .collect()
        })
        .unwrap_or_default();
    if cfg!(unix) {
        wanted.extend(["/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    }
    for dir in wanted {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).ok()
}

/// Whether a console answers `GET /api/code` on the port with 200.
fn answers(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let timeout = Some(Duration::from_secs(3));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    let request =
        format!("GET /api/code HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 64];
    let mut len = 0;
    while len < head.len() {
        match stream.read(&mut head[len..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => len += n,
        }
        if head[..len].contains(&b'\n') {
            break;
        }
    }
    is_ok_status(&head[..len])
}

/// Whether an HTTP response starts with a 200 status line.
pub fn is_ok_status(head: &[u8]) -> bool {
    let line = head.split(|b| *b == b'\n').next().unwrap_or_default();
    let mut parts = std::str::from_utf8(line).unwrap_or("").split_whitespace();
    matches!(parts.next(), Some(v) if v.starts_with("HTTP/1.")) && parts.next() == Some("200")
}

/// The bundled local page, which waits for the console on `port` and returns to it.
pub fn local_page(port: u16) -> Url {
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    Url::parse(&format!("{origin}/index.html?port={port}")).expect("a valid URL")
}

/// When the backend is gone, a window showing the console goes back to the local page.
fn back_to_local_page<R: Runtime>(app: &AppHandle<R>, port: u16) {
    let console = console::url(port);
    for window in app.webview_windows().values() {
        if window.url().is_ok_and(|u| u.origin() == console.origin()) {
            if let Err(e) = window.navigate(local_page(port)) {
                log(&format!("cannot show the local page: {e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_doubles_to_a_cap_and_stops() {
        let secs: Vec<_> = (1..=MAX_FAILURES)
            .map(|n| restart_delay(n).unwrap().as_secs())
            .collect();
        assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(restart_delay(MAX_FAILURES + 1), None);
        assert_eq!(restart_delay(0), None);
    }

    #[test]
    fn the_sidecar_comes_first_and_debug_falls_back_to_deno() {
        let repo = Path::new("/r");
        let sidecar = PathBuf::from("/app/agents-multi-backend");
        let serve = vec!["serve".to_string(), "--no-open".to_string()];
        assert_eq!(
            Launch::choose(Some(sidecar.clone()), false, repo),
            Some(Launch {
                program: sidecar.clone(),
                args: serve.clone()
            })
        );
        assert_eq!(
            Launch::choose(Some(sidecar.clone()), true, repo),
            Some(Launch {
                program: sidecar,
                args: serve.clone()
            })
        );
        assert_eq!(
            Launch::choose(None, true, repo),
            Some(Launch {
                program: PathBuf::from("/r/bin/agents"),
                args: serve
            })
        );
        assert_eq!(Launch::choose(None, false, repo), None);
    }

    #[test]
    fn status_line() {
        assert!(is_ok_status(b"HTTP/1.1 200 OK\r\ncontent-type: x"));
        assert!(is_ok_status(b"HTTP/1.0 200 OK"));
        assert!(!is_ok_status(b"HTTP/1.1 404 Not Found\r\n"));
        assert!(!is_ok_status(b"HTTP/1.1 2000"));
        assert!(!is_ok_status(b"SSH-2.0-OpenSSH_9.9\r\n"));
        assert!(!is_ok_status(b""));
    }

    #[cfg(unix)]
    #[test]
    fn path_keeps_its_order_and_gains_the_units_folders() {
        let got = child_path(
            Some(Path::new("/h")),
            Some("/opt/x:/usr/bin:/h/.local/bin".into()),
        )
        .unwrap();
        assert_eq!(
            got,
            "/opt/x:/usr/bin:/h/.local/bin:/h/.deno/bin:/h/.local/share/pnpm/bin:/h/.local/share/pnpm:/usr/local/bin:/bin"
        );
        assert_eq!(
            child_path(None, None).unwrap(),
            "/usr/local/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn local_page_carries_the_port() {
        let page = local_page(7341);
        assert!(crate::navigation::is_app_url(&page));
        assert_eq!(page.query(), Some("port=7341"));
    }

    #[test]
    fn nothing_answers_on_a_closed_port() {
        // a port just released by the system: nothing listens there
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .unwrap()
            .port();
        assert!(!answers(port));
    }

    #[test]
    fn a_server_answering_200_is_a_console() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 256];
            let n = s.read(&mut buf).unwrap();
            assert!(buf[..n].starts_with(b"GET /api/code HTTP/1.1\r\n"));
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}")
                .unwrap();
        });
        assert!(answers(port));
        server.join().unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn terminate_stops_a_child_with_sigterm() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let t0 = Instant::now();
        terminate(&mut child, Duration::from_secs(5));
        assert!(t0.elapsed() < Duration::from_secs(2));
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            child.try_wait().ok().flatten().and_then(|s| s.signal()),
            Some(libc::SIGTERM)
        );
    }
}
