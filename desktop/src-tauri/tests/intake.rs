use question_bank::{
    db::{Query, Store},
    intake,
};
use serde_json::{json, Value};
fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(dir.path().join("test.sqlite")).unwrap();
    (dir, s)
}
fn reply() -> Value {
    json!({"format":"qbank-photo-question-1","type":"single","stem":"此 API 返回什么？","options":[{"key":"A","content":"中文 🧪"},{"key":"B","content":"字符串 \"A\""}],"answer":["B"],"answer_origin":"inferred","explanation":"测试作答依据。","model":{"name":"测试模型","version":"test-1","version_source":"user"},"warnings":[]})
}
#[test]
fn parse_model_reply_rejects_incomplete_or_unexpected_content() {
    let text = reply().to_string();
    assert!(intake::parse_reply(&format!("```json\n{text}\n```\n")).is_ok());
    for (key, value) in [
        ("answer", Value::Null),
        ("answer", json!(["C"])),
        ("photo", json!("https://example.com/image.png")),
        ("type", Value::Null),
        ("model", json!({"name":"x"})),
        ("stem", json!("【看不清】")),
    ] {
        let mut r = reply();
        r[key] = value;
        assert!(intake::parse_reply(&r.to_string()).is_err(), "{key}");
    }
}
#[test]
fn local_intake_remaps_choices_deduplicates_and_preserves_readonly_originals() {
    let (_dir, s) = setup();
    let b = s.create("初级").unwrap();
    s.conn()
        .unwrap()
        .execute("UPDATE banks SET read_only=1", [])
        .unwrap();
    let first = intake::save(&s, &b, "", &reply().to_string()).unwrap();
    assert!(first.added);
    let mut reordered = reply();
    reordered["options"] =
        json!([{"key":"A","content":"字符串 \"A\""},{"key":"B","content":"中文 🧪"}]);
    reordered["answer"] = json!(["A"]);
    let repeated = intake::save(&s, &b, &first.batch_id, &reordered.to_string()).unwrap();
    assert!(!repeated.added);
    assert_eq!(repeated.comparison.status, "duplicate");
    reordered["answer"] = json!(["B"]);
    assert_eq!(
        intake::save(&s, &b, &first.batch_id, &reordered.to_string())
            .unwrap()
            .comparison
            .status,
        "conflict"
    );
    assert_eq!(s.questions(&b).unwrap().len(), 1);
    assert_eq!(s.questions(&b).unwrap()[0].answer, json!(["B"]));
    assert_eq!(
        s.search(&Query {
            text: "API".into(),
            bank_id: b.clone(),
            ..Default::default()
        })
        .unwrap()
        .items
        .len(),
        1
    );
    let other = s.create("高级").unwrap();
    assert!(
        intake::save(&s, &other, "", &reply().to_string())
            .unwrap()
            .added
    );
    let mut new = reply();
    new["stem"] = json!("新题");
    assert!(intake::save(&s, &other, &first.batch_id, &new.to_string()).is_err());
}
#[test]
fn delta_round_trip_is_additive_idempotent_and_upload_state_is_local() {
    let (dir, s) = setup();
    let bank = s.create("同名题库").unwrap();
    let first = intake::save(&s, &bank, "", &reply().to_string()).unwrap();
    let qid = first.comparison.question.question_id;
    intake::mark_upload(&s, &bank, &qid, true).unwrap();
    let file = dir.path().join("batch.qbank-delta.json");
    assert_eq!(intake::export(&s, &first.batch_id, &file).unwrap(), 1);
    let reopened = Store::open(&s.path).unwrap();
    assert_eq!(
        intake::entries(&reopened, &first.batch_id).unwrap()[0].upload_status,
        "uploaded_manual"
    );
    let (_dest, d) = setup();
    let same_name = d.create("同名题库").unwrap();
    let got = intake::import(&d, &file).unwrap();
    assert_eq!(got.bank_id, bank);
    assert_eq!(got.added, 1);
    assert_eq!(d.questions(&same_name).unwrap().len(), 0);
    assert_eq!(intake::import(&d, &file).unwrap().skipped, 1);
    assert_eq!(d.questions(&bank).unwrap().len(), 1);
    let exported: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let export_id = exported["batch_id"].as_str().unwrap();
    assert_ne!(export_id, first.batch_id);
    assert_eq!(
        intake::entries(&d, export_id).unwrap()[0].upload_status,
        "pending"
    );
    let mut delta: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    delta["payload"] = json!("damaged");
    std::fs::write(&file, delta.to_string()).unwrap();
    assert!(intake::import(&d, &file).is_err());
    assert_eq!(d.questions(&bank).unwrap().len(), 1);
}
#[test]
fn mobile_export_imports_into_desktop_with_model_and_option_ids_intact() {
    let (dir, s) = setup();
    let file = dir.path().join("mobile.qbank-delta.json");
    std::fs::write(
        &file,
        include_str!("../../../tests/fixtures/intake/mobile-delta.json"),
    )
    .unwrap();
    let result = intake::import(&s, &file).unwrap();
    assert_eq!(result.added, 1);
    let q = &s.questions(&result.bank_id).unwrap()[0];
    assert_eq!(q.sources[0]["model"]["version"], "test-1");
    assert!(uuid::Uuid::parse_str(&q.options[0].option_id).is_ok());
}
#[test]
fn additive_json_import_is_idempotent_and_keeps_the_merged_question() {
    let (dir, source) = setup();
    let bank = source.create("题库").unwrap();
    let saved = intake::save(&source, &bank, "", &reply().to_string()).unwrap();
    let file = dir.path().join("new.qbank-delta.json");
    intake::export(&source, &saved.batch_id, &file).unwrap();
    let (_other, target) = setup();
    target
        .conn()
        .unwrap()
        .execute(
            "INSERT INTO banks VALUES(?1,'题库',1,1,'now','','')",
            [&bank],
        )
        .unwrap();
    assert_eq!(intake::import(&target, &file).unwrap().added, 1);
    assert_eq!(target.questions(&bank).unwrap().len(), 1);
    assert_eq!(intake::import(&target, &file).unwrap().skipped, 1);
}
