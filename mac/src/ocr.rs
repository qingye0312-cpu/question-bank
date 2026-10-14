use super::{decode, image_file, image_input, ClipboardInput, ImageInput, Recognition};
use crate::model::{err, Result};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

unsafe extern "C" {
    fn qbank_ocr_image(bytes: *const u8, length: usize) -> *mut std::ffi::c_char;
    fn qbank_ocr_clipboard() -> *mut std::ffi::c_char;
    fn qbank_ocr_free(value: *mut std::ffi::c_char);
    fn qbank_capture_allowed() -> bool;
}

unsafe fn native_json(value: *mut std::ffi::c_char) -> Result<serde_json::Value> {
    if value.is_null() {
        return Err("系统识别没有返回数据".into());
    }
    let result = serde_json::from_slice(std::ffi::CStr::from_ptr(value).to_bytes()).map_err(err);
    qbank_ocr_free(value);
    let result: serde_json::Value = result?;
    if let Some(message) = result["error"].as_str() {
        return Err(message.into());
    }
    Ok(result)
}

pub fn recognize(bytes: &[u8]) -> Result<Recognition> {
    unsafe {
        serde_json::from_value(native_json(qbank_ocr_image(bytes.as_ptr(), bytes.len()))?)
            .map_err(err)
    }
}

pub fn clipboard() -> Result<ClipboardInput> {
    unsafe {
        let value = native_json(qbank_ocr_clipboard())?;
        if let Some(data) = value["image"].as_str() {
            return Ok(ClipboardInput {
                image: Some(image_input(&decode(data)?, "粘贴的图片".into())?),
                text: String::new(),
            });
        }
        Ok(ClipboardInput {
            image: None,
            text: value["text"].as_str().unwrap_or_default().into(),
        })
    }
}

pub fn check_capture_permission() -> Result<()> {
    if !unsafe { qbank_capture_allowed() } {
        return Err("请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」允许题库截图，然后重新打开程序。也可用系统截图后粘贴识别。".into());
    }
    Ok(())
}

pub fn capture(cancel: &AtomicBool) -> Result<Option<ImageInput>> {
    let temp = tempfile::tempdir().map_err(err)?;
    let path = temp.path().join("question.png");
    let mut child = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png", "-D", "1"])
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(err)?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(err)?.is_some() {
            break;
        }
        if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    if !path.exists() {
        let output = child.wait_with_output().map_err(err)?;
        let reason = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "未能截取主屏幕，请检查屏幕录制权限，或使用系统截图后粘贴。{}",
            reason.trim()
        ));
    }
    let mut input = image_file(&path)?;
    input.name = "主屏幕截图".into();
    input.needs_crop = true;
    Ok(Some(input))
}
