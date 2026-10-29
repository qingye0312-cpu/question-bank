use super::*;
use serde_json::{json, Value};
use std::io::Cursor;

fn fields(q: &Question) -> Vec<(String, String)> {
    let mut vals = vec![
        q.external_id.clone(),
        match q.kind.as_str() {
            "single" => "单选",
            "multiple" => "多选",
            "programming" => "编程",
            _ => "判断",
        }
        .into(),
        q.bank.clone(),
        q.chapter.clone(),
        q.stem.clone(),
    ];
    for k in "ABCDEFGH".chars() {
        vals.push(
            q.options
                .iter()
                .find(|o| o.key == k.to_string())
                .map(|o| o.content.clone())
                .unwrap_or_default(),
        );
    }
    vals.extend([
        if let Some(b) = q.answer.as_bool() {
            if b { "正确" } else { "错误" }.into()
        } else {
            q.answer
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("|")
                })
                .unwrap_or_default()
        },
        q.explanation.clone(),
        q.tags.join("|"),
        match q.difficulty.as_str() {
            "easy" => "简单",
            "medium" => "中等",
            "hard" => "困难",
            _ => "",
        }
        .into(),
        q.applicable_version.clone(),
        q.source_note.clone(),
        q.question_id.clone(),
        q.base_revision.to_string(),
    ]);
    let mut out: Vec<_> = HEADERS.iter().map(|s| s.to_string()).zip(vals).collect();
    out.push(("记录元数据".into(),json!({"schema_version":q.schema_version,"recorded_at":q.recorded_at,"recorded_at_source":q.recorded_at_source,"updated_at":q.updated_at,"sources":q.sources,"issues":q.issues,"status":q.status,"option_ids":q.options.iter().map(|o|&o.option_id).collect::<Vec<_>>()} ).to_string()));
    out
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn cell(text: &str, bold: bool) -> String {
    let p = text
        .lines()
        .map(|l| {
            format!(
                "<w:p><w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                if bold { "<w:rPr><w:b/></w:rPr>" } else { "" },
                escape(l)
            )
        })
        .collect::<String>();
    format!(
        "<w:tc>{}</w:tc>",
        if p.is_empty() { "<w:p/>".into() } else { p }
    )
}
fn table(rows: &[(String, String)]) -> String {
    format!("<w:tbl><w:tblPr><w:tblW w:w=\"9600\" w:type=\"dxa\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w=\"1800\"/><w:gridCol w:w=\"7800\"/></w:tblGrid>{}</w:tbl><w:p/>",rows.iter().map(|(k,v)|format!("<w:tr>{}{}</w:tr>",cell(k,true),cell(v,false))).collect::<String>())
}
pub fn write_docx(name: &str, qs: &[Question]) -> Result<Vec<u8>> {
    let mut body = format!(
        "<w:p><w:r><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr><w:t>{}</w:t></w:r></w:p>",
        escape(name)
    );
    body.push_str(&table(&[
        ("模板版本".into(), "1.0".into()),
        ("默认题库".into(), name.into()),
    ]));
    for q in qs {
        body.push_str(&table(&fields(q)));
    }
    docx_body(&body)
}
pub fn write_print_docx(name: &str, qs: &[Question], mode: &str) -> Result<Vec<u8>> {
    if !["docx-study", "docx-exam", "docx-answers"].contains(&mode) {
        return Err("未知 Word 模式".into());
    }
    let paragraph = |text: &str| {
        format!("<w:p><w:pPr><w:spacing w:after=\"160\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",escape(text).replace('\n',"</w:t><w:br/><w:t xml:space=\"preserve\">"))
    };
    let label = match mode {
        "docx-exam" => "试卷",
        "docx-answers" => "参考答案",
        _ => "学习资料",
    };
    let mut body = paragraph(&format!("{name} · {label}"));
    for (i, q) in qs.iter().enumerate() {
        let answer = match &q.answer {
            Value::Bool(b) => {
                if *b {
                    "正确".into()
                } else {
                    "错误".into()
                }
            }
            Value::Array(a) => a
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join("、"),
            _ => "尚未确定".into(),
        };
        if mode != "docx-answers" {
            body.push_str(&paragraph(&format!("{}. {}", i + 1, q.stem)));
            for o in &q.options {
                body.push_str(&paragraph(&format!("{}. {}", o.key, o.content)));
            }
        }
        if mode == "docx-exam" {
            body.push_str(&paragraph("作答：________________"));
        } else {
            body.push_str(&paragraph(&format!(
                "{}答案：{}{}",
                if mode == "docx-answers" {
                    format!("{}. ", i + 1)
                } else {
                    String::new()
                },
                answer,
                if q.status != "verified" {
                    "（待核实）"
                } else {
                    ""
                }
            )));
            if mode == "docx-study" && !q.explanation.is_empty() {
                body.push_str(&paragraph(&format!("解析：{}", q.explanation)));
            }
        }
    }
    docx_body(&body)
}

