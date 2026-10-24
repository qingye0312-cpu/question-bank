use super::*;
#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub release_name: Option<String>,
    #[serde(default)]
    pub release_id: Option<String>,
    #[serde(default)]
    pub rollback_at: Option<String>,
    #[serde(default)]
    pub rollback_of: Option<u64>,
    #[serde(default)]
    pub merges: Vec<Value>,
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
        .prepare("SELECT bank_id,revision FROM cloud_snapshots")
        .map_err(err)?;
    let rows=stmt.query_map([],|r|Ok(json!({"bank_id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?}))).map_err(err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(err)
}
pub fn apply(store: &Store, payload: &str, digest: &str) -> Result<()> {
    if payload.len() > 4 * 1024 * 1024 || hash(payload.as_bytes()) != digest {
        return Err("同步数据摘要或大小无效".into());
    }
    let mut s: Snapshot = serde_json::from_str(payload).map_err(err)?;
    if s.format != "qbank-snapshot-2"
        || uuid::Uuid::parse_str(&s.bank_id).is_err()
        || s.name.trim().is_empty()
        || s.revision == 0
        || s.revision > 9_007_199_254_740_991
        || s.release_version > 9_007_199_254_740_991
        || chrono::DateTime::parse_from_rfc3339(&s.updated_at).is_err()
        || s.rollback_at
            .as_deref()
            .is_some_and(|at| chrono::DateTime::parse_from_rfc3339(at).is_err())
        || s.rollback_of.is_some_and(|revision| revision == 0)
    {
        return Err("云端题库身份无效".into());
    }
    if !s.pending.is_empty()
        || s.removed.iter().any(|r| {
            r["status"] != "merged"
                || uuid::Uuid::parse_str(r["question_id"].as_str().unwrap_or("")).is_err()
        })
    {
        return Err("云端题库不支持候选层".into());
    }
    // Normalize legacy released records that contain a flagged missing answer
    // but were incorrectly labeled verified. Keep the question and issue text.
    if let Some(formal) = s.formal.as_mut() {
        for q in formal {
            if q.status == "verified"
                && q.kind != "programming"
                && q.answer.is_null()
                && !q.issues.is_empty()
            {
                q.status = "needs_review".into();
            }
        }
    }
    for qs in [s.formal.as_deref().unwrap_or(&[])] {
        let mut ids = HashSet::new();
        for q in qs {
            q.validate(q.status == "needs_review" && !q.issues.is_empty())?;
            if uuid::Uuid::parse_str(&q.question_id).is_err()
                || q.options
                    .iter()
                    .any(|o| uuid::Uuid::parse_str(&o.option_id).is_err())
                || !["unreviewed", "needs_review", "verified"].contains(&q.status.as_str())
                || q.bank != s.name
                || !ids.insert(&q.question_id)
            {
                return Err("云端题库含错误身份或重复 ID".into());
            }
        }
    }
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let old: Option<i64> = tx
        .query_row(
            "SELECT revision FROM cloud_snapshots WHERE bank_id=?1",
            [&s.bank_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if let Some(revision) = old {
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
    let converting = crate::promotion::begin_apply(&tx, &s.bank_id, &s.name, s.formal.as_deref())?;
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
    let formal = match &s.formal {
        Some(q) => {
            // The baseline is the authoritative cloud layer, not a one-time
            // import marker. Replace it on every revision, including rollback.
            tx.execute(
                "INSERT INTO cloud_baselines VALUES(?1,?2) ON CONFLICT(bank_id) DO UPDATE SET payload=excluded.payload",
                params![s.bank_id, serde_json::to_string(q).map_err(err)?],
            )
            .map_err(err)?;
            q.clone()
        }
        None => {
            let raw: Option<String> = tx
                .query_row(
                    "SELECT payload FROM cloud_baselines WHERE bank_id=?1",
                    [&s.bank_id],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if let Some(raw) = raw {
                serde_json::from_str(&raw).map_err(err)?
            } else {
                let raw = serde_json::to_string(&baseline).map_err(err)?;
                tx.execute(
                    "INSERT INTO cloud_baselines VALUES(?1,?2)",
                    params![s.bank_id, raw],
                )
                .map_err(err)?;
                baseline
            }
        }
    };
    let mut st=tx.prepare("SELECT o.data FROM intake_originals o JOIN intake_entries e ON e.bank_id=o.bank_id AND e.question_id=o.question_id WHERE o.bank_id=?1 AND o.deleted=0 AND e.upload_status='pending' ORDER BY e.created_at,o.question_id").map_err(err)?;
    let drafts = st
        .query_map([&s.bank_id], |r| r.get::<_, String>(0))
        .map_err(err)?
        .map(|r| serde_json::from_str::<Question>(&r.map_err(err)?).map_err(err))
        .collect::<Result<Vec<_>>>()?;
    drop(st);
    // Materialize search rows in the same transaction as the formal snapshot.
    // Original drafts stay separately addressable even when the formal row wins.
    db::clear_bank(&tx, &s.bank_id)?;
    tx.execute("DELETE FROM question_layers WHERE bank_id=?1", [&s.bank_id])
        .map_err(err)?;
    let mut ids = HashSet::new();
    let mut identities = HashSet::new();
    for (layer, qs) in [("formal", formal), ("draft", drafts)] {
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
        let result_at = s.rollback_at.as_deref().or(s.merged_at.as_deref());
        db::set_result(&tx, &s.bank_id, result_at, name, digest)?;
    }
    if converting {
        crate::promotion::finish_apply(&tx, &s.bank_id, digest)?;
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
