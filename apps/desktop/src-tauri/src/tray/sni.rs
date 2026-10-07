//! The tray on Linux: a StatusNotifierItem of its own over D-Bus (`ksni`), which KDE's tray speaks
//! natively. Tauri's tray goes through libayatana-appindicator there, which never reports a click: any
//! click opened the menu. An item of our own gets `Activate` for the left click, which shows or hides
//! the console window as the tray app did (`controller::toggle_console`); the menu stays on the right
//! click. It draws the same `View` as the other systems' tray (the parent module): icon with its dot,
//! tooltip, menu.
//!
//! ksni serves the item from a thread of its own; what it is asked to do goes to the main thread.

use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::{StandardItem, SubMenu};
use ksni::{Icon, MenuItem, ToolTip};
use tauri::{AppHandle, Manager};

use super::{icon_rgba, Action, Entry, View, TITLE, TRAY_ID};
use crate::controller;

/// The item: the app to act on, and what it shows now.
struct Item {
    app: AppHandle,
    view: View,
}

impl Item {
    /// Hands `f` to the main thread, where the windows are.
    fn on_main(&self, f: impl FnOnce(&AppHandle) + Send + 'static) {
        let app = self.app.clone();
        let a = app.clone();
        if let Err(e) = app.run_on_main_thread(move || f(&a)) {
            eprintln!("agents-multi: the tray cannot reach the app: {e}");
        }
    }
}

impl ksni::Tray for Item {
    fn id(&self) -> String {
        TRAY_ID.into()
    }

    fn title(&self) -> String {
        TITLE.into()
    }

    /// The left click: the console window, shown or hidden.
    fn activate(&mut self, _x: i32, _y: i32) {
        if cfg!(debug_assertions) {
            eprintln!("agents-multi: tray activated");
        }
        self.on_main(controller::toggle_console);
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        let (rgba, width, height) = icon_rgba(self.view.level);
        vec![Icon {
            width: width as i32,
            height: height as i32,
            data: argb(rgba),
        }]
    }

    fn tool_tip(&self) -> ToolTip {
        let (title, description) = tooltip(&self.view.tooltip);
        ToolTip {
            title,
            description,
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        self.view.menu.iter().map(item).collect()
    }
}

/// One entry of the menu; an item's click goes to the controller, like the menu's of the other systems.
fn item(entry: &Entry) -> MenuItem<Item> {
    let action = |label: &str, action: Action| -> MenuItem<Item> {
        StandardItem {
            label: label_text(label),
            activate: Box::new(move |item: &mut Item| {
                let action = action.clone();
                item.on_main(move |app| controller::on_tray(app, action));
            }),
            ..Default::default()
        }
        .into()
    };
    match entry {
        Entry::Label(text) => StandardItem {
            label: label_text(text),
            enabled: false,
            ..Default::default()
        }
        .into(),
        Entry::Item(text, a) => action(text, a.clone()),
        Entry::Profiles(ps) => SubMenu {
            label: "Open Claude Desktop".into(),
            submenu: ps
                .iter()
                .map(|p| action(p, Action::Launch(p.clone())))
                .collect(),
            ..Default::default()
        }
        .into(),
        Entry::Separator => MenuItem::Separator,
    }
}

/// A menu label as dbusmenu reads it: an underscore marks the access key, two are one underscore.
pub fn label_text(text: &str) -> String {
    text.replace('_', "__")
}

/// The tooltip's title (the headline line) and its description: the other lines, as the markup the
/// StatusNotifierItem tooltip takes (escaped, a `<br/>` between lines; Plasma joins plain newlines).
pub fn tooltip(text: &str) -> (String, String) {
    let mut lines = text.lines();
    let title = lines.next().unwrap_or_default().to_owned();
    let description = lines
        .map(|l| {
            l.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        })
        .collect::<Vec<_>>()
        .join("<br/>");
    (title, description)
}

/// RGBA pixels as the ARGB32, network byte order, a StatusNotifierItem's pixmap is in.
pub fn argb(mut rgba: Vec<u8>) -> Vec<u8> {
    for px in rgba.as_chunks_mut::<4>().0 {
        px.rotate_right(1);
    }
    rgba
}

/// The running item, to redraw it.
struct Sni(Handle<Item>);

/// Puts the item on the session bus, showing `first`.
pub fn create(app: &AppHandle, first: &View) -> Result<(), ksni::Error> {
    let handle = Item {
        app: app.clone(),
        view: first.clone(),
    }
    .spawn()?;
    app.manage(Sni(handle));
    Ok(())
}

/// Shows `view`: ksni compares it with what the tray host has and signals only what changed.
pub fn apply(app: &AppHandle, view: &View) {
    if let Some(sni) = app.try_state::<Sni>() {
        let view = view.clone();
        sni.0.update(move |item| item.view = view);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn underscores_are_not_access_keys() {
        assert_eq!(label_text("my_profile"), "my__profile");
        assert_eq!(label_text("Hey Claude…"), "Hey Claude…");
    }

    #[test]
    fn the_tooltip_is_the_headline_and_the_lines() {
        assert_eq!(
            tooltip("Agents Multi — All good"),
            ("Agents Multi — All good".into(), String::new())
        );
        assert_eq!(
            tooltip(
                "Agents Multi — Something needs attention\n✗ a <b> & c\nRunning: 1 CLI · 0 Desktop"
            ),
            (
                "Agents Multi — Something needs attention".into(),
                "✗ a &lt;b&gt; &amp; c<br/>Running: 1 CLI · 0 Desktop".into()
            )
        );
    }

    #[test]
    fn pixels_become_argb() {
        assert_eq!(argb(vec![1, 2, 3, 4, 5, 6, 7, 8]), [4, 1, 2, 3, 8, 5, 6, 7]);
    }
}
