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
    if !regex::Regex::new(r"^/(health|v1/(catalog|me|uploads|auth/desktop|banks/promote|banks/[0-9a-f-]{36}/(manifest|snapshot|snapshot-file|candidates|review|publish|seed)))$").unwrap().is_match(path){return Err("不支持的云端接口".into());}
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
