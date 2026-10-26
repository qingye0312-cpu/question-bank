use super::*;

#[tauri::command]
pub(crate) async fn backup_database(
    s: State<'_, AppState>,
    path: String,
    restore: bool,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        if restore {
            backup::restore(&d, &PathBuf::from(path))
        } else {
            backup::save(&d, &PathBuf::from(path))
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_name(s: State<'_, AppState>, bank_id: String) -> Result<String> {
    let d = s.store.clone();
    blocking(move || crate::exchange::export_name(&d.bank(&bank_id)?, &d.questions(&bank_id)?))
        .await
}

#[tauri::command]
pub(crate) async fn export_bank(
    s: State<'_, AppState>,
    bank_id: String,
    path: String,
    format: String,
    filter: Option<Query>,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::exchange::export_filtered(&d, &bank_id, &PathBuf::from(path), &format, filter)
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_recorded_questions(
    s: State<'_, AppState>,
    bank_id: String,
    path: String,
    start_at: Option<String>,
    end_before: Option<String>,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::exchange::export_recorded_questions(
            &d,
            &bank_id,
            &PathBuf::from(path),
            start_at,
            end_before,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_text_file(path: String) -> Result<String> {
    blocking(move || {
        let bytes = crate::exchange::read_file(&PathBuf::from(path))?;
        String::from_utf8(bytes).map_err(|_| "证书文件不是 UTF-8 文本".into())
    })
    .await
}
