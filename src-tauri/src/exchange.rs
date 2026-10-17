use crate::{
    db::{self, Store},
    model::*,
};
use calamine::{Data, Reader, Xlsx};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

pub const HEADERS: [&str; 21] = [
    "外部编号",
    "题型",
    "题库",
    "章节",
    "题干",
    "选项A",
    "选项B",
    "选项C",
    "选项D",
    "选项E",
    "选项F",
    "选项G",
    "选项H",
    "答案",
    "解析",
    "标签",
    "难度",
    "适用版本",
    "来源说明",
    "系统ID",
    "基准修订号",
];
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_PAYLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: String,
    pub bank_id: String,
    pub name: String,
    pub release_id: String,
    pub release_version: i64,
    pub published_at: String,
    pub min_app_version: String,
    pub question_count: usize,
    pub files: Vec<PackageFile>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PackageFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Preview {
    pub token: String,
    pub filename: String,
    pub name: String,
    pub count: usize,
    pub review_count: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub samples: Vec<Question>,
    pub package: bool,
    pub action: String,
    pub added: usize,
    pub changed: usize,
    pub removed: usize,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Pending {
    pub preview: Preview,
    pub questions: Vec<Question>,
    pub manifest: Option<Manifest>,
    pub fingerprint: String,
    pub target: String,
    pub target_version: Option<i64>,
}

pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path).map_err(err)?.len() > MAX_FILE {
        return Err("文件超过 256 MB，请拆分后导入".into());
    }
    std::fs::read(path).map_err(err)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("无效保存路径")?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    tmp.write_all(bytes).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    tmp.persist(path).map_err(err)?;
    Ok(())
}
fn jsonl(qs: &[Question]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for q in qs {
        serde_json::to_writer(&mut out, q).map_err(err)?;
        out.push(b'\n');
    }
    Ok(out)
}
fn parse_jsonl(bytes: &[u8], errors: &mut Vec<String>) -> Vec<Question> {
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            errors.push("JSONL 必须使用 UTF-8 编码".into());
            return Vec::new();
        }
    };
    text.trim_start_matches('\u{feff}')
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .filter_map(|(i, l)| {
            if l.len() > 1_000_000 {
                errors.push(format!("第 {} 行超过 1 MB", i + 1));
                return None;
            }
            // Missing schema/answer must not silently become valid new records.
            match serde_json::from_str::<Value>(l) {
                Ok(v)
                    if v.get("question_id")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                        && v.get("base_revision").is_none() =>
                {
                    errors.push(format!("第 {} 行：带系统 ID 的题目必须带基准修订号", i + 1));
                    None
                }
                Ok(v) if v.get("schema_version").is_some() && v.get("answer").is_some() => {
                    match serde_json::from_value(v) {
                        Ok(q) => Some(q),
                        Err(e) => {
                            errors.push(format!("第 {} 行：{e}", i + 1));
                            None
                        }
                    }
                }
                Ok(_) => {
                    errors.push(format!("第 {} 行缺少 schema_version 或答案", i + 1));
                    None
                }
                Err(e) => {
                    errors.push(format!("第 {} 行：{e}", i + 1));
                    None
                }
            }
        })
        .collect()
}
fn zip_entry(z: &mut ZipArchive<Cursor<&[u8]>>, name: &str, limit: u64) -> Result<Vec<u8>> {
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
fn inspect_zip(z: &mut ZipArchive<Cursor<&[u8]>>) -> Result<()> {
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
pub fn package_bytes(bank: &Bank, qs: &[Question]) -> Result<Vec<u8>> {
    if qs.is_empty() {
        return Err("空题库不能制作发布包，请先添加或导入题目".into());
    }
    let payload = jsonl(qs)?;
    let manifest = Manifest {
        schema_version: "1.0".into(),
        bank_id: bank.id.clone(),
        name: bank.name.clone(),
        release_id: hash(&payload),
        release_version: bank.version,
        published_at: now(),
        min_app_version: "0.1.0".into(),
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
fn read_package(bytes: &[u8], errors: &mut Vec<String>) -> Result<(Manifest, Vec<Question>)> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    inspect_zip(&mut z)?;
    if z.len() != 2 {
        return Err("题库包必须只包含 manifest.json 和 questions.jsonl；附件扩展尚未启用".into());
    }
    let m: Manifest =
        serde_json::from_slice(&zip_entry(&mut z, "manifest.json", 1024 * 1024)?).map_err(err)?;
    if m.schema_version != "1.0" || m.min_app_version != "0.1.0" {
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

pub fn preview(store: &Store, path: &Path, target: &str) -> Result<Pending> {
    preview_controlled(store, path, target, &crate::import_jobs::Control::default())
}
pub fn preview_controlled(
    store: &Store,
    path: &Path,
    target: &str,
    control: &crate::import_jobs::Control,
) -> Result<Pending> {
    control.step("读取文件", 0, 1)?;
    let bytes = read_file(path)?;
    control.step("解析文件", 0, 1)?;
    let fingerprint = hash(&bytes);
    let filename = path
        .file_name()
        .ok_or("无效文件名")?
        .to_string_lossy()
        .to_string();
    let mut errors = vec![];
    let mut warnings = vec![];
    let mut manifest = None;
    let mut qs = if filename.to_lowercase().ends_with(".qbank.zip") {
        let (m, q) = read_package(&bytes, &mut errors)?;
        manifest = Some(m);
        q
    } else if filename.to_lowercase().ends_with(".jsonl") {
        parse_jsonl(&bytes, &mut errors)
    } else if filename.to_lowercase().ends_with(".docx") {
        read_docx(&bytes, &mut errors)?
    } else if filename.to_lowercase().ends_with(".xlsx") {
        read_xlsx(&bytes, &mut errors)?
    } else {
        return Err("请选择标准 .xlsx、.docx、.jsonl 或 .qbank.zip 文件".into());
    };
    let mut seen = HashSet::new();
    let count = qs.len();
    for (i, q) in qs.iter_mut().enumerate() {
        if i % 100 == 0 {
            control.step("校验题目", i, count)?;
        }
        if manifest.is_some() && q.question_id.is_empty() {
            errors.push(format!("第 {} 题缺少系统 ID", i + 1));
        }
        if let Err(e) = q.validate(q.status == "needs_review" && !q.sources.is_empty()) {
            errors.push(format!("第 {} 题 {}：{e}", i + 1, q.external_id));
        }
        q.prepare();
        if !seen.insert(q.question_id.clone()) {
            errors.push(format!("第 {} 题系统 ID 重复", i + 1));
        }
    }
    if qs.is_empty() {
        errors.push("没有可导入的题目；Excel 只读取「题目」工作表".into());
    }
    let mut target_id = manifest
        .as_ref()
        .map(|m| m.bank_id.clone())
        .unwrap_or(target.into());
    if manifest.is_none() && target_id.is_empty() {
        target_id = store
            .conn()?
            .query_row(
                "SELECT bank_id FROM imports WHERE fingerprint=?1 ORDER BY at DESC LIMIT 1",
                [&fingerprint],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .unwrap_or_default();
    }
    let existing = store.banks()?.into_iter().find(|b| b.id == target_id);
    let name = manifest
        .as_ref()
        .map(|m| m.name.clone())
        .or_else(|| existing.as_ref().map(|b| b.name.clone()))
        .unwrap_or_else(|| {
            qs.first()
                .filter(|q| !q.bank.is_empty())
                .map(|q| q.bank.clone())
                .unwrap_or_else(|| filename.clone())
        });
    if name.trim().is_empty() || name.chars().count() > 100 {
        errors.push("题库名称须为 1 至 100 字，请修改文件中的题库字段或选择已有题库".into());
    }
    let mut action = if manifest.is_some() {
        "导入只读发布题库"
    } else if existing.is_some() {
        "导入当前可编辑题库"
    } else {
        "建立可编辑题库"
    }
    .to_string();
    let mut added = qs.len();
    let mut changed = 0;
    let mut removed = 0;
    if let Some(b) = &existing {
        if manifest.is_some()
            && store
                .conn()?
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM cloud_snapshots WHERE bank_id=?1)",
                    [&b.id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(err)?
        {
            errors.push(
                "本题库已由云端维护，请在云端发布新版或建立独立副本；不能用离线全量包覆盖同步状态"
                    .into(),
            );
        }
        let old: HashMap<String, Question> = store
            .questions(&b.id)?
            .into_iter()
            .map(|q| (q.question_id.clone(), q))
            .collect();
        added = 0;
        for q in &qs {
            if let Some(previous) = old.get(&q.question_id) {
                if serde_json::to_value(q).map_err(err)?
                    != serde_json::to_value(previous).map_err(err)?
                {
                    changed += 1;
                }
                if manifest.is_none() && q.base_revision != previous.base_revision {
                    errors.push(format!("{} 的基准修订号过期", q.external_id));
                }
            } else {
                added += 1;
            }
        }
        if let Some(m) = &manifest {
            let local_ids = crate::intake::local_question_ids(&store.conn()?, &b.id)?;
            removed = old
                .keys()
                .filter(|k| !seen.contains(*k) && !local_ids.contains(*k))
                .count();
            let current_hash = hash(&jsonl(&store.questions(&b.id)?)?);
            if m.release_version == b.version && m.release_id == current_hash {
                action = "已存在，跳过重复导入".into();
                added = 0;
                changed = 0;
                removed = 0;
            } else if m.release_version <= b.version {
                errors.push("该题库已存在相同或更高版本；请使用回退操作或建立新副本".into());
            } else if !b.read_only {
                errors.push("同 ID 的题库在本机可编辑，不能用发布包覆盖；请在阅读端导入".into());
            } else {
                action = format!("更新发布版本 v{} → v{}", b.version, m.release_version);
            }
        } else if b.read_only {
            errors.push("当前题库只读，请选择可编辑题库或另建副本".into());
        }
        if manifest.is_none() {
            let exists: bool = store
                .conn()?
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM imports WHERE fingerprint=?1 AND bank_id=?2)",
                    params![fingerprint, b.id],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if exists {
                action = "已存在，跳过重复导入".into();
                added = 0;
                changed = 0;
            }
        }
    }
    let review_count = qs.iter().filter(|q| q.status == "needs_review").count();
    if review_count > 0 {
        warnings.push(format!(
            "包含 {review_count} 道历史待核对记录，来源元数据将保留"
        ));
    }
    warnings.push("校验仅检查结构，不自动证明知识答案正确。".into());
    let p = Preview {
        token: uid(),
        filename,
        name,
        count: qs.len(),
        review_count,
        errors,
        warnings,
        samples: qs.iter().take(3).cloned().collect(),
        package: manifest.is_some(),
        action,
        added,
        changed,
        removed,
    };
    control.step("预览就绪", count, count)?;
    Ok(Pending {
        preview: p,
        questions: qs,
        manifest,
        fingerprint,
        target: target_id,
        target_version: existing.map(|b| b.version),
    })
}

pub fn commit(store: &Store, p: &Pending) -> Result<String> {
    commit_controlled(store, p, &crate::import_jobs::Control::default())
}
pub fn commit_controlled(
    store: &Store,
    p: &Pending,
    control: &crate::import_jobs::Control,
) -> Result<String> {
    control.step("准备导入", 0, p.questions.len())?;
    if !p.preview.errors.is_empty() {
        return Err("导入校验尚未通过".into());
    }
    if p.preview.action == "已存在，跳过重复导入" {
        store
            .conn()?
            .execute("DELETE FROM import_jobs WHERE token=?1", [&p.preview.token])
            .map_err(err)?;
        return Ok(p.target.clone());
    }
    let id = if p.target.is_empty() {
        uid()
    } else {
        p.target.clone()
    };
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let actual: Option<i64> = tx
        .query_row("SELECT version FROM banks WHERE id=?1", [&id], |r| r.get(0))
        .optional()
        .map_err(err)?;
    if actual != p.target_version {
        return Err("题库在预览后发生变化，请重新导入预览".into());
    }
    let before = crate::import_jobs::rows(&tx, &id)?;
    if actual.is_some() {
        let bank = db::get_bank(&tx, &id)?;
        db::snapshot(&tx, &bank)?;
    }
    if let Some(m) = &p.manifest {
        let additions = if actual.is_some() {
            crate::intake::preserve_additions(&tx, &id, &p.questions)?
        } else {
            vec![]
        };
        if actual.is_some() {
            db::clear_bank(&tx, &id)?;
        }
        tx.execute("INSERT INTO banks VALUES(?1,?2,1,?3,?4,?5,'离线发布包') ON CONFLICT(id) DO UPDATE SET name=excluded.name,read_only=1,version=excluded.version,updated_at=excluded.updated_at,content_hash=excluded.content_hash",params![id,m.name,m.release_version,m.published_at,m.release_id]).map_err(err)?;
        for (i, q) in p.questions.iter().enumerate() {
            if i % 100 == 0 {
                control.step("写入题目与索引", i, p.questions.len())?;
            }
            db::insert(&tx, &id, q)?;
        }
        for q in &additions {
            db::insert(&tx, &id, q)?;
        }
    } else {
        if actual.is_none() {
            tx.execute(
                "INSERT INTO banks VALUES(?1,?2,0,1,?3,'',?4)",
                params![id, p.preview.name, now(), p.preview.filename],
            )
            .map_err(err)?;
        }
        for (i, original) in p.questions.iter().enumerate() {
            if i % 100 == 0 {
                control.step("写入题目与索引", i, p.questions.len())?;
            }
            let mut q = original.clone();
            q.bank = p.preview.name.clone();
            let old: Option<(i64, String)> = tx
                .query_row(
                    "SELECT rowid,data FROM questions WHERE bank_id=?1 AND id=?2",
                    params![id, q.question_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(err)?;
            if let Some((rowid, data)) = old {
                let previous: Question = serde_json::from_str(&data).map_err(err)?;
                if previous.base_revision != q.base_revision {
                    return Err("修订号已变化，请重新预览".into());
                }
                if serde_json::to_value(&previous).map_err(err)?
                    == serde_json::to_value(&q).map_err(err)?
                {
                    continue;
                }
                let frozen:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM intake_entries e JOIN intake_transfers t ON t.batch_id=e.batch_id WHERE e.bank_id=?1 AND e.question_id=?2)",params![id,q.question_id],|r|r.get(0)).map_err(err)?;
                if frozen {
                    return Err("本题已导出或提交，不能用文件修改原批次".into());
                }
                db::record(&tx, &id, &previous, "文件导入更新")?;
                q.base_revision += 1;
                db::remove_index(&tx, rowid)?;
                tx.execute("DELETE FROM questions WHERE rowid=?1", [rowid])
                    .map_err(err)?;
            }
            db::insert(&tx, &id, &q)?;
            tx.execute(
                "UPDATE intake_originals SET data=?1,deleted=0 WHERE bank_id=?2 AND question_id=?3",
                params![serde_json::to_string(&q).map_err(err)?, id, q.question_id],
            )
            .map_err(err)?;
        }
        if actual.is_some() {
            db::touch(&tx, &id)?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO imports VALUES(?1,?2,?3)",
        params![p.fingerprint, id, now()],
    )
    .map_err(err)?;
    tx.execute("UPDATE snapshots SET expected_version=(SELECT version FROM banks WHERE id=?1) WHERE bank_id=?1",[&id]).map_err(err)?;
    control.step("保存撤回记录", p.questions.len(), p.questions.len())?;
    crate::import_jobs::record(&tx, &id, &p.preview.filename, &p.fingerprint, &before)?;
    tx.execute("DELETE FROM import_jobs WHERE token=?1", [&p.preview.token])
        .map_err(err)?;
    control.step("提交事务", p.questions.len(), p.questions.len())?;
    tx.commit().map_err(err)?;
    Ok(id)
}

pub fn export(store: &Store, id: &str, path: &Path, format: &str) -> Result<usize> {
    export_filtered(store, id, path, format, None)
}
pub fn export_filtered(
    store: &Store,
    id: &str,
    path: &Path,
    format: &str,
    filter: Option<db::Query>,
) -> Result<usize> {
    let c = store.conn()?;
    c.execute_batch("BEGIN DEFERRED").map_err(err)?;
    let qs = if let Some(mut query) = filter {
        if format == "package" {
            return Err(
                "离线发布包必须包含完整题库，请选择 Word、Excel 或 JSONL 导出筛选结果".into(),
            );
        }
        query.bank_id = id.into();
        query.trash = false;
        query.after_rowid = 0;
        let mut found = vec![];
        loop {
            let result = store.search_conn(&c, &query)?;
            if result.items.is_empty() {
                break;
            }
            query.after_rowid = result.items.last().unwrap().rowid;
            found.extend(result.items.into_iter().map(|h| h.question));
            if !result.has_more {
                break;
            }
        }
        found
    } else {
        db::questions(&c, id)?
    };
    let bank = db::get_bank(&c, id)?;
    let bytes = match format {
        "package" => package_bytes(&bank, &qs)?,
        "jsonl" => jsonl(&qs)?,
        "docx" => write_docx(&bank.name, &qs)?,
        "docx-study" | "docx-exam" | "docx-answers" => write_print_docx(&bank.name, &qs, format)?,
        "xlsx" => write_xlsx(&bank.name, &qs)?,
        _ => return Err("未知导出格式".into()),
    };
    c.execute_batch("COMMIT").map_err(err)?;
    atomic_write(path, &bytes)?;
    Ok(qs.len())
}

fn from_fields(fields: &HashMap<String, String>) -> Result<Question> {
    let get = |k: &str| fields.get(k).cloned().unwrap_or_default();
    let kind = match get("题型").as_str() {
        "单选" => "single",
        "多选" => "multiple",
        "判断" => "true_false",
        _ => return Err("题型必须为单选、多选、判断".into()),
    };
    let options: Vec<Choice> = "ABCDEFGH"
        .chars()
        .filter_map(|k| {
            let content = get(&format!("选项{k}"));
            if content.is_empty() {
                None
            } else {
                Some(Choice {
                    key: k.to_string(),
                    content,
                    option_id: String::new(),
                })
            }
        })
        .collect();
    let a = get("答案");
    let answer = if a.is_empty() && !get("记录元数据").is_empty() {
        Value::Null
    } else if kind == "true_false" {
        match a.as_str() {
            "正确" => json!(true),
            "错误" => json!(false),
            _ => return Err("判断答案须写正确或错误".into()),
        }
    } else {
        json!(a.split('|').filter(|s| !s.is_empty()).collect::<Vec<_>>())
    };
    let id = get("系统ID");
    let rev = get("基准修订号");
    if !id.is_empty() && rev.is_empty() {
        return Err("更新题目必须带基准修订号".into());
    }
    let mut q:Question=serde_json::from_value(json!({"schema_version":"1.0","question_id":id,"base_revision":if rev.is_empty(){1}else{rev.parse::<u64>().map_err(|_|"基准修订号必须是正整数")?},"type":kind,"stem":get("题干"),"options":options,"answer":answer,"external_id":get("外部编号"),"bank":get("题库"),"chapter":get("章节"),"explanation":get("解析"),"tags":get("标签").split('|').filter(|s|!s.is_empty()).collect::<Vec<_>>(),"difficulty":match get("难度").as_str(){""=>"","简单"=>"easy","中等"=>"medium","困难"=>"hard",_=>return Err("难度不合法".into())},"applicable_version":get("适用版本"),"source_note":get("来源说明")})).map_err(err)?;
    let metadata = get("记录元数据");
    if !metadata.is_empty() {
        let m: Value =
            serde_json::from_str(&metadata).map_err(|_| "记录元数据损坏，请从系统重新导出")?;
        q.sources = serde_json::from_value(m["sources"].clone()).map_err(err)?;
        q.issues = serde_json::from_value(m["issues"].clone()).map_err(err)?;
        q.status = m["status"].as_str().ok_or("状态元数据无效")?.to_string();
        if let Some(ids) = m["option_ids"].as_array() {
            for (o, id) in q.options.iter_mut().zip(ids) {
                o.option_id = id.as_str().unwrap_or_default().to_string();
            }
        }
    }
    Ok(q)
}
fn fields(q: &Question) -> Vec<(String, String)> {
    let mut vals = vec![
        q.external_id.clone(),
        match q.kind.as_str() {
            "single" => "单选",
            "multiple" => "多选",
            _ => "判断",
        }
        .into(),
        q.bank.clone(),
        q.chapter.clone(),
        q.stem.clone(),
    ];
    for k in "ABCDEFGH".chars() {
        vals.push(
            q.options
                .iter()
                .find(|o| o.key == k.to_string())
                .map(|o| o.content.clone())
                .unwrap_or_default(),
        );
    }
    vals.extend([
        if let Some(b) = q.answer.as_bool() {
            if b { "正确" } else { "错误" }.into()
        } else {
            q.answer
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("|")
                })
                .unwrap_or_default()
        },
        q.explanation.clone(),
        q.tags.join("|"),
        match q.difficulty.as_str() {
            "easy" => "简单",
            "medium" => "中等",
            "hard" => "困难",
            _ => "",
        }
        .into(),
        q.applicable_version.clone(),
        q.source_note.clone(),
        q.question_id.clone(),
        q.base_revision.to_string(),
    ]);
    let mut out: Vec<_> = HEADERS.iter().map(|s| s.to_string()).zip(vals).collect();
    out.push(("记录元数据".into(),json!({"sources":q.sources,"issues":q.issues,"status":q.status,"option_ids":q.options.iter().map(|o|&o.option_id).collect::<Vec<_>>()} ).to_string()));
    out
}
fn xml_text(n: roxmltree::Node) -> String {
    n.descendants()
        .filter(|n| n.is_element())
        .filter_map(|n| match n.tag_name().name() {
            "t" => Some(n.text().unwrap_or("").to_string()),
            "br" | "cr" => Some("\n".into()),
            "tab" => Some("\t".into()),
            _ => None,
        })
        .collect()
}
fn read_docx(bytes: &[u8], errors: &mut Vec<String>) -> Result<Vec<Question>> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    inspect_zip(&mut z)?;
    if z.file_names()
        .any(|n| n.contains("media/") || n.contains("embeddings/") || n.contains("vbaProject"))
    {
        return Err("Word 含图片、嵌入对象或宏，此版本不支持，请保留原文件".into());
    }
    let data = zip_entry(&mut z, "word/document.xml", MAX_PAYLOAD)?;
    let xml = std::str::from_utf8(&data).map_err(err)?;
    let doc = roxmltree::Document::parse(xml).map_err(err)?;
    if doc.descendants().any(|n| {
        n.is_element()
            && ["oMath", "drawing", "pict", "altChunk", "ins", "del"].contains(&n.tag_name().name())
    }) {
        return Err("Word 含图片、公式、修订或复杂对象，不能静默忽略，请先处理后导入".into());
    }
    let mut qs = vec![];
    let mut schema = false;
    let mut default_bank = String::new();
    for (i, t) in doc
        .descendants()
        .filter(|n| {
            n.has_tag_name((
                "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                "tbl",
            ))
        })
        .enumerate()
    {
        if t.ancestors().skip(1).any(|a| a.tag_name().name() == "tbl") {
            return Err("不支持嵌套表格".into());
        }
        let mut f = HashMap::new();
        for row in t.children().filter(|n| n.tag_name().name() == "tr") {
            let cells: Vec<_> = row
                .children()
                .filter(|n| n.tag_name().name() == "tc")
                .collect();
            if cells.len() != 2 {
                errors.push(format!("第 {} 表必须是两列", i + 1));
                continue;
            }
            if row
                .descendants()
                .any(|n| ["vMerge", "gridSpan"].contains(&n.tag_name().name()))
            {
                errors.push(format!("第 {} 表不能合并单元格", i + 1));
            }
            let value = cells[1]
                .children()
                .filter(|n| n.tag_name().name() == "p")
                .map(xml_text)
                .collect::<Vec<_>>()
                .join("\n");
            let key = xml_text(cells[0]);
            if f.insert(key.trim().to_string(), value).is_some() {
                errors.push(format!("第 {} 表字段重复", i + 1));
            }
        }
        if let Some(v) = f.get("模板版本") {
            schema = v == "1.0";
            default_bank = f.get("默认题库").cloned().unwrap_or_default();
            continue;
        }
        if !f.contains_key("题型") {
            errors.push(format!("第 {} 表无法识别，必须使用题库标准模板", i + 1));
            continue;
        }
        if f.get("题库").map(|s| s.is_empty()).unwrap_or(true) {
            f.insert("题库".into(), default_bank.clone());
        }
        for key in f.keys() {
            if !HEADERS.contains(&key.as_str()) && key != "记录元数据" {
                errors.push(format!("第 {} 表出现未知字段 {key}", i + 1));
            }
        }
        match from_fields(&f) {
            Ok(q) => qs.push(q),
            Err(e) => errors.push(format!("第 {} 表：{e}", i + 1)),
        }
    }
    if !schema {
        errors.push("缺少模板版本 1.0；旧版 Word 已迁移，请改用新模板".into());
    }
    Ok(qs)
}
fn read_xlsx(bytes: &[u8], errors: &mut Vec<String>) -> Result<Vec<Question>> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    inspect_zip(&mut z)?;
    if z.file_names().any(|n| {
        n.starts_with("xl/media/")
            || n.starts_with("xl/drawings/")
            || n.starts_with("xl/embeddings/")
            || n.contains("vbaProject")
    }) {
        return Err("Excel 含图片、绘图、嵌入对象或宏，此版本不支持，请保留原文件".into());
    }
    let mut wb: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).map_err(err)?;
    let info = wb
        .worksheet_range("填写说明")
        .map_err(|_| "缺少填写说明工作表与模板版本")?;
    if !info.rows().any(|r| {
        r.first().map(|c| c.to_string()) == Some("模板版本".into())
            && r.get(1).map(|c| c.to_string()) == Some("1.0".into())
    }) {
        return Err("缺少模板版本 1.0".into());
    }
    let range = wb.worksheet_range("题目").map_err(|_| "找不到题目工作表")?;
    let formula = wb.worksheet_formula("题目").map_err(err)?;
    for ((row, col), _, s) in formula
        .cells()
        .filter(|(_, _, s)| !s.is_empty())
        .map(|(r, c, s)| ((r, c), 0, s))
    {
        errors.push(format!(
            "题目表第 {} 行第 {} 列含公式，请改成文本值：{}",
            row + 1,
            col + 1,
            s
        ));
    }
    let mut rows = range.rows();
    let h: Vec<String> = rows
        .next()
        .ok_or("题目表为空")?
        .iter()
        .map(ToString::to_string)
        .collect();
    if h.len() < 21 || h[..21] != HEADERS {
        return Err("表头不符合 v1 固定字段，请使用下载的模板".into());
    }
    if h.len() > 22 || h.get(21).map(|h| h != "记录元数据").unwrap_or(false) {
        return Err("发现未知列，不能静默丢弃，请使用标准表头".into());
    }
    let mut qs = vec![];
    for (i, row) in rows.enumerate() {
        if row
            .iter()
            .all(|c| matches!(c, Data::Empty) || c.to_string().trim().is_empty())
        {
            continue;
        }
        let f: HashMap<_, _> = h
            .iter()
            .enumerate()
            .map(|(j, h)| {
                (
                    h.clone(),
                    row.get(j).map(ToString::to_string).unwrap_or_default(),
                )
            })
            .collect();
        match from_fields(&f) {
            Ok(q) => qs.push(q),
            Err(e) => errors.push(format!("题目表第 {} 行：{e}", i + 2)),
        }
    }
    Ok(qs)
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn cell(text: &str, bold: bool) -> String {
    let p = text
        .lines()
        .map(|l| {
            format!(
                "<w:p><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                if bold { "<w:rPr><w:b/></w:rPr>" } else { "" },
                escape(l)
            )
        })
        .collect::<String>();
    format!(
        "<w:tc>{}</w:tc>",
        if p.is_empty() { "<w:p/>".into() } else { p }
    )
}
fn table(rows: &[(String, String)]) -> String {
    format!("<w:tbl><w:tblPr><w:tblW w:w=\"9600\" w:type=\"dxa\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w=\"1800\"/><w:gridCol w:w=\"7800\"/></w:tblGrid>{}</w:tbl><w:p/>",rows.iter().map(|(k,v)|format!("<w:tr>{}{}</w:tr>",cell(k,true),cell(v,false))).collect::<String>())
}
pub fn write_docx(name: &str, qs: &[Question]) -> Result<Vec<u8>> {
    let mut body = format!(
        "<w:p><w:r><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr><w:t>{}</w:t></w:r></w:p>",
        escape(name)
    );
    body.push_str(&table(&[
        ("模板版本".into(), "1.0".into()),
        ("默认题库".into(), name.into()),
    ]));
    for q in qs {
        body.push_str(&table(&fields(q)));
    }
    docx_body(&body)
}
pub fn write_print_docx(name: &str, qs: &[Question], mode: &str) -> Result<Vec<u8>> {
    if !["docx-study", "docx-exam", "docx-answers"].contains(&mode) {
        return Err("未知 Word 模式".into());
    }
    let paragraph = |text: &str| {
        format!("<w:p><w:pPr><w:spacing w:after=\"160\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",escape(text).replace('\n',"</w:t><w:br/><w:t xml:space=\"preserve\">"))
    };
    let label = match mode {
        "docx-exam" => "试卷",
        "docx-answers" => "参考答案",
        _ => "学习资料",
    };
    let mut body = paragraph(&format!("{name} · {label}"));
    for (i, q) in qs.iter().enumerate() {
        let answer = match &q.answer {
            Value::Bool(b) => {
                if *b {
                    "正确".into()
                } else {
                    "错误".into()
                }
            }
            Value::Array(a) => a
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join("、"),
            _ => "尚未确定".into(),
        };
        if mode != "docx-answers" {
            body.push_str(&paragraph(&format!("{}. {}", i + 1, q.stem)));
            for o in &q.options {
                body.push_str(&paragraph(&format!("{}. {}", o.key, o.content)));
            }
        }
        if mode == "docx-exam" {
            body.push_str(&paragraph("作答：________________"));
        } else {
            body.push_str(&paragraph(&format!(
                "{}答案：{}{}",
                if mode == "docx-answers" {
                    format!("{}. ", i + 1)
                } else {
                    String::new()
                },
                answer,
                if q.status != "verified" {
                    "（待核实）"
                } else {
                    ""
                }
            )));
            if mode == "docx-study" && !q.explanation.is_empty() {
                body.push_str(&paragraph(&format!("解析：{}", q.explanation)));
            }
        }
    }
    docx_body(&body)
}
fn docx_body(body: &str) -> Result<Vec<u8>> {
    let doc=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1000\" w:right=\"1000\" w:bottom=\"1000\" w:left=\"1000\"/></w:sectPr></w:body></w:document>");
    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    for (n,s) in [("[Content_Types].xml","<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),("_rels/.rels","<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"),("word/document.xml",doc.as_str())]{z.start_file(n,SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(err)?;z.write_all(s.as_bytes()).map_err(err)?;}
    Ok(z.finish().map_err(err)?.into_inner())
}
pub fn write_xlsx(name: &str, qs: &[Question]) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Color, Format, Workbook};
    let mut wb = Workbook::new();
    let info = wb.add_worksheet().set_name("填写说明").map_err(err)?;
    info.write_string(0, 0, "模板版本")
        .map_err(err)?
        .write_string(0, 1, "1.0")
        .map_err(err)?;
    info.write_string(1, 0, "题库")
        .map_err(err)?
        .write_string(1, 1, name)
        .map_err(err)?;
    info.write_string(2,0,"填写规则").map_err(err)?.write_string(2,1,"只读取题目工作表；多选答案用 | 分隔；禁止公式、图片；记录元数据由系统维护。疑问题复核后更新状态。").map_err(err)?;
    info.set_column_width(0, 18)
        .map_err(err)?
        .set_column_width(1, 85)
        .map_err(err)?;
    let sheet = wb.add_worksheet().set_name("题目").map_err(err)?;
    let header = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x163C3B))
        .set_font_color(Color::White);
    let text = Format::new().set_num_format("@").set_text_wrap();
    for (j, h) in HEADERS
        .iter()
        .chain(std::iter::once(&"记录元数据"))
        .enumerate()
    {
        sheet
            .write_string_with_format(0, j as u16, *h, &header)
            .map_err(err)?;
        sheet
            .set_column_width(j as u16, if j == 4 { 65. } else { 20. })
            .map_err(err)?;
    }
    sheet.set_freeze_panes(1, 5).map_err(err)?;
    for (i, q) in qs.iter().enumerate() {
        for (j, (_, v)) in fields(q).iter().enumerate() {
            if v.chars().count() > 32767 {
                return Err(format!(
                    "{} 字段过长，Excel 单元格不能超过 32767 字符，请使用 JSONL 或离线包",
                    q.external_id
                ));
            }
            sheet
                .write_string_with_format(i as u32 + 1, j as u16, v, &text)
                .map_err(err)?;
        }
    }
    wb.save_to_buffer().map_err(err)
}
