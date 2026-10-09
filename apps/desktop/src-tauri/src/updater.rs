//! The app's own updates (docs/adr/0004): Tauri's signed updater, on the manifest the project site
//! serves for the app's channel (`<site>/updates/<channel>.json`), so the app never depends on where
//! the artifacts live. Updating is the console's to show: the app checks and downloads on its own, and
//! installs only when the console's update screen asks it to.
//!
//! - **Checks** a minute after start, then once a day by the wall clock (a laptop asleep for a day
//!   checks when it wakes), and on the console's request. A newer version is downloaded in the
//!   background and its signature verified against the key in `tauri.conf.json` before it is kept.
//! - **The console** (`/api/app/update` in apps/cli/console/app-update.ts) reaches the app over a unix
//!   socket of the user's (`socket.rs`), never the page itself: it reads the status, follows its
//!   changes, and asks for `check`, `install` (download if needed, install, relaunch) and `dismiss`.
//! - **Installing** relaunches the app and what it runs (the backend, the tray, the windows): it
//!   leaves a note in the app's data folder (`updated.json`), and the new version, finding it at start
//!   (`after_relaunch`), opens the console on the update screen, whose status says `updated` until the
//!   page dismisses it. An AppImage downloaded and not installed is also installed on quit, since
//!   replacing its own file asks nothing (a deb or an rpm asks for an administrator's password through
//!   pkexec, which a quit must not do); the note is left the same way. The app never restarts on its own.
//! - **Off**, with the reason in the status (`off`): the build has no updater (the `updater` feature),
//!   no site or key (release.json, tauri.conf.json), the app is not a bundle (`cargo run`, `tauri dev`:
//!   installing would overwrite the binary), or a package manager owns it — the AUR package puts a
//!   `package-manager` file naming it in the app's resources.
//!
//! The channel is `beta` for a beta build, which also writes it to `update-channel` in the app's config
//! folder, so the stable version a beta ends in keeps following betas; deleting that file, or writing
//! `stable` there, leaves the channel. `AGENTS_MULTI_UPDATE_CHANNEL` overrides both. A beta manifest also
//! carries a stable version newer than its last beta (scripts/app-release.ts).
//!
//! The updater plugin carries JavaScript commands, but no capability grants them (the app declares
//! none), so no page can reach them: everything here runs from Rust.

// built without the `updater` feature, only the status, the socket and the tray's part are used
#![cfg_attr(not(feature = "updater"), allow(dead_code))]

pub mod socket;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};
use url::Url;

use crate::flags::Request;
use crate::tray::{Action, Entry, View};

/// The project site (`site` in apps/desktop/release.json, through build.rs); empty in a build without one.
const SITE: &str = env!("AGENTS_MULTI_UPDATE_SITE");
/// The console's view the update screen lives on: the tray's «Update…» and a relaunch open it.
pub const UPDATE_VIEW: &str = "system/updates";
/// The variable that tells the backend where the socket is (backend.rs sets it for the backend it starts).
pub const SOCKET_VAR: &str = "AGENTS_MULTI_APP_SOCKET";
/// A file in the app's resources naming the package manager that updates the app instead.
const PACKAGE_MANAGER: &str = "package-manager";
/// The channel a person chose, in the app's config folder.
const CHANNEL_FILE: &str = "update-channel";
const CHANNEL_VAR: &str = "AGENTS_MULTI_UPDATE_CHANNEL";
/// The note an install leaves for the version it installs, in the app's data folder.
const UPDATED_FILE: &str = "updated.json";
/// How often the app looks for a new version.
const EVERY: Duration = Duration::from_secs(24 * 3600);
/// Release notes longer than this are cut.
const NOTES_MAX: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

/// The channel: the one chosen (the variable, else the file), else the build's — beta for a beta version.
pub fn channel(version: &str, chosen: Option<&str>) -> Channel {
    match chosen.map(str::trim) {
        Some("beta") => Channel::Beta,
        Some("stable") => Channel::Stable,
        _ if version.contains("-beta.") => Channel::Beta,
        _ => Channel::Stable,
    }
}

/// The channel's manifest on the site, or None for a build without a site.
pub fn endpoint(site: &str, channel: Channel) -> Option<Url> {
    let site = site.trim().trim_end_matches('/');
    if site.is_empty() {
        return None;
    }
    Url::parse(&format!("{site}/updates/{}.json", channel.name())).ok()
}

