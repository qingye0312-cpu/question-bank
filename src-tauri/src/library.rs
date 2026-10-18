//! Local library removal is backed up and committed together with its indexes.
use crate::{
    db::{self, Store},
    model::*,
};
use rusqlite::Connection;

fn check_removable(c: &Connection, bank_id: &str, version: i64) -> Result<()> {
    let bank = db::get_bank(c, bank_id)?;
    let cloud: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM cloud_snapshots WHERE bank_id=?1) OR EXISTS(SELECT 1 FROM cloud_baselines WHERE bank_id=?1)",
        [bank_id], |r| r.get(0),
    ).map_err(err)?;
    if bank.read_only || cloud {
        return Err("云端及发布题库不支持删除；仅可删除本地自建题库或可编辑副本".into());
    }
    let promotion: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bank_promotions WHERE bank_id=?1)",
            [bank_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if promotion {
        return Err("此题库已关联云端转换任务，请先完成原转换，不能删除".into());
    }
    let uploaded: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM intake_transfers t JOIN intake_batches b ON b.id=t.batch_id WHERE b.bank_id=?1 AND t.endpoint<>'') OR EXISTS(SELECT 1 FROM client_state s, json_each(s.value) j WHERE s.key='upload-queue' AND json_extract(j.value,'$.bankId')=?1)",
        [bank_id], |r| r.get(0),
    ).map_err(err)?;
    if uploaded {
        return Err("此题库有关联的云端上传任务，须保留题库以继续同步和核对回执".into());
    }
    if bank.version != version {
        return Err("题库已发生变化，请刷新后重新确认删除".into());
    }
    Ok(())
}

pub fn delete_local_bank(store: &Store, bank_id: &str, version: i64) -> Result<String> {
    let mut c = store.conn()?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    check_removable(&tx, bank_id, version)?;

    // Keep an independent backup, outside the rotating automatic-backup set.
    // The reserved write transaction also prevents edits during this backup.
    let directory = store.path.with_file_name("backups");
    std::fs::create_dir_all(&directory).map_err(err)?;
    let backup = directory.join(format!("qbank-deleted-{}.sqlite", uid()));
    crate::backup::save(store, &backup)?;

    db::clear_bank(&tx, bank_id)?;
    tx.execute("DELETE FROM intake_transfers WHERE batch_id IN (SELECT id FROM intake_batches WHERE bank_id=?1)", [bank_id]).map_err(err)?;
    tx.execute(
        "DELETE FROM import_changes WHERE run_id IN (SELECT id FROM import_runs WHERE bank_id=?1)",
        [bank_id],
    )
    .map_err(err)?;
    for table in [
        "intake_entries",
        "intake_batches",
        "intake_originals",
        "intake_snapshots",
        "delta_imports",
        "draft_records",
        "history",
        "snapshots",
        "imports",
        "import_runs",
        "question_layers",
        "bank_results",
        "bank_result_content",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE bank_id=?1"), [bank_id])
            .map_err(err)?;
    }
    tx.execute(
        "DELETE FROM import_jobs WHERE json_extract(data,'$.target')=?1",
        [bank_id],
    )
    .map_err(err)?;
    tx.execute(
        "DELETE FROM client_state WHERE key=?1",
        [format!("draft:{bank_id}")],
    )
    .map_err(err)?;
    tx.execute("DELETE FROM banks WHERE id=?1", [bank_id])
        .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(backup.display().to_string())
}
