//! The project's environment variables, read as the CLI's `amEnv()` does (shared/mcp/lib/env.ts):
//! `AGENTS_MULTI_<NAME>`. One copy for every module that looks one up, and the runtime folder they share.

use std::path::{Path, PathBuf};

/// The value of `AGENTS_MULTI_<name>`; empty counts as not set.
pub fn am_env(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(&format!("AGENTS_MULTI_{name}")).filter(|v| !v.is_empty())
}

/// Pure: the runtime, as apps/cli/lib/runtime-root.ts finds it: `AGENTS_MULTI_ROOT`, else
/// `~/.agents-multi`.
pub fn runtime_root(get: &impl Fn(&str) -> Option<String>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(root) = am_env(get, "ROOT") {
        return Some(PathBuf::from(root));
    }
    Some(home?.join(".agents-multi"))
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
    fn an_empty_value_is_not_set() {
        let get = env(&[("AGENTS_MULTI_X", "v"), ("AGENTS_MULTI_Y", "")]);
        assert_eq!(am_env(&get, "X").as_deref(), Some("v"));
        assert_eq!(am_env(&get, "Y"), None);
        assert_eq!(am_env(&env(&[]), "X"), None);
    }

    #[test]
    fn the_runtime_is_the_variable_then_the_folder_in_home() {
        let home = Path::new("/h");
        let none = env(&[]);
        assert_eq!(
            runtime_root(&none, Some(home)),
            Some("/h/.agents-multi".into())
        );
        let root = env(&[("AGENTS_MULTI_ROOT", "/rt")]);
        assert_eq!(runtime_root(&root, None), Some("/rt".into()));
        assert_eq!(runtime_root(&none, None), None);
    }
}
