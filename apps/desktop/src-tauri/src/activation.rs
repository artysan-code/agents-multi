//! Bringing the window forward when the app is launched a second time.
//!
//! A compositor gives focus only with proof that the user asked for it. The launcher (app menu,
//! KRunner, a file manager) hands that proof to the process it starts: `XDG_ACTIVATION_TOKEN` on
//! Wayland (xdg-activation-v1), `DESKTOP_STARTUP_ID` on X11 (startup notification, with the launch
//! time after `_TIME`). A second launch is that process, but it exits at once, and the
//! single-instance plugin forwards only its arguments and working directory to the running one.
//! So on Linux the second launch puts the token into its own arguments, by executing itself again
//! with `--activation-token=` added (`forward_through_args`), and the running instance hands it to
//! GTK (`bring_forward`). Without a token (a launch from a terminal) the window is not raised: the
//! taskbar entry asks for attention instead.

use std::time::Duration;
use tauri::{Runtime, UserAttentionType, WebviewWindow};

/// The argument a second launch carries its activation token in.
pub const FLAG: &str = "--activation-token=";

/// How long a raise may take before the window asks for attention instead.
const FOCUS_GRACE: Duration = Duration::from_millis(500);

/// The token the launcher gave this process: the Wayland one first, else the X11 startup id.
pub fn launch_token(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"]
        .into_iter()
        .filter_map(get)
        .find(|v| !v.is_empty())
}

/// The token a second launch forwarded among its arguments, if any.
pub fn forwarded_token(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix(FLAG))
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// The launch time an X11 startup id carries after `_TIME`, for focus-stealing prevention.
pub fn startup_time(id: &str) -> Option<u32> {
    id.rsplit_once("_TIME").and_then(|(_, t)| t.parse().ok())
}

/// Executes this program again with the launcher's token added to its arguments, so that the
/// single-instance plugin forwards it if another instance is running. Runs first thing in `main`,
/// before GTK starts; the environment is kept, so a first instance still finds its token there.
/// Returns only when there is nothing to forward or the exec failed (then the launch goes on as is).
#[cfg(target_os = "linux")]
pub fn forward_through_args() {
    use std::os::unix::process::CommandExt;

    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.iter().any(|a| a.to_string_lossy().starts_with(FLAG)) {
        return;
    }
    let Some(token) = launch_token(|name| std::env::var(name).ok()) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = std::process::Command::new(exe);
    if let Some(arg0) = args.first() {
        command.arg0(arg0);
    }
    let err = command
        .args(args.iter().skip(1))
        .arg(format!("{FLAG}{token}"))
        .exec();
    eprintln!("agents-multi: cannot pass the activation token on ({err}); a second launch will not raise the window");
}

/// Brings the window forward for a second launch, with the token it forwarded if any. When the
/// window has not got the focus shortly after, it asks for attention (the taskbar entry is
/// highlighted) — never always-on-top.
pub fn bring_forward<R: Runtime>(window: &WebviewWindow<R>, token: Option<String>) {
    if cfg!(debug_assertions) {
        let with = if token.is_some() { "with" } else { "without" };
        eprintln!("agents-multi: second launch, {with} an activation token");
    }
    let _ = window.unminimize();
    let _ = window.show();
    match token {
        Some(token) => present_with_token(window, token),
        None => {
            let _ = window.set_focus();
        }
    }
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FOCUS_GRACE);
        let focused = window.is_focused().unwrap_or(true);
        if cfg!(debug_assertions) {
            eprintln!("agents-multi: focused after the raise: {focused}");
        }
        if !focused {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    });
}

/// GTK takes the launcher's token through the startup id: on Wayland it activates the window with
/// it (xdg_activation_v1_activate); on X11 it records the launch time, and the window is presented
/// with that time.
#[cfg(target_os = "linux")]
fn present_with_token<R: Runtime>(window: &WebviewWindow<R>, token: String) {
    use gtk::prelude::*;

    let w = window.clone();
    let ran = window.run_on_main_thread(move || {
        let Ok(gtk_window) = w.gtk_window() else {
            let _ = w.set_focus();
            return;
        };
        gtk_window.set_startup_id(&token);
        // On Wayland, presenting again would ask the compositor for a token of the app's own,
        // which it refuses: the startup id above is the activation.
        if gtk_window.display().type_().name() != "GdkWaylandDisplay" {
            match startup_time(&token) {
                Some(time) => gtk_window.present_with_time(time),
                None => {
                    let _ = w.set_focus();
                }
            }
        }
    });
    if ran.is_err() {
        let _ = window.set_focus();
    }
}

#[cfg(not(target_os = "linux"))]
fn present_with_token<R: Runtime>(window: &WebviewWindow<R>, _token: String) {
    let _ = window.set_focus();
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
    fn wayland_token_first_then_startup_id() {
        assert_eq!(launch_token(env(&[])), None);
        assert_eq!(
            launch_token(env(&[
                ("DESKTOP_STARTUP_ID", "x11_TIME5"),
                ("XDG_ACTIVATION_TOKEN", "wl")
            ])),
            Some("wl".into())
        );
        assert_eq!(
            launch_token(env(&[
                ("DESKTOP_STARTUP_ID", "x11_TIME5"),
                ("XDG_ACTIVATION_TOKEN", "")
            ])),
            Some("x11_TIME5".into())
        );
    }

    #[test]
    fn token_is_read_back_from_the_arguments() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(forwarded_token(&args(&["app"])), None);
        assert_eq!(
            forwarded_token(&args(&["app", "--activation-token="])),
            None
        );
        assert_eq!(
            forwarded_token(&args(&["app", "--activation-token=abc"])),
            Some("abc".into())
        );
    }

    #[test]
    fn launch_time_from_an_x11_startup_id() {
        assert_eq!(startup_time("kwin-1234-host-app-0_TIME98765"), Some(98765));
        assert_eq!(startup_time("_TIME42"), Some(42));
        assert_eq!(startup_time("a-wayland-token"), None);
        assert_eq!(startup_time("x_TIMEnope"), None);
    }
}
