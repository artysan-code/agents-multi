//! What the programs the app starts must not inherit from its AppImage. The AppImage's AppRun points
//! the app at the libraries, Python, Perl, GTK modules and data folders inside its mount (`APPDIR`,
//! `/tmp/.mount_*`); a child that keeps them — Claude Desktop from the tray, the console and through it
//! Claude Code, git, the hooks — loads the mount's libraries instead of the system's, or breaks outright
//! (python3: «No module named 'encodings'»). Each spawn of another program takes its environment
//! through `apply`; the app's own restart and re-exec keep theirs. A deb or a checkout has no
//! `APPDIR`, and nothing changes.

use std::process::Command;

/// Set by AppRun and its GTK hook with no mount path in the value: gone with the AppImage.
const OWN: [&str; 6] = [
    "APPDIR",
    "OWD",
    "ARGV0",
    "GTK_THEME",
    "GDK_BACKEND",
    "PYTHONDONTWRITEBYTECODE",
];

/// Pure: an entry of a value that lies in an AppImage's mount (this one's, or the one before it, which
/// started this one at an update).
fn in_mount(entry: &str, appdir: &str) -> bool {
    entry.contains("/.mount_") || (!appdir.is_empty() && entry.starts_with(appdir))
}

/// Pure: the changes to `vars` for a child — a value to set, or `None` to remove. Nothing when there is
/// no `APPDIR`. A value that names the mount keeps its other entries (`PATH` keeps the person's), or is
/// removed when none is left; `XDG_DATA_DIRS` left with only `/usr/share`, which the GTK hook added,
/// is removed too, so the child falls back to the specification's default.
pub fn fixes(vars: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let Some(appdir) = vars
        .iter()
        .find(|(k, _)| k == "APPDIR")
        .map(|(_, v)| v.as_str())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (k, v) in vars {
        if OWN.contains(&k.as_str()) {
            out.push((k.clone(), None));
            continue;
        }
        if !v.split(':').any(|e| in_mount(e, appdir)) {
            continue;
        }
        let mut kept: Vec<&str> = Vec::new();
        for e in v.split(':') {
            if !e.is_empty() && !in_mount(e, appdir) && !kept.contains(&e) {
                kept.push(e);
            }
        }
        let gone = kept.is_empty() || (k == "XDG_DATA_DIRS" && kept == ["/usr/share"]);
        out.push((k.clone(), (!gone).then(|| kept.join(":"))));
    }
    out
}

/// This process's environment, as `fixes` takes it.
fn current() -> Vec<(String, String)> {
    std::env::vars().collect()
}

/// `PATH` for a child: this process's, without the mount's folders.
pub fn path() -> Option<std::ffi::OsString> {
    match fixes(&current()).into_iter().find(|(k, _)| k == "PATH") {
        Some((_, v)) => v.map(Into::into),
        None => std::env::var_os("PATH"),
    }
}

/// Gives `cmd` an environment without the AppImage's (see `fixes`).
pub fn apply(cmd: &mut Command) -> &mut Command {
    for (k, v) in fixes(&current()) {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        let v = vars(&[("PATH", "/usr/bin"), ("GTK_THEME", "Breeze")]);
        assert!(fixes(&v).is_empty());
    }

    #[test]
    fn the_mount_leaves_the_child_and_the_persons_values_stay() {
        let m = "/tmp/.mount_me.abc";
        let v = vars(&[
            ("APPDIR", m),
            ("OWD", "/tmp/.mount_me.old/usr"),
            ("GTK_THEME", "Adwaita:dark"),
            ("PATH", "/h/.local/bin:/tmp/.mount_me.abc/usr/bin/:/usr/bin"),
            ("PYTHONHOME", "/tmp/.mount_me.abc/usr/"),
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_me.abc/usr/lib/:/tmp/.mount_me.old/usr/lib/:",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_me.abc/usr/share:/usr/share:/tmp/.mount_me.old/usr/share:/usr/share:",
            ),
            ("HOME", "/h"),
            ("QT_WAYLAND_RECONNECT", "1"),
        ]);
        let mut got = fixes(&v);
        got.sort();
        assert_eq!(
            got,
            vec![
                ("APPDIR".into(), None),
                ("GTK_THEME".into(), None),
                ("LD_LIBRARY_PATH".into(), None),
                ("OWD".into(), None),
                ("PATH".into(), Some("/h/.local/bin:/usr/bin".into())),
                ("PYTHONHOME".into(), None),
                ("XDG_DATA_DIRS".into(), None),
            ]
        );
    }

    #[test]
    fn xdg_data_dirs_keeps_what_the_session_had() {
        let v = vars(&[
            ("APPDIR", "/tmp/.mount_x"),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_x/usr/share:/usr/share:/usr/local/share:/usr/share",
            ),
        ]);
        let got = fixes(&v);
        assert!(got.contains(&(
            "XDG_DATA_DIRS".into(),
            Some("/usr/share:/usr/local/share".into())
        )));
    }

    #[test]
    fn an_extracted_appimage_is_recognised_by_its_appdir() {
        let v = vars(&[
            ("APPDIR", "/tmp/appimage_extracted_1"),
            ("PATH", "/tmp/appimage_extracted_1/usr/bin:/usr/bin"),
        ]);
        assert!(fixes(&v).contains(&("PATH".into(), Some("/usr/bin".into()))));
    }
}
