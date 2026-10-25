use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, sync::Mutex};
use tauri::Manager;

pub const TRAY_ID: &str = "qbank-main";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrayStyle {
    #[default]
    System,
    White,
    Black,
    Color,
}

#[derive(Default, Deserialize, Serialize)]
struct Settings {
    #[serde(default)]
    tray_style: TrayStyle,
}

struct Preferences {
    path: PathBuf,
    style: Mutex<TrayStyle>,
}

fn read_style(path: &Path) -> TrayStyle {
    std::fs::read(path).ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .unwrap_or_default().tray_style
}

pub fn init(app: &tauri::AppHandle, dir: &Path) {
    let path = dir.join("desktop-settings.json");
    let style = read_style(&path);
    app.manage(Preferences { path, style: Mutex::new(style) });
}

// Windows permits different app and taskbar themes. Read the taskbar setting,
// rather than the WebView's prefers-color-scheme or Window::theme().
#[cfg(target_os = "windows")]
fn system_is_dark() -> bool {
    use windows::{core::w, Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD}};
    let mut light = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("SystemUsesLightTheme"), RRF_RT_REG_DWORD, None,
            Some((&mut light as *mut u32).cast()), Some(&mut size))
    };
    result.is_err() || light == 0
}

#[cfg(not(target_os = "windows"))]
fn system_is_dark() -> bool { true }

fn presentation(style: TrayStyle, macos: bool, dark: bool) -> (TrayStyle, bool) {
    match style {
        TrayStyle::System if macos => (TrayStyle::White, true),
        TrayStyle::System => (if dark { TrayStyle::White } else { TrayStyle::Black }, false),
        style => (style, false),
    }
}

fn pixels(style: TrayStyle, macos: bool) -> tauri::Result<image::RgbaImage> {
    // tray-icon displays macOS images at 18 pt; 36 px preserves Retina detail.
    // Regenerate these from cutout.svg / ../icon.svg with `tauri icon --png 32 --png 36`.
    let bytes: &[u8] = match (style == TrayStyle::Color, macos) {
        (false, true) => include_bytes!("../icons/tray/cutout/36x36.png"),
        (false, false) => include_bytes!("../icons/tray/cutout/32x32.png"),
        (true, true) => include_bytes!("../icons/tray/color/36x36.png"),
        (true, false) => include_bytes!("../icons/tray/color/32x32.png"),
    };
    let mut rgba = image::load_from_memory(bytes)
        .map_err(|error| tauri::Error::InvalidIcon(std::io::Error::other(error)))?.into_rgba8();
    if style == TrayStyle::Black {
        for pixel in rgba.pixels_mut() { pixel.0[..3].fill(0); }
    }
    Ok(rgba)
}

fn icon(style: TrayStyle) -> tauri::Result<(tauri::image::Image<'static>, bool)> {
    let macos = cfg!(target_os = "macos");
    let (color, template) = presentation(style, macos, system_is_dark());
    let rgba = pixels(color, macos)?;
    let (width, height) = rgba.dimensions();
    Ok((tauri::image::Image::new_owned(rgba.into_raw(), width, height), template))
}

pub fn current_icon(app: &tauri::AppHandle) -> tauri::Result<(tauri::image::Image<'static>, bool)> {
    icon(*app.state::<Preferences>().style.lock().unwrap_or_else(|e| e.into_inner()))
}

fn apply(app: &tauri::AppHandle, style: TrayStyle) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("系统托盘暂不可用")?;
    let (image, template) = icon(style).map_err(|e| e.to_string())?;
    tray.set_icon_with_as_template(Some(image), template).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tray_style(app: tauri::AppHandle) -> TrayStyle {
    *app.state::<Preferences>().style.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn set_tray_style(app: tauri::AppHandle, style: TrayStyle) -> Result<TrayStyle, String> {
    let preferences = app.state::<Preferences>();
    let previous = *preferences.style.lock().map_err(|e| e.to_string())?;
    apply(&app, style)?;
    let bytes = serde_json::to_vec(&Settings { tray_style: style }).map_err(|e| e.to_string())?;
    if let Err(error) = crate::exchange::atomic_write(&preferences.path, &bytes) {
        let _ = apply(&app, previous);
        return Err(format!("图标样式未保存：{error}"));
    }
    *preferences.style.lock().map_err(|e| e.to_string())? = style;
    Ok(style)
}

pub fn refresh_system_style(app: &tauri::AppHandle) {
    // macOS renders template images automatically, including wallpaper changes.
    #[cfg(target_os = "windows")]
    if let Some(preferences) = app.try_state::<Preferences>() {
        let style = *preferences.style.lock().unwrap_or_else(|e| e.into_inner());
        if style == TrayStyle::System {
            if let Err(error) = apply(app, style) { eprintln!("Could not update tray theme: {error}"); }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_and_taskbar_theme_selection() {
        for dark in [false, true] {
            assert_eq!(presentation(TrayStyle::System, true, dark), (TrayStyle::White, true));
            assert_eq!(presentation(TrayStyle::System, false, dark),
                (if dark { TrayStyle::White } else { TrayStyle::Black }, false));
            for style in [TrayStyle::White, TrayStyle::Black, TrayStyle::Color] {
                assert_eq!(presentation(style, true, dark), (style, false));
                assert_eq!(presentation(style, false, dark), (style, false));
            }
        }
    }

    #[test]
    fn icons_preserve_transparent_book_cutout_at_both_native_sizes() {
        for macos in [false, true] {
            let white = pixels(TrayStyle::White, macos).unwrap();
            let black = pixels(TrayStyle::Black, macos).unwrap();
            let color = pixels(TrayStyle::Color, macos).unwrap();
            let size = if macos { 36 } else { 32 };
            assert_eq!(white.dimensions(), (size, size));
            assert_eq!(color.dimensions(), (size, size));
            assert_eq!(white.get_pixel(0, 0).0[3], 0);
            assert_eq!(white.get_pixel(size / 2, size / 5).0, [255; 4]);
            // Center of the first book is a real hole, not white paint.
            assert_eq!(white.get_pixel(size / 2, size * 2 / 5).0[3], 0);
            assert_eq!(color.get_pixel(size / 2, size * 2 / 5).0[3], 255);
            assert!(white.pixels().any(|p| p.0[3] > 0 && p.0[3] < 255));
            for (a, b) in white.pixels().zip(black.pixels()) {
                assert_eq!(a.0[3], b.0[3]);
                assert_eq!(&b.0[..3], &[0, 0, 0]);
            }
        }
    }

    #[test]
    fn preferences_survive_restart_and_recover_from_missing_or_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-settings.json");
        assert_eq!(read_style(&path), TrayStyle::System);
        for style in [TrayStyle::System, TrayStyle::White, TrayStyle::Black, TrayStyle::Color] {
            crate::exchange::atomic_write(&path, &serde_json::to_vec(&Settings { tray_style: style }).unwrap()).unwrap();
            assert_eq!(read_style(&path), style);
        }
        for invalid in ["{", "{}", "{\"tray_style\":\"unknown\"}", "null"] {
            std::fs::write(&path, invalid).unwrap();
            assert_eq!(read_style(&path), TrayStyle::System);
        }
        assert!(serde_json::from_str::<TrayStyle>("\"unknown\"").is_err());
    }
}
