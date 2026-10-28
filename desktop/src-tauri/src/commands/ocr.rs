use super::*;

#[tauri::command]
pub(crate) async fn ocr_image_file(path: String) -> Result<crate::ocr::ImageInput> {
    blocking(move || crate::ocr::image_file(&PathBuf::from(path))).await
}
#[tauri::command]
pub(crate) async fn ocr_recognize(data_url: String) -> Result<crate::ocr::Recognition> {
    blocking(move || crate::ocr::recognize(&data_url)).await
}
#[tauri::command]
pub(crate) async fn ocr_clipboard() -> Result<crate::ocr::ClipboardInput> {
    blocking(crate::ocr::clipboard).await
}
#[tauri::command]
pub(crate) async fn clipboard_write_text(text: String) -> Result<()> {
    blocking(move || crate::ocr::write_clipboard(&text)).await
}
#[tauri::command]
pub(crate) async fn ocr_capture(
    window: tauri::WebviewWindow,
) -> Result<Option<crate::ocr::ImageInput>> {
    blocking(move || crate::ocr::capture(window)).await
}
#[tauri::command]
pub(crate) fn ocr_cancel_capture() {
    crate::ocr::cancel_capture();
}
#[tauri::command]
pub(crate) async fn ocr_match(
    s: State<'_, AppState>,
    bank_id: String,
    text: String,
) -> Result<crate::ocr::matching::Matches> {
    let store = s.store.clone();
    blocking(move || crate::ocr::matching::find(&store, &bank_id, &text)).await
}
