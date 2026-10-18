use question_bank::{cloud, db::Store, drafts, intake, model::*, promotion};
use serde_json::{json, Value};
fn setup() -> (tempfile::TempDir, Store, String) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("drafts.sqlite")).unwrap();
    let b = s.create("录题测试").unwrap();
    (d, s, b)
}
fn draft(bank: &str, stem: &str) -> Value {
    let reply = json!({"format":"qbank-photo-question-1","type":"single","stem":stem,"options":[{"key":"A","content":"一"},{"key":"B","content":"二"}],"answer":["A"],"answer_origin":"inferred","explanation":"解析","model":{"name":"test","version":"1","version_source":"user"},"warnings":[]});
    json!({"id":uid(),"bankId":bank,"revision":1,"recordedAt":"2020-01-01T00:00:00Z","updatedAt":"2020-01-01T00:00:00Z","raw":reply.to_string(),"original":reply.to_string(),"reply":reply,"metadata":{"chapter":"","tags":[],"difficulty":"","external_id":"","applicable_version":""},"sourceIssues":[],"issues":[],"removed":false,"submissionId":""})
}
fn expected(rows: &[Value]) -> Value {
    json!(rows
        .iter()
        .filter(|r| r["removed"] != true && r["submissionId"] == "")
        .map(|r| json!({"id":r["id"],"revision":r["revision"]}))
        .collect::<Vec<_>>())
}
#[test]
fn autosave_preserves_invalid_input_cas_identity_time_and_remove_undo() {
    let (_d, s, b) = setup();
    let original = drafts::save(&s, draft(&b, "原题"), 0).unwrap();
    assert_eq!(s.questions(&b).unwrap().len(), 1);
    let mut invalid = original.clone();
    invalid["revision"] = json!(2);
    invalid["reply"]["answer"] = json!([]);
    invalid["raw"] = json!("完整未完成原文");
    invalid["recordedAt"] = json!("2001-01-01T00:00:00Z");
    let saved = drafts::save(&s, invalid.clone(), 1).unwrap();
    assert_eq!(saved["recordedAt"], original["recordedAt"]);
    assert!(!saved["issues"].as_array().unwrap().is_empty());
    assert!(s.questions(&b).unwrap().is_empty());
    assert!(drafts::save(&s, invalid, 1).is_err());
    let reopened = Store::open(&s.path).unwrap();
    let rows = drafts::list(&reopened, &b).unwrap();
    assert_eq!(rows[0]["raw"], "完整未完成原文");
    assert!(drafts::enqueue(&s, &b, expected(&rows), "https://example.test", "d_admin").is_err());
    assert!(cloud::client_state(&s, "upload-queue", None)
        .unwrap()
        .is_null());
    let mut fixed = saved;
    fixed["revision"] = json!(3);
    fixed["reply"]["answer"] = json!(["B"]);
    let fixed = drafts::save(&s, fixed, 2).unwrap();
    let mut removed = fixed.clone();
    removed["revision"] = json!(4);
    removed["removed"] = json!(true);
    let mut removed = drafts::save(&s, removed, 3).unwrap();
    assert!(s.questions(&b).unwrap().is_empty());
    removed["revision"] = json!(5);
    removed["removed"] = json!(false);
    let restored = drafts::save(&s, removed, 4).unwrap();
    assert_eq!(restored["id"], original["id"]);
    assert_eq!(restored["recordedAt"], original["recordedAt"]);
    assert_eq!(s.questions(&b).unwrap().len(), 1);
    let mut impersonate = draft(&b, "非法覆盖");
    let q = intake::parse_reply(impersonate["reply"].to_string().as_str()).unwrap();
    let id = s.save(&b, q).unwrap();
    impersonate["id"] = json!(id);
    assert!(drafts::save(&s, impersonate, 0).is_err());
}
#[test]
fn final_submit_is_one_immutable_package_and_export_does_not_freeze() {
    let (d, s, b) = setup();
    for i in 0..101 {
        drafts::save(&s, draft(&b, &format!("题目 {i}")), 0).unwrap();
    }
    let mut rows = drafts::list(&s, &b).unwrap();
    let file = d.path().join("export.json");
    assert_eq!(drafts::export(&s, &b, &file).unwrap(), 101);
    assert!(
        s.conn()
            .unwrap()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM intake_transfers", [], |r| r.get(0))
            .unwrap()
            == 0
    );
    rows[0]["revision"] = json!(2);
    rows[0]["reply"]["explanation"] = json!("导出后继续改");
    drafts::save(&s, rows[0].clone(), 1).unwrap();
    assert!(drafts::enqueue(&s, &b, json!([]), "https://example.test", "d_admin").is_err());
    let rows = drafts::list(&s, &b).unwrap();
    let job = drafts::enqueue(&s, &b, expected(&rows), "https://example.test", "d_admin").unwrap();
    let id = job["id"].as_str().unwrap();
    let transfer = cloud::transfer(&s, id, "https://example.test").unwrap();
    let decoded = cloud::decode(&serde_json::to_vec(&transfer["envelope"]).unwrap()).unwrap();
    let package: Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(package["question_count"], 101);
    assert_eq!(
        cloud::client_state(&s, "upload-queue", None)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reopen = Store::open(&s.path).unwrap();
    assert_eq!(
        transfer,
        cloud::transfer(&reopen, id, "https://example.test").unwrap()
    );
    let mut old = rows[0].clone();
    old["revision"] = json!(3);
    assert!(drafts::save(&s, old, 2).is_err());
    drafts::save(&s, draft(&b, "上传期间新录入"), 0).unwrap();
    assert_eq!(
        drafts::list(&s, &b)
            .unwrap()
            .iter()
            .filter(|r| r["submissionId"] == "")
            .count(),
        1
    );
    assert_eq!(
        transfer,
        cloud::transfer(&s, id, "https://example.test").unwrap()
    );
    let mut receipt = json!({"submission_id":hash(format!("{}/{}",b,id).as_bytes()),"bank_id":b,"batch_id":id,"sha256":hash(&decoded),"payload_sha256":package["sha256"],"question_count":101,"status":"pending_merge","accepted_at":now()});
    receipt["question_count"] = json!(100);
    assert!(cloud::acknowledge(&s, id, receipt.clone()).is_err());
    receipt["question_count"] = json!(101);
    cloud::acknowledge(&s, id, receipt).unwrap();
    assert!(intake::entries(&s, id)
        .unwrap()
        .iter()
        .all(|r| r.upload_status == "uploaded"));
}
#[test]
fn oversize_session_never_splits_or_freezes_any_record() {
    let (_d, s, b) = setup();
    let seed = drafts::save(&s, draft(&b, "基准"), 0).unwrap();
    let mut c = s.conn().unwrap();
    let tx = c.transaction().unwrap();
    for _ in 1..1001 {
        let mut r = seed.clone();
        r["id"] = json!(uid());
        r["question"]["question_id"] = r["id"].clone();
        tx.execute(
            "INSERT INTO draft_records VALUES(?1,?2,1,?3)",
            rusqlite::params![r["id"].as_str(), b, r.to_string()],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let rows = drafts::list(&s, &b).unwrap();
    assert!(
        drafts::enqueue(&s, &b, expected(&rows), "https://example.test", "d_admin")
            .unwrap_err()
            .contains("1000")
    );
    assert!(cloud::client_state(&s, "upload-queue", None)
        .unwrap()
        .is_null());
    assert!(drafts::list(&s, &b)
        .unwrap()
        .iter()
        .all(|r| r["submissionId"] == ""));
}
#[test]
fn promotion_guards_one_bank_backups_and_verifies_exact_first_release() {
    let (_d, s, b) = setup();
    drafts::save(&s, draft(&b, "转换题"), 0).unwrap();
    let other = s.create("其他库").unwrap();
    let task = promotion::prepare(
        &s,
        &b,
        "https://example.test",
        "d_admin",
        s.bank(&b).unwrap().version,
    )
    .unwrap();
    assert!(std::path::Path::new(task["backup"].as_str().unwrap()).exists());
    assert!(drafts::save(&s, draft(&b, "不能改变"), 0).is_err());
    drafts::save(&s, draft(&other, "其他库可编辑"), 0).unwrap();
    let reopened = Store::open(&s.path).unwrap();
    assert_eq!(
        promotion::prepare(&reopened, &b, "https://example.test", "d_admin", 0).unwrap(),
        task
    );
    let mut snapshot = json!({"format":"qbank-snapshot-2","bank_id":b,"name":"录题测试","revision":1,"release_version":1,"updated_at":now(),"formal":task["snapshot"]["questions"],"pending":[],"removed":[]});
    snapshot["formal"][0]["chapter"] = json!("不一致");
    let raw = snapshot.to_string();
    assert!(cloud::apply(&s, &raw, &hash(raw.as_bytes())).is_err());
    assert!(!s.bank(&b).unwrap().read_only);
    assert_eq!(promotion::list(&s).unwrap()[0]["status"], "pending");
    snapshot["formal"][0]["chapter"] = json!("");
    let raw = snapshot.to_string();
    cloud::apply(&s, &raw, &hash(raw.as_bytes())).unwrap();
    assert!(s.bank(&b).unwrap().read_only);
    assert_eq!(promotion::list(&s).unwrap()[0]["status"], "done");
    assert!(drafts::list(&s, &b).unwrap()[0]["publishedAt"].is_string());
    drafts::save(&s, draft(&b, "新云端增量"), 0).unwrap();
    assert_eq!(s.questions(&b).unwrap().len(), 2);
}
#[test]
fn legacy_orphan_recovery_preserves_identity_bytes_and_does_not_upload_exports() {
    let (_d, s, b) = setup();
    let first = intake::save(&s, &b, "", &draft(&b, "历史上传")["reply"].to_string()).unwrap();
    let frozen = cloud::transfer(&s, &first.batch_id, "https://example.test").unwrap();
    let second = intake::save(&s, &b, "", &draft(&b, "历史仅导出")["reply"].to_string()).unwrap();
    cloud::transfer(&s, &second.batch_id, "").unwrap();
    assert_eq!(
        cloud::recover_legacy(&s, &b, "https://another.test", "d_old").unwrap(),
        0
    );
    assert_eq!(
        cloud::recover_legacy(&s, &b, "https://example.test", "d_old").unwrap(),
        1
    );
    assert_eq!(
        cloud::recover_legacy(&s, &b, "https://example.test", "d_other").unwrap(),
        0
    );
    let jobs = cloud::client_state(&s, "upload-queue", None).unwrap();
    assert_eq!(jobs.as_array().unwrap().len(), 1);
    assert_eq!(jobs[0]["actor"], "d_old");
    assert_eq!(jobs[0]["confirmed"], false);
    assert_eq!(
        cloud::transfer(&s, &first.batch_id, "https://example.test").unwrap(),
        frozen
    );
    let records = drafts::list(&s, &b).unwrap();
    assert_eq!(
        records
            .iter()
            .find(|r| r["id"] == second.comparison.question.question_id)
            .unwrap()["submissionId"],
        ""
    );
}
