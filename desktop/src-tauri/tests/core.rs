use question_bank::{
    db::{self, Query, Store},
    exchange,
    model::*,
};
use serde_json::json;
use std::io::{Cursor, Read};

#[test]
fn ordered_fts_matches_a_full_scan_with_mixed_terms_filters_and_cursors() {
    let (_dir, store) = setup();
    let banks = [store.create("甲").unwrap(), store.create("乙").unwrap()];
    let mut conn = store.conn().unwrap();
    let tx = conn.transaction().unwrap();
    let mut corpus = Vec::new();
    for i in 0..777 {
        let mut q = sample();
        q.prepare();
        q.stem = format!(
            "中文检索 service{:03} @Component {} {}",
            i % 19,
            if i % 7 == 0 { "Ωξ" } else { "常用" },
            if i % 11 == 0 {
                "连续 短语"
            } else {
                "短语 连续"
            }
        );
        let bank = banks[i % 2].clone();
        db::insert(&tx, &bank, &q).unwrap();
        let row = tx.last_insert_rowid();
        let deleted = i % 17 == 0;
        if deleted {
            tx.execute("UPDATE questions SET deleted=1 WHERE rowid=?1", [row])
                .unwrap();
        }
        corpus.push((row, bank, deleted, q.search_text()));
    }
    tx.commit().unwrap();
    for text in [
        "中",
        "中文",
        "Ωξ @Component",
        "中 service007",
        "罕 @Component",
        "中 不存在",
        "\"连续 短语\"",
        "中文 Ωξ service007",
        "@Component 短语",
        "=不存在",
    ] {
        for bank in ["", banks[0].as_str(), banks[1].as_str()] {
            let terms = db::query_terms(&normalize(text));
            let expected: Vec<_> = corpus
                .iter()
                .filter(|(_, b, d, t)| {
                    !*d && (bank.is_empty() || b == bank) && terms.iter().all(|s| t.contains(s))
                })
                .map(|(row, _, _, _)| *row)
                .collect();
            for loaded in [0, 50, 100] {
                let after_rowid = if loaded == 0 {
                    0
                } else {
                    expected.get(loaded - 1).copied().unwrap_or(i64::MAX)
                };
                let result = store
                    .search(&Query {
                        text: text.into(),
                        bank_id: bank.into(),
                        after_rowid,
                        ..Default::default()
                    })
                    .unwrap();
                assert_eq!(
                    result.items.iter().map(|h| h.rowid).collect::<Vec<_>>(),
                    expected
                        .iter()
                        .copied()
                        .skip(loaded)
                        .take(50)
                        .collect::<Vec<_>>(),
                    "{text} {bank} {after_rowid}"
                );
                assert_eq!(result.has_more, expected.len() > loaded + 50);
            }
        }
    }
}
fn sample() -> Question {
    serde_json::from_str::<Vec<Question>>(include_str!("../resources/examples.json"))
        .unwrap()
        .remove(0)
}
fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(dir.path().join("test.sqlite")).unwrap();
    (dir, s)
}
fn find(s: &Store, text: &str) -> Vec<String> {
    s.search(&Query {
        text: text.into(),
        ..Default::default()
    })
    .unwrap()
    .items
    .iter()
    .map(|h| h.question.stem.clone())
    .collect()
}

#[test]
fn migrated_sources_are_complete_and_searchable() {
    let (_dir, s) = setup();
    s.seed().unwrap();
    assert_eq!(s.banks().unwrap()[0].count, 914);
    s.seed().unwrap();
    assert_eq!(s.banks().unwrap()[0].count, 914);
    assert!(!find(&s, "onSaveState").is_empty());
    let qs = s.questions(&s.banks().unwrap()[0].id).unwrap();
    assert!(qs.iter().any(|q| q.external_id == "J-050"));
    assert!(qs.iter().all(|q| q.validate(true).is_ok()));
    for q in &qs {
        let ids: std::collections::HashSet<_> = q.options.iter().map(|o| &o.option_id).collect();
        assert_eq!(
            ids.len(),
            q.options.len(),
            "{} duplicate option ID",
            q.external_id
        )
    }
}

