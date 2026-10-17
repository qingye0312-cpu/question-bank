use crate::{
    db::{self, Store},
    exchange::Pending,
    model::*,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
#[derive(Default)]
pub struct Control {
    cancelled: AtomicBool,
    progress: Mutex<Value>,
}
impl Control {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
    pub fn step(&self, phase: &str, done: usize, total: usize) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err("导入已取消，未提交的修改已回滚；可从导入任务继续".into());
        }
        *self.progress.lock().map_err(err)? = json!({"phase":phase,"done":done,"total":total});
        Ok(())
    }
    pub fn status(&self) -> Value {
        self.progress
            .lock()
            .map(|v| v.clone())
            .unwrap_or(Value::Null)
    }
}
pub fn initialize(c: &Connection) -> Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS import_jobs(token TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_runs(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL,label TEXT NOT NULL,at TEXT NOT NULL,fingerprint TEXT NOT NULL,undone INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS import_changes(run_id TEXT NOT NULL,question_id TEXT NOT NULL,before TEXT,after TEXT,PRIMARY KEY(run_id,question_id));").map_err(err)
}
pub fn save(store: &Store, p: &Pending) -> Result<()> {
    store
        .conn()?
        .execute(
            "INSERT OR REPLACE INTO import_jobs VALUES(?1,?2,?3)",
            params![
                p.preview.token,
                serde_json::to_string(p).map_err(err)?,
                now()
            ],
        )
        .map_err(err)?;
    Ok(())
}
pub fn load(store: &Store, token: &str) -> Result<Pending> {
    let raw: String = store
        .conn()?
        .query_row(
            "SELECT data FROM import_jobs WHERE token=?1",
            [token],
            |r| r.get(0),
        )
        .map_err(|_| "没有可恢复的导入任务")?;
    serde_json::from_str(&raw).map_err(err)
}
pub fn list(store: &Store) -> Result<Vec<Value>> {
    let c = store.conn()?;
    let mut st = c
        .prepare("SELECT data,created_at FROM import_jobs ORDER BY created_at DESC")
        .map_err(err)?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?;
    rows.map(|r| {
        let (data, at) = r.map_err(err)?;
        let p: Pending = serde_json::from_str(&data).map_err(err)?;
        Ok(json!({"preview":p.preview,"at":at}))
    })
    .collect()
}
#[derive(Serialize, Deserialize)]
pub struct Row {
    pub question: Question,
    pub deleted: bool,
}
pub fn rows(c: &Connection, bank: &str) -> Result<BTreeMap<String, String>> {
    let mut st = c
        .prepare("SELECT id,data,deleted FROM questions WHERE bank_id=?1")
        .map_err(err)?;
    let items = st
        .query_map([bank], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })
        .map_err(err)?;
    items
        .map(|r| {
            let (id, data, deleted) = r.map_err(err)?;
            Ok((
                id,
                serde_json::to_string(&Row {
                    question: serde_json::from_str(&data).map_err(err)?,
                    deleted,
                })
                .map_err(err)?,
            ))
        })
        .collect()
}
pub fn record(
    c: &Connection,
    bank: &str,
    label: &str,
    fingerprint: &str,
    before: &BTreeMap<String, String>,
) -> Result<()> {
    let after = rows(c, bank)?;
    let id = uid();
    let keys: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).collect();
    let mut count = 0;
    for key in keys {
        if before.get(key) != after.get(key) {
            c.execute(
                "INSERT INTO import_changes VALUES(?1,?2,?3,?4)",
                params![id, key, before.get(key), after.get(key)],
            )
            .map_err(err)?;
            count += 1;
        }
    }
    if count > 0 {
        c.execute(
            "INSERT INTO import_runs VALUES(?1,?2,?3,?4,?5,0)",
            params![id, bank, label, now(), fingerprint],
        )
        .map_err(err)?;
    }
    Ok(())
}
pub fn history(store: &Store, bank: &str) -> Result<Vec<Value>> {
    let c = store.conn()?;
    let mut st=c.prepare("SELECT r.id,r.label,r.at,r.undone,(SELECT COUNT(*) FROM import_changes WHERE run_id=r.id) FROM import_runs r WHERE bank_id=?1 ORDER BY at DESC").map_err(err)?;
    let rows=st.query_map([bank],|r|Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"at":r.get::<_,String>(2)?,"undone":r.get::<_,bool>(3)?,"count":r.get::<_,i64>(4)?}))).map_err(err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(err)
}
pub fn undo(store: &Store, run: &str) -> Result<usize> {
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let (bank, fingerprint): (String, String) = tx
        .query_row(
            "SELECT bank_id,fingerprint FROM import_runs WHERE id=?1 AND undone=0",
            [run],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "批次不存在或已撤回")?;
    if tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_snapshots WHERE bank_id=?1)",
            [&bank],
            |r| r.get::<_, bool>(0),
        )
        .map_err(err)?
    {
        return Err("已同步的云端题库请通过云端审核维护，不可在本地撤回发布".into());
    }
    let current = rows(&tx, &bank)?;
    let mut st = tx
        .prepare("SELECT question_id,before,after FROM import_changes WHERE run_id=?1")
        .map_err(err)?;
    let changes = st
        .query_map([run], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    drop(st);
    for (id, _, after) in &changes {
        if current.get(id) != after.as_ref() {
            return Err("此批次涉及的题目已有后续修改，撤回被阻止；其他批次和修改均已保留".into());
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM intake_entries e JOIN intake_transfers t ON t.batch_id=e.batch_id WHERE e.bank_id=?1 AND e.question_id=?2)",params![bank,id],|r|r.get::<_,bool>(0)).map_err(err)?{return Err("批次已导出或上传，须保留原始内容和回执，不能撤回".into());}
    }
    for (id, before, _) in &changes {
        if let Some(rowid) = tx
            .query_row(
                "SELECT rowid FROM questions WHERE bank_id=?1 AND id=?2",
                params![bank, id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(err)?
        {
            db::remove_index(&tx, rowid)?;
            tx.execute("DELETE FROM questions WHERE rowid=?1", [rowid])
                .map_err(err)?;
        }
        if let Some(data) = before {
            let row: Row = serde_json::from_str(data).map_err(err)?;
            db::insert(&tx, &bank, &row.question)?;
            tx.execute(
                "UPDATE questions SET deleted=?1 WHERE bank_id=?2 AND id=?3",
                params![row.deleted, bank, id],
            )
            .map_err(err)?;
            tx.execute("UPDATE intake_originals SET data=?1,deleted=?2 WHERE bank_id=?3 AND question_id=?4",params![serde_json::to_string(&row.question).map_err(err)?,row.deleted,bank,id]).map_err(err)?;
        } else {
            tx.execute(
                "DELETE FROM intake_entries WHERE bank_id=?1 AND question_id=?2",
                params![bank, id],
            )
            .map_err(err)?;
            tx.execute(
                "DELETE FROM intake_originals WHERE bank_id=?1 AND question_id=?2",
                params![bank, id],
            )
            .map_err(err)?;
        }
    }
    tx.execute(
        "DELETE FROM imports WHERE bank_id=?1 AND fingerprint=?2",
        params![bank, fingerprint],
    )
    .map_err(err)?;
    tx.execute(
        "DELETE FROM delta_imports WHERE bank_id=?1 AND fingerprint=?2",
        params![bank, fingerprint],
    )
    .map_err(err)?;
    tx.execute("UPDATE import_runs SET undone=1 WHERE id=?1", [run])
        .map_err(err)?;
    db::touch(&tx, &bank)?;
    tx.commit().map_err(err)?;
    Ok(changes.len())
}
