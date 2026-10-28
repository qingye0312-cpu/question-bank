#[cfg(target_os = "macos")]
#[path = "../../../../mac/src/ocr.rs"]
mod mac;
pub mod matching;
#[cfg(target_os = "windows")]
#[path = "../../../../windows/src/ocr.rs"]
mod windows;

use crate::model::{err, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    io::Cursor,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 30_000_000;
static CAPTURING: AtomicBool = AtomicBool::new(false);
static CANCEL_CAPTURE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
pub struct ImageInput {
    pub data_url: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub needs_crop: bool,
}
#[derive(Serialize, Deserialize)]
pub struct Line {
    pub text: String,
    pub confidence: Option<f64>,
    pub bounds: [f64; 4],
}
#[derive(Serialize, Deserialize)]
pub struct Recognition {
    pub engine: String,
    pub text: String,
    pub lines: Vec<Line>,
    #[serde(default)]
    pub elapsed_ms: f64,
}
#[derive(Serialize, Default)]
pub struct ClipboardInput {
    pub image: Option<ImageInput>,
    pub text: String,
}

pub fn image_input(bytes: &[u8], name: String) -> Result<ImageInput> {
    if bytes.len() > MAX_BYTES {
        return Err("图片超过 20 MB，请裁剪后重试".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "请选择 PNG、JPEG 或 WebP 图片")?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("请选择 PNG、JPEG 或 WebP 图片".into()),
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(err)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("图片尺寸过大，请裁剪到一道题后重试（最多 3000 万像素）".into());
    }
    Ok(ImageInput {
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        name,
        width,
        height,
        needs_crop: false,
    })
}
pub fn image_file(path: &Path) -> Result<ImageInput> {
    if std::fs::metadata(path).map_err(err)?.len() > MAX_BYTES as u64 {
        return Err("图片超过 20 MB，请裁剪后重试".into());
    }
    image_input(
        &std::fs::read(path).map_err(err)?,
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    )
}
pub fn decode(data_url: &str) -> Result<Vec<u8>> {
    if data_url.len() > MAX_BYTES * 4 / 3 + 100 {
        return Err("图片超过 20 MB".into());
    }
    let (header, value) = data_url.split_once(',').ok_or("无效图片数据")?;
    if !matches!(
        header,
        "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64"
    ) {
        return Err("请选择 PNG、JPEG 或 WebP 图片".into());
    }
    let bytes = STANDARD.decode(value).map_err(err)?;
    image_input(&bytes, String::new())?;
    Ok(bytes)
}

pub fn recognize(data_url: &str) -> Result<Recognition> {
    let started = Instant::now();
    let bytes = decode(data_url)?;
    #[cfg(target_os = "macos")]
    let mut result = mac::recognize(&bytes)?;
    #[cfg(target_os = "windows")]
    let mut result = windows::recognize(&bytes)?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut result: Recognition = {
        let _ = bytes;
        return Err("当前平台请使用内置识别引擎".into());
    };
    result.elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
    Ok(result)
}
pub fn clipboard() -> Result<ClipboardInput> {
    #[cfg(target_os = "macos")]
    return mac::clipboard();
    #[cfg(target_os = "windows")]
    return windows::clipboard();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("请使用 Ctrl / ⌘ V 粘贴图片或题目文字".into())
}
pub fn write_clipboard(text: &str) -> Result<()> {
    if text.len() > 1_000_000 {
        return Err("复制内容超过 1 MB".into());
    }
    #[cfg(target_os = "macos")]
    return mac::write_clipboard(text);
    #[cfg(target_os = "windows")]
    return windows::write_clipboard(text);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("当前平台不支持系统剪贴板".into())
}

pub fn cancel_capture() {
    CANCEL_CAPTURE.store(true, Ordering::SeqCst);
}
pub fn capture(window: tauri::WebviewWindow) -> Result<Option<ImageInput>> {
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return Err("截图已在进行中".into());
    }
    CANCEL_CAPTURE.store(false, Ordering::SeqCst);
    struct Restore(tauri::WebviewWindow);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = self.0.show();
            let _ = self.0.set_focus();
            CAPTURING.store(false, Ordering::SeqCst);
        }
    }
    let restore = Restore(window);
    #[cfg(target_os = "macos")]
    mac::check_capture_permission()?;
    restore.0.hide().map_err(err)?;
    std::thread::sleep(Duration::from_millis(250));
    #[cfg(target_os = "macos")]
    return mac::capture(&CANCEL_CAPTURE);
    #[cfg(target_os = "windows")]
    return windows::capture(&CANCEL_CAPTURE);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("此平台请使用系统截图后粘贴识别".into())
}
