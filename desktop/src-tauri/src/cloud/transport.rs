use super::*;

pub fn request(
    origin: &str,
    path: &str,
    body: Option<Value>,
    token: Option<String>,
) -> Result<Value> {
    let url = reqwest::Url::parse(origin).map_err(|_| "服务地址无效")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("请填写不带路径的 HTTPS 服务地址".into());
    }
    if !allowed_path(path) {
        return Err("不支持的云端接口".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "网络初始化失败")?;
    let endpoint = format!("{}{}", origin.trim_end_matches('/'), path);
    let mut call = if let Some(body) = body {
        let text = serde_json::to_string(&body).map_err(err)?;
        if text.len() > 4 * 1024 * 1024 {
            return Err("请求超过 4 MiB".into());
        }
        client
            .post(endpoint)
            .header("content-type", "application/json")
            .body(text)
    } else {
        client.get(endpoint)
    };
    if let Some(t) = token {
        if t.len() > 4096 {
            return Err("会话无效".into());
        }
        call = call.bearer_auth(t);
    }
    let response = call
        .send()
        .map_err(|_| "NETWORK: 网络请求未完成，本地数据已保留，可重试")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "NETWORK: 云端响应未接收完整")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("云端响应超过大小限制".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "云端响应不是有效 JSON")?;
    Ok(json!({"status":status,"body":value}))
}

fn allowed_path(path: &str) -> bool {
    regex::Regex::new(r"^/(health|v1/(catalog|me|uploads|auth/(desktop|register|password-login|password-reset|refresh|logout)|maintainer-applications(/[0-9a-f-]{36}/decision)?|maintainer-accounts(/[0-9a-f-]{36}/(permissions|revoke|password-reset))?|banks/promote|banks/[0-9a-f-]{36}/(manifest|question-file|operations-file|rollback|seed)))$")
        .unwrap().is_match(path)
}

#[cfg(test)]
mod tests {
    use super::allowed_path;

    #[test]
    fn desktop_allows_current_maintenance_routes_only() {
        let id = "00000000-0000-4000-8000-000000000001";
        for path in [
            "/v1/maintainer-applications".to_string(),
            "/v1/maintainer-accounts".into(),
            format!("/v1/maintainer-applications/{id}/decision"),
            format!("/v1/maintainer-accounts/{id}/revoke"),
            format!("/v1/banks/{id}/question-file"),
            format!("/v1/banks/{id}/rollback"),
        ] {
            assert!(allowed_path(&path), "{path}");
        }
        for action in ["review", "publish", "candidates", "snapshot"] {
            assert!(!allowed_path(&format!("/v1/banks/{id}/{action}")));
        }
        assert!(!allowed_path("/v1/auth/wechat"));
        assert!(!allowed_path("/v1/maintainer-accounts/../revoke"));
    }
}
