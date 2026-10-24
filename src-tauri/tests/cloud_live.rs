//! Explicit, read-only server smoke test. Uses an isolated desktop database.
use base64::{engine::general_purpose::STANDARD, Engine};
use question_bank::{cloud, db::Store};
use serde_json::Value;
use std::io::Read;

#[test]
#[ignore = "connects to the configured live HTTPS service"]
fn https_catalog_downloads_all_banks_into_an_isolated_desktop() {
    let config: Value =
        serde_json::from_str(include_str!("../../shared/desktop-service.json")).unwrap();
    let origin = config["origin"].as_str().unwrap();
    let health = cloud::request(origin, "/health", None, None).unwrap();
    assert_eq!(health["status"], 200);
    assert_eq!(health["body"]["sync_enabled"], true);
    let catalog = cloud::request(origin, "/v1/catalog", None, None).unwrap();
    assert_eq!(catalog["status"], 200);
    let banks = catalog["body"]["banks"].as_array().unwrap();
    assert!(banks.len() >= 2);
    let temporary = tempfile::tempdir().unwrap();
    let store = Store::open(temporary.path().join("https-verification.sqlite")).unwrap();
    store.seed().unwrap();
    for bank in banks {
        let id = bank["bank_id"].as_str().unwrap();
        let response =
            cloud::request(origin, &format!("/v1/banks/{id}/snapshot-file"), None, None).unwrap();
        assert_eq!(response["status"], 200);
        let wrapper = &response["body"];
        assert_eq!(wrapper["format"], "qbank-cloud-file-1");
        assert_eq!(wrapper["encoding"], "gzip+base64");
        assert_eq!(wrapper["sha256"], bank["sha256"]);
        let compressed = STANDARD.decode(wrapper["data"].as_str().unwrap()).unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text.len() as u64, bank["bytes"].as_u64().unwrap());
        assert_eq!(wrapper["uncompressed_size"], bank["bytes"]);
        cloud::apply(&store, &text, bank["sha256"].as_str().unwrap()).unwrap();
        let snapshot: Value = serde_json::from_str(&text).unwrap();
        let count = store.questions(id).unwrap().len();
        assert_eq!(count, snapshot["formal"].as_array().unwrap().len());
        assert!(count > 0);
        eprintln!(
            "{}: {} questions, revision {}",
            bank["name"], count, bank["revision"]
        );
        // Applying the same immutable snapshot again is safe and does not duplicate questions.
        cloud::apply(&store, &text, bank["sha256"].as_str().unwrap()).unwrap();
        assert_eq!(store.questions(id).unwrap().len(), count);
    }
    assert_eq!(cloud::versions(&store).unwrap().len(), banks.len());
}
