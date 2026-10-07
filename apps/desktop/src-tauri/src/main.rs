//! Agents Multi's desktop app: one window on the local console.
//!
//! The window opens on the bundled local page (`../src/index.html`), which waits for the console to
//! answer on 127.0.0.1 and then navigates to it. The console is loaded by URL, never bundled: it is
//! same-origin by construction (relative URLs, SSE on /api/events, cookies). No IPC is granted to
//! any page — the app has no capabilities — so the console's origin cannot reach the app.

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activation;
mod backend;
mod console;
mod navigation;
mod repo;

use navigation::Decision;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

const MAIN: &str = "main";

fn main() {
    // A second launch can only forward its arguments: the launcher's activation token goes there.
    #[cfg(target_os = "linux")]
    activation::forward_through_args();

    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    set_app_id(&context.config().identifier);

    tauri::Builder::default()
        // First, so a second launch exits before it builds anything: it raises the window instead.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN) {
                activation::bring_forward(&window, activation::forwarded_token(&args));
            }
        }))
        // The console's backend: started before the window, stopped on exit (backend.rs).
        .plugin(backend::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            set_window_class(&app.config().identifier);
            let port = console::port();
            // The local page waits for whatever serves the console on `port`: the backend plugin's
            // sidecar, or a console that was already running.
            open_main_window(app.handle(), port)?;
            Ok(())
        })
        .run(context)
        .expect("error while running the desktop app");
}

/// The window's app_id on Wayland, set before GTK starts (GTK 3 sends the program name): the
/// compositor finds `<app_id>.desktop`, and the icon there, by it. The bundles' desktop file is named
/// after the same identifier (tauri.linux.conf.json, checked by build.rs).
#[cfg(target_os = "linux")]
fn set_app_id(id: &str) {
    gtk::glib::set_prgname(Some(id));
}

/// The X11 class (WM_CLASS) of the windows opened from now on. GTK's init resets it to the program
/// name with a capital first letter, so this runs after it, before the first window.
#[cfg(target_os = "linux")]
fn set_window_class(id: &str) {
    gtk::gdk::set_program_class(id);
}

/// The main window, on the local page that waits for the console on `port`.
fn open_main_window(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let console = console::url(port);
    let page = WebviewUrl::App(format!("index.html?port={port}").into());
    let window = WebviewWindowBuilder::new(app, MAIN, page)
        .title("Agents Multi")
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .on_navigation(move |url| match navigation::decide(url, &console) {
            Decision::Allow => {
                if cfg!(debug_assertions) {
                    eprintln!("agents-multi: navigating to {url}");
                }
                true
            }
            other => {
                refuse(url, other);
                false
            }
        })
        .on_new_window(|url, _features| {
            refuse(&url, navigation::external(&url));
            NewWindowResponse::Deny
        })
        .build()?;
    // the attention asked for when a second launch could not raise the window ends when it has focus
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(true) = event {
            let _ = w.request_user_attention(None);
        }
    });
    Ok(())
}

/// A navigation the window does not follow: a web link goes to the system browser.
fn refuse(url: &Url, decision: Decision) {
    match decision {
        Decision::OpenExternally => {
            if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
                eprintln!("agents-multi: cannot open {url} in the browser: {e}");
            }
        }
        _ => eprintln!("agents-multi: navigation to {url} blocked"),
    }
}