/// After a check that could not reach the manifest (the site restarting while a release is
/// published, no network): the next one comes this soon, not a day later.
const RETRY: Duration = Duration::from_secs(15 * 60);

/// Whether it is time to look again: never looked, a day passed (RETRY after a failed check), or
/// the clock went back.
pub fn due(last: Option<SystemTime>, now: SystemTime, failed: bool) -> bool {
    let every = if failed { RETRY } else { EVERY };
    match last {
        None => true,
        Some(at) => now.duration_since(at).map_or(true, |d| d >= every),
    }
}

/// Release notes: at most NOTES_MAX bytes, cut on a character boundary.
pub fn clip(notes: &str) -> String {
    if notes.len() <= NOTES_MAX {
        return notes.to_string();
    }
    let mut end = NOTES_MAX;
    while !notes.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &notes[..end])
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

// ---------------------------------------------------------------- the status and its moves

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Downloading,
    Ready,
    Installing,
    Restarting,
    Error,
}

/// A newer version the manifest offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Available {
    pub version: String,
    pub notes: String,
    pub date: Option<String>,
}

/// The update this run of the app came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Updated {
    pub from: String,
    pub to: String,
}

/// What the app says about its updates: the body of `GET /api/app/update`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The running version.
    pub current: String,
    pub channel: Channel,
    pub state: Phase,
    pub available: Option<Available>,
    /// The download, 0 to 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Why this app does not update itself: `build`, `not-configured`, `not-packaged`,
    /// `package-manager:<name>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub off: Option<String>,
    /// Set after a relaunch from an update, until the console dismisses it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<Updated>,
    /// When the app last looked, in seconds since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
}

impl Status {
    pub fn new(current: &str, channel: Channel, off: Option<String>) -> Status {
        Status {
            current: current.into(),
            channel,
            state: Phase::Idle,
            available: None,
            progress: None,
            error: None,
            off,
            updated: None,
            checked_at: None,
        }
    }

    /// Something is under way that a check or an install would trample.
    pub fn busy(&self) -> bool {
        matches!(
            self.state,
            Phase::Checking | Phase::Downloading | Phase::Installing | Phase::Restarting
        )
    }

    /// A check starts; false when updates are off or something is under way.
    pub fn checking(&mut self) -> bool {
        if self.off.is_some() || self.busy() {
            return false;
        }
        self.state = Phase::Checking;
        self.error = None;
        true
    }

    /// What a check found, `have` being the version already downloaded: nothing newer, the version
    /// already here, or one to download.
    pub fn found(&mut self, found: Option<Available>, have: Option<&str>, now: u64) {
        self.checked_at = Some(now);
        self.progress = None;
        match found {
            None if have.is_some() => self.state = Phase::Ready,
            None => {
                self.state = Phase::Idle;
                self.available = None;
            }
            Some(a) => {
                self.state = if have == Some(a.version.as_str()) {
                    Phase::Ready
                } else {
                    self.progress = Some(0.0);
                    Phase::Downloading
                };
                self.available = Some(a);
            }
        }
    }

    /// The download moved; true when the change is worth saying (a percent or more, or the end).
    pub fn advance(&mut self, progress: f64) -> bool {
        let p = progress.clamp(0.0, 1.0);
        let before = self.progress.unwrap_or(0.0);
        if self.state != Phase::Downloading || (p - before < 0.01 && p < 1.0) {
            return false;
        }
        self.progress = Some(p);
        true
    }

    pub fn downloaded(&mut self) {
        self.state = Phase::Ready;
        self.progress = None;
    }

    /// A check, a download or an install failed. With a version already downloaded the app stays
    /// ready to install it, the error said beside it.
    pub fn failed(&mut self, error: &str, have: Option<&str>) {
        self.state = if have.is_some() {
            Phase::Ready
        } else {
            Phase::Error
        };
        self.progress = None;
        self.error = Some(error.into());
    }
}

/// A follower of the status: called with it now and on every change, until it returns false.
pub type Watcher = Box<dyn FnMut(&Status) -> bool + Send>;

/// The status, and who follows it: the socket's watchers and the app (the tray).
pub struct Hub {
    status: Mutex<Status>,
    watchers: Mutex<Vec<Watcher>>,
}

impl Hub {
    pub fn new(status: Status) -> Hub {
        Hub {
            status: Mutex::new(status),
            watchers: Mutex::new(Vec::new()),
        }
    }