/// Build a compact, template-shaped question document without bank metadata.
pub fn write_recommended_docx(qs: &[Question]) -> Result<Vec<u8>> {
    let mut body = String::new();
    for (index, q) in qs.iter().enumerate() {
        let kind = match q.kind.as_str() {
            "single" => "单选题",
            "multiple" => "多选题",
            "true_false" => "判断题",
            "programming" => "编程题",
            _ => "题目",
        };
        body.push_str("<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\"/></w:pPr>");
        body.push_str(&text_run(&format!("{}.", index + 1), false));
        body.push_str(&text_run(&format!("【{kind}】"), true));
        body.push_str(&text_run(&q.stem, false));
        body.push_str("</w:p>");

        if matches!(q.kind.as_str(), "single" | "multiple") {
            for option in &q.options {
                body.push_str(&text_paragraph(
                    &format!("{}.{}", option.key, option.content),
                    false,
                ));
            }
        }

        if let Some(answer) = recommended_answer(&q.answer) {
            body.push_str(&text_paragraph(&format!("答案：{answer}"), false));
        }
        if let Some(explanation) = clean_export_explanation(&q.explanation) {
            body.push_str(&text_paragraph(&format!("答案解析：{explanation}"), false));
        }
        if index + 1 < qs.len() {
            body.push_str("<w:p/>");
        }
    }
    docx_body_with_margins(&body, 1440, 1440, 1800, 1800)
}

