use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone)]
pub struct Store {
    pub path: PathBuf,
}
#[derive(Serialize)]
pub struct Hit {
    pub rowid: i64,
    pub layer: String,
    pub bank_id: String,
    pub bank_name: String,
    pub question: Question,
}
#[derive(Default, Clone, Deserialize)]
pub struct Query {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub bank_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub after_rowid: i64,
    #[serde(default)]
    pub chapter: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub difficulty: String,
    #[serde(default)]
    pub applicable_version: String,
    #[serde(default)]
    pub layer: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub trash: bool,
}
#[derive(Serialize)]
pub struct Results {
    pub items: Vec<Hit>,
    pub has_more: bool,
    pub elapsed_ms: f64,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(p) = path.as_ref().parent() {
            std::fs::create_dir_all(p).map_err(err)?;
        }
        let s = Self {
            path: path.as_ref().into(),
        };
        let version: i64 = s
            .conn()?
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version > 4 {
            return Err("数据库来自更高版本的程序，请更新程序后打开".into());
        }
        if version > 0 && version < 4 {
            crate::backup::automatic(&s, "migration")?;
        }
        s.conn()?.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
          CREATE TABLE IF NOT EXISTS bank_result_content(bank_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS bank_results(bank_id TEXT PRIMARY KEY,merged_at TEXT,release_name TEXT NOT NULL,release_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS banks(id TEXT PRIMARY KEY,name TEXT NOT NULL,read_only INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,content_hash TEXT NOT NULL DEFAULT '',provenance TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS questions(rowid INTEGER PRIMARY KEY,bank_id TEXT NOT NULL REFERENCES banks(id),id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,external_id TEXT NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(bank_id,id));
          CREATE INDEX IF NOT EXISTS by_bank ON questions(bank_id,deleted,kind,status);
          CREATE INDEX IF NOT EXISTS by_external ON questions(external_id);
          CREATE VIRTUAL TABLE IF NOT EXISTS search_tri USING fts5(text,tokenize='trigram',content='',contentless_delete=1);
          CREATE VIRTUAL TABLE IF NOT EXISTS search_short USING fts5(text,content='',contentless_delete=1);
          CREATE VIRTUAL TABLE IF NOT EXISTS search_tri_vocab USING fts5vocab(search_tri, 'row');
          CREATE VIRTUAL TABLE IF NOT EXISTS search_short_vocab USING fts5vocab(search_short, 'row');
          CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,bank_id TEXT NOT NULL,question_id TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS snapshots(bank_id TEXT PRIMARY KEY,bank TEXT NOT NULL,questions TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS imports(fingerprint TEXT NOT NULL,bank_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(fingerprint,bank_id));
          ").map_err(err)?;
        // v2 records the imported version so rollback cannot erase later edits.
        let mut c = s.conn()?;
        if version < 2 {
            c.execute_batch("ALTER TABLE snapshots ADD COLUMN expected_version INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=2;").map_err(err)?;
        }
        if version < 3 {
            // v3 excludes explanations from both indexes, including existing
            // and deleted questions. Commit the rebuild and marker together.
            let tx = c.transaction().map_err(err)?;
            rebuild_indexes(&tx)?;
            tx.execute_batch("PRAGMA user_version=3;").map_err(err)?;
            tx.commit().map_err(err)?;
        }
        crate::intake::initialize(&s.conn()?)?;
        crate::drafts::initialize(&s.conn()?)?;
        crate::cloud::initialize(&s.conn()?)?;
        crate::promotion::initialize(&s.conn()?)?;
        crate::import_jobs::initialize(&s.conn()?)?;
        s.conn()?
            .execute_batch("PRAGMA user_version=4;")
            .map_err(err)?;
        Ok(s)
    }
    pub fn conn(&self) -> Result<Connection> {
        let c = Connection::open(&self.path).map_err(err)?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        c.execute_batch("PRAGMA foreign_keys=ON;").map_err(err)?;
        Ok(c)
    }
    pub fn banks(&self) -> Result<Vec<Bank>> {
        let c = self.conn()?;
        let mut s = c.prepare("SELECT b.id,b.name,b.read_only,b.version,b.updated_at,b.content_hash,b.provenance,COUNT(q.rowid),COALESCE(SUM(q.status='needs_review'),0) FROM banks b LEFT JOIN questions q ON q.bank_id=b.id AND q.deleted=0 GROUP BY b.id ORDER BY b.rowid").map_err(err)?;
        let rows = s
            .query_map([], |r| {
                Ok(Bank {
                    result_content_hash: None,
                    merged_at: None,
                    release_name: None,
                    release_id: None,
                    id: r.get(0)?,
                    name: r.get(1)?,
                    read_only: r.get(2)?,
                    version: r.get(3)?,
                    updated_at: r.get(4)?,
                    content_hash: r.get(5)?,
                    provenance: r.get(6)?,
                    count: r.get(7)?,
                    review_count: r.get(8)?,
                })
            })
            .map_err(err)?;
        let mut banks = rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        for b in &mut banks {
            decorate_bank(&c, b)?;
        }
        Ok(banks)
    }
    pub fn bank(&self, id: &str) -> Result<Bank> {
        get_bank(&self.conn()?, id)
    }
    pub fn create(&self, name: &str) -> Result<String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err("题库名称须为 1 至 100 字".into());
        }
        let id = uid();
        self.conn()?
            .execute(
                "INSERT INTO banks VALUES(?1,?2,0,1,?3,'','')",
                params![id, name, now()],
            )
            .map_err(err)?;
        record_result(&self.conn()?, &id, Some(&now()), "初建")?;
        Ok(id)
    }
    pub fn seed(&self) -> Result<()> {
        if !self.banks()?.is_empty() {
            return Ok(());
        }
        let mut qs: Vec<Question> =
            serde_json::from_str(include_str!("../resources/seed.json")).map_err(err)?;
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
        let id = "ad50971f-66af-51c2-bb0e-dc798b03b369";
        tx.execute(
            "INSERT INTO banks VALUES(?1,'HarmonyOS 初级认证',1,1,?2,'','9.23 原始文档一次迁移')",
            params![id, now()],
        )
        .map_err(err)?;
        for q in &mut qs {
            q.prepare();
            q.validate(true)?;
            insert(&tx, id, q)?;
        }
        tx.commit().map_err(err)
    }
    pub fn questions(&self, id: &str) -> Result<Vec<Question>> {
        questions(&self.conn()?, id)
    }
    pub fn search(&self, q: &Query) -> Result<Results> {
        self.search_conn(&self.conn()?, q)
    }
    pub fn search_conn(&self, c: &Connection, q: &Query) -> Result<Results> {
        let started = Instant::now();
        let terms = query_terms(&normalize(&q.text));
        if terms.len() > 12 || q.text.chars().count() > 300 {
            return Err("搜索词过长，请缩短到 300 字、12 个词以内".into());
        }
        let mut tri = Vec::new();
        let mut short = Vec::new();
        for term in &terms {
            if term.chars().count() < 3 {
                short.push(short_query(term));
            } else {
                tri.push(format!("\"{}\"", term.replace('"', "\"\"")));
            }
        }
        let mut groups = Vec::new();
        if !tri.is_empty() {
            groups.push(("search_tri", tri.join(" AND ")));
        }
        if !short.is_empty() {
            groups.push(("search_short", short.join(" AND ")));
        }
        if groups.len() == 2 {
            // Estimate selectivity from live vocabulary statistics. A probe also
            // avoids scanning a broad group when the other phrase has no match.
            let mut estimates = Vec::new();
            for (table, expr) in &groups {
                let exists: bool = c
                    .query_row(
                        &format!(
                            "SELECT EXISTS(SELECT 1 FROM {table} WHERE {table} MATCH ? LIMIT 1)"
                        ),
                        [expr],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if !exists {
                    return Ok(Results {
                        items: vec![],
                        has_more: false,
                        elapsed_ms: started.elapsed().as_secs_f64() * 1000.,
                    });
                }
                let mut estimate = i64::MAX;
                for term in &terms {
                    let chars: Vec<_> = term.chars().collect();
                    let tokens: Vec<String> = if *table == "search_short" && chars.len() < 3 {
                        vec![short_query(term)]
                    } else if *table == "search_tri" && chars.len() >= 3 {
                        vec![
                            chars[..3].iter().collect(),
                            chars[chars.len() - 3..].iter().collect(),
                        ]
                    } else {
                        vec![]
                    };
                    for token in tokens {
                        let count: Option<i64> = c
                            .query_row(
                                &format!("SELECT doc FROM {table}_vocab WHERE term=?"),
                                [token],
                                |r| r.get(0),
                            )
                            .optional()
                            .map_err(err)?;
                        estimate = estimate.min(count.unwrap_or(0));
                    }
                }
                estimates.push(estimate);
            }
            if estimates[1] < estimates[0] {
                groups.swap(0, 1);
            }
        }
        // Let FTS stream row IDs in order and stop after one result batch;
        // materializing every matching row ID scales badly for frequent words.
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        let mut sql = if let Some((table, expr)) = groups.first() {
            values.push(expr.clone().into());
            format!("SELECT q.rowid,q.bank_id,b.name,q.data,COALESCE((SELECT layer FROM question_layers l WHERE l.bank_id=q.bank_id AND l.question_id=q.id),(SELECT 'draft' FROM intake_entries e WHERE e.bank_id=q.bank_id AND e.question_id=q.id),'formal') FROM {table} CROSS JOIN questions q ON q.rowid={table}.rowid JOIN banks b ON b.id=q.bank_id WHERE {table} MATCH ? AND q.deleted=?")
        } else {
            "SELECT q.rowid,q.bank_id,b.name,q.data,COALESCE((SELECT layer FROM question_layers l WHERE l.bank_id=q.bank_id AND l.question_id=q.id),(SELECT 'draft' FROM intake_entries e WHERE e.bank_id=q.bank_id AND e.question_id=q.id),'formal') FROM questions q JOIN banks b ON b.id=q.bank_id WHERE q.deleted=?".into()
        };
        values.push((q.trash as i64).into());
        for (col, val) in [
            ("q.bank_id", &q.bank_id),
            ("q.kind", &q.kind),
            ("q.status", &q.status),
        ] {
            if !val.is_empty() {
                sql.push_str(&format!(" AND {col}=?"));
                values.push(val.clone().into());
            }
        }
        for (field, value) in [
            ("chapter", &q.chapter),
            ("difficulty", &q.difficulty),
            ("applicable_version", &q.applicable_version),
        ] {
            if !value.is_empty() {
                sql.push_str(&format!(" AND json_extract(q.data,'$.{field}')=?"));
                values.push(value.clone().into());
            }
        }
        if !q.tag.is_empty() {
            sql.push_str(" AND EXISTS(SELECT 1 FROM json_each(q.data,'$.tags') WHERE value=?)");
            values.push(q.tag.clone().into());
        }
        if !q.layer.is_empty() {
            sql.push_str(" AND COALESCE((SELECT layer FROM question_layers l WHERE l.bank_id=q.bank_id AND l.question_id=q.id),(SELECT 'draft' FROM intake_entries e WHERE e.bank_id=q.bank_id AND e.question_id=q.id),'formal')=?");
            values.push(q.layer.clone().into());
        }
        for (table, expr) in groups.iter().skip(1) {
            sql.push_str(&format!(" AND EXISTS(SELECT 1 FROM {table} WHERE {table}.rowid=q.rowid AND {table} MATCH ?)"));
            values.push(expr.clone().into());
        }
        let order = groups
            .first()
            .map(|(t, _)| format!("{t}.rowid"))
            .unwrap_or("q.rowid".into());
        if q.sort == "newest" {
            // Unknown historical timestamps sort last. The cursor is looked up
            // locally; it never trusts a client-provided display time.
            let time = "COALESCE(julianday(json_extract(q.data,'$.recorded_at')),julianday(json_extract(q.data,'$.sources[0].recorded_at')),0)";
            if q.after_rowid > 0 {
                let (at, id, bank): (f64, String, String) = c
                    .query_row(
                        &format!("SELECT {time},q.id,q.bank_id FROM questions q WHERE q.rowid=?1"),
                        [q.after_rowid],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .map_err(err)?;
                sql.push_str(&format!(
                    " AND ({time}<? OR ({time}=? AND (q.id>? OR (q.id=? AND q.bank_id>?))))"
                ));
                values.extend([
                    at.into(),
                    at.into(),
                    id.clone().into(),
                    id.into(),
                    bank.into(),
                ]);
            }
            sql.push_str(&format!(
                " ORDER BY {time} DESC,q.id ASC,q.bank_id ASC LIMIT 51"
            ));
        } else {
            if q.after_rowid > 0 {
                sql.push_str(&format!(" AND {order}>?"));
                values.push(q.after_rowid.into());
            }
            sql.push_str(&format!(" ORDER BY {order} ASC LIMIT 51"));
        }
        let mut st = c.prepare(&sql).map_err(err)?;
        let rows = st
            .query_map(rusqlite::params_from_iter(values), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(err)?;
        let mut items = Vec::new();
        for r in rows {
            let (rowid, bank_id, bank_name, data, layer) = r.map_err(err)?;
            items.push(Hit {
                rowid,
                bank_id,
                bank_name,
                layer,
                question: serde_json::from_str(&data).map_err(err)?,
            });
        }
        let has_more = items.len() > 50;
        items.truncate(50);
        Ok(Results {
            items,
            has_more,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.,
        })
    }
    pub fn save(&self, bank_id: &str, mut q: Question) -> Result<String> {
        let bank = self.bank(bank_id)?;
        if bank.read_only {
            return Err("发布题库只读，请先建立可编辑副本".into());
        }
        let is_draft: bool = self
            .conn()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM draft_records WHERE id=?1)",
                [&q.question_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if is_draft {
            return Err("请在录题记录中编辑本题，避免覆盖未上传草稿".into());
        }
        q.validate(false)?;
        q.prepare();
        q.bank = bank.name;
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
        let frozen:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM intake_entries e JOIN intake_transfers t ON t.batch_id=e.batch_id WHERE e.bank_id=?1 AND e.question_id=?2 AND t.endpoint<>'')",params![bank_id,q.question_id],|r|r.get(0)).map_err(err)?;
        if frozen {
            return Err("本题所在批次已导出或提交，请通过新的录题批次提交修改".into());
        }
        let old: Option<(i64, String)> = tx
            .query_row(
                "SELECT rowid,data FROM questions WHERE bank_id=?1 AND id=?2 AND deleted=0",
                params![bank_id, q.question_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        if let Some((rowid, data)) = old {
            let previous: Question = serde_json::from_str(&data).map_err(err)?;
            if previous.base_revision != q.base_revision {
                return Err("题目已发生变化，请重新打开再编辑".into());
            }
            record(&tx, bank_id, &previous, "编辑")?;
            q.recorded_at = previous.recorded_at.clone();
            q.recorded_at_source = previous.recorded_at_source.clone();
            q.recover_recorded_at(None);
            q.updated_at = Some(now());
            q.base_revision += 1;
            remove_index(&tx, rowid)?;
            tx.execute(
                "UPDATE questions SET kind=?1,status=?2,external_id=?3,data=?4 WHERE rowid=?5",
                params![
                    q.kind,
                    q.status,
                    q.external_id,
                    serde_json::to_string(&q).map_err(err)?,
                    rowid
                ],
            )
            .map_err(err)?;
            index(&tx, rowid, &q)?;
        } else {
            q.recorded_at = Some(now());
            q.recorded_at_source = Some("local".into());
            q.schema_version = "1.1".into();
            q.updated_at = q.recorded_at.clone();
            insert(&tx, bank_id, &q)?;
        }
        tx.execute(
            "UPDATE intake_originals SET data=?1 WHERE bank_id=?2 AND question_id=?3",
            params![
                serde_json::to_string(&q).map_err(err)?,
                bank_id,
                q.question_id
            ],
        )
        .map_err(err)?;
        touch(&tx, bank_id)?;
        tx.commit().map_err(err)?;
        Ok(q.question_id)
    }
    pub fn delete(&self, rowid: i64, restore: bool) -> Result<()> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
        let (bank_id,data,readonly):(String,String,bool)=tx.query_row("SELECT q.bank_id,q.data,b.read_only FROM questions q JOIN banks b ON b.id=q.bank_id WHERE q.rowid=?1",[rowid],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(err)?;
        if readonly {
            return Err("发布题库只读，请先建立可编辑副本".into());
        }
        let q: Question = serde_json::from_str(&data).map_err(err)?;
        let frozen:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM intake_entries e JOIN intake_transfers t ON t.batch_id=e.batch_id WHERE e.bank_id=?1 AND e.question_id=?2 AND t.endpoint<>'')",params![bank_id,q.question_id],|r|r.get(0)).map_err(err)?;
        if frozen {
            return Err("本题所在批次已导出或提交，保留原题以便重试和核对回执".into());
        }
        tx.execute(
            "UPDATE intake_originals SET deleted=?1 WHERE bank_id=?2 AND question_id=?3",
            params![!restore, bank_id, q.question_id],
        )
        .map_err(err)?;
        tx.execute("UPDATE draft_records SET revision=revision+1,data=json_set(data,'$.removed',json(?3),'$.revision',revision+1,'$.updatedAt',?4) WHERE bank_id=?1 AND id=?2",params![bank_id,q.question_id,if restore {"false"}else{"true"},now()]).map_err(err)?;
        record(
            &tx,
            &bank_id,
            &q,
            if restore { "恢复" } else { "移入回收站" },
        )?;
        tx.execute(
            "UPDATE questions SET deleted=?1 WHERE rowid=?2",
            params![!restore, rowid],
        )
        .map_err(err)?;
        touch(&tx, &bank_id)?;
        tx.commit().map_err(err)
    }
    pub fn fork(&self, id: &str) -> Result<String> {
        let bank = self.bank(id)?;
        let mut qs = self.questions(id)?;
        let new = uid();
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
        tx.execute(
            "INSERT INTO banks VALUES(?1,?2,0,1,?3,'',?4)",
            params![
                new,
                format!("{} · 副本", bank.name),
                now(),
                format!("来源 {} / v{} / {}", bank.name, bank.version, bank.id)
            ],
        )
        .map_err(err)?;
        for q in &mut qs {
            q.sources.push(serde_json::json!({"bank_id":bank.id,"question_id":q.question_id,"release_version":bank.version}));
            q.question_id = uid();
            q.base_revision = 1;
            q.bank = format!("{} · 副本", bank.name);
            for o in &mut q.options {
                o.option_id = uid();
            }
            insert(&tx, &new, q)?;
        }
        record_result(&tx, &new, Some(&now()), "副本")?;
        tx.commit().map_err(err)?;
        Ok(new)
    }
    pub fn history(&self, id: &str, question_id: &str) -> Result<Vec<serde_json::Value>> {
        let c = self.conn()?;
        let mut st=c.prepare("SELECT data,at,reason FROM history WHERE bank_id=?1 AND question_id=?2 ORDER BY id DESC LIMIT 100").map_err(err)?;
        let rows = st
            .query_map(params![id, question_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?;
        rows.map(|r|{let(d,at,reason)=r.map_err(err)?;Ok(serde_json::json!({"question":serde_json::from_str::<Question>(&d).map_err(err)?,"at":at,"reason":reason}))}).collect()
    }
    pub fn rollback(&self, id: &str) -> Result<()> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cloud_snapshots WHERE bank_id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(err)?
        {
            return Err("云端题库请通过审核发布维护；本机回退会破坏同步修订，已阻止".into());
        }
        let (b, d, expected): (String, String, i64) = tx
            .query_row(
                "SELECT bank,questions,expected_version FROM snapshots WHERE bank_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "没有可以回退的上一版本".to_string())?;
        if get_bank(&tx, id)?.version != expected {
            return Err("导入后题库已有其他修改，不能直接回退。请先导出当前内容，再单独处理需要撤回的题目。".into());
        }
        let bank: Bank = serde_json::from_str(&b).map_err(err)?;
        let qs: Vec<SnapshotRow> = serde_json::from_str(&d).map_err(err)?;
        clear_bank(&tx, id)?;
        tx.execute("UPDATE banks SET name=?1,read_only=?2,version=?3,updated_at=?4,content_hash=?5,provenance=?6 WHERE id=?7",params![bank.name,bank.read_only,bank.version,bank.updated_at,bank.content_hash,bank.provenance,id]).map_err(err)?;
        for row in &qs {
            insert(&tx, id, &row.question)?;
            if row.deleted {
                tx.execute(
                    "UPDATE questions SET deleted=1 WHERE rowid=?1",
                    [tx.last_insert_rowid()],
                )
                .map_err(err)?;
            }
        }
        tx.execute("DELETE FROM snapshots WHERE bank_id=?1", [id])
            .map_err(err)?;
        tx.execute("DELETE FROM imports WHERE bank_id=?1", [id])
            .map_err(err)?;
        crate::intake::restore_snapshot(&tx, id)?;
        if let (Some(name), Some(digest)) = (&bank.release_name, &bank.release_id) {
            set_result(&tx, id, bank.merged_at.as_deref(), name, digest)?;
        } else {
            tx.execute("DELETE FROM bank_results WHERE bank_id=?1", [id])
                .map_err(err)?;
            tx.execute("DELETE FROM bank_result_content WHERE bank_id=?1", [id])
                .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
    pub fn reindex(&self) -> Result<()> {
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
        rebuild_indexes(&tx)?;
        tx.commit().map_err(err)
    }
}
fn rebuild_indexes(c: &Connection) -> Result<()> {
    c.execute_batch("DELETE FROM search_tri; DELETE FROM search_short;")
        .map_err(err)?;
    let mut st = c.prepare("SELECT rowid,data FROM questions").map_err(err)?;
    let mut rows = st.query([]).map_err(err)?;
    // Stream records instead of retaining the full bank in memory.
    while let Some(row) = rows.next().map_err(err)? {
        let id: i64 = row.get(0).map_err(err)?;
        let data: String = row.get(1).map_err(err)?;
        index(c, id, &serde_json::from_str(&data).map_err(err)?)?;
    }
    Ok(())
}
pub fn query_terms(s: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut buf = String::new();
    let mut quoted = false;
    for c in s.chars() {
        if c == '"' {
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            if !buf.is_empty() {
                terms.push(std::mem::take(&mut buf));
            }
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        terms.push(buf);
    }
    terms
}
pub fn questions(c: &Connection, id: &str) -> Result<Vec<Question>> {
    let mut s = c
        .prepare("SELECT data FROM questions WHERE bank_id=?1 AND deleted=0 ORDER BY rowid")
        .map_err(err)?;
    let rows = s.query_map([id], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect()
}
pub fn index(c: &Connection, rowid: i64, q: &Question) -> Result<()> {
    let text = q.search_text();
    c.execute(
        "INSERT INTO search_tri(rowid,text) VALUES(?1,?2)",
        params![rowid, text],
    )
    .map_err(err)?;
    c.execute(
        "INSERT INTO search_short(rowid,text) VALUES(?1,?2)",
        params![rowid, short_tokens(&text)],
    )
    .map_err(err)?;
    Ok(())
}
pub fn remove_index(c: &Connection, rowid: i64) -> Result<()> {
    c.execute("DELETE FROM search_tri WHERE rowid=?1", [rowid])
        .map_err(err)?;
    c.execute("DELETE FROM search_short WHERE rowid=?1", [rowid])
        .map_err(err)?;
    Ok(())
}
pub fn insert(c: &Connection, id: &str, q: &Question) -> Result<()> {
    c.execute(
        "INSERT INTO questions(bank_id,id,kind,status,external_id,data) VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            id,
            q.question_id,
            q.kind,
            q.status,
            q.external_id,
            serde_json::to_string(q).map_err(err)?
        ],
    )
    .map_err(err)?;
    index(c, c.last_insert_rowid(), q)
}
pub fn touch(c: &Connection, id: &str) -> Result<()> {
    c.execute(
        "UPDATE banks SET version=version+1,updated_at=?1,content_hash='' WHERE id=?2",
        params![now(), id],
    )
    .map_err(err)?;
    Ok(())
}
pub fn record(c: &Connection, id: &str, q: &Question, reason: &str) -> Result<()> {
    c.execute(
        "INSERT INTO history(bank_id,question_id,data,at,reason) VALUES(?1,?2,?3,?4,?5)",
        params![
            id,
            q.question_id,
            serde_json::to_string(q).map_err(err)?,
            now(),
            reason
        ],
    )
    .map_err(err)?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct SnapshotRow {
    question: Question,
    deleted: bool,
}
pub fn get_bank(c: &Connection, id: &str) -> Result<Bank> {
    let mut bank=c.query_row("SELECT b.id,b.name,b.read_only,b.version,b.updated_at,b.content_hash,b.provenance,(SELECT count(*) FROM questions WHERE bank_id=b.id AND deleted=0),(SELECT count(*) FROM questions WHERE bank_id=b.id AND deleted=0 AND status='needs_review') FROM banks b WHERE b.id=?1",[id],|r|Ok(Bank{result_content_hash:None,merged_at:None,release_name:None,release_id:None,id:r.get(0)?,name:r.get(1)?,read_only:r.get(2)?,version:r.get(3)?,updated_at:r.get(4)?,content_hash:r.get(5)?,provenance:r.get(6)?,count:r.get(7)?,review_count:r.get(8)?})).map_err(err)?;
    decorate_bank(c, &mut bank)?;
    Ok(bank)
}
pub fn snapshot(c: &Connection, bank: &Bank) -> Result<()> {
    let mut st = c
        .prepare("SELECT data,deleted FROM questions WHERE bank_id=?1 ORDER BY rowid")
        .map_err(err)?;
    let rows = st
        .query_map([&bank.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })
        .map_err(err)?;
    let all: Vec<SnapshotRow> = rows
        .map(|r| {
            let (data, deleted) = r.map_err(err)?;
            Ok(SnapshotRow {
                question: serde_json::from_str(&data).map_err(err)?,
                deleted,
            })
        })
        .collect::<Result<_>>()?;
    c.execute("INSERT OR REPLACE INTO snapshots(bank_id,bank,questions,expected_version) VALUES(?1,?2,?3,0)",params![bank.id,serde_json::to_string(bank).map_err(err)?,serde_json::to_string(&all).map_err(err)?]).map_err(err)?;
    crate::intake::snapshot(c, &bank.id)?;
    Ok(())
}
pub fn clear_bank(c: &Connection, id: &str) -> Result<()> {
    let ids = {
        let mut st = c
            .prepare("SELECT rowid FROM questions WHERE bank_id=?1")
            .map_err(err)?;
        let rows = st.query_map([id], |r| r.get::<_, i64>(0)).map_err(err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?
    };
    for rowid in ids {
        remove_index(c, rowid)?;
    }
    c.execute("DELETE FROM questions WHERE bank_id=?1", [id])
        .map_err(err)?;
    Ok(())
}

fn decorate_bank(c: &Connection, b: &mut Bank) -> Result<()> {
    b.result_content_hash = c
        .query_row(
            "SELECT content_hash FROM bank_result_content WHERE bank_id=?1",
            [&b.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let result: Option<(Option<String>, String, String)> = c
        .query_row(
            "SELECT merged_at,release_name,release_id FROM bank_results WHERE bank_id=?1",
            [&b.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((at, name, id)) = result {
        b.merged_at = at;
        b.release_name = Some(name);
        b.release_id = Some(id);
    } else {
        b.release_name = Some(result_name(
            None,
            &b.name,
            "历史迁移",
            &format!("v{}", b.version),
            &b.id,
            &if b.content_hash.is_empty() {
                hash(b.id.as_bytes())
            } else {
                b.content_hash.clone()
            },
        ));
    }
    Ok(())
}
pub fn set_result(
    c: &Connection,
    id: &str,
    at: Option<&str>,
    name: &str,
    digest: &str,
) -> Result<()> {
    c.execute(
        "INSERT OR REPLACE INTO bank_results VALUES(?1,?2,?3,?4)",
        params![id, at, name, digest],
    )
    .map_err(err)?;
    let mut st=c.prepare("SELECT q.data FROM questions q LEFT JOIN question_layers l ON l.bank_id=q.bank_id AND l.question_id=q.id WHERE q.bank_id=?1 AND q.deleted=0 AND (l.layer IS NULL OR l.layer='formal') ORDER BY q.rowid").map_err(err)?;
    let qs = st
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(err)?
        .map(|r| serde_json::from_str::<Question>(&r.map_err(err)?).map_err(err))
        .collect::<Result<Vec<_>>>()?;
    c.execute(
        "INSERT OR REPLACE INTO bank_result_content VALUES(?1,?2)",
        params![id, hash(&crate::exchange::jsonl(&qs)?)],
    )
    .map_err(err)?;
    Ok(())
}
pub fn record_result(c: &Connection, id: &str, at: Option<&str>, stage: &str) -> Result<()> {
    let b = get_bank(c, id)?;
    let qs = questions(c, id)?;
    let payload = crate::exchange::jsonl(&qs)?;
    let digest = hash(&payload);
    if b.release_id.as_deref() == Some(&digest) {
        return Ok(());
    }
    set_result(
        c,
        id,
        at,
        &result_name(at, &b.name, stage, &format!("v{}", b.version), id, &digest),
        &digest,
    )
}
