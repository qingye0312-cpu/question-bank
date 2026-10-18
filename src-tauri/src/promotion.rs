//! A persisted, immutable local-to-cloud conversion. Only this bank is guarded.
use crate::{
    db::{self, Store},
    model::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS bank_promotions(bank_id TEXT PRIMARY KEY,id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);").map_err(err)?;
    // Transactions that fail midway roll back both the edit and the guard change.
    for (table, column) in [
        ("questions", "bank_id"),
        ("draft_records", "bank_id"),
        ("intake_originals", "bank_id"),
        ("banks", "id"),
    ] {
        for (event, reference) in [("INSERT", "NEW"), ("UPDATE", "OLD"), ("DELETE", "OLD")] {
            c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS promotion_guard_{table}_{event} BEFORE {event} ON {table} WHEN EXISTS(SELECT 1 FROM bank_promotions WHERE bank_id={reference}.{column} AND status='pending') BEGIN SELECT RAISE(ABORT,'此题库正在启用云同步，请先完成原转换任务；其他题库仍可编辑'); END;")).map_err(err)?;
        }
    }
    Ok(())
}
pub fn list(store: &Store) -> Result<Vec<Value>> {
    let c = store.conn()?;
    let mut s = c
        .prepare("SELECT data FROM bank_promotions ORDER BY rowid")
        .map_err(err)?;
    let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect()
}
pub fn prepare(
    store: &Store,
    bank: &str,
    origin: &str,
    actor: &str,
    version: i64,
) -> Result<Value> {
    if !origin.starts_with("https://") || !actor.starts_with("d_") {
        return Err("请先使用桌面管理身份登录".into());
    }
    if let Some(old) = list(store)?.into_iter().find(|j| j["bankId"] == bank) {
        if old["origin"] != origin || old["actor"] != actor {
            return Err("请使用原服务地址和创建身份恢复转换".into());
        }
        return Ok(old);
    }
    let b = store.bank(bank)?;
    if b.read_only || b.version != version {
        return Err("题库已改变，请刷新后重新确认".into());
    }
    let c = store.conn()?;
    let unresolved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM draft_records WHERE bank_id=?1 AND json_extract(data,'$.removed')=0 AND (json_array_length(json_extract(data,'$.issues'))>0 OR json_extract(data,'$.submissionId')<>''))",[bank],|r|r.get(0)).map_err(err)?;
    if unresolved {
        return Err("请先补全草稿或核对已提交任务，再设置云端题库".into());
    }
    let questions = db::questions(&c, bank)?;
    if questions.is_empty() || questions.len() > 10000 {
        return Err("完整题库须包含 1 至 10000 题".into());
    }
    for q in &questions {
        q.validate(true)?;
    }
    let snapshot = json!({"bank_id":bank,"name":b.name,"questions":questions});
    let raw = snapshot.to_string();
    if raw.len() > 4 * 1024 * 1024 {
        return Err("完整题库超过 4 MiB 上限，本地题库保留".into());
    }
    use std::io::Write;
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
    gzip.write_all(raw.as_bytes()).map_err(err)?;
    if gzip.finish().map_err(err)?.len() > 3 * 1024 * 1024 - 4096 {
        return Err("完整题库压缩编码后超过请求上限，本地题库保持可编辑".into());
    }
    let directory = store.path.with_file_name("backups");
    std::fs::create_dir_all(&directory).map_err(err)?;
    let id = uid();
    let backup = directory.join(format!("qbank-cloud-{id}.sqlite"));
    crate::backup::save(store, &backup)?;
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    if db::get_bank(&tx, bank)?.version != version {
        return Err("备份期间题库已改变，请刷新后重试".into());
    }
    let task = json!({"id":id,"bankId":bank,"origin":origin,"actor":actor,"status":"pending","snapshot":snapshot,"backup":backup,"createdAt":now(),"localVersion":version});
    tx.execute(
        "INSERT INTO bank_promotions VALUES(?1,?2,'pending',?3)",
        params![bank, id, task.to_string()],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(task)
}
// Called inside the snapshot apply transaction. Compare durable content, not the
// display-only provenance that the public cloud projection deliberately removes.
pub fn begin_apply(
    c: &Connection,
    bank: &str,
    name: &str,
    formal: Option<&[Question]>,
) -> Result<bool> {
    let raw: Option<String> = c
        .query_row(
            "SELECT data FROM bank_promotions WHERE bank_id=?1 AND status='pending'",
            [bank],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let Some(raw) = raw else { return Ok(false) };
    let task: Value = serde_json::from_str(&raw).map_err(err)?;
    if task["snapshot"]["name"] != name {
        return Err("云端题库名称与转换快照不同".into());
    }
    let expected: Vec<Question> =
        serde_json::from_value(task["snapshot"]["questions"].clone()).map_err(err)?;
    let formal = formal.ok_or("首版尚未发布，保留本地任务")?;
    for q in &expected {
        let p = formal
            .iter()
            .find(|p| p.question_id == q.question_id)
            .ok_or("云端首版未包含全部本地题，保留备份与任务")?;
        if p.stem != q.stem
            || p.kind != q.kind
            || serde_json::to_value(&p.options).map_err(err)?
                != serde_json::to_value(&q.options).map_err(err)?
            || p.answer != q.answer
            || p.explanation != q.explanation
            || p.recorded_at != q.recorded_at
            || p.chapter != q.chapter
            || p.tags != q.tags
            || p.external_id != q.external_id
            || p.difficulty != q.difficulty
            || p.applicable_version != q.applicable_version
        {
            return Err("云端首版内容与确认快照不一致".into());
        }
    }
    c.execute(
        "UPDATE bank_promotions SET status='applying' WHERE bank_id=?1",
        [bank],
    )
    .map_err(err)?;
    Ok(true)
}
pub fn finish_apply(c: &Connection, bank: &str, digest: &str) -> Result<()> {
    let raw: String = c
        .query_row(
            "SELECT data FROM bank_promotions WHERE bank_id=?1",
            [bank],
            |r| r.get(0),
        )
        .map_err(err)?;
    let mut task: Value = serde_json::from_str(&raw).map_err(err)?;
    task["status"] = json!("done");
    task["sha256"] = json!(digest);
    task["completedAt"] = json!(now());
    c.execute("UPDATE draft_records SET data=json_set(data,'$.submissionId',?2,'$.publishedAt',?3) WHERE bank_id=?1 AND json_extract(data,'$.removed')=0",params![bank,task["id"].as_str(),task["completedAt"].as_str()]).map_err(err)?;
    c.execute(
        "UPDATE intake_entries SET upload_status='published' WHERE bank_id=?1",
        [bank],
    )
    .map_err(err)?;
    c.execute(
        "UPDATE bank_promotions SET status='done',data=?2 WHERE bank_id=?1",
        params![bank, task.to_string()],
    )
    .map_err(err)?;
    Ok(())
}
