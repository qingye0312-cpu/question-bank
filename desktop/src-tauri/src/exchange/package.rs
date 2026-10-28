use super::*;
use std::io::Cursor;
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
