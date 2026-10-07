//! What the window may show. The main frame stays on two origins: the bundled local page and the
//! local console. Any other web link goes to the system browser; anything else is refused.

use url::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Load it in the window.
    Allow,
    /// Refuse it here and hand it to the system browser.
    OpenExternally,
    /// Refuse it.
    Block,
}

/// The bundled local page's origin: `tauri://localhost` on Linux and macOS,
/// `http(s)://tauri.localhost` on Windows.
pub fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Where a navigation of the main frame may go, given the console's root URL.
pub fn decide(url: &Url, console: &Url) -> Decision {
    if is_app_url(url) || url.origin() == console.origin() {
        Decision::Allow
    } else {
        external(url)
    }
}

/// A request for a new window (`target="_blank"`, `window.open`): the app has one window, so every
/// web page, the console's own included, opens in the system browser.
pub fn external(url: &Url) -> Decision {
    match url.scheme() {
        "http" | "https" | "mailto" => Decision::OpenExternally,
        _ => Decision::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    const CONSOLE: &str = "http://127.0.0.1:7331/";

    #[test]
    fn local_page_and_console_are_allowed() {
        let console = u(CONSOLE);
        assert_eq!(
            decide(&u("tauri://localhost/index.html?port=7331"), &console),
            Decision::Allow
        );
        assert_eq!(
            decide(&u("http://tauri.localhost/"), &console),
            Decision::Allow
        );
        assert_eq!(
            decide(&u("http://127.0.0.1:7331/tasks?x=1#y"), &console),
            Decision::Allow
        );
    }

    #[test]
    fn same_host_on_another_port_or_scheme_is_not_the_console() {
        let console = u(CONSOLE);
        assert_eq!(
            decide(&u("http://127.0.0.1:8384/"), &console),
            Decision::OpenExternally
        );
        assert_eq!(
            decide(&u("https://127.0.0.1:7331/"), &console),
            Decision::OpenExternally
        );
        assert_eq!(
            decide(&u("http://localhost:7331/"), &console),
            Decision::OpenExternally
        );
    }

    #[test]
    fn web_links_open_externally_the_rest_is_blocked() {
        let console = u(CONSOLE);
        assert_eq!(
            decide(&u("https://example.com/"), &console),
            Decision::OpenExternally
        );
        assert_eq!(
            decide(&u("mailto:someone@example.com"), &console),
            Decision::OpenExternally
        );
        assert_eq!(decide(&u("file:///etc/passwd"), &console), Decision::Block);
        assert_eq!(decide(&u("tauri://evil/"), &console), Decision::Block);
        assert_eq!(decide(&u("javascript:alert(1)"), &console), Decision::Block);
    }

    #[test]
    fn new_windows_never_stay_in_the_app() {
        assert_eq!(
            external(&u("http://127.0.0.1:7331/old/")),
            Decision::OpenExternally
        );
        assert_eq!(external(&u("data:text/html,hi")), Decision::Block);
    }
}
