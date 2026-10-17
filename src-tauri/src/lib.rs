pub mod backup;
pub mod cloud;
pub mod db;
mod desktop;
pub mod exchange;
pub mod import_jobs;
pub mod intake;
pub mod model;
pub mod ocr;
pub mod updater;
use db::{Query, Results, Store};
use model::*;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

struct AppState {
    store: Store,
    writes: Arc<Mutex<()>>,
    controls: Mutex<HashMap<String, Arc<import_jobs::Control>>>,
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}
#[tauri::command]
async fn backup_database(s: State<'_, AppState>, path: String, restore: bool) -> Result<usize> {
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
async fn cloud_request(
    origin: String,
    path: String,
    body: Option<serde_json::Value>,
    token: Option<String>,
) -> Result<serde_json::Value> {
    blocking(move || cloud::request(&origin, &path, body, token)).await
}
#[tauri::command]
async fn cloud_transfer(
    s: State<'_, AppState>,
    batch_id: String,
    endpoint: String,
) -> Result<serde_json::Value> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        cloud::transfer(&d, &batch_id, &endpoint)
    })
    .await
}
#[tauri::command]
async fn cloud_receipt(
    s: State<'_, AppState>,
    batch_id: String,
    receipt: serde_json::Value,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        cloud::acknowledge(&d, &batch_id, receipt)
    })
    .await
}
#[tauri::command]
async fn cloud_versions(s: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || cloud::versions(&d)).await
}
#[tauri::command]
async fn cloud_apply(s: State<'_, AppState>, payload: String, sha256: String) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        cloud::apply(&d, &payload, &sha256)
    })
    .await
}
#[tauri::command]
async fn bank_questions(s: State<'_, AppState>, bank_id: String) -> Result<Vec<Question>> {
    let d = s.store.clone();
    blocking(move || cloud::formal_questions(&d, &bank_id)).await
}
#[tauri::command]
async fn banks(s: State<'_, AppState>) -> Result<Vec<Bank>> {
    let d = s.store.clone();
    blocking(move || d.banks()).await
}
#[tauri::command]
async fn search(s: State<'_, AppState>, query: Query) -> Result<Results> {
    let d = s.store.clone();
    blocking(move || d.search(&query)).await
}
#[tauri::command]
async fn ocr_image_file(path: String) -> Result<ocr::ImageInput> {
    blocking(move || ocr::image_file(&PathBuf::from(path))).await
}
#[tauri::command]
async fn ocr_recognize(data_url: String) -> Result<ocr::Recognition> {
    blocking(move || ocr::recognize(&data_url)).await
}
#[tauri::command]
async fn ocr_clipboard() -> Result<ocr::ClipboardInput> {
    blocking(ocr::clipboard).await
}
#[tauri::command]
async fn clipboard_write_text(text: String) -> Result<()> {
    blocking(move || ocr::write_clipboard(&text)).await
}
#[tauri::command]
async fn intake_preview(
    s: State<'_, AppState>,
    bank_id: String,
    text: String,
) -> Result<intake::Comparison> {
    let d = s.store.clone();
    blocking(move || intake::preview(&d, &bank_id, &text)).await
}
#[tauri::command]
async fn intake_save(
    s: State<'_, AppState>,
    bank_id: String,
    batch_id: String,
    text: String,
    metadata: Option<intake::Metadata>,
) -> Result<intake::Saved> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        intake::save_with_metadata(&d, &bank_id, &batch_id, &text, metadata.unwrap_or_default())
    })
    .await
}
#[tauri::command]
async fn intake_batches(s: State<'_, AppState>) -> Result<Vec<intake::Batch>> {
    let d = s.store.clone();
    blocking(move || intake::batches(&d)).await
}
#[tauri::command]
async fn intake_entries(s: State<'_, AppState>, batch_id: String) -> Result<Vec<intake::Entry>> {
    let d = s.store.clone();
    blocking(move || intake::entries(&d, &batch_id)).await
}
#[tauri::command]
async fn intake_mark_upload(
    s: State<'_, AppState>,
    bank_id: String,
    question_id: String,
    uploaded: bool,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        intake::mark_upload(&d, &bank_id, &question_id, uploaded)
    })
    .await
}
#[tauri::command]
async fn intake_export(s: State<'_, AppState>, batch_id: String, path: String) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        intake::export(&d, &batch_id, &PathBuf::from(path))
    })
    .await
}
#[tauri::command]
async fn import_delta(s: State<'_, AppState>, path: String) -> Result<intake::Imported> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        intake::import(&d, &PathBuf::from(path))
    })
    .await
}
#[tauri::command]
async fn ocr_capture(window: tauri::WebviewWindow) -> Result<Option<ocr::ImageInput>> {
    blocking(move || ocr::capture(window)).await
}
#[tauri::command]
fn ocr_cancel_capture() {
    ocr::cancel_capture();
}
#[tauri::command]
async fn ocr_match(
    s: State<'_, AppState>,
    bank_id: String,
    text: String,
) -> Result<ocr::matching::Matches> {
    let store = s.store.clone();
    blocking(move || ocr::matching::find(&store, &bank_id, &text)).await
}
#[tauri::command]
async fn create_bank(s: State<'_, AppState>, name: String) -> Result<String> {
    let d = s.store.clone();
    blocking(move || d.create(&name)).await
}
#[tauri::command]
async fn save_question(
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
async fn delete_question(s: State<'_, AppState>, rowid: i64, restore: bool) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.delete(rowid, restore)
    })
    .await
}
#[tauri::command]
async fn fork_bank(s: State<'_, AppState>, bank_id: String) -> Result<String> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.fork(&bank_id)
    })
    .await
}
#[tauri::command]
fn import_status(
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
async fn import_jobs_list(s: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || import_jobs::list(&d)).await
}
#[tauri::command]
async fn import_runs(s: State<'_, AppState>, bank_id: String) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || import_jobs::history(&d, &bank_id)).await
}
#[tauri::command]
async fn import_undo(s: State<'_, AppState>, run_id: String) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        import_jobs::undo(&d, &run_id)
    })
    .await
}
#[tauri::command]
async fn import_preview(
    s: State<'_, AppState>,
    path: String,
    bank_id: String,
    job_id: String,
) -> Result<exchange::Preview> {
    let control = Arc::new(import_jobs::Control::default());
    s.controls
        .lock()
        .map_err(err)?
        .insert(job_id.clone(), control.clone());
    let d = s.store.clone();
    let lock = s.writes.clone();
    let result = blocking(move || {
        let p = exchange::preview_controlled(&d, &PathBuf::from(path), &bank_id, &control)?;
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
async fn import_commit(s: State<'_, AppState>, token: String) -> Result<String> {
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
        exchange::commit_controlled(&d, &p, &control)
    })
    .await;
    s.controls.lock().map_err(err)?.remove(&token);
    result
}
#[tauri::command]
async fn export_bank(
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
        exchange::export_filtered(&d, &bank_id, &PathBuf::from(path), &format, filter)
    })
    .await
}
#[tauri::command]
async fn rollback_bank(s: State<'_, AppState>, bank_id: String) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.rollback(&bank_id)
    })
    .await
}
#[tauri::command]
async fn history(
    s: State<'_, AppState>,
    bank_id: String,
    question_id: String,
) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || d.history(&bank_id, &question_id)).await
}
#[tauri::command]
async fn rebuild_index(s: State<'_, AppState>) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        d.reindex()
    })
    .await
}
#[tauri::command]
fn app_info(app: tauri::AppHandle, s: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"global_shortcut":app.state::<desktop::Features>().shortcut,"tray":app.state::<desktop::Features>().tray.to_string(),"database":s.store.path,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"benchmark_enabled":if std::env::var("QBANK_BENCHMARK").as_deref()==Ok("1"){"true"}else{"false"}})
}
#[tauri::command]
async fn save_benchmark(s: State<'_, AppState>, report: serde_json::Value) -> Result<String> {
    if std::env::var("QBANK_BENCHMARK").as_deref() != Ok("1") {
        return Err("性能验证模式未启用".into());
    }
    let path = s.store.path.with_file_name("ui-benchmark-report.json");
    blocking(move || {
        exchange::atomic_write(&path, &serde_json::to_vec_pretty(&report).map_err(err)?)?;
        Ok(path.display().to_string())
    })
    .await
}
#[tauri::command]
async fn download_template(path: String, format: String) -> Result<()> {
    blocking(move || {
        let bytes: &[u8] = match format.as_str() {
            "docx" => include_bytes!("../../templates/题库导入模板_v1.docx"),
            "xlsx" => include_bytes!("../../templates/题库导入模板_v1.xlsx"),
            "jsonl" => include_bytes!("../../templates/题库导入示例_v1.jsonl"),
            _ => return Err("未知模板格式".into()),
        };
        exchange::atomic_write(&PathBuf::from(path), &bytes)
    })
    .await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop::focus(app)
        }))
        .on_window_event(|w, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if w.app_handle()
                    .try_state::<desktop::Features>()
                    .is_some_and(|f| f.tray)
                {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let features = desktop::install(app);
            app.manage(features);
            let dir = std::env::var_os("QBANK_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let store =
                Store::open(dir.join("question-bank.sqlite")).map_err(std::io::Error::other)?;
            store.seed().map_err(std::io::Error::other)?;
            app.manage(AppState {
                store,
                controls: Mutex::new(HashMap::new()),
                writes: Arc::new(Mutex::new(())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater::software_update_check,
            updater::software_update_install,
            backup_database,
            cloud_request,
            cloud_transfer,
            cloud_receipt,
            cloud_versions,
            cloud_apply,
            bank_questions,
            banks,
            search,
            ocr_image_file,
            ocr_recognize,
            ocr_clipboard,
            clipboard_write_text,
            intake_preview,
            intake_save,
            intake_batches,
            intake_entries,
            intake_mark_upload,
            intake_export,
            import_delta,
            ocr_capture,
            ocr_cancel_capture,
            ocr_match,
            create_bank,
            save_question,
            delete_question,
            fork_bank,
            import_status,
            import_jobs_list,
            import_runs,
            import_undo,
            import_preview,
            import_commit,
            export_bank,
            rollback_bank,
            history,
            rebuild_index,
            app_info,
            download_template,
            save_benchmark
        ])
        .run(tauri::generate_context!())
        .expect("题库启动失败");
}
