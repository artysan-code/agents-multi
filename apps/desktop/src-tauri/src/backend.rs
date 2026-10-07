//! The console's backend, owned by the app (docs/adr/0003): `agents serve` as a child process.
//!
//! On start, a console that already answers `GET /api/code` on the port (the systemd unit during the
//! transition, one started by hand) is used as it is: nothing is spawned, and the app never stops or
//! restarts it. Otherwise the app starts the backend (repo.rs says which source): the package's copy,
//! run by the package's Deno (the sidecar) on the package's module cache, or a checkout's `bin/agents`
//! for a developer — with its output in `backend.log` in the app's log folder. If it dies, the window
//! goes back to the local page (which waits for the console) and the backend is restarted after a delay
//! that doubles up to a cap; after too many quick failures in a row the app stops trying, until the
//! tray's «Start the console» asks again. On exit the app stops only the process it started: SIGTERM,
//! then SIGKILL after a grace period. On Linux the child also gets SIGTERM when the app dies without
//! exiting cleanly (a signal, a crash), so it never outlives the app.
//!
//! A plugin only to hook into the app's start and exit: it has no commands, so no page can reach it.

use std::ffi::OsString;
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
use tauri::{AppHandle, Manager, RunEvent, Wry};
use url::Url;

use crate::repo::{self, Source};
use crate::{console, repo::is_repo};

/// The package's Deno next to the app's executable (`bundle.externalBin` without the target triple).
const DENO: &str = "agents-multi-deno";
/// The permissions the package's backend runs with: `bin/agents`' set, with the network open (the
/// brain's host is in the person's accounts.json; ADR 0003). A test keeps the two from drifting.
pub const PERMISSIONS: [&str; 6] = [
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-env",
    "--allow-sys=hostname",
    "--allow-net",
];
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
pub fn init() -> TauriPlugin<Wry> {
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

/// The tray's «Start the console»: when the app runs the backend, it starts it now (out of its
/// backoff, or again after it gave up) and answers true; otherwise the console is someone else's.
pub fn start_again(app: &AppHandle) -> bool {
    app.try_state::<Backend>().is_some_and(|b| b.start_again())
}

/// Who serves the console, as the supervisor found it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// Not known yet.
    Looking,
    /// Another console (the unit, one started by hand): the app leaves it alone.
    External,
    /// The app's own backend.
    Own,
    /// Nothing the app can run (see the log).
    Unavailable,
}

/// The backend the app supervises; `stop` ends it, and only it.
pub struct Backend {
    app: AppHandle,
    port: u16,
    shared: Arc<Shared>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

struct Shared {
    /// The running child: taken out by whoever reaps it, so a pid is never signalled after its reaping.
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
    /// Asked to start now: the backoff ends and starts over.
    now: AtomicBool,
    mode: Mutex<Mode>,
}

impl Shared {
    fn child(&self) -> MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
    fn mode(&self) -> Mode {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    }
}

impl Backend {
    fn start(app: AppHandle, port: u16) -> Self {
        let backend = Backend {
            app,
            port,
            shared: Arc::new(Shared {
                child: Mutex::new(None),
                stopping: AtomicBool::new(false),
                now: AtomicBool::new(false),
                mode: Mutex::new(Mode::Looking),
            }),
            supervisor: Mutex::new(None),
        };
        *backend.supervisor() = backend.supervise();
        backend
    }

    fn supervisor(&self) -> MutexGuard<'_, Option<JoinHandle<()>>> {
        self.supervisor.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn supervise(&self) -> Option<JoinHandle<()>> {
        let (app, port, shared) = (self.app.clone(), self.port, self.shared.clone());
        thread::Builder::new()
            .name("backend".into())
            .spawn(move || supervise(&app, port, &shared))
            .map_err(|e| log(&format!("cannot start the backend's supervisor: {e}")))
            .ok()
    }

    fn start_again(&self) -> bool {
        if self.shared.mode() != Mode::Own {
            return false;
        }
        if self.shared.stopping() {
            return true;
        }
        let mut supervisor = self.supervisor();
        if supervisor.as_ref().is_some_and(|h| !h.is_finished()) {
            // waiting to restart: now; running: nothing to do
            self.shared.now.store(true, Ordering::SeqCst);
        } else {
            log("starting the backend again");
            *supervisor = self.supervise();
        }
        true
    }

