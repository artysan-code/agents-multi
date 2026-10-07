//! Windows that appear already showing the console. Each of the app's windows opens on the local page,
//! which waits for the console and then navigates there; shown at once, it would flash «Connecting to
//! the console…» even when the console answers in a few milliseconds. So a window is built hidden
//! (`hidden`) and shown when the console's page has finished loading in it, or after `GRACE` when it
//! has not (the console is slow or down): then the local page says so and keeps waiting, as before.
//!
//! A request to raise a window still hidden (a second launch, with the launcher's activation token)
//! is kept and applied when the window is shown, so the token is not spent on a window not yet mapped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::{PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use url::Url;

/// How long a window waits, hidden, for the console's page before it shows the local page instead.
pub const GRACE: Duration = Duration::from_millis(1500);

/// The windows built hidden and not shown yet, by label: a generation (a window closed and opened
/// again under the same label is another one, which an older timer must not show) and the activation
/// token a raise left for it.
#[derive(Default)]
struct Pending(Mutex<HashMap<String, Entry>>);

struct Entry {
    generation: u64,
    token: Option<String>,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Whether a page load in a window shows the console: the page has finished loading and it is the
/// console's origin (the local page's own load does not count).
pub fn shows_console(event: PageLoadEvent, url: &Url, console: &Url) -> bool {
    event == PageLoadEvent::Finished && url.origin() == console.origin()
}

/// The builder of a window that stays hidden until the console's page has loaded in it. Call `arm`
/// with the window once it is built.
pub fn hidden<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    console: Url,
) -> WebviewWindowBuilder<'a, R, M> {
    builder.visible(false).on_page_load(move |window, payload| {
        if shows_console(payload.event(), payload.url(), &console) {
            if cfg!(debug_assertions) && is_pending(&window) {
                eprintln!(
                    "agents-multi: {}: the console's page has loaded, showing the window",
                    window.label()
                );
            }
            reveal(&window);
        }
    })
}

/// Starts the wait of a window built with `hidden`: it is shown after `GRACE` if the console's page
/// has not loaded by then.
pub fn arm<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle();
    if app.try_state::<Pending>().is_none() {
        app.manage(Pending::default());
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    let label = window.label().to_owned();
    if let Ok(mut map) = app.state::<Pending>().0.lock() {
        map.insert(
            label.clone(),
            Entry {
                generation,
                token: None,
            },
        );
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GRACE);
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = a.get_webview_window(&label) else {
                return;
            };
            if take(&a, &label, Some(generation)).is_some() {
                if cfg!(debug_assertions) {
                    eprintln!("agents-multi: {label}: no console page yet, showing the local page");
                }
                show(&window, None);
            }
        });
    });
}

/// Whether `window` was built hidden and is not shown yet.
pub fn is_pending<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window
        .try_state::<Pending>()
        .and_then(|p| p.0.lock().ok().map(|m| m.contains_key(window.label())))
        .unwrap_or(false)
}

/// Shows a window still waiting, with the token a raise left for it.
pub fn reveal<R: Runtime>(window: &WebviewWindow<R>) {
    if let Some(entry) = take(window.app_handle(), window.label(), None) {
        show(window, entry.token);
    }
}

/// Brings a window forward for a second launch, with the launcher's token if it gave one; a window
/// still waiting keeps the token for the moment it is shown.
pub fn raise<R: Runtime>(window: &WebviewWindow<R>, token: Option<String>) {
    if let Some(pending) = window.try_state::<Pending>() {
        if let Ok(mut map) = pending.0.lock() {
            if let Some(entry) = map.get_mut(window.label()) {
                if token.is_some() {
                    entry.token = token;
                }
                return;
            }
        }
    }
    crate::activation::bring_forward(window, token);
}

/// The pending entry of `label`, removed; with a generation, only if it is still that one.
fn take<R: Runtime>(app: &AppHandle<R>, label: &str, generation: Option<u64>) -> Option<Entry> {
    let pending = app.try_state::<Pending>()?;
    let mut map = pending.0.lock().ok()?;
    match (map.get(label), generation) {
        (Some(e), Some(g)) if e.generation != g => None,
        (Some(_), _) => map.remove(label),
        (None, _) => None,
    }
}

/// Shows a window that waited: with the token a second launch left while it did, or as its own
/// launch's window, which GTK maps with the launcher's token from the environment.
fn show<R: Runtime>(window: &WebviewWindow<R>, token: Option<String>) {
    match token {
        Some(token) => crate::activation::bring_forward(window, Some(token)),
        None => {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_consoles_finished_page_counts() {
        let console = Url::parse("http://127.0.0.1:7331/").unwrap();
        let page = Url::parse("http://127.0.0.1:7331/#hey").unwrap();
        let local = Url::parse("tauri://localhost/index.html?port=7331&view=hey").unwrap();
        let other_port = Url::parse("http://127.0.0.1:7332/").unwrap();
        assert!(shows_console(PageLoadEvent::Finished, &page, &console));
        assert!(!shows_console(PageLoadEvent::Started, &page, &console));
        assert!(!shows_console(PageLoadEvent::Finished, &local, &console));
        assert!(!shows_console(
            PageLoadEvent::Finished,
            &other_port,
            &console
        ));
    }
}
