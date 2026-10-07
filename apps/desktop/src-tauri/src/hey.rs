//! «Hey Claude», the quick entry (what `apps/tray/hey.py` does): one field in a small frameless window
//! near the top of the screen. The page is the console's (`/#hey`, apps/ui/src/pages/hey/), loaded by URL
//! like the main window — through the local page, which waits for the console — so it needs no IPC: it
//! asks through the console's `/api/ask` and hands over to a terminal through `/api/terminal`.
//!
//! The window fits the page: the page says its height, and whether an answer is on screen, through
//! its title (`agents-multi:size=<px>` or `agents-multi:size=<px>,answer`), and asks to close with
//! `agents-multi:close` as the picker does — titles are the one thing a page says without IPC. Like a
//! launcher it goes away when it loses the focus (once it has had it), unless an answer is there to
//! keep reading, as in hey.py.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use crate::navigation::{self, Decision};
use crate::{console, reveal};

pub const LABEL: &str = "hey";
/// The page's request to close, as the picker's (apps/ui/src/lib/window.ts).
const CLOSE_TITLE: &str = "agents-multi:close";
const WIDTH: f64 = 720.0;
/// The field alone, before the page has said its height.
const COMPACT: f64 = 72.0;
const MAX_HEIGHT: f64 = 640.0;
/// From the top of the screen, as a share of its height (hey.py's).
const FROM_TOP: f64 = 0.22;

/// What the page asks of its window, through its title.
#[derive(Debug, PartialEq)]
pub enum Message {
    Close,
    Size { height: f64, answer: bool },
}

/// The message in a title, if it is one: a height is clamped to what the window allows.
pub fn message(title: &str) -> Option<Message> {
    if title == CLOSE_TITLE {
        return Some(Message::Close);
    }
    let rest = title.strip_prefix("agents-multi:size=")?;
    let (px, answer) = match rest.split_once(',') {
        Some((px, "answer")) => (px, true),
        Some(_) => return None,
        None => (rest, false),
    };
    let height = px.parse::<u32>().ok()? as f64;
    Some(Message::Size {
        height: height.clamp(COMPACT, MAX_HEIGHT),
        answer,
    })
}

/// Where the window goes in a screen's work area (logical x, y, width, height): centred, near the top.
pub fn place(area: (f64, f64, f64, f64), width: f64) -> (f64, f64) {
    let (x, y, w, h) = area;
    (x + ((w - width) / 2.0).max(0.0), y + (h * FROM_TOP).round())
}

/// The window's state: whether it has had the focus, and whether an answer is on screen.
#[derive(Default)]
struct State {
    had_focus: AtomicBool,
    answer: AtomicBool,
}

/// Opens «Hey Claude», or brings it forward when it is open.
pub fn open(app: &AppHandle, port: u16) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        if !reveal::is_pending(&w) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return Ok(());
    }
    match app.try_state::<State>() {
        Some(s) => {
            s.had_focus.store(false, Ordering::SeqCst);
            s.answer.store(false, Ordering::SeqCst);
        }
        None => {
            app.manage(State::default());
        }
    }
    let console = console::url(port);
    let page = WebviewUrl::App(format!("index.html?port={port}&view=hey").into());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page)
        .title("Hey Claude")
        .inner_size(WIDTH, COMPACT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true);
    builder = match top_centre(app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    let nav = console.clone();
    let builder = builder
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
        .on_document_title_changed(on_title);
    let window = reveal::hidden(builder, console).build()?;
    reveal::arm(&window);
    Ok(())
}

fn on_title(window: WebviewWindow, title: String) {
    match message(&title) {
        Some(Message::Close) => {
            let _ = window.close();
        }
        Some(Message::Size { height, answer }) => {
            if cfg!(debug_assertions) {
                eprintln!("agents-multi: hey: the page is {height} px high (answer: {answer})");
            }
            if let Some(s) = window.try_state::<State>() {
                s.answer.store(answer, Ordering::SeqCst);
            }
            let _ = window.set_size(LogicalSize::new(WIDTH, height));
        }
        None => {}
    }
}

/// The top centre of the screen under the pointer (else the primary one). On Wayland the compositor
/// places windows itself and ignores this.
fn top_centre(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    Some(place(
        (
            area.position.x as f64 / scale,
            area.position.y as f64 / scale,
            area.size.width as f64 / scale,
            area.size.height as f64 / scale,
        ),
        WIDTH,
    ))
}

/// The window's events: it closes when the focus leaves it, once it has had it and while no answer is
/// on screen.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::Focused(focused) = event else {
        return;
    };
    let Some(s) = window.try_state::<State>() else {
        return;
    };
    if *focused {
        s.had_focus.store(true, Ordering::SeqCst);
    } else if s.had_focus.load(Ordering::SeqCst) && !s.answer.load(Ordering::SeqCst) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_and_size_messages() {
        assert_eq!(message("agents-multi:close"), Some(Message::Close));
        assert_eq!(
            message("agents-multi:size=180"),
            Some(Message::Size {
                height: 180.0,
                answer: false
            })
        );
        assert_eq!(
            message("agents-multi:size=320,answer"),
            Some(Message::Size {
                height: 320.0,
                answer: true
            })
        );
    }

    #[test]
    fn heights_are_clamped_and_other_titles_ignored() {
        assert_eq!(
            message("agents-multi:size=5"),
            Some(Message::Size {
                height: COMPACT,
                answer: false
            })
        );
        assert_eq!(
            message("agents-multi:size=99999,answer"),
            Some(Message::Size {
                height: MAX_HEIGHT,
                answer: true
            })
        );
        assert_eq!(message("Hey Claude"), None);
        assert_eq!(message("agents-multi:size=-3"), None);
        assert_eq!(message("agents-multi:size=12.5"), None);
        assert_eq!(message("agents-multi:size=200,other"), None);
    }

    #[test]
    fn placed_centred_near_the_top() {
        assert_eq!(place((0.0, 0.0, 1920.0, 1000.0), 720.0), (600.0, 220.0));
        assert_eq!(
            place((1920.0, 30.0, 1280.0, 1000.0), 720.0),
            (2200.0, 250.0)
        );
        // a screen narrower than the window: its left edge
        assert_eq!(place((0.0, 0.0, 600.0, 800.0), 720.0), (0.0, 176.0));
    }
}
