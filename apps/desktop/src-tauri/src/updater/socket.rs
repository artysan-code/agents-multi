//! The local channel between the console's backend and the app (docs/adr/0004): a unix socket in the
//! user's runtime folder, `$XDG_RUNTIME_DIR/agents-multi-app.sock` (a development instance's carries its
//! name), readable by the user alone. Without a runtime folder it is in the app's state folder
//! (`~/.local/state/agents-multi`, made private), never in a shared one like `/tmp`. The backend asks, the app answers; the page never reaches it.
//!
//! One request per connection, a JSON line: `{"op":"status"}` answers the status (`Status`) and closes;
//! `{"op":"watch"}` answers it and then a line on every change, for as long as the backend keeps the
//! connection; `check`, `install`, `dismiss` and `{"op":"channel","channel":"beta"|"stable"}` answer
//! `{"ok":true}` or `{"ok":false,"error":…}` and close, what they started being told through the status. Unix only for now: Windows (1.x) gets a
//! named pipe.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use super::{Channel, Hub, Ops};
use crate::install::state_dir;

/// The longest request line read.
const MAX_LINE: u64 = 1024;
/// A peer that sends nothing, or reads nothing, for this long is dropped.
const TIMEOUT: Duration = Duration::from_secs(10);

/// A request from the backend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase", tag = "op")]
pub enum Request {
    Status,
    Watch,
    Check,
    Install,
    Dismiss,
    Channel { channel: Channel },
}

/// Pure: the folder of the socket: the runtime folder, else the state folder (the backend's default is
/// the same, apps/cli/console/app-update.ts). True when it is the state folder, which the app makes
/// private. None when there is neither.
pub fn dir_from(
    get: &impl Fn(&str) -> Option<String>,
    home: Option<&Path>,
) -> Option<(PathBuf, bool)> {
    match get("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        Some(dir) => Some((PathBuf::from(dir), false)),
        None => state_dir(get, home).map(|d| (d, true)),
    }
}

/// The socket's path (a development instance's own), and whether its folder is the state one.
fn location() -> Option<(PathBuf, bool)> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let (dir, private) = dir_from(&|n| std::env::var(n).ok(), home.as_deref())?;
    Some((dir.join(name(crate::instance::dev().as_deref())), private))
}

/// The socket's path; None when the machine has no runtime folder and no home to keep it in.
pub fn path() -> Option<PathBuf> {
    location().map(|(p, _)| p)
}

/// Makes the folder only the user can open, so that no one else can plant a file where the socket goes.
#[cfg(unix)]
fn private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// The socket's file name, with a development instance's name.
pub fn name(dev: Option<&str>) -> String {
    match dev {
        Some(d) => format!("agents-multi-app.dev_{d}.sock"),
        None => "agents-multi-app.sock".into(),
    }
}

/// The answer to an action.
fn answer(result: Result<(), String>) -> String {
    match result {
        Ok(()) => r#"{"ok":true}"#.into(),
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Serves one connection: one request, its answer.
#[cfg(unix)]
fn handle(stream: std::os::unix::net::UnixStream, hub: &Hub, ops: &dyn Ops) {
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let Ok(reader) = stream.try_clone() else {
        return;
    };
    let mut line = String::new();
    if BufReader::new(reader.take(MAX_LINE))
        .read_line(&mut line)
        .is_err()
    {
        return;
    }
    let request = serde_json::from_str::<Request>(line.trim());
    let mut out = stream;
    let reply = match request {
        Ok(Request::Watch) => {
            hub.watch(Box::new(move |s| write_line(&mut out, s)));
            return;
        }
        Ok(Request::Status) => serde_json::to_string(&hub.get()).unwrap_or_default(),
        Ok(Request::Check) => answer(ops.check()),
        Ok(Request::Install) => answer(ops.install()),
        Ok(Request::Dismiss) => {
            ops.dismiss();
            answer(Ok(()))
        }
        Ok(Request::Channel { channel }) => answer(ops.set_channel(channel)),
        Err(_) => answer(Err("unknown request".into())),
    };
    let _ = writeln!(out, "{reply}");
}

/// Writes the status as a line: false once the peer is gone.
#[cfg(unix)]
fn write_line(out: &mut std::os::unix::net::UnixStream, s: &super::Status) -> bool {
    let line = serde_json::to_string(s).unwrap_or_default();
    writeln!(out, "{line}").and_then(|_| out.flush()).is_ok()
}

/// Binds the socket at `path`: a file left by an app that died is replaced, one that answers is
/// another app's and left alone. Only the user can connect.
#[cfg(unix)]
pub fn bind(path: &std::path::Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    if path.exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!("{} answers already", path.display()),
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Answers on the socket for the app's lifetime, each connection on its own thread.
#[cfg(unix)]
pub fn serve(hub: Arc<Hub>, ops: Arc<dyn Ops>) {
    let Some((path, private)) = location() else {
        eprintln!("agents-multi: no update socket: no runtime folder and no home");
        return;
    };
    if let (true, Some(dir)) = (private, path.parent()) {
        if let Err(e) = private_dir(dir) {
            eprintln!("agents-multi: no update socket: {}: {e}", dir.display());
            return;
        }
    }
    let listener = match bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("agents-multi: no update socket at {}: {e}", path.display());
            return;
        }
    };
    let _ = std::thread::Builder::new()
        .name("update-socket".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let (hub, ops) = (Arc::clone(&hub), Arc::clone(&ops));
                std::thread::spawn(move || handle(stream, &hub, ops.as_ref()));
            }
        });
}

