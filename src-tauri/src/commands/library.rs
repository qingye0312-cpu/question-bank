use super::*;

#[tauri::command]
pub(crate) async fn bank_questions(
    s: State<'_, AppState>,
    bank_id: String,
) -> Result<Vec<Question>> {
    let d = s.store.clone();
    blocking(move || crate::cloud::formal_questions(&d, &bank_id)).await
}
#[tauri::command]
pub(crate) async fn banks(s: State<'_, AppState>) -> Result<Vec<Bank>> {
    let d = s.store.clone();
    blocking(move || d.banks()).await
}
#[tauri::command]
pub(crate) async fn search(s: State<'_, AppState>, query: Query) -> Result<Results> {
    let d = s.store.clone();
    blocking(move || d.search(&query)).await
}
#[tauri::command]
pub(crate) async fn create_bank(s: State<'_, AppState>, name: String) -> Result<String> {
    let d = s.store.clone();
    blocking(move || d.create(&name)).await
}
#[tauri::command]
pub(crate) async fn save_question(
    s: State<'_, AppState>,
    bank_id: String,
    question: Question,
) -> Result<String> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.save(&bank_id, question)
    })
    .await
}
#[tauri::command]
pub(crate) async fn delete_question(
    s: State<'_, AppState>,
    rowid: i64,
    restore: bool,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.delete(rowid, restore)
    })
    .await
}
#[tauri::command]
pub(crate) async fn fork_bank(s: State<'_, AppState>, bank_id: String) -> Result<String> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.fork(&bank_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn delete_bank(
    s: State<'_, AppState>,
    bank_id: String,
    version: i64,
) -> Result<String> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::library::delete_local_bank(&d, &bank_id, version)
    })
    .await
}
#[tauri::command]
pub(crate) async fn rollback_bank(s: State<'_, AppState>, bank_id: String) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.rollback(&bank_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn history(
    s: State<'_, AppState>,
    bank_id: String,
    question_id: String,
) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || d.history(&bank_id, &question_id)).await
}
#[tauri::command]
pub(crate) async fn rebuild_index(s: State<'_, AppState>) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.reindex()
    })
    .await
}
#[tauri::command]
pub(crate) fn app_info(app: tauri::AppHandle, s: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"global_shortcut":app.state::<desktop::Features>().shortcut,"tray":app.state::<desktop::Features>().tray.to_string(),"database":s.store.path,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"benchmark_enabled":if std::env::var("QBANK_BENCHMARK").as_deref()==Ok("1"){"true"}else{"false"}})
}
#[tauri::command]
pub(crate) async fn save_benchmark(
    s: State<'_, AppState>,
    report: serde_json::Value,
) -> Result<String> {
    if std::env::var("QBANK_BENCHMARK").as_deref() != Ok("1") {
        return Err("性能验证模式未启用".into());
    }
    let path = s.store.path.with_file_name("ui-benchmark-report.json");
    blocking(move || {
        crate::exchange::atomic_write(&path, &serde_json::to_vec_pretty(&report).map_err(err)?)?;
        Ok(path.display().to_string())
    })
    .await
}