    pub fn get(&self) -> Status {
        match self.status.lock() {
            Ok(s) => s.clone(),
            Err(e) => e.into_inner().clone(),
        }
    }

    /// Changes the status; when `change` says the change is worth it, every watcher hears it.
    pub fn update(&self, change: impl FnOnce(&mut Status) -> bool) {
        let now = {
            let Ok(mut s) = self.status.lock() else {
                return;
            };
            if !change(&mut s) {
                return;
            }
            s.clone()
        };
        if cfg!(debug_assertions) {
            eprintln!(
                "agents-multi: update status {}",
                serde_json::to_string(&now).unwrap_or_default()
            );
        }
        if let Ok(mut ws) = self.watchers.lock() {
            ws.retain_mut(|w| w(&now));
        }
    }

    /// Calls `watcher` with the status now and on every change, until it returns false.
    pub fn watch(&self, mut watcher: Watcher) {
        if let Ok(mut ws) = self.watchers.lock() {
            if watcher(&self.get()) {
                ws.push(watcher);
            }
        }
    }
}

/// What the socket's requests do: the app's updater, or a build without one.
pub trait Ops: Send + Sync {
    fn check(&self) -> Result<(), String>;
    fn install(&self) -> Result<(), String>;
    fn dismiss(&self);
    /// Follows `channel` from now on (CHANNEL_FILE), and looks at once.
    fn set_channel(&self, channel: Channel) -> Result<(), String>;
}

// ---------------------------------------------------------------- the tray

/// The tray's view with a newer version: a line saying so with the state, and «Update…» (the
/// console's update screen) above Quit.
pub fn with_available(mut view: View, available: Option<&str>) -> View {
    let Some(version) = available else {
        return view;
    };
    let line = format!("Agents Multi {version} is available");
    view.tooltip = format!("{}\n{line}", view.tooltip);
    let state_end = view
        .menu
        .iter()
        .position(|e| *e == Entry::Separator)
        .unwrap_or(view.menu.len());
    view.menu.insert(state_end, Entry::Label(line));
    let quit = view
        .menu
        .iter()
        .rposition(|e| *e == Entry::Separator)
        .unwrap_or(view.menu.len());
    view.menu.insert(
        quit,
        Entry::Item("Update Agents Multi…", Action::View(UPDATE_VIEW.into())),
    );
    view
}

/// The tray's view, with «Update…» when a newer version is there.
pub fn annotate(app: &AppHandle, view: View) -> View {
    let available = app
        .try_state::<Arc<Hub>>()
        .and_then(|h| h.get().available.map(|a| a.version));
    with_available(view, available.as_deref())
}

// ---------------------------------------------------------------- the app

fn package_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The channel this app follows. A beta build joins the beta channel for good (CHANNEL_FILE).
fn chosen_channel(app: &AppHandle, version: &str) -> Channel {
    if let Ok(v) = std::env::var(CHANNEL_VAR) {
        return channel(version, Some(&v));
    }
    let file = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(CHANNEL_FILE));
    let chosen = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok());
    let ch = channel(version, chosen.as_deref());
    if chosen.is_none() && ch == Channel::Beta && crate::instance::dev().is_none() {
        if let Some(f) = &file {
            let _ = f
                .parent()
                .map(std::fs::create_dir_all)
                .transpose()
                .and_then(|_| std::fs::write(f, "beta\n"));
        }
    }
    ch
}

/// The note's path; a development instance's own, so the installed app never takes it for its own.
fn updated_file(app: &AppHandle) -> Option<PathBuf> {
    let name = match crate::instance::dev() {
        Some(dev) => format!("dev_{dev}.{UPDATED_FILE}"),
        None => UPDATED_FILE.into(),
    };
    app.path().app_local_data_dir().ok().map(|d| d.join(name))
}

/// Leaves the note the installed version finds at start.
fn leave_note(app: &AppHandle, from: &str, to: &str) {
    let Some(f) = updated_file(app) else { return };
    let note = Updated {
        from: from.into(),
        to: to.into(),
    };
    let _ = f
        .parent()
        .map(std::fs::create_dir_all)
        .transpose()
        .and_then(|_| std::fs::write(&f, serde_json::to_string(&note).unwrap_or_default()));
}

