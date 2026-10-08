//! The app's half of the replacement step (docs/adr/0003): on a machine in app mode the code Claude,
//! the launchers and the MCP servers use is a copy of the package's in the runtime
//! (`~/.agents-multi/app/current`, apps/cli/appcopy.ts). When the app starts with a build that copy is
//! not — after an update, or the first time — it runs `agents install --app` from its package, before
//! its backend starts and so before the console is shown, and waits for it. The CLI decides the rest
//! (it refuses a checkout installation, leaves install waiting while a Claude is open) and records the
//! result for the doctor, which the health page shows; the app logs it in `install.log`.
//!
//! At every start it also writes the build it carries to `$XDG_STATE_HOME/agents-multi/app-build.json`,
//! which the doctor compares with the copy's. A development build, or one pointed at a checkout
//! (`AGENTS_MULTI_REPO`), does neither: its code is not the package's.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::backend::{child_path, DENO, PERMISSIONS};
use crate::repo::{self, Source};

/// An install that runs longer than this is stopped (the backend waits for it).
const TIMEOUT: Duration = Duration::from_secs(300);

/// The stamp at the root of the package's code (scripts/bundle.sh).
const BUILD_FILE: &str = "build.json";

/// Runs `install --app` when the package's build is not the copy's; called by the backend's
/// supervisor before it starts anything.
pub fn before_backend(app: &AppHandle) {
    let resources = app.path().resource_dir().ok();
    let bundled = resources.as_ref().map(|r| r.join("repo"));
    let Ok(Source::Bundled(code)) = repo::from_env(bundled.as_deref()) else {
        return; // a checkout: its code is not the package's
    };
    let Some(build) = read_build(&code) else {
        return log(&format!(
            "{} has no {BUILD_FILE}: no install",
            code.display()
        ));
    };
    let get = |n: &str| std::env::var(n).ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(dir) = state_dir(&get, home.as_deref()) {
        let version = app.package_info().version.to_string();
        let _ = std::fs::create_dir_all(&dir).and_then(|_| {
            std::fs::write(
                dir.join("app-build.json"),
                format!("{{\"version\":\"{version}\",\"build\":\"{build}\"}}\n"),
            )
        });
    }
    let Some(root) = runtime_root(&get, home.as_deref()) else {
        return;
    };
    let copy = read_build(&root.join("app/current"));
    if copy.as_deref() == Some(build.as_str()) {
        return;
    }
    let Some(deno) = package_deno() else {
        return log("the package's Deno is missing next to the app: no install");
    };
    let cache = resources.map(|r| r.join("deno-dir")).filter(|d| d.is_dir());
    let exe = std::env::current_exe().ok();
    let cmd = InstallCommand::new(&code, &deno, cache.as_deref(), exe.as_deref());
    log(&format!(
        "the app's code is {build}, its copy {}: running {}",
        copy.as_deref().unwrap_or("none"),
        cmd.describe()
    ));
    let log_path = app.path().app_log_dir().map(|d| d.join("install.log")).ok();
    match run(&cmd, home.as_deref(), log_path.as_deref()) {
        Ok(status) => log(&format!("install --app finished ({status})")),
        Err(e) => log(&format!("install --app: {e}")),
    }
}

fn log(message: &str) {
    eprintln!("agents-multi: {message}");
}

/// Pure: a build's name, as apps/cli/appcopy.ts's `buildId`: its version and the start of its digest.
pub fn build_id(stamp: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stamp).ok()?;
    let version = v.get("version")?.as_str()?;
    let digest = v.get("digest")?.as_str()?;
    (digest.len() >= 12 && digest.is_ascii()).then(|| format!("{version}-{}", &digest[..12]))
}

fn read_build(dir: &Path) -> Option<String> {
    build_id(&std::fs::read_to_string(dir.join(BUILD_FILE)).ok()?)
}

/// The first of the variables `get` returns that is set and not empty, as `amEnv()` reads them.
fn am_env(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    ["AGENTS_MULTI_", "CLAUDE_MULTI_"]
        .iter()
        .find_map(|prefix| get(&format!("{prefix}{name}")).filter(|v| !v.is_empty()))
}

/// Pure: the runtime, as apps/cli/lib/paths.ts finds it: AGENTS_MULTI_ROOT, else ~/.agents-multi (a
/// machine not moved yet has it as a link to ~/.claude-multi).
pub fn runtime_root(get: &impl Fn(&str) -> Option<String>, home: Option<&Path>) -> Option<PathBuf> {
    am_env(get, "ROOT")
        .map(PathBuf::from)
        .or_else(|| home.map(|h| h.join(".agents-multi")))
}

/// Pure: `$XDG_STATE_HOME/agents-multi`, the CLI's STATE (the old name, `claude-multi`, is a link to it
/// once the CLI has moved it: apps/cli/lib/runtime-root.ts).
pub fn state_dir(get: &impl Fn(&str) -> Option<String>, home: Option<&Path>) -> Option<PathBuf> {
    get("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|h| h.join(".local/state")))
        .map(|d| d.join("agents-multi"))
}

fn package_deno() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(
        exe.parent()?
            .join(format!("{DENO}{}", std::env::consts::EXE_SUFFIX)),
    )
    .filter(|p| p.is_file())
}

