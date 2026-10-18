mod document;
mod jsonl;
mod package;
use crate::{
    db::{self, Store},
    model::*,
};
use calamine::{Data, Reader, Xlsx};
use document::{read_docx, read_xlsx};
pub use document::{write_docx, write_print_docx, write_xlsx};
pub(crate) use jsonl::jsonl;
use jsonl::parse_jsonl;
pub use package::{export_name, package_bytes};
use package::{inspect_zip, read_package, zip_entry};
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
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub release_name: Option<String>,
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
                q.recorded_at = previous.recorded_at.clone();
                q.recorded_at_source = previous.recorded_at_source.clone();
                q.recover_recorded_at(None);
                q.updated_at = Some(now());
                db::remove_index(&tx, rowid)?;
                tx.execute("DELETE FROM questions WHERE rowid=?1", [rowid])
                    .map_err(err)?;
            }
            if q.recorded_at.is_none() && q.sources.is_empty() && q.recorded_at_source.is_none() {
                q.recover_recorded_at(Some(&now()));
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
    if let Some(m) = &p.manifest {
        let name = m.release_name.clone().unwrap_or_else(|| {
            result_name(
                m.merged_at.as_deref(),
                &m.name,
                "历史迁移",
                &format!("v{}", m.release_version),
                &m.bank_id,
                &m.release_id,
            )
        });
        db::set_result(&tx, &id, m.merged_at.as_deref(), &name, &m.release_id)?;
    } else {
        db::record_result(&tx, &id, Some(&now()), "合并")?;
    }
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
