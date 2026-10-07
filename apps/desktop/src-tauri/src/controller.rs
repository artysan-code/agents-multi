//! What the app does with a request — its own launch's, a second launch's (handed over by the
//! single-instance plugin), or the tray menu's — and when it stays alive. The behaviour of
//! `apps/tray/app.py`:
//!
//! - With a tray, closing the console window hides it and the app lives in the tray; it quits from the
//!   menu. Without one (GNOME without the AppIndicator extension) the app quits with its last window.
//! - `--tray` waits up to a minute for a tray host (at login it can come up after the app), then gives
//!   up, says so, and notes it for the doctor; any other launch looks once.
//! - What the menu does is a CLI command (`claude-launch`, `systemctl` for a console the app does not run),
//!   the app's backend (`backend.rs`), or one of the app's windows.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};

use crate::flags::{self, Request};
use crate::tray::{self, Action};
use crate::{picker, profiles};

/// At login the tray host can come up after the app.
const TRAY_WAIT: Duration = Duration::from_secs(60);
/// The console's unit, for a console the app does not run (backend.rs): the transition's.
const CONSOLE_UNIT: &str = "claude-multi-console.service";

struct Shell {
    port: u16,
    tray: AtomicBool,
}

fn port(app: &AppHandle) -> u16 {
    app.state::<Shell>().port
}

fn has_tray(app: &AppHandle) -> bool {
    app.try_state::<Shell>()
        .is_some_and(|s| s.tray.load(Ordering::SeqCst))
}

/// The first launch: looks for a tray, then does what was asked.
pub fn start(app: &AppHandle, port: u16, request: Request) {
    app.manage(Shell {
        port,
        tray: AtomicBool::new(false),
    });
    let wait = if request == Request::Tray {
        TRAY_WAIT
    } else {
        Duration::ZERO
    };
    let handle = app.clone();
    let tray_only = request == Request::Tray;
    std::thread::spawn(move || attach_tray(handle, wait, tray_only));
    handle_request(app, request);
}

fn attach_tray(app: AppHandle, wait: Duration, tray_only: bool) {
    let deadline = Instant::now() + wait;
    while !tray::host_available() {
        if Instant::now() >= deadline {
            tray::record(false);
            if tray_only {
                eprintln!("agents-multi: no system tray in this session");
            }
            let a = app.clone();
            let _ = app.run_on_main_thread(move || maybe_quit(&a));
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    tray::record(true);
    let a = app.clone();
    let _ = app.run_on_main_thread(move || match tray::create(&a, port(&a)) {
        Ok(()) => a.state::<Shell>().tray.store(true, Ordering::SeqCst),
        Err(e) => {
            eprintln!("agents-multi: cannot create the tray icon: {e}");
            maybe_quit(&a);
        }
    });
}

/// A second launch's arguments (without the program's name), handed over by the single-instance plugin.
pub fn second_launch(app: &AppHandle, args: &[String]) {
    let request = flags::parse(args);
    eprintln!("agents-multi: request from a second launch: {request:?}");
    let raises = matches!(request, Request::Show(_) | Request::Hey);
    handle_request(app, request);
    // the console window, shown again, comes forward with the launcher's token if it gave one: a
    // compositor refuses a plain focus request (activation.rs)
    if raises {
        if let Some(window) = app.get_webview_window(crate::MAIN) {
            crate::activation::bring_forward(&window, crate::activation::forwarded_token(args));
        }
    }
}

pub fn handle_request(app: &AppHandle, request: Request) {
    let result = match request {
        Request::Show(view) => show_console(app, view.as_deref()),
        Request::Pick => picker::open(app, port(app)),
        Request::Hey => show_hey(app),
        Request::Tray => Ok(()), // already running: nothing to do
    };
    if let Err(e) = result {
        eprintln!("agents-multi: {e}");
    }
}

/// The console window on `view` (Today unless another is asked for, as an application opens on its
/// start page): created when there is none, otherwise shown and moved there without a reload.
pub fn show_console(app: &AppHandle, view: Option<&str>) -> tauri::Result<()> {
    let view = view.filter(|v| flags::is_view(v)).unwrap_or("today");
    let port = port(app);
    let Some(window) = app.get_webview_window(crate::MAIN) else {
        return crate::open_main_window(app, port, view);
    };
    let mut url = window.url()?;
    if url.origin() == crate::console::url(port).origin() {
        // a view is a hashchange the page follows (is_view: no quote can reach the script)
        window.eval(format!("location.hash = '{view}'"))?;
    } else {
        // still on the local page, waiting for the console: it goes to the view once it answers
        url.set_query(Some(&format!("port={port}&view={view}")));
        window.navigate(url)?;
    }
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

/// «Hey Claude», the quick entry: not ported yet (apps/tray/hey.py). Its place: until it is, the
/// console window opens instead.
fn show_hey(app: &AppHandle) -> tauri::Result<()> {
    eprintln!("agents-multi: Hey Claude is not ported to the desktop app yet; showing the console");
    show_console(app, None)
}

/// What the tray menu asked for.
pub fn on_tray(app: &AppHandle, action: Action) {
    let result = match action {
        Action::Hey => show_hey(app),
        Action::Console => show_console(app, None),
        Action::View(v) => show_console(app, Some(&v)),
        Action::Launch(profile) => {
            launch(&profile);
            Ok(())
        }
        Action::StartConsole => {
            start_console(app);
            Ok(())
        }
        Action::Quit => {
            app.exit(0);
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("agents-multi: {e}");
    }
}

/// Runs `program` detached from the app (its own process group, no terminal), and reaps it.
fn spawn(program: &str, args: &[&str]) {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    match cmd.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(e) => eprintln!("agents-multi: cannot run {program}: {e}"),
    }
}

/// Opens a profile's Claude Desktop through `claude-launch`, which starts it or brings its window
/// forward. Only a profile the manifests declare.
fn launch(profile: &str) {
    if !profiles::names().iter().any(|p| p == profile) {
        eprintln!("agents-multi: no profile {profile:?}");
        return;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let bin = std::path::Path::new(&home).join(".local/bin/claude-launch");
    spawn(&bin.to_string_lossy(), &[profile]);
}

fn start_console(app: &AppHandle) {
    if !crate::backend::start_again(app) {
        spawn("systemctl", &["--user", "start", CONSOLE_UNIT]);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        tray::refresh(&app);
    });
}

/// Without a tray nothing keeps the app alive but its windows.
fn maybe_quit(app: &AppHandle) {
    if !has_tray(app) && app.webview_windows().is_empty() {
        app.exit(0);
    }
}

/// Window events: the console window hides into the tray instead of closing; the picker closes when
/// the focus leaves it.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match window.label() {
        crate::MAIN => {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if has_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        }
        picker::LABEL => picker::on_window_event(window, event),
        _ => {}
    }
}

/// The app's run events: with a tray, closing the last window does not quit it (the menu's Quit does).
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested {
        code: None, api, ..
    } = event
    {
        if has_tray(app) {
            api.prevent_exit();
        }
    }
}
