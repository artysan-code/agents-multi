//! Which source the backend runs (docs/adr/0003): the console serves `apps/ui/dist`, reads `shared/` and
//! runs `bin/agents` from it, so it is a folder in the repository's layout. In order:
//!
//! 1. `AGENTS_MULTI_REPO`, then `CLAUDE_MULTI_REPO` (the names bin/lib/prelaunch.sh reads): a checkout
//!    a developer points the app at;
//! 2. in a debug build, the checkout the app was built from;
//! 3. the copy the package carries in its resources (`repo/`, made by scripts/bundle.sh).

use std::path::{Path, PathBuf};

use crate::amenv::am_env;

/// The file that tells a folder is the source.
const MARKER: &str = "apps/cli/main.ts";

#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    /// A checkout, run as a developer runs it: its `bin/agents`, with the Deno on PATH.
    Checkout(PathBuf),
    /// The package's copy, run with the package's Deno.
    Bundled(PathBuf),
}

pub fn is_repo(dir: &Path) -> bool {
    dir.join(MARKER).is_file()
}

/// The source, from the variables `get` returns, a debug build's checkout and the package's copy.
pub fn find(
    get: impl Fn(&str) -> Option<String>,
    checkout: Option<&Path>,
    bundled: Option<&Path>,
) -> Result<Source, String> {
    if let Some(given) = am_env(&get, "REPO") {
        let repo = PathBuf::from(&given);
        return if is_repo(&repo) {
            Ok(Source::Checkout(repo))
        } else {
            Err(format!("AGENTS_MULTI_REPO={given} has no {MARKER}"))
        };
    }
    if let Some(dir) = checkout.and_then(|c| std::fs::canonicalize(c).ok()) {
        if is_repo(&dir) {
            return Ok(Source::Checkout(dir));
        }
    }
    match bundled {
        Some(dir) if is_repo(dir) => Ok(Source::Bundled(dir.to_path_buf())),
        _ => Err(format!(
            "the package carries no source in {} (built without scripts/bundle.sh?) \
             and AGENTS_MULTI_REPO is not set",
            bundled.map_or("its resources".into(), |d| d.display().to_string())
        )),
    }
}

/// The source, from the environment and the package's copy (`bundled`, under the resources).
pub fn from_env(bundled: Option<&Path>) -> Result<Source, String> {
    // A debug build runs the code next to it: the checkout it was built from (apps/desktop/src-tauri).
    let checkout =
        cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    find(|n| std::env::var(n).ok(), checkout.as_deref(), bundled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A fresh folder under the system's temporary directory, removed when dropped.
    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agents-multi-repo-test-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Temp(fs::canonicalize(&dir).unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn make_repo(dir: &Path) {
        fs::create_dir_all(dir.join("apps/cli")).unwrap();
        fs::write(dir.join(MARKER), "").unwrap();
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn the_variable_wins_and_must_be_a_repository() {
        let t = Temp::new("var");
        make_repo(&t.0.join("dev"));
        make_repo(&t.0.join("bundled"));
        let at = t.0.join("dev").display().to_string();
        let env = move |n: &str| (n == "CLAUDE_MULTI_REPO").then(|| at.clone());
        assert_eq!(
            find(env, None, Some(&t.0.join("bundled"))),
            Ok(Source::Checkout(t.0.join("dev")))
        );
        let env = |n: &str| (n == "AGENTS_MULTI_REPO").then(|| "/nowhere".to_string());
        assert!(find(env, None, Some(&t.0.join("bundled"))).is_err());
    }

    #[test]
    fn a_debug_checkout_comes_before_the_package() {
        let t = Temp::new("checkout");
        make_repo(&t.0.join("checkout"));
        make_repo(&t.0.join("bundled"));
        let bundled = t.0.join("bundled");
        assert_eq!(
            find(no_env, Some(&t.0.join("checkout")), Some(&bundled)),
            Ok(Source::Checkout(t.0.join("checkout")))
        );
        // a checkout that is gone (the package installed elsewhere) leaves the package's copy
        assert_eq!(
            find(no_env, Some(&t.0.join("gone")), Some(&bundled)),
            Ok(Source::Bundled(bundled.clone()))
        );
        assert!(find(no_env, None, Some(&t.0.join("gone"))).is_err());
        assert!(find(no_env, None, None).is_err());
    }

    #[test]
    fn this_checkout_is_found() {
        assert!(matches!(from_env(None), Ok(Source::Checkout(r)) if is_repo(&r)));
    }
}