#[test]
fn search_cjk_short_substrings_symbols_and_atomic_edits() {
    let (_dir, s) = setup();
    let b = s.create("测试").unwrap();
    let mut q = sample();
    q.stem = "这是中文检索功能！使用 @Component.foo() 保留符号".into();
    let id = s.save(&b, q.clone()).unwrap();
    for term in [
        "中",
        "中文",
        "文检索",
        "@component.foo()",
        "！",
        "功能 @Component",
        "\"中文检索\"",
        "@",
    ] {
        assert_eq!(find(&s, term).len(), 1, "{term}");
    }
    assert!(find(&s, "不存在").is_empty());
    assert!(find(&s, "中文 @Entry").is_empty());
    q = s.questions(&b).unwrap().remove(0);
    q.stem = "更新后独特内容".into();
    s.save(&b, q.clone()).unwrap();
    assert!(find(&s, "@Component").is_empty());
    assert_eq!(find(&s, "独特").len(), 1);
    assert!(s.save(&b, q).is_err());
    let row = s.search(&Query::default()).unwrap().items[0].rowid;
    s.delete(row).unwrap();
    assert!(find(&s, "独特").is_empty());
    s.reindex().unwrap();
    assert!(find(&s, "独特").is_empty());
    let history = s.history(&b, &id).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["reason"], "删除");
    assert_eq!(history[1]["reason"], "编辑");
}

#[test]
fn explanation_is_preserved_but_not_searched_after_edits_reindex_or_package_export() {
    let (dir, s) = setup();
    let b = s.create("搜索范围").unwrap();
    let mut q = sample();
    q.stem = "跨端迁移场景".into();
    q.options[0].content = "手机视频聊天".into();
    q.explanation = "霜 雾露 银河系 解释专用值".into();
    s.save(&b, q).unwrap();
    let assert_scope = |store: &Store| {
        for term in ["霜", "雾露", "银河系", "解释专用值", "天 霜"] {
            assert!(find(store, term).is_empty(), "{term}");
        }
        assert_eq!(find(store, "天").len(), 1);
        assert_eq!(find(store, "视频聊天").len(), 1);
    };
    assert_scope(&s);
    let mut q = s.questions(&b).unwrap().remove(0);
    q.explanation.push_str(" 修改后的解析");
    s.save(&b, q).unwrap();
    s.reindex().unwrap();
    assert_scope(&s);
    assert!(find(&s, "修改后的解析").is_empty());
    let package = dir.path().join("search-scope.qbank.zip");
    exchange::export(&s, &b, &package, "package").unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(std::fs::read(package).unwrap())).unwrap();
    let mut payload = String::new();
    archive
        .by_name("questions.jsonl")
        .unwrap()
        .read_to_string(&mut payload)
        .unwrap();
    let exported: Question = serde_json::from_str(payload.lines().next().unwrap()).unwrap();
    assert_eq!(
        exported.explanation,
        s.questions(&b).unwrap()[0].explanation
    );
}

fn put_legacy_index(store: &Store) {
    let c = store.conn().unwrap();
    let mut st = c.prepare("SELECT rowid,data FROM questions").unwrap();
    let rows = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .unwrap();
    for row in rows {
        let (id, data) = row.unwrap();
        let q: Question = serde_json::from_str(&data).unwrap();
        let text = format!("{}\n{}", q.search_text(), normalize(&q.explanation));
        db::remove_index(&c, id).unwrap();
        c.execute(
            "INSERT INTO search_tri(rowid,text) VALUES(?1,?2)",
            rusqlite::params![id, text],
        )
        .unwrap();
        c.execute(
            "INSERT INTO search_short(rowid,text) VALUES(?1,?2)",
            rusqlite::params![id, short_tokens(&text)],
        )
        .unwrap();
    }
    c.execute_batch("PRAGMA user_version=2;").unwrap();
}

