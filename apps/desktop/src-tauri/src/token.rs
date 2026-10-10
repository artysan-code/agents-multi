//! The console's token (apps/cli/console/token.ts): the console asks for a secret on everything but its
//! liveness probe, and writes it, at every start, to a file only the user reads — in the folder of the
//! app's socket (`updater::socket::dir_from`), `agents-multi-console.token`, with the port in the name
//! when it is not the default. The app reads it afresh whenever it needs it, because a console that
//! restarts has a new one, and never keeps it.
//!
//! - The tray's requests send it as a header (`http.rs`).
//! - The windows get it as a cookie: the local page (`index.html`), once the console answers, goes to
//!   `index.html?go=1&view=…`, which no page loads — `intercept` takes that navigation, reads the file
//!   and sends the window to `/?k=<token>`; the console sets the cookie and redirects to its root.
//!   The token goes from the file to the window inside this process, never through an argument list.
//! - A page that finds its token gone (a console restarted under an open window) says so by its
//!   title, `REAUTH_TITLE`, and the main window enters again.

use std::path::{Path, PathBuf};
use std::thread;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use url::Url;

use crate::updater::socket::dir_from;
use crate::{console, flags, navigation};

/// The header the console reads the token from.
pub const HEADER: &str = "x-agents-token";
/// What a page sets its title to when the console no longer knows its token (apps/ui/src/lib/window.ts).
pub const REAUTH_TITLE: &str = "agents-multi:reauth";
/// The longest token read: the console's is 43 characters.
const MAX_LEN: usize = 128;

/// The token file's name for the console on `port`.
pub fn file_name(port: u16) -> String {
    if port == console::DEFAULT_PORT {
        "agents-multi-console.token".into()
    } else {
        format!("agents-multi-console.{port}.token")
    }
}

/// Pure: the token file's path, in the socket's folder.
pub fn path_from(
    get: &impl Fn(&str) -> Option<String>,
    home: Option<&Path>,
    port: u16,
) -> Option<PathBuf> {
    dir_from(get, home).map(|(dir, _)| dir.join(file_name(port)))
}

/// Pure: a token in the file's text, or None when it is not one (empty, too long, or with characters
/// a header or a URL would have to escape).
pub fn parse(text: &str) -> Option<String> {
    let t = text.trim();
    let ok = !t.is_empty()
        && t.len() <= MAX_LEN
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then(|| t.to_string())
}

/// The console's token as the file has it now; None when the console has not written one (it is not
/// running, or runs code from before the token).
pub fn read(port: u16) -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = path_from(&|n| std::env::var(n).ok(), home.as_deref(), port)?;
    parse(&std::fs::read_to_string(path).ok()?)
}

/// Pure: where a window enters the console: its root with the token as the key, on `view`.
pub fn entry_url(port: u16, token: Option<&str>, view: Option<&str>) -> Url {
    let mut url = console::url(port);
    if let Some(t) = token {
        url.query_pairs_mut().append_pair("k", t);
    }
    url.set_fragment(view.filter(|v| flags::is_view(v)));
    url
}

/// Sends the window `label` into the console, with the token as it is now. Off the calling thread: the
/// callers are navigation and title callbacks of the window itself.
pub fn enter<R: Runtime>(app: &AppHandle<R>, label: &str, port: u16, view: Option<String>) {
    let (app, label) = (app.clone(), label.to_string());
    thread::spawn(move || {
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        let url = entry_url(port, read(port).as_deref(), view.as_deref());
        if let Err(e) = window.navigate(url) {
            eprintln!("agents-multi: cannot open the console in {label}: {e}");
        }
    });
}

/// Takes the local page's handoff (`navigation::handoff`): true when `url` was one, and the window is
/// on its way into the console.
pub fn intercept<R: Runtime>(app: &AppHandle<R>, label: &str, port: u16, url: &Url) -> bool {
    match navigation::handoff(url) {
        Some(view) => {
            enter(app, label, port, view);
            true
        }
        None => false,
    }
}

/// The main window's answer to `REAUTH_TITLE`: enters again, on the view it shows.
pub fn reauth<R: Runtime>(window: &WebviewWindow<R>, port: u16) {
    let view = window
        .url()
        .ok()
        .and_then(|u| u.fragment().map(str::to_string))
        .filter(|v| flags::is_view(v));
    enter(window.app_handle(), window.label(), port, view);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |n| {
            pairs
                .iter()
                .find(|(k, _)| *k == n)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn the_file_is_beside_the_socket_one_per_port() {
        let get = env(&[("XDG_RUNTIME_DIR", "/run/user/1")]);
        assert_eq!(
            path_from(&get, None, 7331),
            Some(PathBuf::from("/run/user/1/agents-multi-console.token"))
        );
        assert_eq!(
            path_from(&get, None, 7400),
            Some(PathBuf::from("/run/user/1/agents-multi-console.7400.token"))
        );
        let home = PathBuf::from("/h");
        assert_eq!(
            path_from(&env(&[]), Some(&home), 7331),
            Some(PathBuf::from(
                "/h/.local/state/agents-multi/agents-multi-console.token"
            ))
        );
        assert_eq!(path_from(&env(&[]), None, 7331), None);
    }

    #[test]
    fn a_token_is_one_word_of_the_console_alphabet() {
        assert_eq!(parse("aB-_9\n").as_deref(), Some("aB-_9"));
        assert_eq!(parse(""), None);
        assert_eq!(parse("  \n"), None);
        assert_eq!(parse("a b"), None);
        assert_eq!(parse("a&k=b"), None);
        assert_eq!(parse(&"a".repeat(MAX_LEN + 1)), None);
    }

    #[test]
    fn a_window_enters_with_the_key_and_the_view() {
        assert_eq!(
            entry_url(7331, Some("tok_1"), Some("system/health")).as_str(),
            "http://127.0.0.1:7331/?k=tok_1#system/health"
        );
        assert_eq!(
            entry_url(7331, Some("tok"), None).as_str(),
            "http://127.0.0.1:7331/?k=tok"
        );
        // without a token (an older console) it is the plain root; a view that is not one is dropped
        assert_eq!(
            entry_url(7331, None, Some("a'b")).as_str(),
            "http://127.0.0.1:7331/"
        );
    }
}
