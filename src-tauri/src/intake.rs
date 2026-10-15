//! Local model intake and additive packages. Neither export nor sharing is an upload.
use crate::{
    db::{self, Store},
    exchange,
    model::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

pub fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS intake_batches(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL REFERENCES banks(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_entries(bank_id TEXT NOT NULL,question_id TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES intake_batches(id),created_at TEXT NOT NULL,upload_status TEXT NOT NULL DEFAULT 'pending',uploaded_at TEXT NOT NULL DEFAULT '',exported_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(bank_id,question_id));
      CREATE INDEX IF NOT EXISTS intake_by_batch ON intake_entries(batch_id);
      CREATE TABLE IF NOT EXISTS intake_snapshots(bank_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delta_imports(fingerprint TEXT NOT NULL,bank_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(fingerprint,bank_id));").map_err(err)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplyChoice {
    key: String,
    content: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Model {
    name: String,
    version: String,
    version_source: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    format: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    stem: String,
    options: Vec<ReplyChoice>,
    answer: Value,
    answer_origin: String,
    explanation: String,
    model: Model,
    warnings: Vec<String>,
}
pub fn parse_reply(text: &str) -> Result<Question> {
    if text.len() > 1_000_000 {
        return Err("回复过长，请每次粘贴一道文字题".into());
    }
    let mut text = text.trim().trim_start_matches('\u{feff}');
    if text.starts_with("```") {
        let (header, rest) = text.split_once('\n').ok_or("请复制完整的 JSON 代码块")?;
        if !["```", "```json"].contains(&header.trim().to_ascii_lowercase().as_str()) {
            return Err("只支持 JSON 代码块".into());
        }
        text = rest
            .trim_end()
            .strip_suffix("```")
            .ok_or("代码块没有结束，请完整复制")?
            .trim();
    }
    let r: Reply = serde_json::from_str(text).map_err(|e| format!("单题 JSON 无效：{e}"))?;
    if r.format != "qbank-photo-question-1" {
        return Err("请使用大模型单题输出规范".into());
    }
    if r.answer_origin != "inferred" || r.answer.is_null() {
        return Err("模型尚未给出答案，请核对后再录入".into());
    }
    if r.model.name.trim().is_empty()
        || r.model.version.trim().is_empty()
        || !["platform", "user", "unknown"].contains(&r.model.version_source.as_str())
    {
        return Err("请保留实际模型名称和版本，无法确认时填未知".into());
    }
    if std::iter::once(r.stem.as_str())
        .chain(r.options.iter().map(|o| o.content.as_str()))
        .any(|s| s.contains("【看不清】"))
    {
        return Err("请补全看不清的题目内容后再录入".into());
    }
    let mut q: Question = serde_json::from_value(json!({
        "type":r.kind.ok_or("题型未确定")?,"stem":r.stem,
        "options":r.options.into_iter().map(|o|json!({"key":o.key,"content":o.content})).collect::<Vec<_>>(),
        "answer":r.answer,"explanation":r.explanation,"issues":r.warnings,
        "source_note":format!("大模型作答 · {} / {}",r.model.name,r.model.version),
        "sources":[{"kind":"model_reply","model":r.model,"answer_origin":r.answer_origin,"warnings":r.warnings,"recorded_at":now()}]
    })).map_err(err)?;
    q.validate(false)?;
    q.prepare();
    Ok(q)
}
fn clean(s: &str) -> String {
    s.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}
pub fn identity(q: &Question) -> String {
    let mut options: Vec<_> = q.options.iter().map(|o| clean(&o.content)).collect();
    if options.iter().collect::<HashSet<_>>().len() == options.len() {
        options.sort();
    }
    // Use a tuple, not a delimiter, so embedded punctuation cannot cause collisions.
    hash(
        serde_json::to_string(&(&q.kind, clean(&q.stem), options))
            .unwrap()
            .as_bytes(),
    )
}
pub fn same_answer(a: &Question, b: &Question) -> bool {
    fn signature(q: &Question) -> Value {
        let Some(keys) = q.answer.as_array() else {
            return q.answer.clone();
        };
        let repeated = q
            .options
            .iter()
            .map(|o| clean(&o.content))
            .collect::<HashSet<_>>()
            .len()
            != q.options.len();
        let mut values: Vec<String> = keys
            .iter()
            .map(|k| {
                if repeated {
                    k.as_str().unwrap_or("").into()
                } else {
                    q.options
                        .iter()
                        .find(|o| Some(o.key.as_str()) == k.as_str())
                        .map(|o| clean(&o.content))
                        .unwrap_or_default()
                }
            })
            .collect();
        values.sort();
        json!(values)
    }
    signature(a) == signature(b)
}
#[derive(Serialize)]
pub struct Match {
    pub question: Question,
    pub same_answer: bool,
    pub deleted: bool,
}
#[derive(Serialize)]
pub struct Comparison {
    pub question: Question,
    pub status: String,
    pub matches: Vec<Match>,
}
fn all_questions(c: &Connection, bank_id: &str) -> Result<Vec<(Question, bool)>> {
    let mut s = c
        .prepare("SELECT data,deleted FROM questions WHERE bank_id=?1 ORDER BY rowid")
        .map_err(err)?;
    let rows = s
        .query_map([bank_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })
        .map_err(err)?;
    rows.map(|r| {
        let (text, deleted) = r.map_err(err)?;
        Ok((serde_json::from_str(&text).map_err(err)?, deleted))
    })
    .collect()
}
fn compare(c: &Connection, bank_id: &str, q: Question) -> Result<Comparison> {
    let key = identity(&q);
    let matches: Vec<_> = all_questions(c, bank_id)?
        .into_iter()
        .filter(|(old, _)| identity(old) == key)
        .map(|(old, deleted)| Match {
            same_answer: same_answer(&q, &old),
            question: old,
            deleted,
        })
        .collect();
    let status = if matches.is_empty() {
        "new"
    } else if matches.iter().any(|m| !m.same_answer) {
        "conflict"
    } else if matches.iter().all(|m| m.deleted) {
        "deleted"
    } else {
        "duplicate"
    };
    Ok(Comparison {
        question: q,
        status: status.into(),
        matches,
    })
}
pub fn preview(store: &Store, bank_id: &str, text: &str) -> Result<Comparison> {
    let b = store.bank(bank_id)?;
    let mut q = parse_reply(text)?;
    q.bank = b.name;
    compare(&store.conn()?, bank_id, q)
}
#[derive(Serialize)]
pub struct Saved {
    pub batch_id: String,
    pub comparison: Comparison,
    pub added: bool,
}
fn add_batch(c: &Connection, id: &str, bank_id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("录入批次 ID 无效".into());
    }
    let existing: Option<String> = c
        .query_row(
            "SELECT bank_id FROM intake_batches WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if existing.is_some_and(|b| b != bank_id) {
        return Err("该批次属于另一题库，请新建录入批次".into());
    }
    c.execute(
        "INSERT OR IGNORE INTO intake_batches VALUES(?1,?2,?3)",
        params![id, bank_id, now()],
    )
    .map_err(err)?;
    Ok(())
}
fn add_entry(c: &Connection, bank: &str, batch: &str, q: &Question) -> Result<()> {
    db::insert(c, bank, q)?;
    c.execute(
        "INSERT INTO intake_entries(bank_id,question_id,batch_id,created_at) VALUES(?1,?2,?3,?4)",
        params![bank, q.question_id, batch, now()],
    )
    .map_err(err)?;
    Ok(())
}
pub fn save(store: &Store, bank_id: &str, batch_id: &str, text: &str) -> Result<Saved> {
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let b = db::get_bank(&tx, bank_id)?;
    let mut q = parse_reply(text)?;
    q.bank = b.name;
    let comparison = compare(&tx, bank_id, q)?;
    if comparison.status != "new" {
        return Ok(Saved {
            batch_id: batch_id.into(),
            comparison,
            added: false,
        });
    }
    let batch = if batch_id.is_empty() {
        uid()
    } else {
        batch_id.into()
    };
    add_batch(&tx, &batch, bank_id)?;
    add_entry(&tx, bank_id, &batch, &comparison.question)?;
    db::touch(&tx, bank_id)?;
    tx.commit().map_err(err)?;
    Ok(Saved {
        batch_id: batch,
        comparison,
        added: true,
    })
}
#[derive(Serialize)]
pub struct Batch {
    pub id: String,
    pub bank_id: String,
    pub bank_name: String,
    pub created_at: String,
    pub count: i64,
    pub pending: i64,
}
#[derive(Serialize)]
pub struct Entry {
    pub question: Question,
    pub upload_status: String,
    pub uploaded_at: String,
    pub exported_at: String,
}
pub fn batches(store: &Store) -> Result<Vec<Batch>> {
    let c = store.conn()?;
    let mut s=c.prepare("SELECT b.id,b.bank_id,k.name,b.created_at,COUNT(q.id),COALESCE(SUM(q.id IS NOT NULL AND e.upload_status='pending'),0) FROM intake_batches b JOIN banks k ON k.id=b.bank_id LEFT JOIN intake_entries e ON e.batch_id=b.id LEFT JOIN questions q ON q.bank_id=e.bank_id AND q.id=e.question_id AND q.deleted=0 GROUP BY b.id ORDER BY b.created_at DESC").map_err(err)?;
    let rows = s
        .query_map([], |r| {
            Ok(Batch {
                id: r.get(0)?,
                bank_id: r.get(1)?,
                bank_name: r.get(2)?,
                created_at: r.get(3)?,
                count: r.get(4)?,
                pending: r.get(5)?,
            })
        })
        .map_err(err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(err)
}
pub fn entries(store: &Store, batch_id: &str) -> Result<Vec<Entry>> {
    entries_conn(&store.conn()?, batch_id)
}
fn entries_conn(c: &Connection, batch_id: &str) -> Result<Vec<Entry>> {
    let mut s=c.prepare("SELECT q.data,e.upload_status,e.uploaded_at,e.exported_at FROM intake_entries e JOIN questions q ON q.bank_id=e.bank_id AND q.id=e.question_id AND q.deleted=0 WHERE e.batch_id=?1 ORDER BY e.created_at,q.rowid").map_err(err)?;
    let rows = s
        .query_map([batch_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(err)?;
    rows.map(|r| {
        let (data, upload_status, uploaded_at, exported_at) = r.map_err(err)?;
        Ok(Entry {
            question: serde_json::from_str(&data).map_err(err)?,
            upload_status,
            uploaded_at,
            exported_at,
        })
    })
    .collect()
}
pub fn mark_upload(store: &Store, bank_id: &str, question_id: &str, uploaded: bool) -> Result<()> {
    let n=store.conn()?.execute("UPDATE intake_entries SET upload_status=?1,uploaded_at=?2 WHERE bank_id=?3 AND question_id=?4",params![if uploaded{"uploaded_manual"}else{"pending"},if uploaded{now()}else{String::new()},bank_id,question_id]).map_err(err)?;
    if n != 1 {
        return Err("找不到这条本地录入记录".into());
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delta {
    pub format: String,
    pub bank_id: String,
    pub name: String,
    pub batch_id: String,
    pub created_at: String,
    pub question_count: usize,
    pub payload: String,
    pub sha256: String,
}
pub fn export(store: &Store, batch_id: &str, path: &Path) -> Result<usize> {
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let bank_id: String = tx
        .query_row(
            "SELECT bank_id FROM intake_batches WHERE id=?1",
            [batch_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    let bank = db::get_bank(&tx, &bank_id)?;
    let entries = entries_conn(&tx, batch_id)?;
    if entries.is_empty() {
        return Err("该批次没有可导出的新题".into());
    }
    let mut payload = String::new();
    for entry in &entries {
        entry.question.validate(false)?;
        payload.push_str(&serde_json::to_string(&entry.question).map_err(err)?);
        payload.push('\n');
    }
    let delta = Delta {
        format: "qbank-delta-1".into(),
        bank_id,
        name: bank.name,
        batch_id: batch_id.into(),
        created_at: now(),
        question_count: entries.len(),
        sha256: hash(payload.as_bytes()),
        payload,
    };
    exchange::atomic_write(path, &serde_json::to_vec_pretty(&delta).map_err(err)?)?;
    tx.execute(
        "UPDATE intake_entries SET exported_at=?1 WHERE batch_id=?2",
        params![now(), batch_id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(entries.len())
}
pub fn read_delta(path: &Path) -> Result<(Delta, Vec<Question>)> {
    let bytes = exchange::read_file(path)?;
    let delta: Delta =
        serde_json::from_slice(&bytes).map_err(|e| format!("增量包格式无效：{e}"))?;
    if delta.format != "qbank-delta-1"
        || uuid::Uuid::parse_str(&delta.bank_id).is_err()
        || uuid::Uuid::parse_str(&delta.batch_id).is_err()
        || delta.name.trim().is_empty()
        || delta.name.chars().count() > 100
        || delta.question_count == 0
        || delta.question_count > 100_000
    {
        return Err("增量包题库身份、批次或数量无效".into());
    }
    if hash(delta.payload.as_bytes()) != delta.sha256 {
        return Err("增量包校验失败，文件可能不完整".into());
    }
    let mut qs = vec![];
    let mut ids = HashSet::new();
    for line in delta.payload.lines().filter(|s| !s.trim().is_empty()) {
        if line.len() > 1_000_000 {
            return Err("单题内容超过 1 MB".into());
        }
        let q: Question = serde_json::from_str(line).map_err(err)?;
        q.validate(false)?;
        if q.question_id.is_empty() || !ids.insert(q.question_id.clone()) {
            return Err("增量包含缺失或重复的题目 ID".into());
        }
        qs.push(q);
    }
    if qs.len() != delta.question_count {
        return Err("增量包题目数量不一致".into());
    }
    Ok((delta, qs))
}
#[derive(Serialize)]
pub struct Imported {
    pub bank_id: String,
    pub name: String,
    pub added: usize,
    pub skipped: usize,
    pub conflicts: usize,
    pub batch_id: String,
}
pub fn import(store: &Store, path: &Path) -> Result<Imported> {
    let (d, qs) = read_delta(path)?;
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM banks WHERE id=?1)",
            [&d.bank_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !existing {
        tx.execute(
            "INSERT INTO banks VALUES(?1,?2,0,1,?3,'','从增量包建立的题库')",
            params![d.bank_id, d.name, now()],
        )
        .map_err(err)?;
    }
    let b = db::get_bank(&tx, &d.bank_id)?;
    let seen: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM delta_imports WHERE fingerprint=?1 AND bank_id=?2)",
            params![d.sha256, d.bank_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    let mut result = Imported {
        bank_id: d.bank_id.clone(),
        name: b.name.clone(),
        added: 0,
        skipped: 0,
        conflicts: 0,
        batch_id: d.batch_id.clone(),
    };
    if seen {
        result.skipped = qs.len();
        return Ok(result);
    }
    let old = all_questions(&tx, &d.bank_id)?;
    let mut by_id: HashMap<String, Question> = old
        .iter()
        .map(|(q, _)| (q.question_id.clone(), q.clone()))
        .collect();
    let mut by_content: HashMap<String, Vec<Question>> = HashMap::new();
    for (q, _) in old {
        by_content.entry(identity(&q)).or_default().push(q);
    }
    add_batch(&tx, &d.batch_id, &d.bank_id)?;
    for mut q in qs {
        let key = identity(&q);
        let found = by_content.get(&key);
        if let Some(previous) = by_id.get(&q.question_id) {
            if identity(previous) != key || !same_answer(previous, &q) {
                result.conflicts += 1;
            } else {
                result.skipped += 1;
            }
            continue;
        }
        if let Some(previous) = found {
            if previous.iter().any(|p| !same_answer(p, &q)) {
                result.conflicts += 1;
            } else {
                result.skipped += 1;
            }
            continue;
        }
        if result.added == 0 && existing {
            db::snapshot(&tx, &b)?;
        }
        q.bank = b.name.clone();
        q.prepare();
        add_entry(&tx, &d.bank_id, &d.batch_id, &q)?;
        by_id.insert(q.question_id.clone(), q.clone());
        by_content.entry(key).or_default().push(q);
        result.added += 1;
    }
    // A conflicting package must remain retryable after the user corrects the bank.
    if result.conflicts == 0 {
        tx.execute(
            "INSERT INTO delta_imports VALUES(?1,?2,?3)",
            params![d.sha256, d.bank_id, now()],
        )
        .map_err(err)?;
    }
    if result.added > 0 {
        db::touch(&tx, &d.bank_id)?;
        tx.execute("UPDATE snapshots SET expected_version=(SELECT version FROM banks WHERE id=?1) WHERE bank_id=?1",[&d.bank_id]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(result)
}
type SnapshotEntry = (String, String, String, String, String, String);
pub fn snapshot(c: &Connection, bank_id: &str) -> Result<()> {
    let mut s=c.prepare("SELECT question_id,batch_id,created_at,upload_status,uploaded_at,exported_at FROM intake_entries WHERE bank_id=?1").map_err(err)?;
    let rows = s
        .query_map([bank_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(err)?;
    let data: Vec<SnapshotEntry> = rows.collect::<std::result::Result<_, _>>().map_err(err)?;
    c.execute(
        "INSERT OR REPLACE INTO intake_snapshots VALUES(?1,?2)",
        params![bank_id, serde_json::to_string(&data).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}
pub fn restore_snapshot(c: &Connection, bank_id: &str) -> Result<()> {
    let data: Option<String> = c
        .query_row(
            "SELECT data FROM intake_snapshots WHERE bank_id=?1",
            [bank_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(data) = data {
        let rows: Vec<SnapshotEntry> = serde_json::from_str(&data).map_err(err)?;
        c.execute("DELETE FROM intake_entries WHERE bank_id=?1", [bank_id])
            .map_err(err)?;
        for (id, batch, created, status, uploaded, exported) in rows {
            c.execute(
                "INSERT INTO intake_entries VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![bank_id, id, batch, created, status, uploaded, exported],
            )
            .map_err(err)?;
        }
        c.execute("DELETE FROM intake_snapshots WHERE bank_id=?1", [bank_id])
            .map_err(err)?;
    }
    c.execute("DELETE FROM delta_imports WHERE bank_id=?1", [bank_id])
        .map_err(err)?;
    Ok(())
}
// Preserve local additions during a later full release. A publisher can absorb
// an addition under another UUID; reattach its intake record to the published ID.
pub fn preserve_additions(
    c: &Connection,
    bank_id: &str,
    incoming: &[Question],
) -> Result<Vec<Question>> {
    let incoming_keys: HashMap<_, _> = incoming.iter().map(|q| (identity(q), q)).collect();
    let incoming_ids: HashSet<_> = incoming.iter().map(|q| q.question_id.as_str()).collect();
    let mut kept = vec![];
    let local_ids = local_question_ids(c, bank_id)?;
    for (q, deleted) in all_questions(c, bank_id)? {
        if !local_ids.contains(&q.question_id)
            || deleted
            || incoming_ids.contains(q.question_id.as_str())
        {
            continue;
        }
        if let Some(published) = incoming_keys.get(&identity(&q)) {
            c.execute("UPDATE OR IGNORE intake_entries SET question_id=?1 WHERE bank_id=?2 AND question_id=?3",params![published.question_id,bank_id,q.question_id]).map_err(err)?;
        } else {
            kept.push(q);
        }
    }
    Ok(kept)
}
pub fn local_question_ids(c: &Connection, bank_id: &str) -> Result<HashSet<String>> {
    let mut s = c
        .prepare("SELECT question_id FROM intake_entries WHERE bank_id=?1")
        .map_err(err)?;
    let rows = s.query_map([bank_id], |r| r.get(0)).map_err(err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(err)
}
