//! Durable per-question working records. A single transaction stores the draft,
//! its searchable projection and (on explicit submission) the immutable request.
use crate::{
    db::{self, Store},
    intake,
    model::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS draft_records(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL);").map_err(err)
}
fn records(c: &Connection, bank: &str) -> Result<Vec<Value>> {
    let mut s = c
        .prepare("SELECT data FROM draft_records WHERE bank_id=?1 ORDER BY rowid")
        .map_err(err)?;
    let rows = s
        .query_map([bank], |r| r.get::<_, String>(0))
        .map_err(err)?;
    rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect()
}
fn read(c: &Connection, id: &str) -> Result<Option<Value>> {
    let text: Option<String> = c
        .query_row("SELECT data FROM draft_records WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    text.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
fn put(c: &Connection, r: &Value) -> Result<()> {
    c.execute("INSERT INTO draft_records VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data",params![r["id"].as_str(),r["bankId"].as_str(),r["revision"].as_i64(),serde_json::to_string(r).map_err(err)?]).map_err(err)?;
    Ok(())
}
fn from_question(bank: &str, q: &Question, submission: &str) -> Value {
    let model = q
        .sources
        .iter()
        .find(|s| s["kind"] == "model_reply")
        .map(|s| s["model"].clone())
        .filter(|s| s.is_object())
        .unwrap_or(json!({"name":"未知","version":"未知","version_source":"unknown"}));
    let reply = json!({"format":"qbank-photo-question-1","type":q.kind,"stem":q.stem,"options":q.options.iter().map(|o|json!({"key":o.key,"content":o.content})).collect::<Vec<_>>(),"answer":q.answer,"answer_origin":"inferred","explanation":q.explanation,"model":model,"warnings":q.issues});
    let raw = reply.to_string();
    json!({"id":q.question_id,"bankId":bank,"revision":1,"recordedAt":q.recorded_at.clone().unwrap_or_default(),"updatedAt":q.updated_at.clone().unwrap_or_else(now),"raw":raw,"original":raw,"reply":reply,"metadata":{"chapter":q.chapter,"tags":q.tags,"difficulty":q.difficulty,"applicable_version":q.applicable_version,"external_id":q.external_id},"sourceIssues":[],"issues":[],"removed":false,"submissionId":submission,"question":q})
}
pub fn list(store: &Store, bank: &str) -> Result<Vec<Value>> {
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    db::get_bank(&tx, bank)?;
    // Keep the old exchange bytes. Only unsent working records move to new jobs.
    let mut s=tx.prepare("SELECT o.data,CASE WHEN COALESCE(t.endpoint,'')<>'' THEN e.batch_id ELSE '' END FROM intake_entries e JOIN intake_originals o ON o.bank_id=e.bank_id AND o.question_id=e.question_id LEFT JOIN intake_transfers t ON t.batch_id=e.batch_id LEFT JOIN draft_records d ON d.id=e.question_id WHERE e.bank_id=?1 AND d.id IS NULL AND o.deleted=0 AND e.upload_status='pending'").map_err(err)?;
    let old = s
        .query_map([bank], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(s);
    for (raw, submission) in old {
        let q: Question = serde_json::from_str(&raw).map_err(err)?;
        put(&tx, &from_question(bank, &q, &submission))?;
    }
    let result = records(&tx, bank)?;
    tx.commit().map_err(err)?;
    Ok(result)
}
fn remove_projection(c: &Connection, bank: &str, id: &str) -> Result<()> {
    let row: Option<i64> = c
        .query_row(
            "SELECT rowid FROM questions WHERE bank_id=?1 AND id=?2",
            params![bank, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(row) = row {
        db::remove_index(c, row)?;
        c.execute("DELETE FROM questions WHERE rowid=?1", [row])
            .map_err(err)?;
    }
    c.execute(
        "UPDATE intake_originals SET deleted=1 WHERE bank_id=?1 AND question_id=?2",
        params![bank, id],
    )
    .map_err(err)?;
    Ok(())
}
pub fn save(store: &Store, mut record: Value, expected: u64) -> Result<Value> {
    if record.to_string().len() > 800_000 {
        return Err("单题草稿过大，原输入仍保留在编辑器".into());
    }
    let id = record["id"].as_str().unwrap_or_default().to_string();
    let bank = record["bankId"].as_str().unwrap_or_default().to_string();
    if uuid::Uuid::parse_str(&id).is_err() || record["revision"].as_u64().unwrap_or(0) <= expected {
        return Err("草稿版本或身份无效".into());
    }
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let b = db::get_bank(&tx, &bank)?;
    let previous = read(&tx, &id)?;
    if previous
        .as_ref()
        .map(|v| v["revision"].as_u64().unwrap_or(0))
        .unwrap_or(0)
        != expected
    {
        return Err("此题已在其他窗口修改，请重新打开；当前输入尚未覆盖".into());
    }
    if let Some(ref old) = previous {
        if old["bankId"] != bank || old["submissionId"].as_str().is_some_and(|s| !s.is_empty()) {
            return Err("已提交题目不可改写，请先核对原回执".into());
        }
        record["recordedAt"] = old["recordedAt"].clone();
    } else {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM questions WHERE bank_id=?1 AND id=?2)",
                params![bank, id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if exists {
            return Err("题目身份已存在，不能通过新草稿覆盖".into());
        }
        record["recordedAt"] = json!(now());
    }
    record["updatedAt"] = json!(now());
    record["submissionId"] = json!("");
    let frozen:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM intake_entries e JOIN intake_transfers t ON t.batch_id=e.batch_id WHERE e.bank_id=?1 AND e.question_id=?2 AND t.endpoint<>'')",params![bank,id],|r|r.get(0)).map_err(err)?;
    if frozen {
        return Err("原提交结果尚待确认，保留内容用于重试".into());
    }
    let valid = (|| -> Result<Question> {
        if record["sourceIssues"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            return Err("请处理原文识别提示后再上传".into());
        }
        let mut q = intake::parse_reply(&record["reply"].to_string())?;
        let metadata: intake::Metadata =
            serde_json::from_value(record["metadata"].clone()).map_err(err)?;
        metadata.apply(&mut q)?;
        q.bank = b.name.clone();
        q.question_id = id.clone();
        q.schema_version = "1.1".into();
        q.base_revision = record["revision"].as_u64().unwrap();
        q.recorded_at = record["recordedAt"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from);
        q.recorded_at_source = Some(
            if q.recorded_at.is_some() {
                previous
                    .as_ref()
                    .and_then(|p| p["question"]["recorded_at_source"].as_str())
                    .unwrap_or("local")
            } else {
                "unknown"
            }
            .into(),
        );
        q.updated_at = record["updatedAt"].as_str().map(String::from);
        q.sources[0]["recorded_at"] = json!(q.recorded_at);
        // Preserve option identities when content survives an edit/reorder.
        if let Some(old) = previous.as_ref().and_then(|r| r.get("question")) {
            if let Ok(old) = serde_json::from_value::<Question>(old.clone()) {
                for o in &mut q.options {
                    if let Some(p) = old.options.iter().find(|p| p.content == o.content) {
                        o.option_id = p.option_id.clone();
                    }
                }
            }
        }
        for (other, _) in intake::all_questions(&tx, &bank)? {
            if other.question_id != id && intake::identity(&other) == intake::identity(&q) {
                return Err("与已有题目重复或答案冲突，请核对后修改或移除本条".into());
            }
        }
        q.validate(false)?;
        Ok(q)
    })();
    remove_projection(&tx, &bank, &id)?;
    match valid {
        Ok(q) => {
            record["issues"] = json!([]);
            record["question"] = serde_json::to_value(&q).map_err(err)?;
            if record["removed"] != true {
                db::insert(&tx, &bank, &q)?;
                tx.execute("INSERT INTO intake_originals(bank_id,question_id,data,deleted) VALUES(?1,?2,?3,0) ON CONFLICT(bank_id,question_id) DO UPDATE SET data=excluded.data,deleted=0",params![bank,id,serde_json::to_string(&q).map_err(err)?]).map_err(err)?;
                let batch:Option<String>=tx.query_row("SELECT e.batch_id FROM intake_entries e LEFT JOIN intake_transfers t ON t.batch_id=e.batch_id WHERE e.bank_id=?1 AND e.question_id=?2 AND t.batch_id IS NULL",params![bank,id],|r|r.get(0)).optional().map_err(err)?;
                let batch = batch.unwrap_or_else(uid);
                intake::add_batch(&tx, &batch, &bank)?;
                tx.execute("INSERT INTO intake_entries(bank_id,question_id,batch_id,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(bank_id,question_id) DO UPDATE SET batch_id=excluded.batch_id",params![bank,id,batch,record["recordedAt"].as_str()]).map_err(err)?;
            }
        }
        Err(message) => {
            record["issues"] = if record["sourceIssues"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
            {
                record["sourceIssues"].clone()
            } else {
                json!([{"field":"question","message":message}])
            };
        }
    }
    put(&tx, &record)?;
    db::touch(&tx, &bank)?;
    tx.commit().map_err(err)?;
    Ok(record)
}

pub fn enqueue(
    store: &Store,
    bank: &str,
    expected: Value,
    endpoint: &str,
    actor: &str,
) -> Result<Value> {
    if !endpoint.starts_with("https://") || actor.is_empty() {
        return Err("请先完成上传授权".into());
    }
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let b = db::get_bank(&tx, bank)?;
    let pending: Vec<Value> = records(&tx, bank)?
        .into_iter()
        .filter(|r| r["removed"] != true && r["submissionId"] == "")
        .collect();
    let versions: Vec<Value> = pending
        .iter()
        .map(|r| json!({"id":r["id"],"revision":r["revision"]}))
        .collect();
    if expected != json!(versions) {
        return Err("录题记录有变化，请核对最新内容后上传".into());
    }
    if pending.is_empty() {
        return Err("没有待上传题目".into());
    }
    if pending
        .iter()
        .any(|r| r["issues"].as_array().is_none_or(|a| !a.is_empty()))
    {
        return Err("有题目待补全，已保留全部记录，请修改或移除后上传".into());
    }
    let id = uid();
    let at = now();
    let mut payload = String::new();
    for r in &pending {
        let q: Question = serde_json::from_value(r["question"].clone()).map_err(err)?;
        q.validate(false)?;
        payload.push_str(&serde_json::to_string(&q).map_err(err)?);
        payload.push('\n');
    }
    let raw = serde_json::to_string(&intake::Delta {
        format: "qbank-delta-1".into(),
        bank_id: bank.into(),
        name: b.name,
        batch_id: id.clone(),
        created_at: at.clone(),
        question_count: pending.len(),
        sha256: hash(payload.as_bytes()),
        payload,
    })
    .map_err(err)?;
    crate::cloud::encode(&raw)?; // One bounded package; never silently split a session.
    let job = json!({"id":id,"groupId":id,"bankId":bank,"endpoint":endpoint,"actor":actor,"confirmedAt":at,"status":"queued","attempts":0,"nextAt":0,"error":"","protocol":"session-v1"});
    let queue: Option<String> = tx
        .query_row(
            "SELECT value FROM client_state WHERE key='upload-queue'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let mut jobs: Vec<Value> =
        serde_json::from_str(queue.as_deref().unwrap_or("[]")).map_err(err)?;
    jobs.push(job.clone());
    intake::add_batch(&tx, &id, bank)?;
    tx.execute(
        "INSERT INTO intake_transfers(batch_id,raw,endpoint) VALUES(?1,?2,?3)",
        params![id, raw, endpoint],
    )
    .map_err(err)?;
    for mut r in pending {
        tx.execute(
            "UPDATE intake_entries SET batch_id=?1 WHERE bank_id=?2 AND question_id=?3",
            params![id, bank, r["id"].as_str()],
        )
        .map_err(err)?;
        r["submissionId"] = json!(id);
        put(&tx, &r)?;
    }
    tx.execute("INSERT INTO client_state VALUES('upload-queue',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&jobs).map_err(err)?]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(job)
}

pub fn export(store: &Store, bank: &str, path: &std::path::Path) -> Result<usize> {
    let c = store.conn()?;
    let b = db::get_bank(&c, bank)?;
    let selected: Vec<Value> = records(&c, bank)?
        .into_iter()
        .filter(|r| r["removed"] != true && r["submissionId"] == "")
        .collect();
    if selected.is_empty() {
        return Err("没有待导出的题目".into());
    }
    if selected
        .iter()
        .any(|r| r["issues"].as_array().is_none_or(|a| !a.is_empty()))
    {
        return Err("请先补全题目；草稿已保留，未修改上传状态".into());
    }
    let mut payload = String::new();
    for r in &selected {
        let q: Question = serde_json::from_value(r["question"].clone()).map_err(err)?;
        q.validate(false)?;
        payload.push_str(&serde_json::to_string(&q).map_err(err)?);
        payload.push('\n');
    }
    let delta = intake::Delta {
        format: "qbank-delta-1".into(),
        bank_id: bank.into(),
        name: b.name,
        batch_id: uid(),
        created_at: now(),
        question_count: selected.len(),
        sha256: hash(payload.as_bytes()),
        payload,
    };
    let envelope = crate::cloud::encode(&serde_json::to_string(&delta).map_err(err)?)?;
    crate::exchange::atomic_write(path, &serde_json::to_vec_pretty(&envelope).map_err(err)?)?;
    Ok(selected.len())
}
