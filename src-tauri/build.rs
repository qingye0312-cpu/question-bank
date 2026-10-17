#[path = "../mac/build.rs"]
mod mac;

fn main() {
    println!("cargo:rerun-if-env-changed=QBANK_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=QBANK_UPDATER_PUBLIC_KEY");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let platform_config = match target_os.as_str() {
        "macos" => Some((
            "../mac/tauri.conf.json",
            include_str!("../mac/tauri.conf.json"),
        )),
        "windows" => Some((
            "../windows/tauri.conf.json",
            include_str!("../windows/tauri.conf.json"),
        )),
        _ => None,
    };
    if let Some((path, config)) = platform_config {
        println!("cargo:rerun-if-changed={path}");
        // The CLI passes merged settings. Plain `cargo test/build` needs the
        // same platform defaults, including the relocated Windows icon.
        if std::env::var_os("TAURI_CONFIG").is_none() {
            let config = config.lines().collect::<String>();
            std::env::set_var("TAURI_CONFIG", &config);
            println!("cargo:rustc-env=TAURI_CONFIG={config}");
        }
    }
    if target_os == "macos" {
        mac::build();
    }
    tauri_build::build()
}
