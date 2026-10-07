use std::fs;

fn main() {
    linux_identity_agrees();
    tauri_build::build()
}

/// On Wayland the compositor finds the window's icon and name through `<app_id>.desktop`. The app
/// sets its app_id to the bundle identifier (`set_app_id` in src/main.rs), and the bundler names its
/// desktop file after the product name, so on Linux the product name is the identifier
/// (tauri.linux.conf.json). This keeps the two from drifting apart when the identifier changes.
fn linux_identity_agrees() {
    let read = |path: &str| -> serde_json::Value {
        println!("cargo:rerun-if-changed={path}");
        let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
    };
    let identifier = read("tauri.conf.json")["identifier"].clone();
    let product_name = read("tauri.linux.conf.json")["productName"].clone();
    assert!(
        identifier.is_string() && identifier == product_name,
        "tauri.linux.conf.json's productName ({product_name}) must be tauri.conf.json's identifier ({identifier}): \
         it names the desktop file the window's app_id points at"
    );
}
