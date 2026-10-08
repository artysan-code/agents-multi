//! The tray icon: the setup's state at a glance, and a menu to act on it — what `apps/tray/tray.py`
//! shows, from the same source. The state is the console's `/api/summary` (`summarize()` in
//! apps/cli/status.ts, with its test): this module only draws it. It is refetched when the console says
//! something changed (`state` on the `/api/events` stream the page also listens to), never on a timer.
//! With the console down the icon turns grey and the stream reconnects with a bounded backoff.
//!
//!   no dot   all good (warnings are listed in the menu, they do not colour the icon)
//!   red      a doctor check fails
//!   grey     the console is not answering
//!
//! Everything here talks to the console over HTTP from Rust: no web view is involved. The menu's
//! actions are carried out by `controller` (CLI commands and the app's windows).
//!
//! What is drawn is a `View`; two backends draw it. On Linux a StatusNotifierItem of the app's own
//! (`sni`), which has the left click (it toggles the console window) that Tauri's tray lacks there;
//! elsewhere Tauri's tray, where a click opens the menu.

use std::io::BufRead;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
#[cfg(not(target_os = "linux"))]
use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
};
use tauri::{AppHandle, Manager};

#[cfg(not(target_os = "linux"))]
use crate::controller;
use crate::{http, profiles, updater};

#[cfg(target_os = "linux")]
mod sni;

const TRAY_ID: &str = "agents-multi";
const TITLE: &str = "Agents Multi";
/// A burst of state events is one refetch.
const DEBOUNCE: Duration = Duration::from_secs(1);
/// The server pings every 25 s: a stream silent for 70 s is a dead one (sleep, restart).
const SILENCE: Duration = Duration::from_secs(70);
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(20);

/// /api/summary, the part the tray reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Summary {
    pub level: String,
    pub fails: Vec<String>,
    pub warns: Vec<String>,
    pub staged: Option<String>,
    pub running: Running,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Running {
    pub cli: u32,
    pub desktop: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Fail,
    Down,
}

impl Level {
    fn headline(self) -> &'static str {
        match self {
            Level::Ok => "All good",
            Level::Fail => "Something needs attention",
            Level::Down => "Console not running",
        }
    }

    /// The dot drawn on the icon, when there is one.
    fn dot(self) -> Option<[u8; 3]> {
        match self {
            Level::Ok => None,
            Level::Fail => Some([0xd6, 0x45, 0x45]),
            Level::Down => Some([0x8a, 0x8f, 0x98]),
        }
    }
}

/// What the menu does: each item's id says it, so the click handler needs nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Hey,
    Console,
    Launch(String),
    View(String),
    StartConsole,
    Quit,
}

// the ids of Tauri's menu items; the Linux tray hands each item its action instead
#[cfg_attr(target_os = "linux", allow(dead_code))]
impl Action {
    pub fn id(&self) -> String {
        match self {
            Action::Hey => "hey".into(),
            Action::Console => "console".into(),
            Action::Launch(p) => format!("launch:{p}"),
            Action::View(v) => format!("view:{v}"),
            Action::StartConsole => "start-console".into(),
            Action::Quit => "quit".into(),
        }
    }

    pub fn from_id(id: &str) -> Option<Action> {
        Some(match id {
            "hey" => Action::Hey,
            "console" => Action::Console,
            "start-console" => Action::StartConsole,
            "quit" => Action::Quit,
            _ => match id.split_once(':')? {
                ("launch", p) if !p.is_empty() => Action::Launch(p.into()),
                ("view", v) if !v.is_empty() => Action::View(v.into()),
                _ => return None,
            },
        })
    }
}

/// One entry of the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// A line of state, not clickable.
    Label(String),
    Item(&'static str, Action),
    /// «Open Claude Desktop», one item per profile.
    Profiles(Vec<String>),
    Separator,
}

/// What the tray shows for a summary (`None`: the console is not answering) and the profiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub level: Level,
    pub tooltip: String,
    pub menu: Vec<Entry>,
}

