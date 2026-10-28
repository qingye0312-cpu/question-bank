//! SQLite online backup includes committed WAL pages and is safe with readers.
use crate::{db::Store, model::*};
use rusqlite::{Connection, MAIN_DB};
use std::path::{Path, PathBuf};
fn copy(source: &Connection, destination: &mut Connection) -> Result<()> {
    let job = rusqlite::backup::Backup::new(source, destination).map_err(err)?;
    job.run_to_completion(128, std::time::Duration::from_millis(5), None)
        .map_err(err)
}
pub fn validate(c: &Connection) -> Result<usize> {
    let integrity: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(err)?;
    if integrity != "ok" {
        return Err("备份数据库完整性检查失败".into());
    }
    let version: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    if !(2..=4).contains(&version) {
        return Err("不支持此备份的数据库版本".into());
    }
    let mut statement = c
        .prepare("SELECT data FROM questions")
        .map_err(|_| "这不是题库数据库备份")?;
    let rows = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?;
    let mut n = 0;
    for row in rows {
        let q: Question = serde_json::from_str(&row.map_err(err)?).map_err(err)?;
        q.validate(true)?;
        n += 1;
    }
    Ok(n)
}
pub fn save(store: &Store, path: &Path) -> Result<usize> {
    if path == store.path
        || (path.exists()
            && std::fs::canonicalize(path).ok() == std::fs::canonicalize(&store.path).ok())
    {
        return Err("备份位置不能是正在使用的数据库".into());
    }
    let parent = path.parent().ok_or("备份路径无效")?;
    let temporary = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    let count = {
        let mut dest = Connection::open(temporary.path()).map_err(err)?;
        copy(&store.conn()?, &mut dest)?;
        validate(&dest)?
    };
    temporary.as_file().sync_all().map_err(err)?;
    temporary.persist(path).map_err(err)?;
    Ok(count)
}
pub fn automatic(store: &Store, reason: &str) -> Result<PathBuf> {
    let directory = store.path.with_file_name("backups");
    std::fs::create_dir_all(&directory).map_err(err)?;
    let path = directory.join(format!(
        "qbank-auto-{}-{reason}-{}.sqlite",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3f"),
        uid()
    ));
    // Before a migration, the source can have an older schema; copy it unchanged.
    store.conn()?.backup(MAIN_DB, &path, None).map_err(err)?;
    let mut files: Vec<_> = std::fs::read_dir(&directory)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("qbank-auto-") && n.ends_with(".sqlite"))
        })
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(7);
    for old in files.into_iter().take(excess) {
        std::fs::remove_file(old).map_err(err)?;
    }
    Ok(path)
}
pub fn restore(store: &Store, path: &Path) -> Result<usize> {
    // Migrate only a temporary copy; never modify the user's chosen backup.
    let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(err)?;
    validate(&source)?;
    let tmp = tempfile::tempdir().map_err(err)?;
    let staged = tmp.path().join("restore.sqlite");
    source.backup(MAIN_DB, &staged, None).map_err(err)?;
    let prepared = Store::open(&staged)?;
    prepared.reindex()?;
    let count = validate(&prepared.conn()?)?;
    automatic(store, "before-restore")?;
    let mut destination = store.conn()?;
    copy(&prepared.conn()?, &mut destination)?;
    Ok(count)
}
