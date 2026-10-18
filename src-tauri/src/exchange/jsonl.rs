use super::*;
pub(crate) fn jsonl(qs: &[Question]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for q in qs {
        serde_json::to_writer(&mut out, q).map_err(err)?;
        out.push(b'\n');
    }
    Ok(out)
}
pub(super) fn parse_jsonl(bytes: &[u8], errors: &mut Vec<String>) -> Vec<Question> {
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => {
            errors.push("JSONL 必须使用 UTF-8 编码".into());
            return Vec::new();
        }
    };
    text.trim_start_matches('\u{feff}')
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .filter_map(|(i, l)| {
            if l.len() > 1_000_000 {
                errors.push(format!("第 {} 行超过 1 MB", i + 1));
                return None;
            }
            // Missing schema/answer must not silently become valid new records.
            match serde_json::from_str::<Value>(l) {
                Ok(v)
                    if v.get("question_id")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                        && v.get("base_revision").is_none() =>
                {
                    errors.push(format!("第 {} 行：带系统 ID 的题目必须带基准修订号", i + 1));
                    None
                }
                Ok(v) if v.get("schema_version").is_some() && v.get("answer").is_some() => {
                    match serde_json::from_value(v) {
                        Ok(q) => Some(q),
                        Err(e) => {
                            errors.push(format!("第 {} 行：{e}", i + 1));
                            None
                        }
                    }
                }
                Ok(_) => {
                    errors.push(format!("第 {} 行缺少 schema_version 或答案", i + 1));
                    None
                }
                Err(e) => {
                    errors.push(format!("第 {} 行：{e}", i + 1));
                    None
                }
            }
        })
        .collect()
}
