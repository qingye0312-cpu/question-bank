use super::{ClipboardInput, ImageInput, Line, Recognition, MAX_PIXELS};
use crate::model::{err, Result};
use std::{
    io::Cursor,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use windows::{
    core::{w, HSTRING, PCWSTR},
    Globalization::Language,
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
        ExifOrientationMode,
    },
    Media::Ocr::OcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    Win32::{
        System::{
            DataExchange::GetClipboardSequenceNumber,
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE},
            Shell::ShellExecuteW,
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
};

pub fn recognize(bytes: &[u8]) -> Result<Recognition> {
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED).map_err(err)?;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    let engine = OcrEngine::TryCreateFromLanguage(
        &Language::CreateLanguage(&HSTRING::from("zh-Hans")).map_err(err)?,
    )
    .or_else(|_| OcrEngine::TryCreateFromUserProfileLanguages())
    .map_err(|e| format!("Windows 系统 OCR 不可用（可能缺少语言包或应用包身份）：{e}"))?;
    let stream = InMemoryRandomAccessStream::new().map_err(err)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(err)?;
    writer.WriteBytes(bytes).map_err(err)?;
    writer.StoreAsync().map_err(err)?.join().map_err(err)?;
    writer.FlushAsync().map_err(err)?.join().map_err(err)?;
    writer.DetachStream().map_err(err)?;
    stream.Seek(0).map_err(err)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(err)?
        .join()
        .map_err(err)?;
    let width = decoder.PixelWidth().map_err(err)?;
    let height = decoder.PixelHeight().map_err(err)?;
    let max = OcrEngine::MaxImageDimension().map_err(err)?;
    let ratio = (max as f64 / width.max(height) as f64).min(1.);
    let transform = BitmapTransform::new().map_err(err)?;
    transform
        .SetScaledWidth(((width as f64 * ratio).round() as u32).max(1))
        .map_err(err)?;
    transform
        .SetScaledHeight(((height as f64 * ratio).round() as u32).max(1))
        .map_err(err)?;
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Ignore,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .map_err(err)?
        .join()
        .map_err(err)?;
    let bw = bitmap.PixelWidth().map_err(err)? as f64;
    let bh = bitmap.PixelHeight().map_err(err)? as f64;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(err)?
        .join()
        .map_err(err)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(err)? {
        let mut left = bw;
        let mut top = bh;
        let mut right = 0f64;
        let mut bottom = 0f64;
        for word in line.Words().map_err(err)? {
            let r = word.BoundingRect().map_err(err)?;
            left = left.min(r.X as f64);
            top = top.min(r.Y as f64);
            right = right.max((r.X + r.Width) as f64);
            bottom = bottom.max((r.Y + r.Height) as f64);
        }
        lines.push(Line {
            text: line.Text().map_err(err)?.to_string(),
            confidence: None,
            bounds: [
                left / bw,
                top / bh,
                (right - left).max(0.) / bw,
                (bottom - top).max(0.) / bh,
            ],
        });
    }
    Ok(Recognition {
        engine: "Windows OCR".into(),
        text: lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        lines,
        elapsed_ms: 0.,
    })
}
pub fn clipboard() -> Result<ClipboardInput> {
    let mut clipboard = arboard::Clipboard::new().map_err(err)?;
    if let Ok(image) = clipboard.get_image() {
        if image.width as u64 * image.height as u64 > MAX_PIXELS {
            return Err("图片过大，请裁剪后粘贴".into());
        }
        let buffer = image::RgbaImage::from_raw(
            image.width as u32,
            image.height as u32,
            image.bytes.into_owned(),
        )
        .ok_or("剪贴板图片格式错误")?;
        let mut bytes = Cursor::new(Vec::new());
        buffer
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(err)?;
        return Ok(ClipboardInput {
            image: Some(super::image_input(bytes.get_ref(), "粘贴的图片".into())?),
            text: String::new(),
        });
    }
    let text = clipboard
        .get_text()
        .map_err(|_| "剪贴板没有图片或文字，请先复制一道题")?;
    if text.chars().count() > 16000 {
        return Err("文字过长，请每次复制一道题".into());
    }
    Ok(ClipboardInput { image: None, text })
}
pub fn write_clipboard(text: &str) -> Result<()> {
    arboard::Clipboard::new()
        .map_err(err)?
        .set_text(text)
        .map_err(err)
}
pub fn capture(cancel: &AtomicBool) -> Result<Option<ImageInput>> {
    // Snipping Tool copies the new snip to the clipboard. Sequence checking avoids
    // accidentally recognizing an older clipboard image. No MSIX callback needed.
    let sequence = unsafe { GetClipboardSequenceNumber() };
    let handle = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            w!("ms-screenclip:"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if handle.0 as isize <= 32 {
        return Err("无法打开截图工具，请按 Win + Shift + S 截图，再回到程序粘贴识别".into());
    }
    let started = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(120));
        if cancel.load(Ordering::SeqCst) || unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } < 0 {
            return Ok(None);
        }
        if unsafe { GetClipboardSequenceNumber() } != sequence {
            if let Ok(input) = clipboard() {
                if input.image.is_some() {
                    return Ok(input.image);
                }
            }
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err("未收到新截图。请用 Win + Shift + S 截图后，回到程序粘贴识别。".into());
        }
    }
}
