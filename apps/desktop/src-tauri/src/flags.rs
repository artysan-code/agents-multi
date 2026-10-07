//! What a launch asks for, from its command line: the same flags as the tray app it replaces
//! (`apps/tray/app.py`). A second launch hands its arguments to the running app, which reads them here.
//!
//!   (none)    show the console window
//!   --tray    start in the tray, no window: what the login unit runs
//!   --pick    «Which Claude?»: choose the profile whose Desktop to open
//!   --hey     «Hey Claude», the quick entry (not ported yet: it shows the console)

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// The console window, on a view (`today`, `system/health`…) or on Today.
    Show(Option<String>),
    Tray,
    Pick,
    Hey,
}

/// The request in `args` (without the program's name). The first match wins in the tray app's order —
/// `--tray`, `--hey`, `--pick` — and anything else is ignored, as there.
pub fn parse<S: AsRef<str>>(args: &[S]) -> Request {
    let has = |flag: &str| args.iter().any(|a| a.as_ref() == flag);
    if has("--tray") {
        Request::Tray
    } else if has("--hey") {
        Request::Hey
    } else if has("--pick") {
        Request::Pick
    } else {
        Request::Show(None)
    }
}

/// Whether `view` can name a view of the console (`system/updates`): it ends up in a URL's fragment
/// and in a script that sets it, so only lowercase words and slashes.
pub fn is_view(view: &str) -> bool {
    !view.is_empty()
        && view.len() <= 64
        && view
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'/' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_flag_shows_the_console() {
        assert_eq!(parse::<&str>(&[]), Request::Show(None));
        assert_eq!(parse(&["--unknown", "x"]), Request::Show(None));
    }

    #[test]
    fn each_flag() {
        assert_eq!(parse(&["--tray"]), Request::Tray);
        assert_eq!(parse(&["--pick"]), Request::Pick);
        assert_eq!(parse(&["--hey"]), Request::Hey);
    }

    #[test]
    fn the_tray_apps_precedence() {
        assert_eq!(parse(&["--pick", "--hey", "--tray"]), Request::Tray);
        assert_eq!(parse(&["--pick", "--hey"]), Request::Hey);
        assert_eq!(parse(&["x", "--pick"]), Request::Pick);
    }

    #[test]
    fn views_are_plain_words() {
        assert!(is_view("today"));
        assert!(is_view("system/updates"));
        assert!(!is_view(""));
        assert!(!is_view("x'; alert(1)//"));
        assert!(!is_view("System"));
        assert!(!is_view(&"a".repeat(65)));
    }
}