#[cfg(not(unix))]
pub fn serve(_hub: Arc<Hub>, _ops: Arc<dyn Ops>) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::updater::{Channel, Phase, Status};
    use std::os::unix::net::UnixStream;
    use std::sync::Mutex;

    struct Fake {
        hub: Arc<Hub>,
        asked: Mutex<Vec<&'static str>>,
    }

    impl Ops for Fake {
        fn check(&self) -> Result<(), String> {
            self.asked.lock().unwrap().push("check");
            self.hub.update(|s| s.checking());
            Ok(())
        }
        fn install(&self) -> Result<(), String> {
            self.asked.lock().unwrap().push("install");
            Err("updates are off: not-packaged".into())
        }
        fn dismiss(&self) {
            self.asked.lock().unwrap().push("dismiss");
        }
        fn set_channel(&self, channel: Channel) -> Result<(), String> {
            self.asked.lock().unwrap().push("channel");
            self.hub.update(|s| {
                s.channel = channel;
                true
            });
            Ok(())
        }
    }

    fn ask(path: &std::path::Path, line: &str) -> BufReader<UnixStream> {
        let mut s = UnixStream::connect(path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        writeln!(s, "{line}").unwrap();
        BufReader::new(s)
    }

    fn read(r: &mut BufReader<UnixStream>) -> serde_json::Value {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn the_names_keep_a_development_instance_apart() {
        assert_eq!(name(None), "agents-multi-app.sock");
        assert_eq!(name(Some("release")), "agents-multi-app.dev_release.sock");
    }

    #[test]
    fn the_folder_is_the_runtime_one_else_the_private_state_one_never_tmp() {
        let home = Path::new("/h");
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |n: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == n)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(
            dir_from(&env(&[("XDG_RUNTIME_DIR", "/run/user/1000")]), Some(home)),
            Some(("/run/user/1000".into(), false))
        );
        assert_eq!(
            dir_from(&env(&[]), Some(home)),
            Some(("/h/.local/state/agents-multi".into(), true))
        );
        assert_eq!(
            dir_from(
                &env(&[("XDG_RUNTIME_DIR", ""), ("XDG_STATE_HOME", "/s")]),
                Some(home)
            ),
            Some(("/s/agents-multi".into(), true))
        );
        assert_eq!(dir_from(&env(&[]), None), None);
    }

    #[test]
    fn the_private_folder_is_made_0700_even_over_a_looser_one() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("am-private-{}", std::process::id()));
        let dir = base.join("state/agents-multi");
        private_dir(&dir).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        private_dir(&dir).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn requests_parse_and_anything_else_does_not() {
        assert_eq!(
            serde_json::from_str::<Request>(r#"{"op":"install"}"#).unwrap(),
            Request::Install
        );
        assert_eq!(
            serde_json::from_str::<Request>(r#"{"op":"channel","channel":"beta"}"#).unwrap(),
            Request::Channel {
                channel: Channel::Beta
            }
        );
        assert!(
            serde_json::from_str::<Request>(r#"{"op":"channel","channel":"nightly"}"#).is_err()
        );
        assert!(serde_json::from_str::<Request>(r#"{"op":"channel"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"op":"rm -rf"}"#).is_err());
        assert!(serde_json::from_str::<Request>("install").is_err());
    }

    #[test]
    fn the_socket_answers_follows_and_acts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("am-socket-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app.sock");
        std::fs::write(&path, "stale").unwrap(); // a file left behind is replaced
        let listener = bind(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(bind(&path).is_err(), "a socket that answers is left alone");

        let hub = Arc::new(Hub::new(Status::new("1.0.0", Channel::Stable, None)));
        let fake = Arc::new(Fake {
            hub: Arc::clone(&hub),
            asked: Mutex::new(vec![]),
        });
        let (h, o) = (Arc::clone(&hub), Arc::clone(&fake) as Arc<dyn Ops>);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (h, o) = (Arc::clone(&h), Arc::clone(&o));
                std::thread::spawn(move || handle(stream, &h, o.as_ref()));
            }
        });

        let status = read(&mut ask(&path, r#"{"op":"status"}"#));
        assert_eq!(status["current"], "1.0.0");
        assert_eq!(status["state"], "idle");

        let mut watch = ask(&path, r#"{"op":"watch"}"#);
        assert_eq!(read(&mut watch)["state"], "idle");
        assert_eq!(read(&mut ask(&path, r#"{"op":"check"}"#))["ok"], true);
        assert_eq!(read(&mut watch)["state"], "checking");
        assert_eq!(hub.get().state, Phase::Checking);

        let refused = read(&mut ask(&path, r#"{"op":"install"}"#));
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"], "updates are off: not-packaged");
        assert_eq!(
            read(&mut ask(&path, r#"{"op":"nope"}"#))["error"],
            "unknown request"
        );
        assert_eq!(read(&mut ask(&path, r#"{"op":"dismiss"}"#))["ok"], true);
        assert_eq!(
            read(&mut ask(&path, r#"{"op":"channel","channel":"beta"}"#))["ok"],
            true
        );
        assert_eq!(hub.get().channel, Channel::Beta);
        assert_eq!(
            *fake.asked.lock().unwrap(),
            vec!["check", "install", "dismiss", "channel"]
        );

        // a watcher that left is dropped at the next change
        drop(watch);
        hub.update(|s| {
            s.found(None, None, 1);
            true
        });
        hub.update(|s| s.checking());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