/// The lines under the headline, as tray.py writes them.
fn lines(s: &Summary) -> Vec<String> {
    let mut lines: Vec<String> = s.fails.iter().map(|m| format!("✗ {m}")).collect();
    if let Some(v) = &s.staged {
        lines.push(format!(
            "Claude Desktop {v} is ready: it switches at the next launch"
        ));
    }
    match s.warns.len() {
        0 => {}
        1 => lines.push("1 warning".into()),
        n => lines.push(format!("{n} warnings")),
    }
    // always there, 0 · 0 too: the menu keeps its width, and Plasma draws the submenu arrow of
    // «Open Claude Desktop» over the label when that is the widest line
    lines.push(format!(
        "Running: {} CLI · {} Desktop",
        s.running.cli, s.running.desktop
    ));
    lines
}

pub fn view(summary: Option<&Summary>, profiles: Vec<String>) -> View {
    let level = match summary {
        None => Level::Down,
        Some(s) if s.level == "ok" => Level::Ok,
        Some(_) => Level::Fail,
    };
    let all = summary.map(lines).unwrap_or_default();
    let tooltip = std::iter::once(format!("{TITLE} — {}", level.headline()))
        .chain(all.iter().cloned())
        .collect::<Vec<_>>()
        .join("\n");
    // at most five lines of state in the menu; the Running line survives the cut
    let shown: Vec<String> = match all.split_last() {
        Some((last, rest)) => rest.iter().take(5).chain([last]).cloned().collect(),
        None => Vec::new(),
    };

    let mut menu = vec![Entry::Label(level.headline().into())];
    menu.extend(shown.into_iter().map(Entry::Label));
    menu.extend([
        Entry::Separator,
        Entry::Item("Hey Claude…", Action::Hey),
        Entry::Item("Open console", Action::Console),
        Entry::Profiles(profiles),
        Entry::Item("Updates", Action::View("system/updates".into())),
        Entry::Item("Health", Action::View("system/health".into())),
    ]);
    if summary.is_none() {
        menu.push(Entry::Item("Start the console", Action::StartConsole));
    }
    menu.extend([Entry::Separator, Entry::Item("Quit", Action::Quit)]);
    View {
        level,
        tooltip,
        menu,
    }
}

/// The wait before the next connection to the event stream after `failures` in a row:
/// 2 s, 4 s, 8 s, 16 s, then 30 s.
pub fn backoff(failures: u32) -> Duration {
    Duration::from_millis((2000u64 << failures.min(4)).min(30_000))
}

/// The event an SSE line names (`event: state`), if it names one.
pub fn sse_event(line: &str) -> Option<&str> {
    line.strip_prefix("event:").map(str::trim)
}

/// Draws the state dot on a square RGBA icon, where tray.py draws it: a soft shadow, then the colour,
/// in the lower right quarter.
pub fn draw_dot(rgba: &mut [u8], size: u32, colour: [u8; 3]) {
    let s = size as f32 / 64.0;
    let (cx, cy) = (48.0 * s, 48.0 * s);
    for (r, c, a) in [(16.0 * s, [0, 0, 0], 90.0 / 255.0), (13.0 * s, colour, 1.0)] {
        for y in 0..size {
            for x in 0..size {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let cover = (r - d + 0.5).clamp(0.0, 1.0) * a;
                if cover > 0.0 {
                    let i = ((y * size + x) * 4) as usize;
                    blend(&mut rgba[i..i + 4], c, cover);
                }
            }
        }
    }
}

/// `colour` at opacity `a` over a straight-alpha pixel.
fn blend(px: &mut [u8], colour: [u8; 3], a: f32) {
    let da = px[3] as f32 / 255.0;
    let out = a + da * (1.0 - a);
    for k in 0..3 {
        let v = (colour[k] as f32 * a + px[k] as f32 * da * (1.0 - a)) / out;
        px[k] = v.round() as u8;
    }
    px[3] = (out * 255.0).round() as u8;
}

/// The icon for `level`: RGBA pixels, width, height.
fn icon_rgba(level: Level) -> (Vec<u8>, u32, u32) {
    let base = tauri::include_image!("../../../desktop/icons/64x64/claude-multi.png");
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    if let Some(colour) = level.dot() {
        draw_dot(&mut rgba, w.min(h), colour);
    }
    (rgba, w, h)
}

