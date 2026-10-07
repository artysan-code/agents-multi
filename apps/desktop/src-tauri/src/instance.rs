//! One instance of the app, and a development instance beside it.
//!
//! A second launch hands its arguments to the running app and exits (`tauri-plugin-single-instance`,
//! over D-Bus on Linux). That keeps a build under test from starting while the installed app runs: it
//! would only raise the other one. In a debug build, `AGENTS_MULTI_DEV_INSTANCE=<name>` gives the app an
//! identity of its own — on Linux the plugin's D-Bus name gets `.dev_<name>`, elsewhere the plugin is
//! left out — so it runs on the normal session bus next to the other, and a second launch with the same
//! name still reaches it. A development instance also leaves the session's `app.json` (the doctor's
//! `app.tray`) to the app the session runs. Release builds ignore the variable.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Wry};

/// The variable that names a development instance (debug builds only).
pub const VAR: &str = "AGENTS_MULTI_DEV_INSTANCE";

/// A development instance's name, as a D-Bus name element takes it: letters, digits and `_`, any other
/// character turned into `_`. None for an unset or empty value.
pub fn parse(value: Option<&str>) -> Option<String> {
    let v = value?.trim();
    (!v.is_empty()).then(|| {
        v.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    })
}

/// This launch's development instance, in a debug build where the variable is set.
pub fn dev() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    parse(std::env::var(VAR).ok().as_deref())
}

/// The base of the single-instance plugin's D-Bus name (it appends `.SingleInstance`): the bundle
/// identifier, with a development instance's name.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn dbus_id(identifier: &str, dev: Option<&str>) -> String {
    match dev {
        Some(name) => format!("{identifier}.dev_{name}"),
        None => identifier.to_owned(),
    }
}

/// The single-instance plugin, with this launch's identity. `on_second` gets a second launch's
/// arguments, the program's name included.
pub fn single_instance(
    identifier: &str,
    on_second: impl FnMut(&AppHandle, Vec<String>, String) + Send + Sync + 'static,
) -> TauriPlugin<Wry> {
    let dev = dev();
    if let Some(name) = &dev {
        eprintln!("agents-multi: development instance {name:?}: a single instance of its own, beside the installed app");
    }
    let builder = tauri_plugin_single_instance::Builder::new().callback(on_second);
    #[cfg(target_os = "linux")]
    {
        builder.dbus_id(dbus_id(identifier, dev.as_deref())).build()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = identifier;
        match dev {
            // the plugin's identity is the bundle identifier there: a development instance goes without
            Some(_) => tauri::plugin::Builder::new("agents-multi-dev-instance").build(),
            None => builder.build(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_fits_a_dbus_name() {
        assert_eq!(parse(None), None);
        assert_eq!(parse(Some("")), None);
        assert_eq!(parse(Some("  ")), None);
        assert_eq!(parse(Some("fix")), Some("fix".into()));
        assert_eq!(parse(Some("f5-fix.2")), Some("f5_fix_2".into()));
        assert_eq!(parse(Some("4ever")), Some("4ever".into()));
    }

    #[test]
    fn the_dbus_id_carries_the_instance() {
        assert_eq!(
            dbus_id("net.local.agents-multi", None),
            "net.local.agents-multi"
        );
        // `dev_` first: a name element may not start with a digit
        assert_eq!(
            dbus_id("net.local.agents-multi", Some("4ever")),
            "net.local.agents-multi.dev_4ever"
        );
    }
}