/// Tauri's updater plugin, registered by the builder: a plugin cannot add another while the plugins
/// start (the store is locked), and `init` needs it there. Without the feature, a plugin that does nothing.
pub fn tauri_updater() -> Box<dyn tauri::plugin::Plugin<Wry>> {
    #[cfg(feature = "updater")]
    return Box::new(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(feature = "updater"))]
    Box::new(Builder::<Wry>::new("agents-multi-no-updater").build())
}

/// The plugin that runs the updater and its socket.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("agents-multi-updater")
        .setup(|app, _api| {
            let ops = imp::start(app);
            if let Some(hub) = app.try_state::<Arc<Hub>>() {
                socket::serve(Arc::clone(&hub), ops);
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::Exit = event {
                imp::on_exit(app);
            }
        })
        .build()
}

/// The launch request after an install: the note the previous version left says this run is the
/// update, and the console opens on the update screen, which shows it once. The install of what
/// changed (`agents install --app`, install.rs) runs before the backend starts, so before the console
/// the window waits for.
pub fn after_relaunch(app: &AppHandle, request: Request) -> Request {
    let Some(f) = updated_file(app) else {
        return request;
    };
    let Some(note) = std::fs::read_to_string(&f)
        .ok()
        .and_then(|t| serde_json::from_str::<Updated>(&t).ok())
    else {
        return request;
    };
    let _ = std::fs::remove_file(&f);
    let current = package_version(app);
    eprintln!(
        "agents-multi: relaunched after the update {} → {}",
        note.from, note.to
    );
    if let Some(hub) = app.try_state::<Arc<Hub>>() {
        hub.update(|s| {
            if note.to == current {
                s.updated = Some(note);
            } else {
                s.state = Phase::Error;
                s.error = Some(format!(
                    "the update to {} did not take: this is {current}",
                    note.to
                ));
            }
            true
        });
    }
    Request::Show(Some(UPDATE_VIEW.into()))
}

