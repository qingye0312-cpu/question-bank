use super::*;
#[tauri::command]
pub(crate) async fn cloud_recover_legacy(
    s: State<'_, AppState>,
    bank_id: String,
    endpoint: String,
    actor: String,
) -> Result<usize> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::cloud::recover_legacy(&d, &bank_id, &endpoint, &actor)
    })
    .await
}

#[tauri::command]
pub(crate) async fn promotion_tasks(s: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || promotion::list(&d)).await
}
#[tauri::command]
pub(crate) async fn promotion_prepare(
    s: State<'_, AppState>,
    bank_id: String,
    origin: String,
    actor: String,
    version: i64,
) -> Result<serde_json::Value> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        promotion::prepare(&d, &bank_id, &origin, &actor, version)
    })
    .await
}
#[tauri::command]
pub(crate) async fn client_state(
    s: State<'_, AppState>,
    key: String,
    value: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::cloud::client_state(&d, &key, value)
    })
    .await
}
#[tauri::command]
pub(crate) async fn credential_save(origin: String, key: Option<String>) -> Result<()> {
    blocking(move || credentials::save(&origin, key)).await
}
#[tauri::command]
pub(crate) async fn credential_login(origin: String) -> Result<serde_json::Value> {
    blocking(move || credentials::login(&origin)).await
}
#[tauri::command]
pub(crate) async fn cloud_request(
    origin: String,
    path: String,
    body: Option<serde_json::Value>,
    token: Option<String>,
) -> Result<serde_json::Value> {
    blocking(move || crate::cloud::request(&origin, &path, body, token)).await
}
#[tauri::command]
pub(crate) async fn cloud_transfer(
    s: State<'_, AppState>,
    batch_id: String,
    endpoint: String,
) -> Result<serde_json::Value> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::cloud::transfer(&d, &batch_id, &endpoint)
    })
    .await
}
#[tauri::command]
pub(crate) async fn cloud_receipt(
    s: State<'_, AppState>,
    batch_id: String,
    receipt: serde_json::Value,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::cloud::acknowledge(&d, &batch_id, receipt)
    })
    .await
}
#[tauri::command]
pub(crate) async fn cloud_versions(s: State<'_, AppState>) -> Result<Vec<serde_json::Value>> {
    let d = s.store.clone();
    blocking(move || crate::cloud::versions(&d)).await
}
#[tauri::command]
pub(crate) async fn cloud_apply(
    s: State<'_, AppState>,
    payload: String,
    sha256: String,
) -> Result<()> {
    let d = s.store.clone();
    let lock = s.writes.clone();
    blocking(move || {
        let _g = lock.lock().map_err(err)?;
        crate::cloud::apply(&d, &payload, &sha256)
    })
    .await
}