#[cfg(not(target_os = "linux"))]
fn icon(level: Level) -> Image<'static> {
    let (rgba, w, h) = icon_rgba(level);
    Image::new_owned(rgba, w, h)
}

#[cfg(not(target_os = "linux"))]
fn menu(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let mut b = MenuBuilder::new(app);
    for (n, e) in entries.iter().enumerate() {
        b = match e {
            Entry::Label(text) => b.item(
                &MenuItemBuilder::with_id(format!("label:{n}"), text)
                    .enabled(false)
                    .build(app)?,
            ),
            Entry::Item(text, action) => b.text(action.id(), *text),
            Entry::Profiles(ps) => {
                let mut sub = SubmenuBuilder::new(app, "Open Claude Desktop");
                for p in ps {
                    sub = sub.text(Action::Launch(p.clone()).id(), p);
                }
                b.item(&sub.build()?)
            }
            Entry::Separator => b.separator(),
        };
    }
    b.build()
}

/// The worker's inbox: what the event stream saw, and requests to look again.
enum Msg {
    /// The stream is open: fetch now.
    Up,
    /// The console said its state changed.
    State,
    /// The stream ended or went silent.
    Down,
    /// Look again now (after «Start the console»).
    Refresh,
}

/// The way to ask the tray to look again.
struct Inbox(Mutex<Sender<Msg>>);

/// Asks the tray to fetch the summary again (no-op without a tray).
pub fn refresh(app: &AppHandle) {
    if let Some(inbox) = app.try_state::<Inbox>() {
        let _ = inbox.0.lock().map(|tx| tx.send(Msg::Refresh));
    }
}

/// Creates the tray icon on `port`'s console and starts following it.
pub fn create(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let first = updater::annotate(app, view(None, profiles::names()));
    build(app, &first)?;

    let (tx, rx) = mpsc::channel();
    app.manage(Inbox(Mutex::new(tx.clone())));
    std::thread::Builder::new()
        .name("tray-events".into())
        .spawn(move || follow(port, tx))?;
    let app = app.clone();
    std::thread::Builder::new()
        .name("tray-view".into())
        .spawn(move || draw(app, port, rx, first))?;
    Ok(())
}

/// Follows the console's event stream for good, reconnecting with a bounded backoff.
fn follow(port: u16, tx: Sender<Msg>) {
    let mut failures = 0;
    loop {
        if let Ok((head, body)) = http::open(port, "/api/events", SILENCE) {
            if head.status == 200 && tx.send(Msg::Up).is_ok() {
                for line in body.lines() {
                    let Ok(line) = line else { break };
                    failures = 0; // anything at all, a ping included: the stream is alive
                    if sse_event(&line) == Some("state") && tx.send(Msg::State).is_err() {
                        return;
                    }
                }
            }
        }
        if tx.send(Msg::Down).is_err() {
            return;
        }
        std::thread::sleep(backoff(failures));
        failures = (failures + 1).min(4);
    }
}

/// Keeps the icon and the menu on what the console says, redrawing only what changed: Plasma keeps a
/// stale layout when a menu on screen is replaced.
fn draw(app: AppHandle, port: u16, rx: Receiver<Msg>, mut shown: View) {
    let mut due: Option<Instant> = None;
    loop {
        let msg = match due {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        let summary = match msg {
            Some(Msg::State) => {
                due = Some(Instant::now() + DEBOUNCE);
                continue;
            }
            Some(Msg::Down) => None,
            Some(Msg::Up) | Some(Msg::Refresh) | None => fetch(port),
        };
        due = None;
        let next = updater::annotate(&app, view(summary.as_ref(), profiles::names()));
        if let Err(e) = apply(&app, &shown, &next) {
            eprintln!("agents-multi: cannot update the tray: {e}");
        }
        shown = next;
    }
}

fn fetch(port: u16) -> Option<Summary> {
    let text = http::get_text(port, "/api/summary", SUMMARY_TIMEOUT).ok()?;
    serde_json::from_str(&text).ok()
}

/// The tray icon, showing `first`: on Linux the app's own StatusNotifierItem.
#[cfg(target_os = "linux")]
fn build(app: &AppHandle, first: &View) -> tauri::Result<()> {
    sni::create(app, first).map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))
}

