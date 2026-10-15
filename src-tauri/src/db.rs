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
        if version > 3 {
            return Err("数据库来自更高版本的程序，请更新程序后打开".into());
        }
        s.conn()?.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
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
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
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
        let started = Instant::now();
        let c = self.conn()?;
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
            format!("SELECT q.rowid,q.bank_id,b.name,q.data FROM {table} CROSS JOIN questions q ON q.rowid={table}.rowid JOIN banks b ON b.id=q.bank_id WHERE {table} MATCH ? AND q.deleted=?")
        } else {
            "SELECT q.rowid,q.bank_id,b.name,q.data FROM questions q JOIN banks b ON b.id=q.bank_id WHERE q.deleted=?".into()
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
        for (table, expr) in groups.iter().skip(1) {
            sql.push_str(&format!(" AND EXISTS(SELECT 1 FROM {table} WHERE {table}.rowid=q.rowid AND {table} MATCH ?)"));
            values.push(expr.clone().into());
        }
        let order = groups
            .first()
            .map(|(t, _)| format!("{t}.rowid"))
            .unwrap_or("q.rowid".into());
        if q.after_rowid > 0 {
            sql.push_str(&format!(" AND {order}>?"));
            values.push(q.after_rowid.into());
        }
        sql.push_str(&format!(" ORDER BY {order} LIMIT 51"));
        let mut st = c.prepare(&sql).map_err(err)?;
        let rows = st
            .query_map(rusqlite::params_from_iter(values), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(err)?;
        let mut items = Vec::new();
        for r in rows {
            let (rowid, bank_id, bank_name, data) = r.map_err(err)?;
            items.push(Hit {
                rowid,
                bank_id,
                bank_name,
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
        q.validate(false)?;
        q.prepare();
        q.bank = bank.name;
        let mut c = self.conn()?;
        let tx = c.transaction().map_err(err)?;
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
            insert(&tx, bank_id, &q)?;
        }
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
    c.query_row("SELECT b.id,b.name,b.read_only,b.version,b.updated_at,b.content_hash,b.provenance,(SELECT count(*) FROM questions WHERE bank_id=b.id AND deleted=0),(SELECT count(*) FROM questions WHERE bank_id=b.id AND deleted=0 AND status='needs_review') FROM banks b WHERE b.id=?1",[id],|r|Ok(Bank{id:r.get(0)?,name:r.get(1)?,read_only:r.get(2)?,version:r.get(3)?,updated_at:r.get(4)?,content_hash:r.get(5)?,provenance:r.get(6)?,count:r.get(7)?,review_count:r.get(8)?})).map_err(err)
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
