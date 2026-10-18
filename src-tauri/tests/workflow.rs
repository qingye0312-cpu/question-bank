use question_bank::{
    backup, cloud,
    db::{self, Query, Store},
    exchange, import_jobs, intake,
    model::*,
};
use serde_json::json;
use std::io::Read;
fn setup() -> (tempfile::TempDir, Store, String) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().join("test.sqlite")).unwrap();
    let b = s.create("测试题库").unwrap();
    (d, s, b)
}
fn question(stem: &str) -> Question {
    let mut q:Question=serde_json::from_value(json!({"type":"single","stem":stem,"options":[{"key":"A","content":"一"},{"key":"B","content":"二"}],"answer":["A"],"explanation":"解释不会进入试卷"})).unwrap();
    q.prepare();
    q
}
fn reply() -> String {
    json!({"format":"qbank-photo-question-1","type":"single","stem":"本地新增","options":[{"key":"A","content":"中文"},{"key":"B","content":"English"}],"answer":["B"],"answer_origin":"inferred","explanation":"测试","model":{"name":"Test","version":"1","version_source":"user"},"warnings":[]}).to_string()
}
fn import(s: &Store, b: &str, p: &std::path::Path, qs: &[Question]) {
    std::fs::write(
        p,
        qs.iter()
            .map(|q| serde_json::to_string(q).unwrap() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let pending = exchange::preview(s, p, b).unwrap();
    assert!(
        pending.preview.errors.is_empty(),
        "{:?}",
        pending.preview.errors
    );
    exchange::commit(s, &pending).unwrap();
}
#[test]
fn consistent_backup_restores_wal_content_and_preserves_failed_restore() {
    let (d, s, b) = setup();
    let live = s.conn().unwrap();
    s.save(&b, question("备份前")).unwrap();
    let file = d.path().join("saved.sqlite");
    assert_eq!(backup::save(&s, &file).unwrap(), 1);
    s.save(&b, question("备份后")).unwrap();
    assert_eq!(backup::restore(&s, &file).unwrap(), 1);
    assert_eq!(s.questions(&b).unwrap().len(), 1);
    let bad = d.path().join("corrupt.sqlite");
    std::fs::write(&bad, b"broken").unwrap();
    assert!(backup::restore(&s, &bad).is_err());
    assert_eq!(s.questions(&b).unwrap()[0].stem, "备份前");
    assert!(backup::save(&s, &s.path).is_err());
    for _ in 0..8 {
        backup::automatic(&s, "test").unwrap();
    }
    assert_eq!(
        std::fs::read_dir(d.path().join("backups")).unwrap().count(),
        7
    );
    drop(live);
}
#[test]
fn persisted_preview_cancel_and_selective_undo_keep_later_unrelated_edits() {
    let (d, s, b) = setup();
    let path = d.path().join("import.jsonl");
    let q = question("导入题");
    std::fs::write(&path, serde_json::to_string(&q).unwrap()).unwrap();
    let p = exchange::preview(&s, &path, &b).unwrap();
    import_jobs::save(&s, &p).unwrap();
    let reopened = Store::open(&s.path).unwrap();
    let p = import_jobs::load(&reopened, &p.preview.token).unwrap();
    let control = import_jobs::Control::default();
    control.cancel();
    assert!(exchange::commit_controlled(&s, &p, &control).is_err());
    assert!(s.questions(&b).unwrap().is_empty());
    assert_eq!(import_jobs::list(&s).unwrap().len(), 1);
    exchange::commit(&s, &p).unwrap();
    assert!(import_jobs::list(&s).unwrap().is_empty());
    let run = import_jobs::history(&s, &b).unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    s.save(&b, question("后来新增")).unwrap();
    assert_eq!(import_jobs::undo(&s, &run).unwrap(), 1);
    assert_eq!(s.questions(&b).unwrap()[0].stem, "后来新增");
    import(&s, &b, &path, &[question("随后导入")]);
    let run = import_jobs::history(&s, &b)
        .unwrap()
        .into_iter()
        .find(|r| r["undone"] == false)
        .unwrap();
    let mut q = s
        .questions(&b)
        .unwrap()
        .into_iter()
        .find(|q| q.stem == "随后导入")
        .unwrap();
    q.stem = "后来人工修改".into();
    s.save(&b, q).unwrap();
    assert!(import_jobs::undo(&s, run["id"].as_str().unwrap()).is_err());
    assert!(s
        .questions(&b)
        .unwrap()
        .iter()
        .any(|q| q.stem == "后来人工修改"));
}
#[test]
fn filters_reverse_cursor_and_print_modes_respect_the_selected_questions() {
    let (d, s, b) = setup();
    let mut c = s.conn().unwrap();
    let tx = c.transaction().unwrap();
    for i in 0..125 {
        let mut q = question(&format!("题干{i:03}"));
        q.bank = "测试题库".into();
        q.tags = vec!["标签".into()];
        q.chapter = "章节".into();
        q.difficulty = "easy".into();
        q.applicable_version = "6".into();
        db::insert(&tx, &b, &q).unwrap();
    }
    tx.commit().unwrap();
    let mut query = Query {
        bank_id: b.clone(),
        tag: "标签".into(),
        chapter: "章节".into(),
        difficulty: "easy".into(),
        applicable_version: "6".into(),
        layer: "formal".into(),
        sort: "newest".into(),
        ..Default::default()
    };
    let mut ids = vec![];
    loop {
        let page = s.search(&query).unwrap();
        ids.extend(page.items.iter().map(|h| h.rowid));
        if !page.has_more {
            break;
        }
        query.after_rowid = *ids.last().unwrap();
    }
    assert_eq!(ids.len(), 125);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        125
    );
    query.text = "题干124".into();
    for mode in ["docx-study", "docx-exam", "docx-answers"] {
        let file = d.path().join(format!("{mode}.docx"));
        assert_eq!(
            exchange::export_filtered(&s, &b, &file, mode, Some(query.clone())).unwrap(),
            1
        );
        let mut zip = zip::ZipArchive::new(std::fs::File::open(file).unwrap()).unwrap();
        let mut xml = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        if mode == "docx-exam" {
            assert!(!xml.contains("解释不会进入试卷"));
            assert!(xml.contains("题干124"));
        }
        if mode == "docx-study" {
            assert!(xml.contains("解释不会进入试卷"));
        }
        if mode == "docx-answers" {
            assert!(!xml.contains("题干124"));
        }
        assert!(!xml.contains("题干123"));
    }
}
#[test]
fn compressed_exchange_freezes_identity_and_receipt_cannot_be_forged_by_mismatch() {
    let (d, s, b) = setup();
    let entry = intake::save(&s, &b, "", &reply()).unwrap();
    let t = cloud::transfer(&s, &entry.batch_id, "https://test.invalid").unwrap();
    let bytes = serde_json::to_vec(&t["envelope"]).unwrap();
    let raw = cloud::decode(&bytes).unwrap();
    assert_eq!(
        String::from_utf8(raw.clone()).unwrap(),
        t["raw"].as_str().unwrap()
    );
    let file = d.path().join("transfer.qbank-upload.json");
    std::fs::write(&file, &bytes).unwrap();
    let (_other, dest, _) = setup();
    let result = intake::import(&dest, &file).unwrap();
    assert_eq!(result.added, 1);
    assert_eq!(
        cloud::transfer(&dest, &entry.batch_id, "https://test.invalid").unwrap()["raw"],
        t["raw"]
    );
    let delta: intake::Delta = serde_json::from_slice(&raw).unwrap();
    let receipt = json!({"submission_id":hash(format!("{}/{}",b,entry.batch_id).as_bytes()),"bank_id":b,"batch_id":entry.batch_id,"sha256":hash(&raw),"payload_sha256":delta.sha256,"question_count":1,"status":"pending_review","accepted_at":now()});
    let mut bad = receipt.clone();
    bad["sha256"] = json!("0".repeat(64));
    assert!(cloud::acknowledge(&s, &entry.batch_id, bad).is_err());
    assert_eq!(
        intake::entries(&s, &entry.batch_id).unwrap()[0].upload_status,
        "pending"
    );
    cloud::acknowledge(&s, &entry.batch_id, receipt).unwrap();
    assert_eq!(
        intake::entries(&s, &entry.batch_id).unwrap()[0].upload_status,
        "uploaded"
    );
    let original = intake::entries(&s, &entry.batch_id).unwrap().remove(0);
    let accepted_at = original.uploaded_at.clone();
    let pending = json!({"format":"qbank-snapshot-1","bank_id":b,"name":"测试题库","revision":1,"release_version":0,"updated_at":now(),"formal":null,"pending":[original.question],"removed":[]});
    let raw = pending.to_string();
    cloud::apply(&s, &raw, &hash(raw.as_bytes())).unwrap();
    assert_eq!(
        intake::entries(&s, &entry.batch_id).unwrap()[0].review_status,
        "pending"
    );
    let mut merged = pending.clone();
    merged["revision"] = json!(2);
    merged["release_version"] = json!(1);
    merged["formal"] = merged["pending"].clone();
    merged["formal"][0]["status"] = json!("verified");
    merged["pending"] = json!([]);
    merged["removed"] = json!([{"question_id":original.question.question_id,"status":"merged"}]);
    let raw = merged.to_string();
    cloud::apply(&s, &raw, &hash(raw.as_bytes())).unwrap();
    let history = intake::entries(&s, &entry.batch_id).unwrap().remove(0);
    assert_eq!(history.review_status, "merged");
    assert_eq!(history.upload_status, "uploaded");
    assert_eq!(history.uploaded_at, accepted_at);
    assert_eq!(history.question.status, original.question.status);
    let mut edited = s.questions(&b).unwrap()[0].clone();
    edited.stem = "不得改变已封存字节".into();
    assert!(s.save(&b, edited).is_err());
    assert!(cloud::transfer(&s, &entry.batch_id, "https://other.invalid").is_err());
    let mut broken = t["envelope"].clone();
    broken["uncompressed_size"] = json!(1);
    assert!(cloud::decode(&serde_json::to_vec(&broken).unwrap()).is_err());
}
#[test]
fn cloud_layers_swap_atomically_preserve_drafts_trash_and_reject_bad_updates() {
    let (_d, s, b) = setup();
    s.save(&b, question("正式题")).unwrap();
    let draft = intake::save(&s, &b, "", &reply()).unwrap();
    s.save(&b, question("回收站题")).unwrap();
    let h = s
        .search(&Query {
            bank_id: b.clone(),
            text: "回收站题".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .remove(0);
    s.delete(h.rowid, false).unwrap();
    let mut pending = question("云端候选");
    pending.bank = "测试题库".into();
    let state = json!({"format":"qbank-snapshot-1","bank_id":b,"name":"测试题库","revision":1,"release_version":0,"updated_at":now(),"formal":null,"pending":[pending],"removed":[]});
    let raw = state.to_string();
    cloud::apply(&s, &raw, &hash(raw.as_bytes())).unwrap();
    assert_eq!(s.questions(&b).unwrap().len(), 3);
    assert_eq!(
        s.search(&Query {
            bank_id: b.clone(),
            trash: true,
            ..Default::default()
        })
        .unwrap()
        .items
        .len(),
        1
    );
    assert_eq!(intake::entries(&s, &draft.batch_id).unwrap().len(), 1);
    assert_eq!(
        s.search(&Query {
            bank_id: b.clone(),
            layer: "pending".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .len(),
        1
    );
    let mut next = state.clone();
    next["revision"] = json!(2);
    next["pending"] = json!([]);
    let text = next.to_string();
    assert!(cloud::apply(&s, &text, &"0".repeat(64)).is_err());
    assert_eq!(s.questions(&b).unwrap().len(), 3);
    cloud::apply(&s, &text, &hash(text.as_bytes())).unwrap();
    assert_eq!(s.questions(&b).unwrap().len(), 2);
    assert!(cloud::apply(&s, &raw, &hash(raw.as_bytes())).is_err());
    let mut invalid = next.clone();
    invalid["revision"] = json!(3);
    let mut q = question("坏身份");
    q.bank = "测试题库".into();
    q.question_id.clear();
    invalid["pending"] = json!([q]);
    let text = invalid.to_string();
    assert!(cloud::apply(&s, &text, &hash(text.as_bytes())).is_err());
}
#[test]
fn historical_cloud_snapshot_preserves_all_seed_questions() {
    let (_d, s, _) = setup();
    let mut qs: Vec<Question> =
        serde_json::from_str(include_str!("../resources/seed.json")).unwrap();
    for q in &mut qs {
        q.prepare();
        q.sources = if q.status == "needs_review" {
            vec![json!({"kind":"published_legacy"})]
        } else {
            vec![]
        };
    }
    let id = uid();
    let raw=json!({"format":"qbank-snapshot-1","bank_id":id,"name":"HarmonyOS 初级认证","revision":1,"release_version":1,"updated_at":now(),"formal":qs,"pending":[],"removed":[]}).to_string();
    cloud::apply(&s, &raw, &hash(raw.as_bytes())).unwrap();
    assert_eq!(s.questions(&id).unwrap().len(), qs.len());
}

#[test]
fn intake_metadata_is_preserved_and_invalid_metadata_never_saves() {
    let (_d, s, b) = setup();
    let metadata = intake::Metadata {
        chapter: "组件".into(),
        tags: vec!["UI".into(), " UI ".into()],
        difficulty: "hard".into(),
        applicable_version: "API 12".into(),
        external_id: "X-1".into(),
    };
    let saved = intake::save_with_metadata(&s, &b, "", &reply(), metadata).unwrap();
    assert!(saved.added);
    let q = &intake::entries(&s, &saved.batch_id).unwrap()[0].question;
    assert_eq!(q.chapter, "组件");
    assert_eq!(q.tags, vec!["UI"]);
    assert_eq!(q.external_id, "X-1");
    assert_eq!(q.difficulty, "hard");
    let bad = intake::Metadata {
        difficulty: "invalid".into(),
        ..Default::default()
    };
    assert!(
        intake::save_with_metadata(&s, &b, "", &reply().replace("本地新增", "非法字段"), bad)
            .is_err()
    );
    assert_eq!(s.questions(&b).unwrap().len(), 1);
}
#[test]
fn offline_build_has_a_valid_updater_plugin_configuration() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let updater: tauri_plugin_updater::Config =
        serde_json::from_value(config["plugins"]["updater"].clone())
            .expect("the updater plugin must initialize even without a production update service");
    assert!(updater.endpoints.is_empty());
    assert!(updater.pubkey.is_empty());
    assert!(!updater.dangerous_insecure_transport_protocol);
    assert!(!updater.dangerous_accept_invalid_certs);
    assert!(!updater.allow_downgrades);
}

#[test]
fn software_updates_require_embedded_https_endpoint_and_a_public_signing_key() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use question_bank::updater::settings;
    assert!(settings("", "").unwrap().is_none());
    assert!(settings("https://example.com/latest.json", "").is_err());
    let mut raw = vec![0_u8; 42];
    raw[..2].copy_from_slice(b"Ed");
    let key = STANDARD.encode(format!(
        "untrusted comment: test key\n{}\n",
        STANDARD.encode(raw)
    ));
    assert!(settings("https://example.com/latest.json", &key)
        .unwrap()
        .is_some());
    for endpoint in [
        "http://example.com/latest.json",
        "file:///tmp/latest.json",
        "https://u:p@example.com/latest.json",
        "https://example.com/latest.json#key",
    ] {
        assert!(settings(endpoint, &key).is_err());
    }
}

#[test]
fn entry_time_survives_edit_and_confirmed_split_is_atomic_and_frozen() {
    let (_d, s, b) = setup();
    let mut batch = String::new();
    for n in 0..103 {
        let mut r: serde_json::Value = serde_json::from_str(&reply()).unwrap();
        r["stem"] = json!(format!("连续录题 {n}"));
        let saved = intake::save(&s, &b, &batch, &r.to_string()).unwrap();
        batch = saved.batch_id;
    }
    assert_eq!(intake::entries(&s, &batch).unwrap().len(), 103);
    let parts = cloud::prepare_batches(&s, &batch).unwrap();
    assert_eq!(parts.len(), 2);
    let mut sizes = vec![];
    for id in &parts {
        let transfer = cloud::transfer(&s, id, "https://test.example").unwrap();
        sizes.push(intake::entries(&s, id).unwrap().len());
        assert_eq!(cloud::prepare_batches(&s, id).unwrap(), vec![id.clone()]);
        assert_eq!(
            cloud::transfer(&s, id, "https://test.example").unwrap(),
            transfer
        );
    }
    assert_eq!(sizes, vec![100, 3]);
}
#[test]
fn recording_time_sort_cursor_is_stable_and_local_exports_do_not_fake_merge_time() {
    let (d, s, b) = setup();
    let mut qs = vec![];
    for n in 0..65 {
        let mut q = question(&format!("按时间 {n}"));
        q.schema_version = "1.1".into();
        q.recorded_at = Some(format!("2026-10-{:02}T00:00:00Z", 1 + n % 3));
        q.recorded_at_source = Some("source".into());
        qs.push(q);
    }
    import(&s, &b, &d.path().join("time.jsonl"), &qs);
    let mut query = Query {
        bank_id: b.clone(),
        sort: "newest".into(),
        ..Default::default()
    };
    let first = s.search(&query).unwrap();
    query.after_rowid = first.items.last().unwrap().rowid;
    let second = s.search(&query).unwrap();
    let combined: Vec<_> = first.items.into_iter().chain(second.items).collect();
    assert_eq!(combined.len(), 65);
    for pair in combined.windows(2) {
        assert!(pair[0].question.recorded_at >= pair[1].question.recorded_at);
        if pair[0].question.recorded_at == pair[1].question.recorded_at {
            assert!(pair[0].question.question_id < pair[1].question.question_id);
        }
    }
    let old = s.bank(&b).unwrap();
    let old_name = exchange::export_name(&old, &s.questions(&b).unwrap()).unwrap();
    assert_eq!(Some(old_name.clone()), old.release_name);
    let mut q = s.questions(&b).unwrap()[0].clone();
    let at = q.recorded_at.clone();
    q.explanation = "修改解析".into();
    s.save(&b, q).unwrap();
    assert_eq!(s.questions(&b).unwrap()[0].recorded_at, at);
    let new = s.bank(&b).unwrap();
    let name = exchange::export_name(&new, &s.questions(&b).unwrap()).unwrap();
    assert_ne!(name, old_name);
    assert!(name.contains("本地汇总"));
    assert_eq!(
        name,
        exchange::export_name(&s.bank(&b).unwrap(), &s.questions(&b).unwrap()).unwrap()
    );
    assert_eq!(new.merged_at, old.merged_at);
}
