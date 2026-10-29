//! Only the native process reads the remembered maintainer key. WebView storage
//! contains an opt-in flag, never the key. Entries are scoped to the HTTPS origin.
use crate::{cloud, model::*};
use serde_json::{json, Value};
const SERVICE: &str = "local.questionbank.desktop.maintainer";
fn account(origin: &str) -> Result<String> {
    let u = reqwest::Url::parse(origin).map_err(|_| "服务地址无效")?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("服务地址无效".into());
    }
    Ok(hash(u.origin().ascii_serialization().as_bytes()))
}
pub fn save(origin: &str, key: Option<String>) -> Result<()> {
    let id = account(origin)?;
    if let Some(ref value) = key {
        if value.len() < 16 || value.len() > 2048 || value.contains('\0') {
            return Err("维护者密钥格式无效".into());
        }
    }
    if key.is_some() {
        platform::save(&format!("{id}:password-refresh"), None)?;
    }
    platform::save(&id, key.as_deref())
}
pub fn save_refresh(origin: &str, refresh_token: Option<String>) -> Result<()> {
    let id = account(origin)?;
    if let Some(ref token) = refresh_token {
        if !token.starts_with("r1.") || token.len() > 128 || token.contains('\0') {
            return Err("登录续期凭据格式无效".into());
        }
        platform::save(&id, None)?;
    }
    platform::save(&format!("{id}:password-refresh"), refresh_token.as_deref())
}
pub fn login(origin: &str) -> Result<Value> {
    let key =
        platform::read(&account(origin)?)?.ok_or("本机没有保存此服务的维护者凭据，请重新登录")?;
    cloud::request(origin, "/v1/auth/desktop", Some(json!({"key":key})), None)
}
pub fn resume(origin: &str) -> Result<Value> {
    let id = account(origin)?;
    if let Some(refresh) = platform::read(&format!("{id}:password-refresh"))? {
        let mut response = cloud::request(
            origin,
            "/v1/auth/refresh",
            Some(json!({"refresh_token":refresh})),
            None,
        )?;
        let status = response["status"].as_u64().unwrap_or(0);
        if (200..300).contains(&status) {
            response["auth_type"] = json!("password");
            if let Some(body) = response.get_mut("body").and_then(Value::as_object_mut) {
                body.remove("refresh_token");
            }
            return Ok(response);
        }
        if status != 401 && status != 403 {
            return Ok(response);
        }
        platform::save(&format!("{id}:password-refresh"), None)?;
    }
    if let Some(key) = platform::read(&id)? {
        let mut response =
            cloud::request(origin, "/v1/auth/desktop", Some(json!({"key":key})), None)?;
        response["auth_type"] = json!("key");
        return Ok(response);
    }
    Ok(
        json!({"status":401,"auth_type":"","body":{"error":{"message":"本机没有保存登录凭据，请使用手机号和密码登录"}}}),
    )
}
pub fn logout(origin: &str) -> Result<()> {
    let id = account(origin)?;
    if let Some(refresh) = platform::read(&format!("{id}:password-refresh"))? {
        let _ = cloud::request(
            origin,
            "/v1/auth/logout",
            Some(json!({"refresh_token":refresh})),
            None,
        );
    }
    platform::save(&id, None)?;
    platform::save(&format!("{id}:password-refresh"), None)
}
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    pub fn save(id: &str, key: Option<&str>) -> Result<()> {
        match key {
            Some(k) => set_generic_password(SERVICE, id, k.as_bytes())
                .map_err(|_| "无法保存到系统钥匙串，请使用本次会话登录".into()),
            None => match delete_generic_password(SERVICE, id) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == -25300 => Ok(()),
                Err(_) => Err("系统钥匙串凭据移除失败".into()),
            },
        }
    }
    pub fn read(id: &str) -> Result<Option<String>> {
        match get_generic_password(SERVICE, id) {
            Ok(k) => String::from_utf8(k)
                .map(Some)
                .map_err(|_| "系统凭据无效".into()),
            Err(e) if e.code() == -25300 => Ok(None),
            Err(_) => Err("无法读取系统钥匙串，请手动登录".into()),
        }
    }
}
#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{Foundation::ERROR_NOT_FOUND, Security::Credentials::*},
    };
    fn target(id: &str) -> Vec<u16> {
        format!("{SERVICE}/{id}")
            .encode_utf16()
            .chain(Some(0))
            .collect()
    }
    pub fn save(id: &str, key: Option<&str>) -> Result<()> {
        let mut name = target(id);
        unsafe {
            if let Some(k) = key {
                let mut blob = k.as_bytes().to_vec();
                let c = CREDENTIALW {
                    Type: CRED_TYPE_GENERIC,
                    TargetName: PWSTR(name.as_mut_ptr()),
                    CredentialBlobSize: blob.len() as u32,
                    CredentialBlob: blob.as_mut_ptr(),
                    Persist: CRED_PERSIST_LOCAL_MACHINE,
                    ..Default::default()
                };
                CredWriteW(&c, 0).map_err(|_| "无法保存到 Windows 凭据管理器".to_string())
            } else {
                match CredDeleteW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None) {
                    Ok(()) => Ok(()),
                    Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
                    Err(_) => Err("系统凭据移除失败".into()),
                }
            }
        }
    }
    pub fn read(id: &str) -> Result<Option<String>> {
        let name = target(id);
        let mut ptr = std::ptr::null_mut();
        unsafe {
            match CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut ptr) {
                Ok(()) => {
                    let c = &*ptr;
                    let bytes = if c.CredentialBlobSize == 0 {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
                            .to_vec()
                    };
                    CredFree(ptr.cast());
                    String::from_utf8(bytes)
                        .map(Some)
                        .map_err(|_| "系统凭据无效".into())
                }
                Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
                Err(_) => Err("无法读取 Windows 凭据管理器，请手动登录".into()),
            }
        }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn save(_: &str, _: Option<&str>) -> Result<()> {
        Err("此平台尚不支持安全保存维护者凭据".into())
    }
    pub fn read(_: &str) -> Result<Option<String>> {
        Ok(None)
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn windows_credential_store_roundtrip_is_scoped_and_removable() {
        // Synthetic, unique target: never read or overwrite a user's credential.
        let origin = format!("https://qbank-test-{}.invalid", uuid::Uuid::new_v4());
        let id = account(&origin).unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = platform::save(&self.0, None);
            }
        }
        let _cleanup = Cleanup(id.clone());
        assert_eq!(platform::read(&id).unwrap(), None);
        assert!(save(&origin, Some("too-short".into())).is_err());
        save(&origin, Some("synthetic-windows-test-key-one".into())).unwrap();
        assert_eq!(
            platform::read(&id).unwrap().as_deref(),
            Some("synthetic-windows-test-key-one")
        );
        save(&origin, Some("synthetic-windows-test-key-two".into())).unwrap();
        assert_eq!(
            platform::read(&id).unwrap().as_deref(),
            Some("synthetic-windows-test-key-two")
        );
        save(&origin, None).unwrap();
        assert_eq!(platform::read(&id).unwrap(), None);
        save(&origin, None).unwrap();
        assert!(account("http://qbank-test.invalid").is_err());
        assert!(account("https://qbank-test.invalid/path").is_err());
    }
}
