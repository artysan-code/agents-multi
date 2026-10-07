use std::fs;

fn main() {
    linux_identity_agrees();
    update_site();
    tauri_build::build()
}

/// The project site the updater asks for its channel's manifest (src/updater.rs): `site` in
/// ../release.json, the one place the release pipeline reads it too (docs/adr/0004). Empty there, the
/// build has no updates. `AGENTS_MULTI_UPDATE_SITE` replaces it for a test build against a local server.
fn update_site() {
    println!("cargo:rerun-if-changed=../release.json");
    println!("cargo:rerun-if-env-changed=AGENTS_MULTI_UPDATE_SITE");
    let site = std::env::var("AGENTS_MULTI_UPDATE_SITE").unwrap_or_else(|_| {
        let text = fs::read_to_string("../release.json")
            .unwrap_or_else(|e| panic!("../release.json: {e}"));
        let release: serde_json::Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("../release.json: {e}"));
        release["site"].as_str().unwrap_or_default().to_string()
    });
    println!(
        "cargo:rustc-env=AGENTS_MULTI_UPDATE_SITE={}",
        site.trim().trim_end_matches('/')
    );
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
