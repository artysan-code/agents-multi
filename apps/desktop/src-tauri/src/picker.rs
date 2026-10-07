//! «Which Claude?»: the profile picker in a small frameless window of its own. The page is the
//! console's (`/#pick`, apps/ui/src/pages/pick/), loaded by URL like the main window — through the local
//! page, which waits for the console — so it needs no IPC: it lists the profiles and opens one through
//! the console's `/api/launch`. Like a launcher, the window goes away when it loses the focus (once it
//! has had it: on Wayland it may never get it); the page asks for it to close, after a choice or on Esc,
//! by setting its title to `CLOSE_TITLE`, the one thing it can say without IPC.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use crate::navigation::{self, Decision};
use crate::{console, profiles, reveal};

pub const LABEL: &str = "picker";
/// The page's request to close (apps/ui/src/lib/window.ts).
const CLOSE_TITLE: &str = "agents-multi:close";
const WIDTH: f64 = 480.0;

/// Whether the window has had the focus since it opened.
#[derive(Default)]
pub struct Focus(AtomicBool);

/// The window's height for `profiles` rows: the title, the rows, the hint — up to nine rows, the ones
/// with a number key.
pub fn height(profiles: usize) -> f64 {
    96.0 + 62.0 * profiles.clamp(1, 9) as f64
}

/// Opens the picker, or brings it forward when it is open.
pub fn open(app: &AppHandle, port: u16) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        if !reveal::is_pending(&w) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return Ok(());
    }
    if let Some(focus) = app.try_state::<Focus>() {
        focus.0.store(false, Ordering::SeqCst);
    } else {
        app.manage(Focus::default());
    }
    let console = console::url(port);
    let page = WebviewUrl::App(format!("index.html?port={port}&view=pick").into());
    let nav = console.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, page)
        .title("Claude")
        .inner_size(WIDTH, height(profiles::names().len()))
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .on_navigation(move |url| match navigation::decide(url, &nav) {
            Decision::Allow => true,
            other => {
                crate::refuse(url, other);
                false
            }
        })
        .on_new_window(|url, _features| {
            crate::refuse(&url, navigation::external(&url));
            NewWindowResponse::Deny
        })
        .on_document_title_changed(|w, title| {
            if title == CLOSE_TITLE {
                let _ = w.close();
            }
        });
    // shown once the console has loaded in it (reveal.rs)
    let window = reveal::hidden(builder, console).build()?;
    reveal::arm(&window);
    Ok(())
}

/// The picker's window events: it closes when the focus leaves it.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::Focused(focused) = event else {
        return;
    };
    let Some(had) = window.try_state::<Focus>() else {
        return;
    };
    if *focused {
        had.0.store(true, Ordering::SeqCst);
    } else if had.0.load(Ordering::SeqCst) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_follows_the_rows_up_to_nine() {
        assert_eq!(height(0), height(1));
        assert!(height(3) > height(2));
        assert_eq!(height(12), height(9));
    }
}
