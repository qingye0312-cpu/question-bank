use crate::{
    db::{self, Store},
    intake,
    model::*,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{bufread::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{Read, Write},
};

pub fn initialize(c: &rusqlite::Connection) -> Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS client_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )
    .map_err(err)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS intake_transfers(batch_id TEXT PRIMARY KEY,raw TEXT NOT NULL,endpoint TEXT NOT NULL DEFAULT '',receipt TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS intake_originals(bank_id TEXT NOT NULL,question_id TEXT NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bank_id,question_id));
 CREATE TABLE IF NOT EXISTS cloud_snapshots(bank_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cloud_baselines(bank_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS question_layers(bank_id TEXT NOT NULL,question_id TEXT NOT NULL,layer TEXT NOT NULL,PRIMARY KEY(bank_id,question_id));").map_err(err)
}
pub fn client_state(store: &Store, key: &str, value: Option<Value>) -> Result<Value> {
    if !(key.starts_with("draft:") || key == "upload-queue" || key == "publish-operations")
        || key.len() > 100
    {
        return Err("状态键无效".into());
    }
    let c = store.conn()?;
    if let Some(value) = value {
        let text = value.to_string();
        if text.len() > 8 * 1024 * 1024 {
            return Err("本地状态过大".into());
        }
        c.execute("INSERT INTO client_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,text]).map_err(err)?;
        return Ok(value);
    }
    let text: Option<String> = c
        .query_row("SELECT value FROM client_state WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    text.map(|s| serde_json::from_str(&s).map_err(err))
        .unwrap_or(Ok(Value::Null))
}

// Split only at final submission. A transaction validates every part before
// moving any question, so an oversized question cannot silently disappear.
pub fn prepare_batches(store: &Store, batch: &str) -> Result<Vec<String>> {
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let frozen: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM intake_transfers WHERE batch_id=?1)",
            [batch],
            |r| r.get(0),
        )
        .map_err(err)?;
    if frozen {
        return Ok(vec![batch.into()]);
    }
    let (bank, at): (String, String) = tx
        .query_row(
            "SELECT bank_id,created_at FROM intake_batches WHERE id=?1",
            [batch],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    let b = db::get_bank(&tx, &bank)?;
    let entries = intake::entries_conn(&tx, batch)?;
    if entries.is_empty() {
        return Err("本批次没有新题".into());
    }
    let raw_for = |qs: &[Question], id: &str| -> Result<String> {
        let mut payload = String::new();
        for q in qs {
            q.validate(false)?;
            payload.push_str(&serde_json::to_string(q).map_err(err)?);
            payload.push('\n');
        }
        serde_json::to_string(&intake::Delta {
            format: "qbank-delta-1".into(),
            bank_id: bank.clone(),
            name: b.name.clone(),
            batch_id: id.into(),
            created_at: at.clone(),
            question_count: qs.len(),
            sha256: hash(payload.as_bytes()),
            payload,
        })
        .map_err(err)
    };
    let mut chunks: Vec<Vec<Question>> = vec![vec![]];
    for e in entries {
        let current = chunks.last_mut().unwrap();
        let mut trial = current.clone();
        trial.push(e.question.clone());
        if trial.len() > 100 || encode(&raw_for(&trial, batch)?).is_err() {
            if current.is_empty() {
                return Err("有一道题超过上传大小限制，请修改后再提交".into());
            }
            encode(&raw_for(&[e.question.clone()], batch)?)?;
            chunks.push(vec![e.question]);
        } else {
            *current = trial;
        }
    }
    let split = chunks.len() > 1;
    let mut ids = vec![];
    for qs in chunks {
        let id = if split { uid() } else { batch.into() };
        let raw = raw_for(&qs, &id)?;
        encode(&raw)?;
        if split {
            tx.execute(
                "INSERT INTO intake_batches VALUES(?1,?2,?3)",
                params![id, bank, at],
            )
            .map_err(err)?;
            for q in qs {
                tx.execute(
                    "UPDATE intake_entries SET batch_id=?1 WHERE bank_id=?2 AND question_id=?3",
                    params![id, bank, q.question_id],
                )
                .map_err(err)?;
            }
        }
        tx.execute(
            "INSERT INTO intake_transfers(batch_id,raw) VALUES(?1,?2)",
            params![id, raw],
        )
        .map_err(err)?;
        ids.push(id);
    }
    tx.commit().map_err(err)?;
    Ok(ids)
}
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
    if !regex::Regex::new(r"^/(health|v1/(catalog|me|uploads|auth/desktop|banks/[0-9a-f-]{36}/(manifest|snapshot|candidates|review|publish|seed)))$").unwrap().is_match(path){return Err("不支持的云端接口".into());}
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
        .map_err(|_| "网络请求未完成，本地数据已保留，可重试")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "云端响应未接收完整")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("云端响应超过大小限制".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "云端响应不是有效 JSON")?;
    Ok(json!({"status":status,"body":value}))
}
pub fn encode(raw: &str) -> Result<Value> {
    if raw.len() > 4 * 1024 * 1024 {
        return Err("增量包超过 4 MiB".into());
    }
    let delta: intake::Delta = serde_json::from_str(raw).map_err(err)?;
    if delta.question_count > 100 {
        return Err("上传批次最多 100 题".into());
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
pub fn transfer(store: &Store, batch: &str, endpoint: &str) -> Result<Value> {
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let saved: Option<(String, String, String)> = tx
        .query_row(
            "SELECT raw,endpoint,receipt FROM intake_transfers WHERE batch_id=?1",
            [batch],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    let (raw, previous, receipt) = if let Some(saved) = saved {
        saved
    } else {
        let (bank, created): (String, String) = tx
            .query_row(
                "SELECT bank_id,created_at FROM intake_batches WHERE id=?1",
                [batch],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(err)?;
        let b = db::get_bank(&tx, &bank)?;
        let entries = intake::entries_conn(&tx, batch)?;
        if entries.is_empty() {
            return Err("本批次没有新题".into());
        }
        let mut payload = String::new();
        for e in &entries {
            e.question.validate(false)?;
            payload.push_str(&serde_json::to_string(&e.question).map_err(err)?);
            payload.push('\n');
        }
        let raw = serde_json::to_string(&intake::Delta {
            format: "qbank-delta-1".into(),
            bank_id: bank,
            name: b.name,
            batch_id: batch.into(),
            created_at: created,
            question_count: entries.len(),
            sha256: hash(payload.as_bytes()),
            payload,
        })
        .map_err(err)?;
        tx.execute(
            "INSERT INTO intake_transfers(batch_id,raw) VALUES(?1,?2)",
            params![batch, raw],
        )
        .map_err(err)?;
        (raw, String::new(), String::new())
    };
    if !previous.is_empty() && !endpoint.is_empty() && previous != endpoint {
        return Err("此批次已提交其他服务地址，不能更换目标后重试".into());
    }
    if !endpoint.is_empty() {
        tx.execute(
            "UPDATE intake_transfers SET endpoint=?1 WHERE batch_id=?2",
            params![endpoint, batch],
        )
        .map_err(err)?;
    }
    let envelope = if endpoint.is_empty() {
        Value::Null
    } else {
        encode(&raw)?
    };
    tx.commit().map_err(err)?;
    Ok(
        json!({"raw":raw,"envelope":envelope,"receipt":if receipt.is_empty(){Value::Null}else{serde_json::from_str(&receipt).map_err(err)?}}),
    )
}
pub fn acknowledge(store: &Store, batch: &str, receipt: Value) -> Result<()> {
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let raw: String = tx
        .query_row(
            "SELECT raw FROM intake_transfers WHERE batch_id=?1 AND endpoint<>''",
            [batch],
            |r| r.get(0),
        )
        .map_err(err)?;
    let d: intake::Delta = serde_json::from_str(&raw).map_err(err)?;
    if receipt["submission_id"] != hash(format!("{}/{}", d.bank_id, d.batch_id).as_bytes())
        || receipt["bank_id"] != d.bank_id
        || receipt["batch_id"] != d.batch_id
        || receipt["sha256"] != hash(raw.as_bytes())
        || receipt["payload_sha256"] != d.sha256
        || receipt["question_count"].as_u64() != Some(d.question_count as u64)
        || !["pending_review", "pending_merge"].contains(&receipt["status"].as_str().unwrap_or(""))
        || chrono::DateTime::parse_from_rfc3339(receipt["accepted_at"].as_str().unwrap_or(""))
            .is_err()
    {
        return Err("回执与本地批次不一致，未标记上传成功".into());
    }
    let current = intake::entries_conn(&tx, batch)?;
    let original: Vec<Question> = d
        .payload
        .lines()
        .map(|s| serde_json::from_str(s).map_err(err))
        .collect::<Result<_>>()?;
    if current.len() != original.len()
        || current.iter().any(|a| {
            !original
                .iter()
                .any(|b| serde_json::to_value(&a.question).ok() == serde_json::to_value(b).ok())
        })
    {
        return Err("上传期间本地题目已改变，请保留原批次并核对".into());
    }
    tx.execute(
        "UPDATE intake_transfers SET receipt=?1 WHERE batch_id=?2",
        params![receipt.to_string(), batch],
    )
    .map_err(err)?;
    tx.execute(
        "UPDATE intake_entries SET upload_status='uploaded',uploaded_at=?1 WHERE batch_id=?2",
        params![receipt["accepted_at"].as_str(), batch],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}
#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub release_name: Option<String>,
    #[serde(default)]
    pub release_id: Option<String>,
    pub format: String,
    pub bank_id: String,
    pub name: String,
    pub revision: u64,
    pub release_version: u64,
    pub updated_at: String,
    pub formal: Option<Vec<Question>>,
    pub pending: Vec<Question>,
    pub removed: Vec<Value>,
}
pub fn versions(store: &Store) -> Result<Vec<Value>> {
    let c = store.conn()?;
    let mut stmt = c
        .prepare("SELECT bank_id,revision,sha256 FROM cloud_snapshots")
        .map_err(err)?;
    let rows=stmt.query_map([],|r|Ok(json!({"bank_id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"sha256":r.get::<_,String>(2)?}))).map_err(err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(err)
}
pub fn apply(store: &Store, payload: &str, digest: &str) -> Result<()> {
    if payload.len() > 4 * 1024 * 1024 || hash(payload.as_bytes()) != digest {
        return Err("同步数据摘要或大小无效，旧版已保留".into());
    }
    let s: Snapshot = serde_json::from_str(payload).map_err(err)?;
    if !["qbank-snapshot-1", "qbank-snapshot-2"].contains(&s.format.as_str())
        || uuid::Uuid::parse_str(&s.bank_id).is_err()
        || s.name.trim().is_empty()
        || s.revision == 0
        || s.revision > 9_007_199_254_740_991
        || s.release_version > 9_007_199_254_740_991
        || chrono::DateTime::parse_from_rfc3339(&s.updated_at).is_err()
    {
        return Err("云端题库身份无效".into());
    }
    for (legacy, qs) in [
        (true, s.formal.as_deref().unwrap_or(&[])),
        (false, s.pending.as_slice()),
    ] {
        let mut ids = HashSet::new();
        for q in qs {
            q.validate(legacy)?;
            if uuid::Uuid::parse_str(&q.question_id).is_err()
                || q.options
                    .iter()
                    .any(|o| uuid::Uuid::parse_str(&o.option_id).is_err())
                || (!legacy && !["unreviewed", "verified"].contains(&q.status.as_str()))
                || q.bank != s.name
                || !ids.insert(&q.question_id)
            {
                return Err("云端题库含错误身份或重复 ID".into());
            }
        }
    }
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let old: Option<(i64, String)> = tx
        .query_row(
            "SELECT revision,sha256 FROM cloud_snapshots WHERE bank_id=?1",
            [&s.bank_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((revision, sha)) = old {
        if (s.revision as i64) < revision || (s.revision as i64 == revision && sha != digest) {
            return Err("拒绝倒退或同版本不同内容的云端更新".into());
        }
        if s.revision as i64 == revision {
            return Ok(());
        }
    }
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM banks WHERE id=?1)",
            [&s.bank_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !exists {
        tx.execute(
            "INSERT INTO banks VALUES(?1,?2,1,1,?3,'','云端题库')",
            params![s.bank_id, s.name, now()],
        )
        .map_err(err)?;
    }
    let previous = db::questions(&tx, &s.bank_id)?;
    let deleted: Vec<_> = intake::all_questions(&tx, &s.bank_id)?
        .into_iter()
        .filter(|(_, deleted)| *deleted)
        .map(|(q, _)| q)
        .collect();
    let locals = intake::local_question_ids(&tx, &s.bank_id)?;
    for q in previous.iter().filter(|q| locals.contains(&q.question_id)) {
        tx.execute(
            "INSERT OR IGNORE INTO intake_originals(bank_id,question_id,data) VALUES(?1,?2,?3)",
            params![
                s.bank_id,
                q.question_id,
                serde_json::to_string(q).map_err(err)?
            ],
        )
        .map_err(err)?;
    }
    let baseline: Vec<_> = previous
        .into_iter()
        .filter(|q| !locals.contains(&q.question_id))
        .collect();
    tx.execute(
        "INSERT OR IGNORE INTO cloud_baselines VALUES(?1,?2)",
        params![s.bank_id, serde_json::to_string(&baseline).map_err(err)?],
    )
    .map_err(err)?;
    let formal = match &s.formal {
        Some(q) => q.clone(),
        None => {
            let raw: String = tx
                .query_row(
                    "SELECT payload FROM cloud_baselines WHERE bank_id=?1",
                    [&s.bank_id],
                    |r| r.get(0),
                )
                .map_err(err)?;
            serde_json::from_str(&raw).map_err(err)?
        }
    };
    let mut st=tx.prepare("SELECT o.data FROM intake_originals o JOIN intake_entries e ON e.bank_id=o.bank_id AND e.question_id=o.question_id WHERE o.bank_id=?1 AND o.deleted=0 ORDER BY e.created_at,o.question_id").map_err(err)?;
    let drafts = st
        .query_map([&s.bank_id], |r| r.get::<_, String>(0))
        .map_err(err)?
        .map(|r| serde_json::from_str::<Question>(&r.map_err(err)?).map_err(err))
        .collect::<Result<Vec<_>>>()?;
    drop(st);
    // Materialize search rows in the same transaction as the two cloud layers.
    // Original drafts stay separately addressable even when the formal row wins.
    db::clear_bank(&tx, &s.bank_id)?;
    tx.execute("DELETE FROM question_layers WHERE bank_id=?1", [&s.bank_id])
        .map_err(err)?;
    let mut ids = HashSet::new();
    let mut identities = HashSet::new();
    for (layer, qs) in [
        ("formal", formal),
        ("pending", s.pending),
        ("draft", drafts),
    ] {
        for q in qs {
            if ids.contains(&q.question_id)
                || (layer != "formal" && identities.contains(&intake::identity(&q)))
            {
                continue;
            }
            ids.insert(q.question_id.clone());
            identities.insert(intake::identity(&q));
            db::insert(&tx, &s.bank_id, &q)?;
            tx.execute(
                "INSERT INTO question_layers VALUES(?1,?2,?3)",
                params![s.bank_id, q.question_id, layer],
            )
            .map_err(err)?;
        }
    }
    for q in deleted {
        if !ids.contains(&q.question_id) {
            db::insert(&tx, &s.bank_id, &q)?;
            tx.execute(
                "UPDATE questions SET deleted=1 WHERE bank_id=?1 AND id=?2",
                params![s.bank_id, q.question_id],
            )
            .map_err(err)?;
        }
    }
    tx.execute(
        "UPDATE banks SET name=?1,read_only=1,version=?2,updated_at=?3,content_hash=?4 WHERE id=?5",
        params![
            s.name,
            s.release_version.max(1) as i64,
            s.updated_at,
            digest,
            s.bank_id
        ],
    )
    .map_err(err)?;
    tx.execute(
        "INSERT OR REPLACE INTO cloud_snapshots VALUES(?1,?2,?3,?4)",
        params![s.bank_id, s.revision as i64, payload, digest],
    )
    .map_err(err)?;
    if let (Some(name), Some(digest)) = (&s.release_name, &s.release_id) {
        db::set_result(&tx, &s.bank_id, s.merged_at.as_deref(), name, digest)?;
    }
    tx.commit().map_err(err)
}

pub fn formal_questions(store: &Store, bank: &str) -> Result<Vec<Question>> {
    let c = store.conn()?;
    let baseline: Option<String> = c
        .query_row(
            "SELECT payload FROM cloud_baselines WHERE bank_id=?1",
            [bank],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(raw) = baseline {
        return serde_json::from_str(&raw).map_err(err);
    }
    let locals = intake::local_question_ids(&c, bank)?;
    Ok(db::questions(&c, bank)?
        .into_iter()
        .filter(|q| !locals.contains(&q.question_id))
        .collect())
}
