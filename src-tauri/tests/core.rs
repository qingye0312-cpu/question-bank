use question_bank::{
    db::{self, Query, Store},
    exchange,
    model::*,
};
use serde_json::json;
use std::io::{Cursor, Read, Write};

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
            for trash in [false, true] {
                let terms = db::query_terms(&normalize(text));
                let expected: Vec<_> = corpus
                    .iter()
                    .filter(|(_, b, d, t)| {
                        *d == trash
                            && (bank.is_empty() || b == bank)
                            && terms.iter().all(|s| t.contains(s))
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
                            trash,
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
                        "{text} {bank} {trash} {after_rowid}"
                    );
                    assert_eq!(result.has_more, expected.len() > loaded + 50);
                }
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
    s.delete(row, false).unwrap();
    assert!(find(&s, "独特").is_empty());
    s.delete(row, true).unwrap();
    assert_eq!(find(&s, "独特").len(), 1);
    s.reindex().unwrap();
    assert_eq!(find(&s, "独特").len(), 1);
    assert!(s.history(&b, &id).unwrap().len() >= 3);
}

#[test]
fn explanation_is_preserved_but_not_searched_after_edits_reindex_or_package_import() {
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
    let (_reader_dir, reader) = setup();
    let pending = exchange::preview(&reader, &package, "").unwrap();
    let imported = exchange::commit(&reader, &pending).unwrap();
    assert_scope(&reader);
    assert_eq!(
        reader.questions(&imported).unwrap()[0].explanation,
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
fn old_indexes_upgrade_once_including_recycle_bin_without_changing_questions() {
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
    s.delete(deleted, false).unwrap();
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
            3
        );
        for trash in [false, true] {
            for text in ["霜", "雾露", "银河系"] {
                assert!(upgraded
                    .search(&Query {
                        text: text.into(),
                        trash,
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
                        trash,
                        ..Default::default()
                    })
                    .unwrap()
                    .items
                    .len(),
                1
            );
        }
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
fn every_reader_can_repackage_and_updates_are_atomic_with_rollback() {
    let (dir, author) = setup();
    let b = author.create("发布测试").unwrap();
    author.save(&b, sample()).unwrap();
    let p1 = dir.path().join("v1.qbank.zip");
    exchange::export(&author, &b, &p1, "package").unwrap();
    let (_reader_dir, reader) = setup();
    let p = exchange::preview(&reader, &p1, "").unwrap();
    assert!(p.preview.errors.is_empty());
    let id = exchange::commit(&reader, &p).unwrap();
    assert!(reader.bank(&id).unwrap().read_only);
    assert!(reader.save(&id, sample()).is_err());
    let rp = dir.path().join("reader.qbank.zip");
    exchange::export(&reader, &id, &rp, "package").unwrap();
    let (_third_dir, third) = setup();
    let p = exchange::preview(&third, &rp, "").unwrap();
    assert!(p.preview.errors.is_empty());
    exchange::commit(&third, &p).unwrap();
    assert_eq!(
        serde_json::to_value(author.questions(&b).unwrap()).unwrap(),
        serde_json::to_value(third.questions(&b).unwrap()).unwrap()
    );
    let duplicate = exchange::preview(&reader, &p1, "").unwrap();
    assert!(duplicate.preview.action.contains("跳过"));
    exchange::commit(&reader, &duplicate).unwrap();
    assert_eq!(reader.bank(&id).unwrap().count, 1);
    let mut q = author.questions(&b).unwrap().remove(0);
    q.stem = "新版变更".into();
    author.save(&b, q).unwrap();
    let p2 = dir.path().join("v2.qbank.zip");
    exchange::export(&author, &b, &p2, "package").unwrap();
    let p = exchange::preview(&reader, &p2, "").unwrap();
    assert_eq!(p.preview.changed, 1);
    exchange::commit(&reader, &p).unwrap();
    assert_eq!(find(&reader, "新版变更").len(), 1);
    assert!(!exchange::preview(&reader, &p1, "")
        .unwrap()
        .preview
        .errors
        .is_empty());
    reader.rollback(&id).unwrap();
    assert!(find(&reader, "新版变更").is_empty());
    assert_eq!(reader.bank(&id).unwrap().count, 1);
    let fork = reader.fork(&id).unwrap();
    assert!(!reader.bank(&fork).unwrap().read_only);
    assert_ne!(
        reader.questions(&id).unwrap()[0].question_id,
        reader.questions(&fork).unwrap()[0].question_id
    );
    exchange::export(
        &reader,
        &fork,
        &dir.path().join("fork.qbank.zip"),
        "package",
    )
    .unwrap();
}

#[test]
fn damaged_package_is_rejected_before_any_mutation() {
    let (dir, s) = setup();
    let b = s.create("完整性").unwrap();
    s.save(&b, sample()).unwrap();
    let data = exchange::package_bytes(&s.bank(&b).unwrap(), &s.questions(&b).unwrap()).unwrap();
    let mut old = zip::ZipArchive::new(Cursor::new(data)).unwrap();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..old.len() {
        let mut f = old.by_index(i).unwrap();
        let mut d = Vec::new();
        f.read_to_end(&mut d).unwrap();
        if f.name() == "questions.jsonl" {
            d.extend(b" ");
        }
        out.start_file(f.name(), zip::write::SimpleFileOptions::default())
            .unwrap();
        out.write_all(&d).unwrap();
    }
    let path = dir.path().join("tampered.qbank.zip");
    std::fs::write(&path, out.finish().unwrap().into_inner()).unwrap();
    assert!(exchange::preview(&s, &path, "")
        .err()
        .unwrap()
        .contains("校验失败"));
    assert_eq!(s.bank(&b).unwrap().count, 1);
}

#[test]
fn office_and_jsonl_roundtrip_preserve_multiline_content_and_answers() {
    let (dir, s) = setup();
    let b = s.create("交换测试").unwrap();
    let mut examples: Vec<Question> =
        serde_json::from_str(include_str!("../resources/examples.json")).unwrap();
    examples[0].stem = "=SUM(A1:A2)\n<Component attr=\"安全\"> & literal".into();
    for q in examples {
        s.save(&b, q).unwrap();
    }
    for format in ["xlsx", "docx", "jsonl"] {
        let path = dir.path().join(format!("exchange.{format}"));
        exchange::export(&s, &b, &path, format).unwrap();
        let (_other_dir, other) = setup();
        let p = exchange::preview(&other, &path, "").unwrap();
        assert!(
            p.preview.errors.is_empty(),
            "{format}: {:?}",
            p.preview.errors
        );
        let new = exchange::commit(&other, &p).unwrap();
        assert_eq!(
            serde_json::to_value(s.questions(&b).unwrap()).unwrap(),
            serde_json::to_value(other.questions(&new).unwrap()).unwrap(),
            "{format}"
        );
    }
}

#[test]
fn import_preview_is_all_or_nothing_and_revision_guarded() {
    let (dir, s) = setup();
    let b = s.create("事务").unwrap();
    s.save(&b, sample()).unwrap();
    let path = dir.path().join("batch.jsonl");
    exchange::export(&s, &b, &path, "jsonl").unwrap();
    let mut qs = s.questions(&b).unwrap();
    qs[0].stem = "批次更新".into();
    std::fs::write(&path, serde_json::to_string(&qs[0]).unwrap()).unwrap();
    let p = exchange::preview(&s, &path, &b).unwrap();
    s.save(&b, sample()).unwrap();
    assert!(exchange::commit(&s, &p).is_err());
    assert!(find(&s, "批次更新").is_empty());
    std::fs::write(
        &path,
        format!(
            "{}\n{{\"bad\":true}}",
            serde_json::to_string(&qs[0]).unwrap()
        ),
    )
    .unwrap();
    let p = exchange::preview(&s, &path, &b).unwrap();
    assert!(!p.preview.errors.is_empty());
    assert!(exchange::commit(&s, &p).is_err());
    assert_eq!(s.bank(&b).unwrap().count, 2);
}

#[test]
fn invalid_answer_types_and_formula_cells_fail() {
    let mut q = sample();
    q.answer = json!(["Z"]);
    assert!(q.validate(false).is_err());
    q.answer = json!("B");
    assert!(q.validate(false).is_err());
    let (dir, s) = setup();
    let mut wb = rust_xlsxwriter::Workbook::new();
    let info = wb.add_worksheet().set_name("填写说明").unwrap();
    info.write_string(0, 0, "模板版本").unwrap();
    info.write_string(0, 1, "1.0").unwrap();
    let sheet = wb.add_worksheet().set_name("题目").unwrap();
    for (j, h) in exchange::HEADERS.iter().enumerate() {
        sheet.write_string(0, j as u16, *h).unwrap();
    }
    sheet.write_formula(1, 4, "=1+1").unwrap();
    sheet.write_string(1, 1, "判断").unwrap();
    sheet.write_string(1, 13, "正确").unwrap();
    let path = dir.path().join("formulas.xlsx");
    wb.save(&path).unwrap();
    let p = exchange::preview(&s, &path, "").unwrap();
    assert!(p.preview.errors.iter().any(|e| e.contains("公式")));
    assert!(exchange::commit(&s, &p).is_err());
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
fn migrated_bank_roundtrips_in_all_formats_without_losing_uncertain_answers() {
    let (dir, s) = setup();
    s.seed().unwrap();
    let id = s.banks().unwrap()[0].id.clone();
    let original = s.questions(&id).unwrap();
    assert_eq!(original.iter().filter(|q| q.answer.is_null()).count(), 3);
    for format in ["package", "jsonl", "docx", "xlsx"] {
        let path = dir.path().join(if format == "package" {
            "seed.qbank.zip".into()
        } else {
            format!("seed.{format}")
        });
        exchange::export(&s, &id, &path, format).unwrap();
        let (_rdir, r) = setup();
        let p = exchange::preview(&r, &path, "").unwrap();
        assert!(
            p.preview.errors.is_empty(),
            "{format}: {:?}",
            p.preview.errors
        );
        let b = exchange::commit(&r, &p).unwrap();
        assert_eq!(
            serde_json::to_value(&original).unwrap(),
            serde_json::to_value(r.questions(&b).unwrap()).unwrap(),
            "{format}"
        );
        let again = exchange::preview(&r, &path, "").unwrap();
        assert!(again.preview.errors.is_empty());
        assert!(again.preview.action.contains("跳过"));
        exchange::commit(&r, &again).unwrap();
        assert_eq!(r.banks().unwrap().len(), 1);
    }
}

#[test]
fn rollback_preserves_recycle_bin_and_rejects_missing_update_revision() {
    let (dir, s) = setup();
    let b = s.create("回退检查").unwrap();
    s.save(&b, sample()).unwrap();
    let hit = s.search(&Query::default()).unwrap().items.remove(0);
    s.delete(hit.rowid, false).unwrap();
    let path = dir.path().join("new.jsonl");
    std::fs::write(&path, serde_json::to_string(&sample()).unwrap()).unwrap();
    let p = exchange::preview(&s, &path, &b).unwrap();
    exchange::commit(&s, &p).unwrap();
    s.rollback(&b).unwrap();
    assert_eq!(s.bank(&b).unwrap().count, 0);
    assert_eq!(
        s.search(&Query {
            trash: true,
            ..Default::default()
        })
        .unwrap()
        .items
        .len(),
        1
    );
    let mut q = serde_json::to_value(hit.question).unwrap();
    q.as_object_mut().unwrap().remove("base_revision");
    std::fs::write(&path, q.to_string()).unwrap();
    let p = exchange::preview(&s, &path, "").unwrap();
    assert!(p.preview.errors.iter().any(|e| e.contains("基准修订号")));
}

#[test]
fn downloadable_templates_match_the_import_contract() {
    let (_dir, s) = setup();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    for file in [
        "templates/题库导入模板_v1.docx",
        "templates/题库导入示例_v1.jsonl",
        "src-tauri/tests/fixtures/excel-filled-test.xlsx",
    ] {
        let p = exchange::preview(&s, &root.join(file), "").unwrap();
        assert!(
            p.preview.errors.is_empty(),
            "{file}: {:?}",
            p.preview.errors
        );
        assert_eq!(p.preview.count, 3);
    }
    let p = exchange::preview(&s, &root.join("templates/题库导入模板_v1.xlsx"), "").unwrap();
    assert_eq!(p.preview.count, 0);
    assert_eq!(p.preview.errors.len(), 1);
    assert!(p.preview.errors[0].contains("没有可导入"));
}

#[test]
fn rollback_cannot_erase_edits_made_after_import() {
    let (dir, s) = setup();
    let b = s.create("保护编辑").unwrap();
    s.save(&b, sample()).unwrap();
    let path = dir.path().join("new.jsonl");
    std::fs::write(&path, serde_json::to_string(&sample()).unwrap()).unwrap();
    let p = exchange::preview(&s, &path, &b).unwrap();
    exchange::commit(&s, &p).unwrap();
    let mut q = s.questions(&b).unwrap().remove(0);
    q.stem = "导入后的编辑必须保留".into();
    s.save(&b, q).unwrap();
    assert!(s.rollback(&b).unwrap_err().contains("其他修改"));
    assert_eq!(find(&s, "必须保留").len(), 1);
}
