mod codec;
mod snapshot;
mod transport;
use crate::{
    db::{self, Store},
    intake,
    model::*,
};
use base64::{engine::general_purpose::STANDARD, Engine};
pub use codec::{decode, encode};
use flate2::{bufread::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub use snapshot::{apply, formal_questions, versions, Snapshot};
use std::{
    collections::HashSet,
    io::{Read, Write},
};
pub use transport::request;

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
        if !endpoint.is_empty() {
            tx.execute(
                "INSERT INTO intake_transfers(batch_id,raw) VALUES(?1,?2)",
                params![batch, raw],
            )
            .map_err(err)?;
        }
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
        || !["merged", "duplicate"].contains(&receipt["status"].as_str().unwrap_or(""))
        || chrono::DateTime::parse_from_rfc3339(receipt["accepted_at"].as_str().unwrap_or(""))
            .is_err()
        || chrono::DateTime::parse_from_rfc3339(receipt["merged_at"].as_str().unwrap_or(""))
            .is_err()
        || !receipt["revision"]
            .as_u64()
            .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
        || !receipt["release_version"]
            .as_u64()
            .is_some_and(|n| n > 0 && Some(n) <= receipt["revision"].as_u64())
        || receipt["added_count"].as_u64().and_then(|a| {
            receipt["duplicate_count"]
                .as_u64()
                .and_then(|b| a.checked_add(b))
        }) != Some(d.question_count as u64)
        || !receipt["release_name"]
            .as_str()
            .is_some_and(|name| !name.trim().is_empty() && name.chars().count() <= 220)
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
