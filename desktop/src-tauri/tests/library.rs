use question_bank::{
    backup, cloud,
    db::{Query, Store},
    drafts, intake, library,
    model::*,
    promotion,
};
use serde_json::{json, Value};

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("library.sqlite")).unwrap();
    let bank = store.create("原始题库").unwrap();
    store
        .save(
            &bank,
            intake::parse_reply(&reply("原题").to_string()).unwrap(),
        )
        .unwrap();
    (dir, store, bank)
}
fn reply(stem: &str) -> Value {
    json!({"format":"qbank-photo-question-1","type":"single","stem":stem,"options":[{"key":"A","content":"一"},{"key":"B","content":"二"}],"answer":["A"],"answer_origin":"inferred","explanation":"解析","model":{"name":"test","version":"1","version_source":"user"},"warnings":[]})
}
fn draft(store: &Store, bank: &str) -> Value {
    let r = reply("副本专属草稿");
    drafts::save(store, json!({"id":uid(),"bankId":bank,"revision":1,"raw":r.to_string(),"original":r.to_string(),"reply":r,"metadata":{"chapter":"","tags":[],"difficulty":"","external_id":"","applicable_version":""},"sourceIssues":[],"issues":[],"removed":false,"submissionId":""}), 0).unwrap()
}
fn remove(store: &Store, bank: &str) -> Result<String> {
    library::delete_local_bank(store, bank, store.bank(bank)?.version)
}

#[test]
fn deleting_local_copy_removes_its_owned_records_and_indexes_and_keeps_a_restorable_backup() {
    let (dir, store, source) = setup();
    store
        .conn()
        .unwrap()
        .execute("UPDATE banks SET read_only=1 WHERE id=?1", [&source])
        .unwrap();
    let copy = store.fork(&source).unwrap();
    let r = draft(&store, &copy);
    let mut edited = store.questions(&copy).unwrap()[0].clone();
    edited.stem = "副本专属修订".into();
    store.save(&copy, edited).unwrap();
    let c = store.conn().unwrap();
    for bank in [&source, &copy] {
        cloud::client_state(
            &store,
            &format!("draft:{bank}"),
            Some(json!({"text":"保留原稿"})),
        )
        .unwrap();
    }
    let before = store.questions(&copy).unwrap().len();
    let path = remove(&store, &copy).unwrap();
    assert!(std::path::Path::new(&path).is_file());
    assert!(store.bank(&copy).is_err());
    assert_eq!(store.bank(&source).unwrap().count, 1);
    assert!(drafts::list(&store, &copy).is_err());
    assert!(cloud::client_state(&store, &format!("draft:{copy}"), None)
        .unwrap()
        .is_null());
    assert_eq!(
        cloud::client_state(&store, &format!("draft:{source}"), None).unwrap()["text"],
        "保留原稿"
    );
    for table in [
        "questions",
        "history",
        "intake_batches",
        "intake_entries",
        "intake_originals",
        "draft_records",
        "bank_results",
        "bank_result_content",
    ] {
        assert_eq!(
            c.query_row::<i64, _, _>(
                &format!("SELECT COUNT(*) FROM {table} WHERE bank_id=?1"),
                [&copy],
                |r| r.get(0)
            )
            .unwrap(),
            0,
            "{table}"
        );
    }
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
            .get(0))
            .unwrap(),
        0
    );
    assert!(store
        .search(&Query {
            text: "副本专属".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        c.query_row::<i64, _, _>("SELECT COUNT(*) FROM search_tri", [], |r| r.get(0))
            .unwrap(),
        1
    );
    let restored = Store::open(dir.path().join("restored.sqlite")).unwrap();
    backup::restore(&restored, std::path::Path::new(&path)).unwrap();
    assert_eq!(restored.bank(&copy).unwrap().count, before as i64);
    assert_eq!(drafts::list(&restored, &copy).unwrap()[0]["id"], r["id"]);
    assert_eq!(restored.bank(&source).unwrap().count, 1);
}

#[test]
fn published_and_cloud_banks_cannot_be_deleted_even_if_ui_checks_are_bypassed() {
    let (_dir, store, bank) = setup();
    let c = store.conn().unwrap();
    c.execute("UPDATE banks SET read_only=1 WHERE id=?1", [&bank])
        .unwrap();
    assert!(remove(&store, &bank).unwrap_err().contains("不支持删除"));
    c.execute("UPDATE banks SET read_only=0 WHERE id=?1", [&bank])
        .unwrap();
    c.execute(
        "INSERT INTO cloud_snapshots VALUES(?1,1,'{}','hash')",
        [&bank],
    )
    .unwrap();
    assert!(remove(&store, &bank).unwrap_err().contains("不支持删除"));
    c.execute("DELETE FROM cloud_snapshots", []).unwrap();
    c.execute("INSERT INTO cloud_baselines VALUES(?1,'{}')", [&bank])
        .unwrap();
    assert!(remove(&store, &bank).unwrap_err().contains("不支持删除"));
    assert_eq!(store.bank(&bank).unwrap().count, 1);
}

#[test]
fn pending_cloud_conversion_and_uploads_remain_recoverable() {
    let (_dir, store, bank) = setup();
    promotion::prepare(
        &store,
        &bank,
        "https://example.test",
        "d_admin",
        store.bank(&bank).unwrap().version,
    )
    .unwrap();
    assert!(remove(&store, &bank).unwrap_err().contains("转换任务"));
    assert_eq!(promotion::list(&store).unwrap()[0]["status"], "pending");
    let local = store.create("本地录题").unwrap();
    let r = draft(&store, &local);
    let job = drafts::enqueue(
        &store,
        &local,
        json!([{"id":r["id"],"revision":r["revision"]}]),
        "https://example.test",
        "d_admin",
    )
    .unwrap();
    assert!(remove(&store, &local).unwrap_err().contains("上传任务"));
    assert_eq!(
        cloud::client_state(&store, "upload-queue", None).unwrap()[0],
        job
    );
    assert_eq!(
        drafts::list(&store, &local).unwrap()[0]["submissionId"],
        job["id"]
    );
}

#[test]
fn stale_confirmation_and_backup_failure_leave_the_library_intact() {
    let (_dir, store, bank) = setup();
    let version = store.bank(&bank).unwrap().version;
    store
        .save(
            &bank,
            intake::parse_reply(&reply("新增题").to_string()).unwrap(),
        )
        .unwrap();
    assert!(library::delete_local_bank(&store, &bank, version)
        .unwrap_err()
        .contains("已发生变化"));
    std::fs::write(store.path.with_file_name("backups"), "not a directory").unwrap();
    assert!(remove(&store, &bank).is_err());
    assert_eq!(store.bank(&bank).unwrap().count, 2);
}

#[test]
fn deletion_failure_rolls_back_questions_drafts_and_search_indexes() {
    let (_dir, store, bank) = setup();
    let r = draft(&store, &bank);
    store.conn().unwrap().execute_batch("CREATE TRIGGER simulate_delete_failure BEFORE DELETE ON banks BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
    assert!(remove(&store, &bank).unwrap_err().contains("test failure"));
    assert_eq!(store.bank(&bank).unwrap().count, 2);
    assert_eq!(drafts::list(&store, &bank).unwrap()[0]["id"], r["id"]);
    assert_eq!(
        store
            .search(&Query {
                text: "副本专属".into(),
                ..Default::default()
            })
            .unwrap()
            .items
            .len(),
        1
    );
}
