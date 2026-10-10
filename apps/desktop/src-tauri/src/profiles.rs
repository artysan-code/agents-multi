//! The profiles, for the tray's «Open Claude Desktop» menu: every folder of the configuration's
//! `profiles/` with a readable `profile.json`, by name — the CLI's rule (`profileNames()`), never a
//! fixed list. The configuration is where the CLI looks (apps/cli/lib/paths.ts): `AGENTS_MULTI_CONFIG`
//! (or `CLAUDE_MULTI_CONFIG`), else `config/` in the runtime — `AGENTS_MULTI_ROOT` (or
//! `CLAUDE_MULTI_ROOT`), else `~/.agents-multi`, or `~/.claude-multi` on a machine that has not moved.
//! Read here, not asked of the console, so the menu still opens a Desktop while the console is down.

use std::path::{Path, PathBuf};

use crate::amenv::{am_env, runtime_root};

/// The configuration folder, given the environment and whether a path exists.
pub fn config_dir_from(
    get: impl Fn(&str) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(dir) = am_env(&get, "CONFIG") {
        return Some(dir.into());
    }
    let home = get("HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
    Some(runtime_root(&get, home.as_deref(), exists)?.join("config"))
}

pub fn config_dir() -> Option<PathBuf> {
    config_dir_from(|n| std::env::var(n).ok(), |p| p.symlink_metadata().is_ok())
}

/// The profiles declared under `config`: folders of `profiles/` whose `profile.json` is JSON, sorted.
pub fn names_in(config: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(config.join("profiles")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let text = std::fs::read_to_string(e.path().join("profile.json")).ok()?;
            serde_json::from_str::<serde_json::Value>(&text).ok()?;
            Some(name)
        })
        .collect();
    names.sort();
    names
}

pub fn names() -> Vec<String> {
    config_dir().map(|c| names_in(&c)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |n| map.get(n).cloned()
    }

    #[test]
    fn config_variable_wins() {
        let get = env(&[
            ("CLAUDE_MULTI_CONFIG", "/b"),
            ("AGENTS_MULTI_CONFIG", "/a"),
            ("HOME", "/h"),
        ]);
        assert_eq!(config_dir_from(get, |_| true), Some("/a".into()));
        let get = env(&[("CLAUDE_MULTI_CONFIG", "/b"), ("HOME", "/h")]);
        assert_eq!(config_dir_from(get, |_| true), Some("/b".into()));
    }

    #[test]
    fn runtime_root_then_home() {
        let get = env(&[("AGENTS_MULTI_ROOT", "/r"), ("HOME", "/h")]);
        assert_eq!(config_dir_from(get, |_| false), Some("/r/config".into()));
        // a fresh machine, and one that moved: the new name
        let get = env(&[("HOME", "/h")]);
        assert_eq!(
            config_dir_from(&get, |_| false),
            Some("/h/.agents-multi/config".into())
        );
        // only the old folder: it is still there
        assert_eq!(
            config_dir_from(&get, |p| p == Path::new("/h/.claude-multi")),
            Some("/h/.claude-multi/config".into())
        );
        assert_eq!(config_dir_from(env(&[]), |_| true), None);
    }

    #[test]
    fn names_are_the_folders_with_a_readable_manifest() {
        let dir =
            std::env::temp_dir().join(format!("agents-multi-profiles-{}", std::process::id()));
        let profiles = dir.join("profiles");
        for (name, manifest) in [
            ("work", Some("{}")),
            ("alpha", Some(r#"{"command":"claude"}"#)),
            ("broken", Some("{ not json")),
            ("empty", None),
        ] {
            std::fs::create_dir_all(profiles.join(name)).unwrap();
            if let Some(m) = manifest {
                std::fs::write(profiles.join(name).join("profile.json"), m).unwrap();
            }
        }
        assert_eq!(names_in(&dir), ["alpha", "work"]);
        assert!(names_in(&dir.join("nowhere")).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
