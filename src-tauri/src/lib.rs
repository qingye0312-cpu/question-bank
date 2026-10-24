pub mod backup;
pub mod cloud;
mod commands;
mod credentials;
pub mod db;
mod desktop;
pub mod drafts;
pub mod exchange;
pub mod import_jobs;
pub mod intake;
pub mod library;
pub mod model;
pub mod ocr;
pub mod promotion;
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
            commands::exchange::backup_database,
            commands::cloud::cloud_request,
            commands::cloud::credential_save,
            commands::cloud::credential_login,
            commands::cloud::client_state,
            commands::intake::draft_records,
            commands::cloud::promotion_tasks,
            commands::cloud::promotion_prepare,
            commands::intake::draft_export,
            commands::intake::draft_save,
            commands::intake::draft_submit,
            commands::cloud::cloud_transfer,
            commands::cloud::cloud_receipt,
            commands::cloud::cloud_versions,
            commands::cloud::cloud_apply,
            commands::library::bank_questions,
            commands::library::banks,
            commands::library::search,
            commands::ocr::ocr_image_file,
            commands::ocr::ocr_recognize,
            commands::ocr::ocr_clipboard,
            commands::ocr::clipboard_write_text,
            commands::intake::intake_preview,
            commands::intake::intake_save,
            commands::intake::intake_edit,
            commands::intake::intake_batches,
            commands::intake::intake_entries,
            commands::intake::intake_mark_upload,
            commands::intake::intake_export,
            commands::intake::import_delta,
            commands::ocr::ocr_capture,
            commands::ocr::ocr_cancel_capture,
            commands::ocr::ocr_match,
            commands::library::create_bank,
            commands::library::save_question,
            commands::library::delete_question,
            commands::library::fork_bank,
            commands::library::delete_bank,
            commands::exchange::import_status,
            commands::exchange::import_jobs_list,
            commands::exchange::import_runs,
            commands::exchange::import_undo,
            commands::exchange::import_preview,
            commands::exchange::import_commit,
            commands::exchange::export_name,
            commands::exchange::export_bank,
            commands::library::rollback_bank,
            commands::library::history,
            commands::library::rebuild_index,
            commands::library::app_info,
            commands::exchange::download_template,
            commands::exchange::read_text_file,
            commands::library::save_benchmark
        ])
        .build(tauri::generate_context!())
        .expect("题库启动失败")
        .run(|app, event| {
            // Finder and Dock reuse the running process on macOS, so they do
            // not trigger the single-instance plugin's new-process callback.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                desktop::focus(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
