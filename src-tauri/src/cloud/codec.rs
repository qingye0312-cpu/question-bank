use super::*;
pub fn encode(raw: &str) -> Result<Value> {
    if raw.len() > 4 * 1024 * 1024 {
        return Err("增量包超过 4 MiB".into());
    }
    let delta: intake::Delta = serde_json::from_str(raw).map_err(err)?;
    if delta.question_count > 1000 {
        return Err("一次上传最多 1000 题；本地记录已保留，不会自动拆包".into());
    }
    let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
    gzip.write_all(raw.as_bytes()).map_err(err)?;
    let data = gzip.finish().map_err(err)?;
    if data.len() > 512 * 1024 {
        return Err("增量包压缩后超过 512 KiB".into());
    }
    Ok(
        json!({"format":"qbank-upload-1","encoding":"gzip+base64","uncompressed_size":raw.len(),"sha256":hash(raw.as_bytes()),"data":STANDARD.encode(data)}),
    )
}
pub fn decode(bytes: &[u8]) -> Result<Vec<u8>> {
    let value: Value = serde_json::from_slice(bytes).map_err(err)?;
    if value["format"] != "qbank-upload-1" {
        return Ok(bytes.to_vec());
    }
    let size = value["uncompressed_size"]
        .as_u64()
        .ok_or("压缩包大小无效")?;
    if value["encoding"] != "gzip+base64" || size == 0 || size > 4 * 1024 * 1024 {
        return Err("压缩包格式或大小无效".into());
    }
    let encoded = value["data"].as_str().ok_or("Base64 无效")?;
    if encoded.len() > 700000 {
        return Err("压缩包过大".into());
    }
    let data = STANDARD.decode(encoded).map_err(|_| "Base64 无效")?;
    if data.len() > 512 * 1024 || STANDARD.encode(&data) != encoded {
        return Err("Base64 格式或大小无效".into());
    }
    let mut raw = Vec::new();
    let mut decoder = GzDecoder::new(data.as_slice());
    (&mut decoder)
        .take(size + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "压缩包损坏")?;
    if !decoder.get_ref().is_empty() {
        return Err("压缩包含多余数据或多个 gzip 成员".into());
    }
    if raw.len() as u64 != size || value["sha256"].as_str() != Some(&hash(&raw)) {
        return Err("压缩包摘要或大小不一致".into());
    }
    Ok(raw)
}
