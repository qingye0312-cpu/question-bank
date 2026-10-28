use question_bank::{
    db::{self, Store},
    model::{Choice, Question},
    ocr::{
        self,
        matching::{self, canonical, parse},
    },
};
use serde_json::json;

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("ocr.sqlite")).unwrap();
    store.seed().unwrap();
    let id = store.banks().unwrap()[0].id.clone();
    (dir, store, id)
}
fn question(id: &str) -> Question {
    serde_json::from_str::<Vec<Question>>(include_str!("../resources/seed.json"))
        .unwrap()
        .into_iter()
        .find(|q| q.external_id == id)
        .unwrap()
}
fn text(q: &Question) -> String {
    format!(
        "{}\n{}",
        q.stem,
        q.options
            .iter()
            .map(|o| format!("{}. {}", o.key, o.content))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
#[test]
fn reordered_options_map_answers_by_content() {
    let (_dir, store, bank) = setup();
    let mut q = question("M-015");
    let old = q.options.clone();
    q.options = [2, 0, 3, 1]
        .iter()
        .enumerate()
        .map(|(i, j)| Choice {
            key: ((b'A' + i as u8) as char).to_string(),
            content: old[*j].content.clone(),
            option_id: String::new(),
        })
        .collect();
    let result = matching::find(&store, &bank, &text(&q)).unwrap();
    assert!(result.automatic, "{}", result.message);
    assert_eq!(result.candidates[0].answer, "B、C、D");
    assert_eq!(result.candidates[0].answer_scope, "image");
}
#[test]
fn plain_stem_and_true_false_resolve_existing_answers() {
    let (_dir, store, bank) = setup();
    for id in ["S-124", "J-134"] {
        let q = question(id);
        let result = matching::find(&store, &bank, &q.stem).unwrap();
        assert!(result.automatic, "{id}: {}", result.message);
        assert!(result.candidates[0].exact_stem);
        assert_eq!(result.candidates[0].answer_scope, "bank");
    }
}
#[test]
fn changed_option_requires_confirmation_and_preserves_bank_labels() {
    let (_dir, store, bank) = setup();
    let mut q = question("S-124");
    q.options[2].content = "由窗口大小决定".into();
    let result = matching::find(&store, &bank, &text(&q)).unwrap();
    assert!(!result.automatic);
    assert!(!result.candidates[0].options_matched);
    assert_eq!(result.candidates[0].answer_scope, "bank");
}
#[test]
fn ocr_noise_negation_numbers_and_code_are_not_exact() {
    let (_dir, store, bank) = setup();
    let mut q = question("S-112");
    q.stem = q.stem.replace("错误", "正确");
    let r = matching::find(&store, &bank, &text(&q)).unwrap();
    assert!(!r.automatic);
    assert!(!r.candidates.is_empty());
    for (a, b) in [
        ("x != 1", "x = 1"),
        ("12.5 px", "12.6 px"),
        ("String", "string"),
        ("x > 3", "x < 3"),
        ("\"null\"", "null"),
        ("f(a,b)", "f(ab)"),
        ("a ? b : c", "a b : c"),
        ("\"a b\"", "\"ab\""),
    ] {
        assert_ne!(canonical(a), canonical(b));
    }
    assert_eq!(parse("12.5 px").stem, "12.5 px");
}
#[test]
fn current_bank_and_deleted_rows_are_respected() {
    let (_dir, store, bank) = setup();
    let q = question("S-124");
    let empty = store.create("空题库").unwrap();
    assert!(matching::find(&store, &empty, &text(&q))
        .unwrap()
        .candidates
        .is_empty());
    store
        .conn()
        .unwrap()
        .execute(
            "UPDATE questions SET deleted=1 WHERE bank_id=?1",
            [bank.clone()],
        )
        .unwrap();
    assert!(matching::find(&store, &bank, &text(&q))
        .unwrap()
        .candidates
        .is_empty());
}
#[test]
fn missing_answer_and_ambiguous_duplicates_are_not_automatic() {
    let (_dir, store, bank) = setup();
    let q = question("J-137");
    let r = matching::find(&store, &bank, &q.stem).unwrap();
    assert!(!r.automatic);
    assert_eq!(r.candidates[0].answer, "待核对");
    let mut q = question("S-124");
    q.question_id = question_bank::model::uid();
    q.answer = json!(["A"]);
    db::insert(&store.conn().unwrap(), &bank, &q).unwrap();
    assert!(!matching::find(&store, &bank, &text(&q)).unwrap().automatic);
}
#[test]
fn parser_handles_fullwidth_number_wrapped_options_and_answer_tail() {
    let parsed = parse(
        "１２．【单选题】题目内容是什么？\nＡ．选项一\n继续一行\nＢ．选项二\n答案：Ａ\n解析：说明",
    );
    assert_eq!(parsed.stem, "题目内容是什么?");
    assert_eq!(parsed.options.len(), 2);
    assert_eq!(parsed.options[0].content, "选项一\n继续一行");
    assert_eq!(parsed.options[1].content, "选项二");
    assert!(parse("题一\nA. 甲\nB. 乙\n题二\nA. 丙\nB. 丁").multiple_questions);
}
#[test]
fn empty_garbage_and_oversized_input_fail_cleanly() {
    let (_dir, store, bank) = setup();
    assert!(matching::find(&store, &bank, "")
        .unwrap()
        .candidates
        .is_empty());
    assert!(
        matching::find(&store, &bank, "完全无关的宇宙星系题目不存在")
            .unwrap()
            .candidates
            .is_empty()
    );
    assert!(matching::find(&store, &bank, &"字".repeat(16001)).is_err());
    assert!(ocr::decode("https://example.com/test.png").is_err());
    assert!(ocr::image_input(b"not an image", "bad.png".into()).is_err());
}
