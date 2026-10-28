use super::*;

#[tauri::command]
pub(crate) async fn draft_export(
    s: State<'_, AppState>,
    bank_id: String,
    path: String,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        drafts::export(&d, &bank_id, &PathBuf::from(path))
    })
    .await
}
#[tauri::command]
pub(crate) async fn draft_records(
    s: State<'_, AppState>,
    bank_id: String,
) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        drafts::list(&d, &bank_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn draft_save(
    s: State<'_, AppState>,
    record: serde_json::Value,
    expected: u64,
) -> Result<serde_json::Value> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        drafts::save(&d, record, expected)
    })
    .await
}
#[tauri::command]
pub(crate) async fn draft_submit(
    s: State<'_, AppState>,
    bank_id: String,
    expected: serde_json::Value,
    endpoint: String,
    actor: String,
) -> Result<serde_json::Value> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        drafts::enqueue(&d, &bank_id, expected, &endpoint, &actor)
    })
    .await
}
#[tauri::command]
pub(crate) async fn draft_commit_local(
    s: State<'_, AppState>,
    bank_id: String,
    expected: serde_json::Value,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        drafts::commit_local(&d, &bank_id, expected)
    })
    .await
}
#[tauri::command]
pub(crate) async fn intake_preview(
    s: State<'_, AppState>,
    bank_id: String,
    text: String,
) -> Result<crate::intake::Comparison> {
    let d = s.store.clone();
    blocking(move || crate::intake::preview(&d, &bank_id, &text)).await
}
#[tauri::command]
pub(crate) async fn intake_save(
    s: State<'_, AppState>,
    bank_id: String,
    batch_id: String,
    text: String,
    metadata: Option<crate::intake::Metadata>,
) -> Result<crate::intake::Saved> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::intake::save_with_metadata(
            &d,
            &bank_id,
            &batch_id,
            &text,
            metadata.unwrap_or_default(),
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn intake_batches(s: State<'_, AppState>) -> Result<Vec<crate::intake::Batch>> {
    let d = s.store.clone();
    blocking(move || crate::intake::batches(&d)).await
}
#[tauri::command]
pub(crate) async fn intake_edit(
    s: State<'_, AppState>,
    bank_id: String,
    question_id: String,
    text: String,
    metadata: crate::intake::Metadata,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::intake::edit_entry(&d, &bank_id, &question_id, &text, metadata)
    })
    .await
}
#[tauri::command]
pub(crate) async fn intake_entries(
    s: State<'_, AppState>,
    batch_id: String,
) -> Result<Vec<crate::intake::Entry>> {
    let d = s.store.clone();
    blocking(move || crate::intake::entries(&d, &batch_id)).await
}
#[tauri::command]
pub(crate) async fn intake_mark_upload(
    s: State<'_, AppState>,
    bank_id: String,
    question_id: String,
    uploaded: bool,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::intake::mark_upload(&d, &bank_id, &question_id, uploaded)
    })
    .await
}
#[tauri::command]
pub(crate) async fn intake_export(
    s: State<'_, AppState>,
    batch_id: String,
    path: String,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::intake::export(&d, &batch_id, &PathBuf::from(path))
    })
    .await
}
#[tauri::command]
pub(crate) async fn import_delta(
    s: State<'_, AppState>,
    path: String,
) -> Result<crate::intake::Imported> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::intake::import(&d, &PathBuf::from(path))
    })
    .await
}