#[cfg(not(target_os = "linux"))]
fn build(app: &AppHandle, first: &View) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(first.level))
        .tooltip(&first.tooltip)
        .menu(&menu(app, &first.menu)?)
        .on_menu_event(|app, event| match Action::from_id(event.id().as_ref()) {
            Some(action) => controller::on_tray(app, action),
            None => eprintln!("agents-multi: unknown menu item {:?}", event.id()),
        })
        .build(app)?;
    Ok(())
}

fn apply(app: &AppHandle, old: &View, new: &View) -> tauri::Result<()> {
    if new.level != old.level && cfg!(debug_assertions) {
        eprintln!("agents-multi: tray {:?} -> {:?}", old.level, new.level);
    }
    redraw(app, old, new)
}

#[cfg(target_os = "linux")]
fn redraw(app: &AppHandle, old: &View, new: &View) -> tauri::Result<()> {
    if new != old {
        sni::apply(app, new);
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn redraw(app: &AppHandle, old: &View, new: &View) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    if new.level != old.level {
        tray.set_icon(Some(icon(new.level)))?;
    }
    if new.tooltip != old.tooltip {
        tray.set_tooltip(Some(&new.tooltip))?;
    }
    if new.menu != old.menu {
        tray.set_menu(Some(menu(app, &new.menu)?))?;
    }
    Ok(())
}

/// Whether this session has a tray to put an icon in. On Linux that is a StatusNotifier host, the one
/// kind the app's indicator speaks (KDE has it; GNOME needs the AppIndicator extension).
#[cfg(target_os = "linux")]
pub fn host_available() -> bool {
    let has = || -> zbus::Result<bool> {
        let bus = zbus::blocking::Connection::session()?;
        let dbus = zbus::blocking::fdo::DBusProxy::new(&bus)?;
        Ok(dbus.name_has_owner("org.kde.StatusNotifierWatcher".try_into()?)?)
    };
    has().unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub fn host_available() -> bool {
    true
}

/// Notes for the doctor whether this session has a tray (its `app.tray` check reads the same file the
/// tray app writes: `$XDG_STATE_HOME/agents-multi/app.json`); a development instance does not.
pub fn record(tray: bool) {
    if crate::instance::dev().is_some() {
        return; // the session's app speaks for it
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let Some(dir) = crate::install::state_dir(&|n| std::env::var(n).ok(), home.as_deref()) else {
        return;
    };
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let _ = std::fs::create_dir_all(&dir).and_then(|_| {
        std::fs::write(
            dir.join("app.json"),
            format!("{{\"tray\": {tray}, \"at\": {at}}}\n"),
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(level: &str) -> Summary {
        Summary {
            level: level.into(),
            fails: vec![],
            warns: vec![],
            staged: None,
            running: Running { cli: 0, desktop: 0 },
        }
    }

    fn labels(v: &View) -> Vec<&str> {
        v.menu
            .iter()
            .filter_map(|e| match e {
                Entry::Label(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    fn actions(v: &View) -> Vec<Action> {
        v.menu
            .iter()
            .filter_map(|e| match e {
                Entry::Item(_, a) => Some(a.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn summary_parses_from_the_console() {
        let json = r#"{"level":"fail","fails":["x"],"warns":[],"staged":null,
            "running":{"cli":5,"desktop":2},"generatedAt":"2026-10-07T19:18:27.261Z"}"#;
        let s: Summary = serde_json::from_str(json).unwrap();
        assert_eq!(s.running, Running { cli: 5, desktop: 2 });
        assert_eq!(s.fails, ["x"]);
    }

    #[test]
    fn all_good_has_no_dot_and_the_running_line() {
        let v = view(Some(&summary("ok")), vec!["a".into()]);
        assert_eq!(v.level, Level::Ok);
        assert_eq!(v.level.dot(), None);
        assert_eq!(labels(&v), ["All good", "Running: 0 CLI · 0 Desktop"]);
        assert_eq!(
            v.tooltip,
            "Agents Multi — All good\nRunning: 0 CLI · 0 Desktop"
        );
        assert!(v.menu.contains(&Entry::Profiles(vec!["a".into()])));
        assert!(!actions(&v).contains(&Action::StartConsole));
    }

    #[test]
    fn failures_staged_and_warnings_are_listed() {
        let mut s = summary("fail");
        s.fails = vec!["one".into(), "two".into()];
        s.staged = Some("1.2.3".into());
        s.warns = vec!["w".into()];
        s.running = Running { cli: 3, desktop: 1 };
        let v = view(Some(&s), vec![]);
        assert_eq!(v.level, Level::Fail);
        assert_eq!(
            labels(&v),
            [
                "Something needs attention",
                "✗ one",
                "✗ two",
                "Claude Desktop 1.2.3 is ready: it switches at the next launch",
                "1 warning",
                "Running: 3 CLI · 1 Desktop",
            ]
        );
        s.warns.push("w2".into());
        assert!(labels(&view(Some(&s), vec![])).contains(&"2 warnings"));
    }

    #[test]
    fn the_menu_keeps_five_lines_and_the_running_one() {
        let mut s = summary("fail");
        s.fails = (1..=8).map(|i| format!("f{i}")).collect();
        let v = view(Some(&s), vec![]);
        let l = labels(&v);
        assert_eq!(l.len(), 1 + 5 + 1);
        assert_eq!(l[5], "✗ f5");
        assert_eq!(l[6], "Running: 0 CLI · 0 Desktop");
        // the tooltip has them all
        assert!(v.tooltip.contains("✗ f8"));
    }

    #[test]
    fn console_down_is_grey_and_offers_to_start_it() {
        let v = view(None, vec!["a".into(), "b".into()]);
        assert_eq!(v.level, Level::Down);
        assert_eq!(labels(&v), ["Console not running"]);
        assert_eq!(v.tooltip, "Agents Multi — Console not running");
        assert_eq!(
            actions(&v),
            [
                Action::Hey,
                Action::Console,
                Action::View("system/updates".into()),
                Action::View("system/health".into()),
                Action::StartConsole,
                Action::Quit,
            ]
        );
        assert_eq!(v.menu.last(), Some(&Entry::Item("Quit", Action::Quit)));
    }

    #[test]
    fn an_unknown_level_is_not_all_good() {
        assert_eq!(view(Some(&summary("warn")), vec![]).level, Level::Fail);
    }

    #[test]
    fn action_ids_round_trip() {
        for a in [
            Action::Hey,
            Action::Console,
            Action::Launch("work".into()),
            Action::View("system/health".into()),
            Action::StartConsole,
            Action::Quit,
        ] {
            assert_eq!(Action::from_id(&a.id()), Some(a));
        }
        assert_eq!(Action::from_id("label:3"), None);
        assert_eq!(Action::from_id("launch:"), None);
        assert_eq!(Action::from_id("nope"), None);
    }

    #[test]
    fn backoff_is_bounded() {
        let s: Vec<u64> = (0..7).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(s, [2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn sse_lines() {
        assert_eq!(sse_event("event: state"), Some("state"));
        assert_eq!(sse_event("event:usage"), Some("usage"));
        assert_eq!(sse_event("data: {}"), None);
        assert_eq!(sse_event(": ping 1"), None);
    }

    #[test]
    fn the_dot_sits_in_the_lower_right() {
        let size = 64;
        let mut rgba = vec![0u8; (size * size * 4) as usize];
        draw_dot(&mut rgba, size, [0xd6, 0x45, 0x45]);
        let px = |x: u32, y: u32| {
            let i = ((y * size + x) * 4) as usize;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        assert_eq!(px(48, 48), [0xd6, 0x45, 0x45, 255]);
        assert_eq!(px(8, 8), [0, 0, 0, 0]);
        // the shadow's ring: dark and translucent
        let ring = px(48, 33);
        assert_eq!(&ring[..3], &[0, 0, 0]);
        assert!(ring[3] > 0 && ring[3] < 255);
    }
}