/// `agents install --app`, run as the backend runs: the package's Deno on its read-only cache, which
/// the CLI forgets before it starts anything (AGENTS_MULTI_BACKEND_ONLY), with the package's Deno and
/// the app's executable named for the runtime's links.
#[derive(Debug)]
pub struct InstallCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub dir: PathBuf,
    pub env: Vec<(&'static str, String)>,
}

impl InstallCommand {
    pub fn new(code: &Path, deno: &Path, cache: Option<&Path>, exe: Option<&Path>) -> Self {
        let mut args: Vec<String> = ["run", "--quiet", "--cached-only"]
            .map(String::from)
            .to_vec();
        args.extend(PERMISSIONS.map(String::from));
        args.push(code.join("apps/cli/main.ts").display().to_string());
        args.extend(["install", "--app"].map(String::from));
        let mut env = vec![
            ("AGENTS_MULTI_DENO", deno.display().to_string()),
            ("DENO_NO_UPDATE_CHECK", "1".to_string()),
        ];
        if let Some(cache) = cache {
            env.push(("DENO_DIR", cache.display().to_string()));
            env.push(("AGENTS_MULTI_BACKEND_ONLY", "DENO_DIR".to_string()));
        }
        if let Some(exe) = exe {
            env.push(("AGENTS_MULTI_APP", exe.display().to_string()));
        }
        InstallCommand {
            program: deno.to_path_buf(),
            args,
            dir: code.to_path_buf(),
            env,
        }
    }

    fn describe(&self) -> String {
        format!("{} {}", self.program.display(), self.args.join(" "))
    }
}

fn run(
    cmd: &InstallCommand,
    home: Option<&Path>,
    log_path: Option<&Path>,
) -> std::io::Result<std::process::ExitStatus> {
    let (out, err) = match log_path {
        Some(path) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut file = OpenOptions::new().create(true).append(true).open(path)?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            writeln!(file, "--- {now} (unix time) {}", cmd.describe())?;
            (Stdio::from(file.try_clone()?), Stdio::from(file))
        }
        None => (Stdio::inherit(), Stdio::inherit()),
    };
    let mut command = Command::new(&cmd.program);
    command
        .args(&cmd.args)
        .current_dir(&cmd.dir)
        .envs(cmd.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    if let Some(path) = child_path(home, std::env::var_os("PATH")) {
        command.env("PATH", path);
    }
    let mut child = command.spawn()?;
    let until = Instant::now() + TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(format!(
                "did not finish in {}s: stopped",
                TIMEOUT.as_secs()
            )));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_is_its_version_and_the_start_of_its_digest() {
        let stamp = r#"{"version":"0.14.0","commit":"45b7b6c","digest":"0123456789abcdef0123"}"#;
        assert_eq!(build_id(stamp).as_deref(), Some("0.14.0-0123456789ab"));
        assert_eq!(build_id(r#"{"version":"0.14.0","digest":"short"}"#), None);
        assert_eq!(build_id(r#"{"digest":"0123456789abcdef"}"#), None);
        assert_eq!(build_id("not json"), None);
    }

    #[test]
    fn the_runtime_and_the_state_follow_the_cli() {
        let home = Path::new("/h");
        let none = |_: &str| None;
        assert_eq!(
            runtime_root(&none, Some(home)),
            Some(PathBuf::from("/h/.agents-multi"))
        );
        let root = |n: &str| (n == "CLAUDE_MULTI_ROOT").then(|| "/rt".to_string());
        assert_eq!(runtime_root(&root, Some(home)), Some(PathBuf::from("/rt")));
        assert_eq!(
            state_dir(&none, Some(home)),
            Some(PathBuf::from("/h/.local/state/agents-multi"))
        );
        let xdg = |n: &str| (n == "XDG_STATE_HOME").then(|| "/s".to_string());
        assert_eq!(
            state_dir(&xdg, Some(home)),
            Some(PathBuf::from("/s/agents-multi"))
        );
        assert_eq!(state_dir(&none, None), None);
    }

    #[test]
    fn install_runs_on_the_package_deno_and_cache() {
        let cmd = InstallCommand::new(
            Path::new("/res/repo"),
            Path::new("/usr/bin/agents-multi-deno"),
            Some(Path::new("/res/deno-dir")),
            Some(Path::new("/usr/bin/agents-multi-desktop")),
        );
        assert_eq!(cmd.program, Path::new("/usr/bin/agents-multi-deno"));
        assert_eq!(&cmd.args[..3], ["run", "--quiet", "--cached-only"]);
        assert_eq!(
            &cmd.args[cmd.args.len() - 3..],
            ["/res/repo/apps/cli/main.ts", "install", "--app"]
        );
        for p in PERMISSIONS {
            assert!(cmd.args.iter().any(|a| a == p), "{p}");
        }
        let env = |k: &str| {
            cmd.env
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(env("DENO_DIR"), Some("/res/deno-dir"));
        assert_eq!(env("AGENTS_MULTI_BACKEND_ONLY"), Some("DENO_DIR"));
        assert_eq!(env("AGENTS_MULTI_DENO"), Some("/usr/bin/agents-multi-deno"));
        assert_eq!(
            env("AGENTS_MULTI_APP"),
            Some("/usr/bin/agents-multi-desktop")
        );
        assert_eq!(cmd.dir, Path::new("/res/repo"));
    }
}
