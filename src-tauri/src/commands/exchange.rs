use super::*;

#[tauri::command]
pub(crate) async fn backup_database(
    s: State<'_, AppState>,
    path: String,
    restore: bool,
) -> Result<usize> {
    if restore {
        for control in s.controls.lock().map_err(err)?.values() {
            control.cancel();
        }
    }
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
pub(crate) fn import_status(
    s: State<'_, AppState>,
    job_id: String,
    cancel: bool,
) -> Result<serde_json::Value> {
    let controls = s.controls.lock().map_err(err)?;
    if let Some(control) = controls.get(&job_id) {
        if cancel {
            control.cancel();
        }
        return Ok(control.status());
    }
    Ok(serde_json::Value::Null)
}
#[tauri::command]
pub(crate) async fn import_jobs_list(s: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || import_jobs::list(&d)).await
}
#[tauri::command]
pub(crate) async fn import_runs(
    s: State<'_, AppState>,
    bank_id: String,
) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || import_jobs::history(&d, &bank_id)).await
}
#[tauri::command]
pub(crate) async fn import_undo(s: State<'_, AppState>, run_id: String) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        import_jobs::undo(&d, &run_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn import_preview(
    s: State<'_, AppState>,
    path: String,
    bank_id: String,
    job_id: String,
) -> Result<crate::exchange::Preview> {
    let control = Arc::new(import_jobs::Control::default());
    s.controls
        .lock()
        .map_err(err)?
        .insert(job_id.clone(), control.clone());
    let d = s.store.clone();
    let lock = s.writes.clone();
    let result = blocking(move || {
        let p = crate::exchange::preview_controlled(&d, &PathBuf::from(path), &bank_id, &control)?;
        let _g = lock.lock().map_err(err)?;
        control.step("保存预览", p.questions.len(), p.questions.len())?;
        import_jobs::save(&d, &p)?;
        Ok(p.preview)
    })
    .await;
    s.controls.lock().map_err(err)?.remove(&job_id);
    result
}
#[tauri::command]
pub(crate) async fn import_commit(s: State<'_, AppState>, token: String) -> Result<String> {
    let control = Arc::new(import_jobs::Control::default());
    s.controls
        .lock()
        .map_err(err)?
        .insert(token.clone(), control.clone());
    let d = s.store.clone();
    let lock = s.writes.clone();
    let job = token.clone();
    let result = blocking(move || {
        let _g = lock.lock().map_err(err)?;
        let p = import_jobs::load(&d, &job)?;
        crate::exchange::commit_controlled(&d, &p, &control)
    })
    .await;
    s.controls.lock().map_err(err)?.remove(&token);
    result
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
pub(crate) async fn download_template(path: String, format: String) -> Result<()> {
    blocking(move || {
        let bytes: &[u8] = match format.as_str() {
            "docx" => include_bytes!("../../../templates/题库导入模板_v1.docx"),
            "xlsx" => include_bytes!("../../../templates/题库导入模板_v1.xlsx"),
            "jsonl" => include_bytes!("../../../templates/题库导入示例_v1.jsonl"),
            _ => return Err("未知模板格式".into()),
        };
        crate::exchange::atomic_write(&PathBuf::from(path), &bytes)
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_text_file(path: String) -> Result<String> {
    blocking(move || {
        let bytes = crate::exchange::read_file(&PathBuf::from(path))?;
        String::from_utf8(bytes).map_err(|_| "证书文件不是 UTF-8 文本".into())
    }).await
}