#[test]
fn old_indexes_upgrade_once_without_changing_questions() {
    let (_dir, s) = setup();
    let b = s.create("旧索引").unwrap();
    let mut q = sample();
    q.stem = "保留题干内容".into();
    q.explanation = "霜 雾露 银河系".into();
    s.save(&b, q.clone()).unwrap();
    q.question_id.clear();
    q.stem = "删除题干内容".into();
    s.save(&b, q).unwrap();
    let deleted = s
        .search(&Query {
            text: "删除题干".into(),
            ..Default::default()
        })
        .unwrap()
        .items[0]
        .rowid;
    s.delete(deleted).unwrap();
    put_legacy_index(&s);
    assert_eq!(find(&s, "银河系").len(), 1);
    let stored_rows = |store: &Store| {
        store
            .conn()
            .unwrap()
            .prepare("SELECT data,deleted FROM questions ORDER BY rowid")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    };
    let before = stored_rows(&s);
    let version = s.bank(&b).unwrap().version;
    for _ in 0..2 {
        let upgraded = Store::open(&s.path).unwrap();
        assert_eq!(
            upgraded
                .conn()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        for text in ["霜", "雾露", "银河系"] {
            assert!(upgraded
                .search(&Query {
                    text: text.into(),
                    ..Default::default()
                })
                .unwrap()
                .items
                .is_empty());
        }
        assert_eq!(
            upgraded
                .search(&Query {
                    text: "题干内容".into(),
                    ..Default::default()
                })
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(stored_rows(&upgraded), before);
        assert_eq!(upgraded.bank(&b).unwrap().version, version);
    }
}

#[test]
fn failed_index_upgrade_rolls_back_both_indexes_and_version_marker() {
    let (_dir, s) = setup();
    let b = s.create("迁移失败恢复").unwrap();
    let mut q = sample();
    q.explanation = "霜 银河系".into();
    s.save(&b, q).unwrap();
    put_legacy_index(&s);
    let c = s.conn().unwrap();
    let original: String = c
        .query_row("SELECT data FROM questions", [], |r| r.get(0))
        .unwrap();
    c.execute("UPDATE questions SET data='invalid json'", [])
        .unwrap();
    assert!(Store::open(&s.path).is_err());
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM search_tri WHERE search_tri MATCH ?",
            ["银河系"],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM search_short WHERE search_short MATCH ?",
            [short_query("霜")],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    c.execute("UPDATE questions SET data=?", [original])
        .unwrap();
    let upgraded = Store::open(&s.path).unwrap();
    assert!(find(&upgraded, "银河系").is_empty());
}

#[test]
fn offline_package_export_preserves_bank_identity_and_questions() {
    let (dir, store) = setup();
    let bank = store.create("离线发布").unwrap();
    store.save(&bank, sample()).unwrap();
    let path = dir.path().join("release.qbank.zip");
    assert_eq!(
        exchange::export(&store, &bank, &path, "package").unwrap(),
        1
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(std::fs::read(path).unwrap())).unwrap();
    let mut manifest = String::new();
    archive
        .by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut manifest)
        .unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["bank_id"], bank);
    assert_eq!(manifest["question_count"], 1);
    let mut payload = String::new();
    archive
        .by_name("questions.jsonl")
        .unwrap()
        .read_to_string(&mut payload)
        .unwrap();
    let exported: Question = serde_json::from_str(payload.lines().next().unwrap()).unwrap();
    assert_eq!(exported.stem, store.questions(&bank).unwrap()[0].stem);
}

#[test]
fn supported_exports_write_package_jsonl_and_print_formats() {
    let (dir, store) = setup();
    let bank = store.create("导出格式").unwrap();
    store.save(&bank, sample()).unwrap();
    for format in [
        "package",
        "jsonl",
        "docx",
        "xlsx",
        "docx-study",
        "docx-exam",
        "docx-answers",
    ] {
        let path = dir.path().join(format!("export-{format}"));
        assert_eq!(
            exchange::export(&store, &bank, &path, format).unwrap(),
            1,
            "{format}"
        );
        assert!(!std::fs::read(path).unwrap().is_empty(), "{format}");
    }
}

#[test]
fn invalid_answer_types_are_rejected() {
    let mut q = sample();
    q.answer = json!(["Z"]);
    assert!(q.validate(false).is_err());
    q.answer = json!("B");
    assert!(q.validate(false).is_err());
}

#[test]
fn cursor_continuation_and_filtering_do_not_drop_records() {
    let (_dir, s) = setup();
    let b = s.create("连续读取").unwrap();
    let mut c = s.conn().unwrap();
    let tx = c.transaction().unwrap();
    for i in 0..123 {
        let mut q = sample();
        q.prepare();
        q.stem = format!("连续读取数据 {i}");
        db::insert(&tx, &b, &q).unwrap();
    }
    tx.commit().unwrap();
    let mut ids = std::collections::HashSet::new();
    let mut after_rowid = 0;
    for batch in 0..3 {
        let result = s
            .search(&Query {
                text: "连续读取".into(),
                bank_id: b.clone(),
                kind: "single".into(),
                after_rowid,
                ..Default::default()
            })
            .unwrap();
        after_rowid = result.items.last().unwrap().rowid;
        for h in result.items {
            assert!(ids.insert(h.rowid));
        }
        assert_eq!(result.has_more, batch < 2);
    }
    assert_eq!(ids.len(), 123);
    assert!(s
        .search(&Query {
            kind: "multiple".into(),
            ..Default::default()
        })
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn migrated_bank_exports_all_supported_formats_without_losing_uncertain_answers() {
    let (dir, store) = setup();
    store.seed().unwrap();
    let bank = store.banks().unwrap()[0].id.clone();
    let original = store.questions(&bank).unwrap();
    assert_eq!(original.iter().filter(|q| q.answer.is_null()).count(), 3);
    for format in ["package", "jsonl", "docx", "xlsx"] {
        let path = dir.path().join(format!("seed.{format}"));
        assert_eq!(
            exchange::export(&store, &bank, &path, format).unwrap(),
            original.len()
        );
        assert!(!std::fs::read(path).unwrap().is_empty(), "{format}");
    }
}
