//! Where the repository is, for the backend: the console serves `apps/ui/dist`, reads `shared/` and
//! runs git and `bin/agents` there, and a compiled backend cannot find it by itself (its modules live
//! in a virtual file system). The app finds it and passes it as `AGENTS_MULTI_REPO`
//! (apps/cli/lib/paths.ts):
//!
//! 1. `AGENTS_MULTI_REPO`, then `CLAUDE_MULTI_REPO`, when set (the names bin/lib/prelaunch.sh reads);
//! 2. in a debug build, the checkout the app was built from;
//! 3. else the target of the runtime's `shared` link (`~/.agents-multi/shared` → `<repo>/shared`),
//!    which `agents install` makes on every machine. The runtime is `AGENTS_MULTI_ROOT`, else
//!    `~/.agents-multi`, else `~/.claude-multi` while only that exists (apps/cli/lib/runtime-root.ts).

use std::path::{Path, PathBuf};

/// The file that tells a folder is the repository.
const MARKER: &str = "apps/cli/main.ts";

/// The runtime under `home`: the new name when it exists or when neither does, the old one while
/// only that exists — `runtimeRoot()` in apps/cli/lib/runtime-root.ts.
pub fn runtime_root(home: &Path, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let now = home.join(".agents-multi");
    let old = home.join(".claude-multi");
    if exists(&now) || !exists(&old) {
        now
    } else {
        old
    }
}

/// The repository whose `shared` folder `runtime/shared` resolves to, when it is one.
pub fn of_runtime(runtime: &Path) -> Option<PathBuf> {
    let shared = std::fs::canonicalize(runtime.join("shared")).ok()?;
    let repo = shared.parent()?.to_path_buf();
    is_repo(&repo).then_some(repo)
}

pub fn is_repo(dir: &Path) -> bool {
    dir.join(MARKER).is_file()
}

/// The first of the variables `get` returns that is set and not empty, as `amEnv()` reads them.
fn am_env(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    ["AGENTS_MULTI_", "CLAUDE_MULTI_"]
        .iter()
        .find_map(|prefix| get(&format!("{prefix}{name}")).filter(|v| !v.is_empty()))
}

/// The repository, from the variables `get` returns, `home`, and the checkout of a debug build.
pub fn find(
    get: impl Fn(&str) -> Option<String>,
    home: Option<&Path>,
    checkout: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(given) = am_env(&get, "REPO") {
        let repo = PathBuf::from(&given);
        return if is_repo(&repo) {
            Ok(repo)
        } else {
            Err(format!("AGENTS_MULTI_REPO={given} has no {MARKER}"))
        };
    }
    if let Some(dir) = checkout.and_then(|c| std::fs::canonicalize(c).ok()) {
        if is_repo(&dir) {
            return Ok(dir);
        }
    }
    let runtime = match am_env(&get, "ROOT") {
        Some(root) => PathBuf::from(root),
        None => runtime_root(home.ok_or("HOME is not set")?, |p| {
            p.symlink_metadata().is_ok()
        }),
    };
    of_runtime(&runtime).ok_or_else(|| {
        format!(
            "{}/shared does not lead to the repository (run `agents install`, or set AGENTS_MULTI_REPO)",
            runtime.display()
        )
    })
}

/// The repository, from the environment.
pub fn from_env() -> Result<PathBuf, String> {
    // A debug build runs the code next to it: the checkout it was built from (apps/desktop/src-tauri).
    let checkout =
        cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    let home = std::env::var_os("HOME").map(PathBuf::from);
    find(
        |n| std::env::var(n).ok(),
        home.as_deref(),
        checkout.as_deref(),
    )
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
        fs::create_dir_all(dir.join("shared")).unwrap();
        fs::write(dir.join(MARKER), "").unwrap();
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn runtime_root_prefers_the_new_name() {
        let home = Path::new("/h");
        let only =
            |set: &'static [&'static str]| move |p: &Path| set.iter().any(|s| p == Path::new(s));
        assert_eq!(runtime_root(home, only(&[])), Path::new("/h/.agents-multi"));
        assert_eq!(
            runtime_root(home, only(&["/h/.claude-multi"])),
            Path::new("/h/.claude-multi")
        );
        assert_eq!(
            runtime_root(home, only(&["/h/.claude-multi", "/h/.agents-multi"])),
            Path::new("/h/.agents-multi")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_runtime_shared_link_leads_to_the_repository() {
        let t = Temp::new("link");
        let repo = t.0.join("src/agents-multi");
        make_repo(&repo);
        fs::create_dir_all(t.0.join(".agents-multi")).unwrap();
        std::os::unix::fs::symlink(repo.join("shared"), t.0.join(".agents-multi/shared")).unwrap();
        assert_eq!(find(no_env, Some(&t.0), None), Ok(repo.clone()));
        // a runtime given by name wins over the home's
        let env =
            |n: &str| (n == "AGENTS_MULTI_ROOT").then(|| t.0.join("none").display().to_string());
        assert!(find(env, Some(&t.0), None).is_err());
    }

    #[test]
    fn the_variable_wins_and_must_be_a_repository() {
        let t = Temp::new("var");
        make_repo(&t.0);
        let at = t.0.display().to_string();
        let env = move |n: &str| (n == "CLAUDE_MULTI_REPO").then(|| at.clone());
        assert_eq!(
            find(env, None, Some(Path::new("/nowhere"))),
            Ok(t.0.clone())
        );
        let env = |n: &str| (n == "AGENTS_MULTI_REPO").then(|| "/nowhere".to_string());
        assert!(find(env, None, None).is_err());
    }

    #[test]
    fn a_debug_checkout_comes_before_the_runtime() {
        let t = Temp::new("checkout");
        make_repo(&t.0);
        assert_eq!(find(no_env, None, Some(&t.0)), Ok(t.0.clone()));
        // a checkout that is not a repository is passed over
        assert!(find(no_env, Some(&t.0.join("home")), Some(&t.0.join("apps"))).is_err());
    }

    #[test]
    fn this_checkout_is_found() {
        assert!(from_env().is_ok_and(|r| is_repo(&r)));
    }
}
