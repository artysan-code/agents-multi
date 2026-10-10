//! The project's environment variables, read as the CLI's `amEnv()` does (shared/mcp/lib/env.ts):
//! `AGENTS_MULTI_<NAME>`, else `CLAUDE_MULTI_<NAME>` (the name before the rename, read until 1.0). One
//! copy for every module that looks one up, and the runtime folder they share.

use std::path::{Path, PathBuf};

/// The variable that is set and not empty — `AGENTS_MULTI_<name>` first — and its value.
pub fn am_var(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<(String, String)> {
    ["AGENTS_MULTI_", "CLAUDE_MULTI_"]
        .iter()
        .find_map(|prefix| {
            let var = format!("{prefix}{name}");
            get(&var).filter(|v| !v.is_empty()).map(|v| (var, v))
        })
}

/// The value of `AGENTS_MULTI_<name>`, else of `CLAUDE_MULTI_<name>`; empty counts as not set.
pub fn am_env(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    am_var(get, name).map(|(_, v)| v)
}

/// Pure: the runtime, as apps/cli/lib/runtime-root.ts finds it: `AGENTS_MULTI_ROOT`, else
/// `~/.agents-multi`, else `~/.claude-multi` while only that exists (a machine not moved yet, before
/// the CLI has made the first a link to the second).
pub fn runtime_root(
    get: &impl Fn(&str) -> Option<String>,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(root) = am_env(get, "ROOT") {
        return Some(PathBuf::from(root));
    }
    let home = home?;
    let (now, old) = (home.join(".agents-multi"), home.join(".claude-multi"));
    Some(if exists(&now) || !exists(&old) {
        now
    } else {
        old
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn the_new_name_wins_and_an_empty_value_is_not_set() {
        let get = env(&[("CLAUDE_MULTI_X", "old"), ("AGENTS_MULTI_X", "new")]);
        assert_eq!(am_env(&get, "X").as_deref(), Some("new"));
        let get = env(&[("CLAUDE_MULTI_X", "old")]);
        assert_eq!(
            am_var(&get, "X"),
            Some(("CLAUDE_MULTI_X".into(), "old".into()))
        );
        let get = env(&[("AGENTS_MULTI_X", ""), ("CLAUDE_MULTI_X", "old")]);
        assert_eq!(am_env(&get, "X").as_deref(), Some("old"));
        assert_eq!(am_env(&env(&[]), "X"), None);
    }

    #[test]
    fn the_runtime_is_the_variable_then_the_new_folder_then_the_old_one_while_alone() {
        let home = Path::new("/h");
        let none = env(&[]);
        assert_eq!(
            runtime_root(&none, Some(home), |_| false),
            Some("/h/.agents-multi".into())
        );
        assert_eq!(
            runtime_root(&none, Some(home), |p| p == Path::new("/h/.claude-multi")),
            Some("/h/.claude-multi".into())
        );
        assert_eq!(
            runtime_root(&none, Some(home), |_| true),
            Some("/h/.agents-multi".into())
        );
        let root = env(&[("CLAUDE_MULTI_ROOT", "/rt")]);
        assert_eq!(runtime_root(&root, None, |_| true), Some("/rt".into()));
        assert_eq!(runtime_root(&none, None, |_| true), None);
    }
}