    /// Stops the backend the app started, if it did, and its supervision. Idempotent.
    pub fn stop(&self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.shared.child().take() {
            log(&format!("stopping the backend (pid {})", child.id()));
            terminate(&mut child, GRACE);
        }
        if let Some(handle) = self.supervisor().take() {
            let _ = handle.join();
        }
    }
}

fn log(message: &str) {
    eprintln!("agents-multi: {message}");
}

/// What runs the backend, found once per supervision.
fn plan(app: &AppHandle) -> Result<Launch, String> {
    let resources = app.path().resource_dir().ok();
    let bundled = resources.as_ref().map(|r| r.join("repo"));
    let source = repo::from_env(bundled.as_deref())?;
    let deno = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            Some(
                exe.parent()?
                    .join(format!("{DENO}{}", std::env::consts::EXE_SUFFIX)),
            )
        })
        .filter(|p| p.is_file());
    let cache = resources.map(|r| r.join("deno-dir")).filter(|d| d.is_dir());
    Launch::plan(source, deno, cache)
}

/// The supervisor's thread: it is also the thread that spawns the child, which matters on Linux, where
/// the parent-death signal follows the spawning thread.
fn supervise(app: &AppHandle, port: u16, shared: &Shared) {
    if answers(port) {
        shared.set_mode(Mode::External);
        return log(&format!(
            "a console already answers on port {port}: using it, no backend started"
        ));
    }
    let launch = match plan(app) {
        Ok(launch) => launch,
        Err(e) => {
            shared.set_mode(Mode::Unavailable);
            return log(&format!("no backend started: {e}"));
        }
    };
    shared.set_mode(Mode::Own);
    let log_path = app.path().app_log_dir().map(|dir| dir.join("backend.log"));
    let mut failures = 0;
    loop {
        let started = Instant::now();
        {
            let mut slot = shared.child();
            if shared.stopping() {
                return;
            }
            shared.now.store(false, Ordering::SeqCst);
            match spawn(&launch, port, log_path.as_ref().ok()) {
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
        if shared.now.load(Ordering::SeqCst) {
            failures = 0;
        }
        if answers(port) {
            shared.set_mode(Mode::External);
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

/// Sleeps `delay`, waking early when the app stops or asks to start now; false when it stops.
fn sleep_unless_stopping(shared: &Shared, delay: Duration) -> bool {
    let until = Instant::now() + delay;
    while Instant::now() < until && !shared.now.load(Ordering::SeqCst) {
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
    args: Vec<OsString>,
    /// Its working folder: the source.
    dir: PathBuf,
    env: Vec<(&'static str, OsString)>,
}

impl Launch {
    /// A checkout runs as a developer runs it, through its `bin/agents` (the Deno on PATH, bin/agents'
    /// permissions). The package's copy runs on the package's Deno, from its module cache and nothing
    /// else (`--cached-only`): the cache is the backend's alone (AGENTS_MULTI_BACKEND_ONLY: the console
    /// forgets it before starting anything), the Deno is also the one `bin/agents` uses for the
    /// commands the console runs (AGENTS_MULTI_DENO).
    pub fn plan(
        source: Source,
        deno: Option<PathBuf>,
        cache: Option<PathBuf>,
    ) -> Result<Self, String> {
        let serve = || ["serve", "--no-open"].map(OsString::from);
        match source {
            Source::Checkout(repo) => Ok(Launch {
                program: repo.join("bin/agents"),
                args: serve().to_vec(),
                dir: repo,
                env: Vec::new(),
            }),
            Source::Bundled(repo) => {
                if !is_repo(&repo) {
                    return Err(format!("{} is not the source", repo.display()));
                }
                let deno = deno.ok_or(format!(
                    "the package's Deno ({DENO}) is missing next to the app"
                ))?;
                let mut args: Vec<OsString> = ["run", "--quiet", "--cached-only"]
                    .map(OsString::from)
                    .to_vec();
                args.extend(PERMISSIONS.map(OsString::from));
                args.push(repo.join("apps/cli/main.ts").into());
                args.extend(serve());
                let mut env = vec![
                    ("AGENTS_MULTI_DENO", deno.into_os_string()),
                    ("DENO_NO_UPDATE_CHECK", "1".into()),
                ];
                if let Some(cache) = cache {
                    env.push(("DENO_DIR", cache.into_os_string()));
                    env.push(("AGENTS_MULTI_BACKEND_ONLY", "DENO_DIR".into()));
                }
                Ok(Launch {
                    program: env[0].1.clone().into(),
                    args,
                    dir: repo,
                    env,
                })
            }
        }
    }

    fn describe(&self) -> String {
        let args: Vec<_> = self.args.iter().map(|a| a.to_string_lossy()).collect();
        format!("{} {}", self.program.display(), args.join(" "))
    }
}

fn spawn(launch: &Launch, port: u16, log_path: Option<&PathBuf>) -> std::io::Result<Child> {
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
        .current_dir(&launch.dir)
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .env("AGENTS_MULTI_PORT", port.to_string())
        // where the app answers about its own updates (updater/socket.rs)
        .env(crate::updater::SOCKET_VAR, crate::updater::socket::path())
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
fn back_to_local_page(app: &AppHandle, port: u16) {
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
    fn a_checkout_runs_its_bin_agents() {
        let launch = Launch::plan(
            Source::Checkout("/r".into()),
            Some("/app/deno".into()),
            None,
        )
        .unwrap();
        assert_eq!(launch.program, Path::new("/r/bin/agents"));
        assert_eq!(launch.args, ["serve", "--no-open"]);
        assert_eq!(launch.dir, Path::new("/r"));
        assert!(launch.env.is_empty());
    }

    #[test]
    fn the_package_runs_its_deno_on_its_cache() {
        let repo = std::env::temp_dir().join(format!("agents-multi-launch-{}", std::process::id()));
        std::fs::create_dir_all(repo.join("apps/cli")).unwrap();
        std::fs::write(repo.join("apps/cli/main.ts"), "").unwrap();
        let launch = Launch::plan(
            Source::Bundled(repo.clone()),
            Some("/app/agents-multi-deno".into()),
            Some("/res/deno-dir".into()),
        );
        let missing = Launch::plan(Source::Bundled(repo.clone()), None, None);
        let _ = std::fs::remove_dir_all(&repo);
        let launch = launch.unwrap();
        assert_eq!(launch.program, Path::new("/app/agents-multi-deno"));
        let mut want: Vec<OsString> = ["run", "--quiet", "--cached-only"]
            .map(OsString::from)
            .to_vec();
        want.extend(PERMISSIONS.map(OsString::from));
        want.push(repo.join("apps/cli/main.ts").into());
        want.extend(["serve", "--no-open"].map(OsString::from));
        assert_eq!(launch.args, want);
        assert_eq!(launch.dir, repo);
        let env = |k: &str| {
            launch
                .env
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(env("DENO_DIR"), Some("/res/deno-dir".into()));
        assert_eq!(env("AGENTS_MULTI_BACKEND_ONLY"), Some("DENO_DIR".into()));
        assert_eq!(
            env("AGENTS_MULTI_DENO"),
            Some("/app/agents-multi-deno".into())
        );
        assert!(missing.is_err(), "no Deno next to the app, nothing to run");
    }

    /// The package's backend runs with bin/agents' permissions, the network aside.
    #[test]
    fn permissions_follow_bin_agents() {
        let script =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../bin/agents"))
                .unwrap();
        let exec = script
            .lines()
            .find(|l| l.contains("run --quiet"))
            .expect("the exec line");
        let theirs: Vec<&str> = exec
            .split_whitespace()
            .filter(|t| t.starts_with("--allow-"))
            .collect();
        let name = |t: &str| t.split('=').next().unwrap().to_string();
        let mut a: Vec<String> = theirs.iter().map(|t| name(t)).collect();
        let mut b: Vec<String> = PERMISSIONS.iter().map(|t| name(t)).collect();
        a.sort();
        b.sort();
        assert_eq!(a, b, "the same permissions");
        for p in PERMISSIONS.iter().filter(|p| !p.starts_with("--allow-net")) {
            assert!(theirs.contains(p), "{p} as bin/agents grants it");
        }
    }

    #[test]
    fn a_start_asked_for_ends_the_wait() {
        let shared = Shared {
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
            now: AtomicBool::new(true),
            mode: Mutex::new(Mode::Own),
        };
        let t0 = Instant::now();
        assert!(sleep_unless_stopping(&shared, Duration::from_secs(30)));
        assert!(t0.elapsed() < Duration::from_secs(1));
        shared.now.store(false, Ordering::SeqCst);
        shared.stopping.store(true, Ordering::SeqCst);
        assert!(!sleep_unless_stopping(&shared, Duration::from_secs(30)));
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