fn recommended_answer(answer: &Value) -> Option<String> {
    match answer {
        Value::Null => None,
        Value::Bool(value) => Some(if *value { "正确" } else { "错误" }.into()),
        Value::Array(values) => {
            let items = values.iter().filter_map(Value::as_str).collect::<Vec<_>>();
            (!items.is_empty()).then(|| items.join("，"))
        }
        Value::String(value) => (!value.trim().is_empty()).then(|| value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Object(_) => None,
    }
}

fn text_paragraph(text: &str, bold: bool) -> String {
    format!(
        "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\"/></w:pPr>{}</w:p>",
        text_run(text, bold)
    )
}

fn clean_export_explanation(value: &str) -> Option<String> {
    let normalized = value
        .replace("&#x20;", " ")
        .replace("&#X20;", " ")
        .replace("&#xA0;", " ")
        .replace("&#xa0;", " ")
        .replace("&#XA0;", " ")
        .replace("&#160;", " ")
        .replace("&nbsp;", " ")
        .replace("\\\r\n", "\n")
        .replace("\\\n", "\n")
        .replace('\u{00a0}', " ")
        .replace('\u{3000}', " ")
        .replace('\r', "\n");
    let mut result = Vec::new();
    let mut in_references = false;

    for raw_line in normalized.lines() {
        let mut line = raw_line.trim().trim_end_matches('\\').trim();
        if line.is_empty() {
            continue;
        }
        if is_reference_heading(line) {
            in_references = true;
        }
        if in_references {
            continue;
        }

        // Strip nested labels while preserving an explanation after a prefix
        // such as "核对答案：正确。解析：...".
        loop {
            if let Some(rest) = line.strip_prefix("答案解析：") {
                line = rest.trim();
            } else if let Some(rest) = line.strip_prefix("解析：") {
                line = rest.trim();
            } else if is_audit_prefix(line) {
                if let Some(index) = line.find("解析：") {
                    line = line[index + "解析：".len()..].trim();
                } else {
                    line = "";
                }
            } else {
                break;
            }
            if line.is_empty() {
                break;
            }
        }
        if line.is_empty() || is_audit_prefix(line) {
            continue;
        }
        if is_reference_heading(line) {
            in_references = true;
            continue;
        }

        // These phrases report the review process rather than explain the
        // answer. Keep normal explanatory sentences and remove this boilerplate.
        if line.contains("题源文字答案")
            || line.contains("未发现相反依据")
            || line.contains("复核状态")
        {
            continue;
        }

        if is_reference_line(line) {
            continue;
        }
        let line = strip_export_links(line);
        let line = line.trim().trim_matches(|character: char| {
            character.is_whitespace() || matches!(character, '：' | ':' | '、' | '；' | ';' | '-')
        });
        if !line.is_empty() {
            result.push(line.to_string());
        }
    }

    let explanation = result.join("\n");
    (!explanation.is_empty()).then_some(explanation)
}

fn is_audit_prefix(line: &str) -> bool {
    [
        "核对答案：",
        "答案核对：",
        "复核状态：",
        "复核结果：",
        "核对状态：",
        "审核状态：",
        "审校状态：",
        "核验状态：",
        "答案状态：",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn is_reference_heading(line: &str) -> bool {
    let heading = line
        .trim()
        .trim_end_matches(|character: char| {
            character.is_whitespace() || matches!(character, '：' | ':' | '。' | '.')
        })
        .trim();
    [
        "官方核对依据",
        "官方核验依据",
        "官方核查依据",
        "官方依据",
        "官方资料",
        "官方参考",
        "核对依据",
        "核验依据",
        "资料依据",
        "参考资料",
        "参考来源",
        "参考链接",
        "资料来源",
        "来源链接",
        "引用来源",
        "引用依据",
        "引用链接",
        "固定资料版本",
        "OpenHarmony固定资料版本",
        "Official evidence",
        "References",
        "Sources",
    ]
    .iter()
    .any(|prefix| heading.eq_ignore_ascii_case(prefix))
}

fn is_reference_line(line: &str) -> bool {
    let contains_url = line.contains("http://") || line.contains("https://");
    (contains_url
        && [
            "简介：",
            "组件导航",
            "官方核对依据：",
            "官方核验依据：",
            "官方核查依据：",
            "华为开发者官方资料：",
            "官方资料：",
            "参考资料：",
            "参考来源：",
            "资料来源：",
            "来源：",
            "链接：",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix)))
        || line.starts_with("OpenHarmony固定资料版本")
}

fn strip_export_links(line: &str) -> String {
    use std::sync::OnceLock;

    static MARKDOWN_LINK: OnceLock<regex::Regex> = OnceLock::new();
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    let without_markdown = MARKDOWN_LINK
        .get_or_init(|| regex::Regex::new(r"!?\[[^\]]*\]\(\s*https?://[^)]+\)").unwrap())
        .replace_all(line, "");
    URL.get_or_init(|| regex::Regex::new(r"https?://[^\s)\]>]+").unwrap())
        .replace_all(&without_markdown, "")
        .into_owned()
}

fn text_run(text: &str, bold: bool) -> String {
    let value = text
        .chars()
        .filter(|c| {
            *c == '\t'
                || *c == '\n'
                || *c == '\r'
                || (*c >= '\u{20}' && *c != '\u{fffe}' && *c != '\u{ffff}')
        })
        .collect::<String>()
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let content = value
        .split('\n')
        .enumerate()
        .map(|(index, line)| {
            format!(
                "{}<w:t xml:space=\"preserve\">{}</w:t>",
                if index == 0 { "" } else { "<w:br/>" },
                escape(line)
            )
        })
        .collect::<String>();
    format!(
        "<w:r><w:rPr><w:rFonts w:ascii=\"Times New Roman\" w:hAnsi=\"Times New Roman\" w:eastAsia=\"Times New Roman\"/><w:sz w:val=\"24\"/>{}</w:rPr>{content}</w:r>",
        if bold { "<w:b/>" } else { "" }
    )
}

fn docx_body(body: &str) -> Result<Vec<u8>> {
    docx_body_with_margins(body, 1000, 1000, 1000, 1000)
}
fn docx_body_with_margins(
    body: &str,
    top: u32,
    bottom: u32,
    left: u32,
    right: u32,
) -> Result<Vec<u8>> {
    let doc=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"{top}\" w:right=\"{right}\" w:bottom=\"{bottom}\" w:left=\"{left}\"/></w:sectPr></w:body></w:document>");
    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    for (n,s) in [("[Content_Types].xml","<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),("_rels/.rels","<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"),("word/document.xml",doc.as_str())]{z.start_file(n,SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(err)?;z.write_all(s.as_bytes()).map_err(err)?;}
    Ok(z.finish().map_err(err)?.into_inner())
}
pub fn write_xlsx(name: &str, qs: &[Question]) -> Result<Vec<u8>> {
    use rust_xlsxwriter::{Color, Format, Workbook};
    let mut wb = Workbook::new();
    let info = wb.add_worksheet().set_name("填写说明").map_err(err)?;
    info.write_string(0, 0, "模板版本")
        .map_err(err)?
        .write_string(0, 1, "1.0")
        .map_err(err)?;
    info.write_string(1, 0, "题库")
        .map_err(err)?
        .write_string(1, 1, name)
        .map_err(err)?;
    info.write_string(2,0,"填写规则").map_err(err)?.write_string(2,1,"只读取题目工作表；多选答案用 | 分隔；禁止公式、图片；记录元数据由系统维护。疑问题复核后更新状态。").map_err(err)?;
    info.set_column_width(0, 18)
        .map_err(err)?
        .set_column_width(1, 85)
        .map_err(err)?;
    let sheet = wb.add_worksheet().set_name("题目").map_err(err)?;
    let header = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0x163C3B))
        .set_font_color(Color::White);
    let text = Format::new().set_num_format("@").set_text_wrap();
    for (j, h) in HEADERS
        .iter()
        .chain(std::iter::once(&"记录元数据"))
        .enumerate()
    {
        sheet
            .write_string_with_format(0, j as u16, *h, &header)
            .map_err(err)?;
        sheet
            .set_column_width(j as u16, if j == 4 { 65. } else { 20. })
            .map_err(err)?;
    }
    sheet.set_freeze_panes(1, 5).map_err(err)?;
    for (i, q) in qs.iter().enumerate() {
        for (j, (_, v)) in fields(q).iter().enumerate() {
            if v.chars().count() > 32767 {
                return Err(format!(
                    "{} 字段过长，Excel 单元格不能超过 32767 字符，请使用 JSONL 或离线包",
                    q.external_id
                ));
            }
            sheet
                .write_string_with_format(i as u32 + 1, j as u16, v, &text)
                .map_err(err)?;
        }
    }
    wb.save_to_buffer().map_err(err)
}
