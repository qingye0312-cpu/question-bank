//! Software updates have a separate, build-time trust root from question banks.
use crate::model::{err, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

static INSTALLING: AtomicBool = AtomicBool::new(false);
pub fn settings(endpoint: &str, key: &str) -> Result<Option<(reqwest::Url, String)>> {
    if endpoint.is_empty() && key.is_empty() {
        return Ok(None);
    }
    let url = reqwest::Url::parse(endpoint).map_err(|_| "软件更新源配置无效")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("软件更新源必须使用 HTTPS 且不能包含账户信息".into());
    }
    let decoded = STANDARD
        .decode(key.trim())
        .map_err(|_| "更新签名公钥无效")?;
    let text = String::from_utf8(decoded).map_err(|_| "更新签名公钥无效")?;
    let raw = STANDARD
        .decode(text.lines().nth(1).unwrap_or(""))
        .map_err(|_| "更新签名公钥无效")?;
    if !text.starts_with("untrusted comment:")
        || raw.len() != 42
        || (raw[..2] != *b"Ed" && raw[..2] != *b"ED")
    {
        return Err("更新签名公钥无效".into());
    }
    Ok(Some((url, key.trim().into())))
}
fn configured() -> Result<Option<(reqwest::Url, String)>> {
    settings(
        option_env!("QBANK_UPDATER_ENDPOINT").unwrap_or(""),
        option_env!("QBANK_UPDATER_PUBLIC_KEY").unwrap_or(""),
    )
}
async fn latest(app: &AppHandle, download: bool) -> Result<Option<tauri_plugin_updater::Update>> {
    let (url, key) = configured()?.ok_or("此构建尚未配置软件更新源")?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(err)?
        .pubkey(key)
        .timeout(Duration::from_secs(if download { 300 } else { 15 }))
        .build()
        .map_err(err)?
        .check()
        .await
        .map_err(err)
}
#[tauri::command]
pub async fn software_update_check(app: AppHandle) -> Result<Value> {
    if configured()?.is_none() {
        return Ok(json!({"configured":false}));
    }
    Ok(match latest(&app, false).await? {
        Some(u) => json!({"configured":true,"version":u.version,"notes":u.body}),
        None => json!({"configured":true,"version":null}),
    })
}
#[tauri::command]
pub async fn software_update_install(app: AppHandle, version: String) -> Result<()> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("更新正在进行".into());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            INSTALLING.store(false, Ordering::SeqCst);
        }
    }
    let _reset = Reset;
    let update = latest(&app, true)
        .await?
        .ok_or("已没有可安装的更新，请重新检查")?;
    if update.version != version {
        return Err("更新版本已变化，请重新检查并确认".into());
    }
    let mut downloaded = 0_u64;
    // The upstream installer verifies the artifact signature before replacing the app.
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(
                    "software-update-progress",
                    json!({"downloaded":downloaded,"total":total}),
                );
            },
            || {},
        )
        .await
        .map_err(err)?;
    app.restart();
}
