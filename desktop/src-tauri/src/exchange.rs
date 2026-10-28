mod document;
mod jsonl;
mod package;
use crate::{db::{self, Store}, model::*};
pub use document::{write_docx, write_print_docx, write_recommended_docx, write_xlsx};
pub(crate) use jsonl::jsonl;
pub use package::{export_name, package_bytes};
use std::{io::Write, path::Path};
use zip::{write::SimpleFileOptions, ZipWriter};

pub const HEADERS: [&str; 21] = [
    "外部编号", "题型", "题库", "章节", "题干", "选项A", "选项B", "选项C", "选项D",
    "选项E", "选项F", "选项G", "选项H", "答案", "解析", "标签", "难度", "适用版本",
    "来源说明", "系统ID", "基准修订号",
];
pub(crate) const MAX_FILE: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_PAYLOAD: u64 = 512 * 1024 * 1024;

#[derive(Clone, serde::Serialize)]
pub struct Manifest {
    pub schema_version: String,
    pub bank_id: String,
    pub name: String,
    pub release_id: String,
    pub release_version: i64,
    pub published_at: String,
    pub merged_at: Option<String>,
    pub release_name: Option<String>,
    pub min_app_version: String,
    pub question_count: usize,
    pub files: Vec<PackageFile>,
}
#[derive(Clone, serde::Serialize)]
pub struct PackageFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    if std::fs::metadata(path).map_err(err)?.len() > MAX_FILE {
        return Err("文件超过 256 MB".into());
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

fn recorded_question_bounds(
    start_at: Option<&str>,
    end_before: Option<&str>,
) -> Result<Option<(i64, i64)>> {
    if start_at.is_some() != end_before.is_some() {
        return Err("录入时间范围必须同时包含开始和结束时间".into());
    }
    let bounds = match (start_at.as_deref(), end_before.as_deref()) {
        (Some(start), Some(end)) => {
            let start = chrono::DateTime::parse_from_rfc3339(start)
                .map_err(|_| "开始时间格式无效")?
                .timestamp_millis();
            let end = chrono::DateTime::parse_from_rfc3339(end)
                .map_err(|_| "结束时间格式无效")?
                .timestamp_millis();
            if start >= end {
                return Err("录入时间范围无效".into());
            }
            Some((start, end))
        }
        (None, None) => None,
        _ => unreachable!(),
    };
    Ok(bounds)
}

fn select_recorded_questions(
    questions: Vec<Question>,
    bounds: Option<(i64, i64)>,
) -> Vec<Question> {
    questions
        .into_iter()
        .filter(|question| {
            let Some((start, end)) = bounds else {
                return true;
            };
            question
                .recorded_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|recorded| {
                    let timestamp = recorded.timestamp_millis();
                    timestamp >= start && timestamp < end
                })
        })
        .collect()
}

pub fn count_recorded_questions(
    store: &Store,
    id: &str,
    start_at: Option<String>,
    end_before: Option<String>,
) -> Result<usize> {
    let bounds = recorded_question_bounds(start_at.as_deref(), end_before.as_deref())?;
    let connection = store.conn()?;
    connection.execute_batch("BEGIN DEFERRED").map_err(err)?;
    db::get_bank(&connection, id)?;
    let selected = select_recorded_questions(db::questions(&connection, id)?, bounds);
    connection.execute_batch("COMMIT").map_err(err)?;
    Ok(selected.len())
}

pub fn export_recorded_questions(
    store: &Store,
    id: &str,
    path: &Path,
    start_at: Option<String>,
    end_before: Option<String>,
) -> Result<usize> {
    let bounds = recorded_question_bounds(start_at.as_deref(), end_before.as_deref())?;
    let connection = store.conn()?;
    connection.execute_batch("BEGIN DEFERRED").map_err(err)?;
    db::get_bank(&connection, id)?;
    let selected = select_recorded_questions(db::questions(&connection, id)?, bounds);
    let bytes = write_recommended_docx(&selected)?;
    connection.execute_batch("COMMIT").map_err(err)?;
    atomic_write(path, &bytes)?;
    Ok(selected.len())
}