/// A build without the updater: the status says so, and the socket answers with it.
/// Marks every descriptor past stdio close-on-exec, before the app relaunches itself. The AppImage
/// runtime hands the app the write end of the pipe its mount helper watches, and a descriptor of the
/// mount, both without close-on-exec: the relaunch carried them into the new version, so the old
/// helper never saw the app go and kept the old mount, and its process, running for good.
#[cfg(target_os = "linux")]
pub fn close_on_exec_all() {
    let Ok(dir) = std::fs::read_dir("/proc/self/fd") else {
        return;
    };
    let fds: Vec<i32> = dir
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .filter(|fd| *fd > 2)
        .collect();
    for fd in fds {
        // SAFETY: F_GETFD/F_SETFD only read and set the descriptor's flags; a descriptor closed
        // meanwhile (the listing's own) answers -1 and is left alone.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

#[cfg(not(feature = "updater"))]
mod imp {
    use super::*;

    struct Off(Arc<Hub>);

    impl Ops for Off {
        fn check(&self) -> Result<(), String> {
            Err("this build has no updater".into())
        }
        fn install(&self) -> Result<(), String> {
            Err("this build has no updater".into())
        }
        fn dismiss(&self) {
            self.0.update(|s| s.updated.take().is_some());
        }
        fn set_channel(&self, _channel: Channel) -> Result<(), String> {
            Err("this build has no updater".into())
        }
    }

    pub fn start(app: &AppHandle) -> Arc<dyn Ops> {
        let v = package_version(app);
        let hub = Arc::new(Hub::new(Status::new(
            &v,
            channel(&v, None),
            Some("build".into()),
        )));
        app.manage(Arc::clone(&hub));
        Arc::new(Off(hub))
    }

    pub fn on_exit(_app: &AppHandle) {}
}

#[cfg(feature = "updater")]
mod imp {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};

    use tauri::utils::config::BundleType;
    use tauri::utils::platform::bundle_type;
    use tauri_plugin_updater::{Update, UpdaterExt};

    /// The first check waits for the app (and its backend) to settle.
    const FIRST_CHECK: Duration = Duration::from_secs(60);
    /// How often the checking thread wakes to see whether a check is due.
    const WAKE: Duration = Duration::from_secs(5 * 60);
    /// Between «restarting» and the relaunch: time for the console to tell the page.
    const RESTART_PAUSE: Duration = Duration::from_millis(1500);

    /// A downloaded, verified version.
    struct Pending {
        update: Update,
        bytes: Vec<u8>,
    }

    pub struct Engine {
        app: AppHandle,
        hub: Arc<Hub>,
        /// The channel's manifest: changes when the person chooses another channel.
        endpoint: Mutex<Option<Url>>,
        pending: Mutex<Option<Pending>>,
        /// An install was asked for before the version was downloaded.
        install_wanted: AtomicBool,
    }

    /// Why this app does not update itself, or None when it does.
    fn off_reason(app: &AppHandle, endpoint: Option<&Url>) -> Option<String> {
        if let Some(name) = app
            .path()
            .resource_dir()
            .ok()
            .and_then(|d| std::fs::read_to_string(d.join(PACKAGE_MANAGER)).ok())
        {
            let name = name.trim();
            let name = if name.is_empty() { "system" } else { name };
            return Some(format!("package-manager:{name}"));
        }
        let pubkey = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u.get("pubkey"))
            .and_then(|k| k.as_str())
            .unwrap_or_default();
        if endpoint.is_none() || pubkey.trim().is_empty() {
            return Some("not-configured".into());
        }
        if bundle_type().is_none() {
            return Some("not-packaged".into());
        }
        None
    }

    pub fn start(app: &AppHandle) -> Arc<dyn Ops> {
        let current = package_version(app);
        let ch = chosen_channel(app, &current);
        let endpoint = endpoint(SITE, ch);
        let off = off_reason(app, endpoint.as_ref());
        let hub = Arc::new(Hub::new(Status::new(&current, ch, off.clone())));
        app.manage(Arc::clone(&hub));
        // the tray shows «Update…» when a version appears or goes
        let tray = app.clone();
        let mut shown: Option<String> = None;
        hub.watch(Box::new(move |s| {
            let now = s.available.as_ref().map(|a| a.version.clone());
            if now != shown {
                shown = now;
                crate::tray::refresh(&tray);
            }
            true
        }));
        let engine = Arc::new(Engine {
            app: app.clone(),
            hub,
            endpoint: Mutex::new(endpoint),
            pending: Mutex::new(None),
            install_wanted: AtomicBool::new(false),
        });
        app.manage(Arc::clone(&engine));
        if off.is_none() {
            let e = Arc::clone(&engine);
            let _ = std::thread::Builder::new()
                .name("updater".into())
                .spawn(move || {
                    std::thread::sleep(FIRST_CHECK);
                    let mut last = None;
                    let mut failed = false;
                    loop {
                        let now = SystemTime::now();
                        if due(last, now, failed) {
                            last = Some(now);
                            failed = !e.run_check();
                        }
                        std::thread::sleep(WAKE);
                    }
                });
        }
        Arc::new(Arc::clone(&engine))
    }

    impl Engine {
        fn have(&self) -> Option<String> {
            self.pending
                .lock()
                .ok()?
                .as_ref()
                .map(|p| p.update.version.clone())
        }

        /// A check, the download of what it found, and the install when one was asked for.
        /// One check, and the download of what it found. False when the manifest could not be read.
        fn run_check(&self) -> bool {
            let mut started = false;
            self.hub.update(|s| {
                started = s.checking();
                started
            });
            if !started {
                return true;
            }
            let have = self.have();
            let endpoint = self.endpoint.lock().ok().and_then(|e| e.clone());
            let found = self
                .app
                .updater_builder()
                .endpoints(endpoint.into_iter().collect())
                .and_then(|b| b.build())
                .map(|u| tauri::async_runtime::block_on(u.check()));
            let update = match found {
                Ok(Ok(u)) => u,
                Ok(Err(e)) | Err(e) => {
                    eprintln!("agents-multi: update check failed: {e}");
                    self.hub.update(|s| {
                        s.checked_at = Some(now_secs());
                        s.failed(&e.to_string(), have.as_deref());
                        true
                    });
                    self.install_wanted.store(false, Ordering::SeqCst);
                    return false;
                }
            };
            let available = update.as_ref().map(|u| Available {
                version: u.version.clone(),
                notes: clip(u.body.as_deref().unwrap_or_default()),
                // as the manifest writes it (RFC 3339), not as `time` prints it
                date: u.raw_json["pub_date"].as_str().map(str::to_string),
            });
            self.hub.update(|s| {
                s.found(available, have.as_deref(), now_secs());
                true
            });
            let Some(update) = update else {
                self.install_wanted.store(false, Ordering::SeqCst);
                return true;
            };
            if have.as_deref() != Some(update.version.as_str()) {
                if !self.download(update) {
                    self.install_wanted.store(false, Ordering::SeqCst);
                    return true;
                }
                notify_ready(&self.hub.get());
            }
            if self.install_wanted.swap(false, Ordering::SeqCst) {
                self.install_pending();
            }
            true
        }

        fn download(&self, update: Update) -> bool {
            let version = update.version.clone();
            eprintln!("agents-multi: downloading version {version}");
            let mut got = 0usize;
            let result = tauri::async_runtime::block_on(update.download(
                |chunk, total| {
                    got += chunk;
                    if let Some(total) = total.filter(|t| *t > 0) {
                        self.hub.update(|s| s.advance(got as f64 / total as f64));
                    }
                },
                || {},
            ));
            match result {
                Ok(bytes) => {
                    if let Ok(mut p) = self.pending.lock() {
                        *p = Some(Pending { update, bytes });
                    }
                    self.hub.update(|s| {
                        s.downloaded();
                        true
                    });
                    true
                }
                Err(e) => {
                    eprintln!("agents-multi: the download of {version} failed: {e}");
                    let have = self.have();
                    self.hub.update(|s| {
                        s.failed(&e.to_string(), have.as_deref());
                        true
                    });
                    false
                }
            }
        }

        /// Installs the downloaded version, leaves the note, and relaunches.
        fn install_pending(&self) {
            // held through the install: a quit meanwhile does not install a second time
            let Ok(mut pending) = self.pending.try_lock() else {
                return;
            };
            let Some(p) = pending.as_ref() else { return };
            let (from, to) = (p.update.current_version.clone(), p.update.version.clone());
            self.hub.update(|s| {
                s.state = Phase::Installing;
                s.error = None;
                true
            });
            match p.update.install(&p.bytes) {
                Ok(()) => {
                    eprintln!("agents-multi: installed {to}, relaunching");
                    *pending = None;
                    drop(pending);
                    leave_note(&self.app, &from, &to);
                    self.hub.update(|s| {
                        s.state = Phase::Restarting;
                        true
                    });
                    std::thread::sleep(RESTART_PAUSE);
                    #[cfg(target_os = "linux")]
                    close_on_exec_all();
                    self.app.restart();
                }
                Err(e) => {
                    // refused (a cancelled password prompt) or failed: still downloaded, to try again
                    eprintln!("agents-multi: the install of {to} failed: {e}");
                    self.hub.update(|s| {
                        s.failed(&format!("install: {e}"), Some(&to));
                        true
                    });
                }
            }
        }
    }

    impl Ops for Arc<Engine> {
        fn check(&self) -> Result<(), String> {
            if let Some(off) = self.hub.get().off {
                return Err(format!("updates are off: {off}"));
            }
            let e = Arc::clone(self);
            std::thread::spawn(move || e.run_check());
            Ok(())
        }

        fn install(&self) -> Result<(), String> {
            let s = self.hub.get();
            if let Some(off) = s.off {
                return Err(format!("updates are off: {off}"));
            }
            if matches!(s.state, Phase::Installing | Phase::Restarting) {
                return Ok(());
            }
            let e = Arc::clone(self);
            if self.have().is_some() && !s.busy() {
                std::thread::spawn(move || e.install_pending());
            } else {
                // download first (a check that finds it, or the one under way), then install
                self.install_wanted.store(true, Ordering::SeqCst);
                std::thread::spawn(move || e.run_check());
            }
            Ok(())
        }

        fn dismiss(&self) {
            self.hub.update(|s| s.updated.take().is_some());
        }

        fn set_channel(&self, channel: Channel) -> Result<(), String> {
            let s = self.hub.get();
            if let Some(off) = s.off {
                return Err(format!("updates are off: {off}"));
            }
            if std::env::var_os(CHANNEL_VAR).is_some() {
                return Err(format!("the channel is set by {CHANNEL_VAR}"));
            }
            if s.busy() {
                return Err("an update is under way".into());
            }
            let dir = self
                .app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir)
                .and_then(|_| {
                    std::fs::write(dir.join(CHANNEL_FILE), format!("{}\n", channel.name()))
                })
                .map_err(|e| e.to_string())?;
            if let Ok(mut e) = self.endpoint.lock() {
                *e = endpoint(SITE, channel);
            }
            // what was found or downloaded on the other channel is not this one's
            if let Ok(mut p) = self.pending.lock() {
                *p = None;
            }
            self.hub.update(|s| {
                s.channel = channel;
                s.available = None;
                s.error = None;
                s.state = Phase::Idle;
                true
            });
            let e = Arc::clone(self);
            std::thread::spawn(move || e.run_check());
            Ok(())
        }
    }

    /// Says once, on the desktop, that a version is ready (normal urgency, eight seconds: AGENTS.md).
    fn notify_ready(s: &Status) {
        let Some(a) = &s.available else { return };
        let mut cmd = std::process::Command::new("notify-send");
        crate::childenv::apply(&mut cmd)
            .args(["-u", "normal", "-t", "8000", "-a", "Agents Multi"])
            .arg(format!("Agents Multi {} is available", a.version))
            .arg("Update it from the console: System › Updates.")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Ok(mut child) = cmd.spawn() {
            std::thread::spawn(move || child.wait());
        }
    }

    /// On quit, an AppImage installs the version it downloaded: replacing its own file asks nothing.
    pub fn on_exit(app: &AppHandle) {
        if bundle_type() != Some(BundleType::AppImage) {
            return;
        }
        let Some(engine) = app.try_state::<Arc<Engine>>() else {
            return;
        };
        let Ok(mut pending) = engine.pending.try_lock() else {
            return;
        };
        if let Some(p) = pending.take() {
            match p.update.install(&p.bytes) {
                Ok(()) => {
                    eprintln!("agents-multi: installed {} on quit", p.update.version);
                    leave_note(app, &p.update.current_version, &p.update.version);
                }
                Err(e) => eprintln!(
                    "agents-multi: the install of {} on quit failed: {e}",
                    p.update.version
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn close_on_exec_all_marks_inherited_descriptors() {
        let mut fds = [0i32; 2];
        // SAFETY: a plain pipe, without O_CLOEXEC, as the AppImage runtime leaves its own
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let cloexec = |fd: i32| unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC != 0;
        assert!(!cloexec(fds[1]));
        close_on_exec_all();
        assert!(cloexec(fds[0]) && cloexec(fds[1]));
        assert!(
            !cloexec(0) && !cloexec(1) && !cloexec(2),
            "stdio is left as it is"
        );
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }

    fn available(v: &str) -> Option<Available> {
        Some(Available {
            version: v.into(),
            notes: String::new(),
            date: None,
        })
    }

    #[test]
    fn the_channel_is_the_chosen_one_else_the_builds() {
        assert_eq!(channel("1.0.0", None), Channel::Stable);
        assert_eq!(channel("1.1.0-beta.2", None), Channel::Beta);
        assert_eq!(channel("1.1.0", Some("beta\n")), Channel::Beta);
        assert_eq!(channel("1.1.0-beta.2", Some("stable")), Channel::Stable);
        assert_eq!(channel("1.1.0", Some("nightly")), Channel::Stable);
    }

    #[test]
    fn the_endpoint_is_the_sites_manifest_for_the_channel() {
        assert_eq!(
            endpoint("https://site.test/", Channel::Beta)
                .unwrap()
                .as_str(),
            "https://site.test/updates/beta.json"
        );
        assert_eq!(
            endpoint("https://site.test", Channel::Stable)
                .unwrap()
                .as_str(),
            "https://site.test/updates/stable.json"
        );
        assert_eq!(endpoint("", Channel::Stable), None);
        assert_eq!(endpoint("not a url", Channel::Stable), None);
    }

    #[test]
    fn a_check_is_due_after_a_day_or_when_the_clock_went_back() {
        let t = UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(due(None, t, false));
        assert!(!due(Some(t), t + Duration::from_secs(3600), false));
        assert!(due(Some(t), t + EVERY, false));
        assert!(due(Some(t), t - Duration::from_secs(1), false));
        // a failed check comes back within the quarter hour, not the next day
        assert!(!due(Some(t), t + Duration::from_secs(60), true));
        assert!(due(Some(t), t + RETRY, true));
    }

    #[test]
    fn long_notes_are_cut_on_a_character() {
        assert_eq!(clip("short"), "short");
        let c = clip(&"è".repeat(NOTES_MAX));
        assert!(c.len() <= NOTES_MAX + "…".len());
        assert!(c.ends_with('…'));
    }

    #[test]
    fn the_status_is_the_consoles_contract() {
        let mut s = Status::new("1.0.0", Channel::Stable, None);
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"current":"1.0.0","channel":"stable","state":"idle","available":null})
        );
        s.found(available("1.1.0"), None, 42);
        s.updated = Some(Updated {
            from: "0.9.0".into(),
            to: "1.0.0".into(),
        });
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"current":"1.0.0","channel":"stable","state":"downloading",
                "available":{"version":"1.1.0","notes":"","date":null},"progress":0.0,
                "updated":{"from":"0.9.0","to":"1.0.0"},"checkedAt":42})
        );
        let off = Status::new(
            "1.0.0",
            Channel::Beta,
            Some("package-manager:pacman".into()),
        );
        assert_eq!(
            serde_json::to_value(&off).unwrap(),
            serde_json::json!({"current":"1.0.0","channel":"beta","state":"idle","available":null,
                "off":"package-manager:pacman"})
        );
    }

    #[test]
    fn a_check_finds_nothing_a_version_to_download_or_the_one_already_here() {
        let mut s = Status::new("1.0.0", Channel::Stable, None);
        assert!(s.checking());
        assert!(!s.checking(), "one check at a time");
        s.found(None, None, 1);
        assert_eq!((s.state, s.available.clone()), (Phase::Idle, None));

        assert!(s.checking());
        s.found(available("1.1.0"), None, 2);
        assert_eq!((s.state, s.progress), (Phase::Downloading, Some(0.0)));
        assert!(!s.advance(0.005), "less than a percent is not worth saying");
        assert!(s.advance(0.5));
        assert!(s.advance(1.0));
        s.downloaded();
        assert_eq!((s.state, s.progress), (Phase::Ready, None));

        // a later check that finds the same version: still ready, nothing to download
        assert!(s.checking());
        s.found(available("1.1.0"), Some("1.1.0"), 3);
        assert_eq!(s.state, Phase::Ready);
        // a failed check with a version here: ready, the error beside it
        assert!(s.checking());
        s.failed("offline", Some("1.1.0"));
        assert_eq!(
            (s.state, s.error.as_deref()),
            (Phase::Ready, Some("offline"))
        );
        // a newer one than what is here: downloaded again
        assert!(s.checking());
        assert_eq!(s.error, None);
        s.found(available("1.2.0"), Some("1.1.0"), 4);
        assert_eq!(s.state, Phase::Downloading);
        s.failed("reset", None);
        assert_eq!(s.state, Phase::Error);
        assert!(s.checking(), "an error does not block the next check");
    }

    #[test]
    fn updates_off_never_check() {
        let mut s = Status::new("1.0.0", Channel::Stable, Some("not-packaged".into()));
        assert!(!s.checking());
        assert_eq!(s.state, Phase::Idle);
    }

    #[test]
    fn the_hub_tells_its_watchers_until_they_leave() {
        let hub = Hub::new(Status::new("1.0.0", Channel::Stable, None));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mine = Arc::clone(&seen);
        hub.watch(Box::new(move |s| {
            let mut v = mine.lock().unwrap();
            v.push(s.state);
            v.len() < 3
        }));
        hub.update(|s| s.checking());
        hub.update(|_| false); // not worth saying
        hub.update(|s| {
            s.found(None, None, 1);
            true
        });
        hub.update(|s| s.checking()); // the watcher left after the third
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Phase::Idle, Phase::Checking, Phase::Idle]
        );
    }

    #[test]
    fn a_newer_version_adds_a_line_and_update_above_quit() {
        let base = crate::tray::view(None, vec![]);
        assert_eq!(with_available(base.clone(), None), base);
        let v = with_available(base, Some("1.1.0"));
        assert!(v.tooltip.ends_with("\nAgents Multi 1.1.0 is available"));
        let first_sep = v.menu.iter().position(|e| *e == Entry::Separator).unwrap();
        assert_eq!(
            v.menu[first_sep - 1],
            Entry::Label("Agents Multi 1.1.0 is available".into())
        );
        let n = v.menu.len();
        assert_eq!(
            &v.menu[n - 3..],
            &[
                Entry::Item("Update Agents Multi…", Action::View(UPDATE_VIEW.into())),
                Entry::Separator,
                Entry::Item("Quit", Action::Quit),
            ]
        );
    }
}
