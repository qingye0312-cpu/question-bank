use super::*;
pub(super) fn zip_entry(
    z: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>> {
    let f = z.by_name(name).map_err(err)?;
    if f.size() > limit {
        return Err(format!("{name} 解压大小超限"));
    }
    let mut bytes = Vec::new();
    f.take(limit + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err("解压大小超限".into());
    }
    Ok(bytes)
}
pub(super) fn inspect_zip(z: &mut ZipArchive<Cursor<&[u8]>>) -> Result<()> {
    if z.len() > 10000 {
        return Err("压缩包条目过多".into());
    }
    let mut total = 0u64;
    let mut seen = HashSet::new();
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(err)?;
        if f.enclosed_name().is_none()
            || f.name().contains('\\')
            || !seen.insert(f.name().to_string())
        {
            return Err("压缩包存在不安全或重复路径".into());
        }
        if f.unix_mode()
            .map(|m| m & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("压缩包不能含符号链接".into());
        }
        total = total.checked_add(f.size()).ok_or("压缩包大小溢出")?;
        if total > MAX_PAYLOAD {
            return Err("解压后超过 512 MB，请拆分文件".into());
        }
    }
    Ok(())
}
pub fn export_name(bank: &Bank, qs: &[Question]) -> Result<String> {
    let digest = hash(&jsonl(qs)?);
    if bank
        .result_content_hash
        .as_deref()
        .or(bank.release_id.as_deref())
        == Some(&digest)
    {
        if let Some(name) = &bank.release_name {
            return Ok(name.clone());
        }
    }
    Ok(result_name(
        Some(&bank.updated_at),
        &bank.name,
        "本地汇总",
        &format!("v{}", bank.version),
        &bank.id,
        &digest,
    ))
}
pub fn package_bytes(bank: &Bank, qs: &[Question]) -> Result<Vec<u8>> {
    if qs.is_empty() {
        return Err("空题库不能制作发布包，请先添加或导入题目".into());
    }
    let payload = jsonl(qs)?;
    let digest = hash(&payload);
    let matches_result = bank
        .result_content_hash
        .as_deref()
        .or(bank.release_id.as_deref())
        == Some(&digest);
    let merged_at = if matches_result {
        bank.merged_at.clone()
    } else {
        None
    };
    let release_name = Some(export_name(bank, qs)?);
    let manifest = Manifest {
        schema_version: "1.0".into(),
        bank_id: bank.id.clone(),
        name: bank.name.clone(),
        release_id: hash(&payload),
        release_version: bank.version,
        published_at: bank.updated_at.clone(),
        merged_at,
        release_name,
        min_app_version: if qs.iter().any(|q| q.schema_version == "1.1") {
            "0.2.7"
        } else {
            "0.1.0"
        }
        .into(),
        question_count: qs.len(),
        files: vec![PackageFile {
            path: "questions.jsonl".into(),
            sha256: hash(&payload),
            size: payload.len() as u64,
        }],
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(err)?;
    if (payload.len() + manifest_bytes.len()) as u64 > MAX_PAYLOAD {
        return Err("题库包内容超过 512 MB，请按题库拆分后发布".into());
    }
    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("manifest.json", manifest_bytes),
        ("questions.jsonl", payload),
    ] {
        z.start_file(
            name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(err)?;
        z.write_all(&bytes).map_err(err)?;
    }
    let output = z.finish().map_err(err)?.into_inner();
    if output.len() as u64 > MAX_FILE {
        return Err("题库包超过 256 MB，请按题库拆分后发布".into());
    }
    Ok(output)
}
pub(super) fn read_package(
    bytes: &[u8],
    errors: &mut Vec<String>,
) -> Result<(Manifest, Vec<Question>)> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    inspect_zip(&mut z)?;
    if z.len() != 2 {
        return Err("题库包必须只包含 manifest.json 和 questions.jsonl；附件扩展尚未启用".into());
    }
    let m: Manifest =
        serde_json::from_slice(&zip_entry(&mut z, "manifest.json", 1024 * 1024)?).map_err(err)?;
    if m.schema_version != "1.0" || !["0.1.0", "0.2.7"].contains(&m.min_app_version.as_str()) {
        return Err("题库包要求另一版本的程序或协议，请更新后重试".into());
    }
    if uuid::Uuid::parse_str(&m.bank_id).is_err()
        || m.release_version <= 0
        || m.name.trim().is_empty()
    {
        return Err("题库包身份或版本无效".into());
    }
    if m.files.len() != 1 || m.files[0].path != "questions.jsonl" {
        return Err("文件清单不符合 v1 规范".into());
    }
    let data = zip_entry(&mut z, "questions.jsonl", MAX_PAYLOAD)?;
    if hash(&data) != m.files[0].sha256
        || hash(&data) != m.release_id
        || data.len() as u64 != m.files[0].size
    {
        return Err("题库包校验失败：内容可能损坏或被更改".into());
    }
    let qs = parse_jsonl(&data, errors);
    if qs.len() != m.question_count {
        return Err("清单题目数量与实际内容不一致".into());
    }
    Ok((m, qs))
}
