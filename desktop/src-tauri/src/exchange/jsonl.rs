use super::*;
pub(crate) fn jsonl(qs: &[Question]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for q in qs {
        serde_json::to_writer(&mut out, q).map_err(err)?;
        out.push(b'\n');
    }
    Ok(out)
}
