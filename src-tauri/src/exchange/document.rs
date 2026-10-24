//! Word and spreadsheet compatibility codecs share the explicit field mapping.
use super::*;
fn from_fields(fields: &HashMap<String, String>) -> Result<Question> {
    let get = |k: &str| fields.get(k).cloned().unwrap_or_default();
    let kind = match get("题型").as_str() {
        "单选" => "single",
        "多选" => "multiple",
        "判断" => "true_false",
        "编程" => "programming",
        _ => return Err("题型必须为单选、多选、判断或编程".into()),
    };
    let options: Vec<Choice> = "ABCDEFGH"
        .chars()
        .filter_map(|k| {
            let content = get(&format!("选项{k}"));
            if content.is_empty() {
                None
            } else {
                Some(Choice {
                    key: k.to_string(),
                    content,
                    option_id: String::new(),
                })
            }
        })
        .collect();
    let a = get("答案");
    let answer = if kind == "programming" {
        Value::Null
    } else if a.is_empty() && !get("记录元数据").is_empty() {
        Value::Null
    } else if kind == "true_false" {
        match a.as_str() {
            "正确" => json!(true),
            "错误" => json!(false),
            _ => return Err("判断答案须写正确或错误".into()),
        }
    } else {
        json!(a.split('|').filter(|s| !s.is_empty()).collect::<Vec<_>>())
    };
    let id = get("系统ID");
    let rev = get("基准修订号");
    if !id.is_empty() && rev.is_empty() {
        return Err("更新题目必须带基准修订号".into());
    }
    let mut q:Question=serde_json::from_value(json!({"schema_version":"1.0","question_id":id,"base_revision":if rev.is_empty(){1}else{rev.parse::<u64>().map_err(|_|"基准修订号必须是正整数")?},"type":kind,"stem":get("题干"),"options":options,"answer":answer,"external_id":get("外部编号"),"bank":get("题库"),"chapter":get("章节"),"explanation":get("解析"),"tags":get("标签").split('|').filter(|s|!s.is_empty()).collect::<Vec<_>>(),"difficulty":match get("难度").as_str(){""=>"","简单"=>"easy","中等"=>"medium","困难"=>"hard",_=>return Err("难度不合法".into())},"applicable_version":get("适用版本"),"source_note":get("来源说明")})).map_err(err)?;
    let metadata = get("记录元数据");
    if !metadata.is_empty() {
        let m: Value =
            serde_json::from_str(&metadata).map_err(|_| "记录元数据损坏，请从系统重新导出")?;
        q.sources = serde_json::from_value(m["sources"].clone()).map_err(err)?;
        q.schema_version = m["schema_version"].as_str().unwrap_or("1.0").into();
        q.recorded_at = m["recorded_at"].as_str().map(str::to_string);
        q.recorded_at_source = m["recorded_at_source"].as_str().map(str::to_string);
        q.updated_at = m["updated_at"].as_str().map(str::to_string);
        q.issues = serde_json::from_value(m["issues"].clone()).map_err(err)?;
        q.status = m["status"].as_str().ok_or("状态元数据无效")?.to_string();
        if let Some(ids) = m["option_ids"].as_array() {
            for (o, id) in q.options.iter_mut().zip(ids) {
                o.option_id = id.as_str().unwrap_or_default().to_string();
            }
        }
    }
    Ok(q)
}
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
fn xml_text(n: roxmltree::Node) -> String {
    n.descendants()
        .filter(|n| n.is_element())
        .filter_map(|n| match n.tag_name().name() {
            "t" => Some(n.text().unwrap_or("").to_string()),
            "br" | "cr" => Some("\n".into()),
            "tab" => Some("\t".into()),
            _ => None,
        })
        .collect()
}
pub(super) fn read_docx(bytes: &[u8], errors: &mut Vec<String>) -> Result<Vec<Question>> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    inspect_zip(&mut z)?;
    if z.file_names()
        .any(|n| n.contains("media/") || n.contains("embeddings/") || n.contains("vbaProject"))
    {
        return Err("Word 含图片、嵌入对象或宏，此版本不支持，请保留原文件".into());
    }
    let data = zip_entry(&mut z, "word/document.xml", MAX_PAYLOAD)?;
    let xml = std::str::from_utf8(&data).map_err(err)?;
    let doc = roxmltree::Document::parse(xml).map_err(err)?;
    if doc.descendants().any(|n| {
        n.is_element()
            && ["oMath", "drawing", "pict", "altChunk", "ins", "del"].contains(&n.tag_name().name())
    }) {
        return Err("Word 含图片、公式、修订或复杂对象，不能静默忽略，请先处理后导入".into());
    }
    let mut qs = vec![];
    let mut schema = false;
    let mut default_bank = String::new();
    for (i, t) in doc
        .descendants()
        .filter(|n| {
            n.has_tag_name((
                "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                "tbl",
            ))
        })
        .enumerate()
    {
        if t.ancestors().skip(1).any(|a| a.tag_name().name() == "tbl") {
            return Err("不支持嵌套表格".into());
        }
        let mut f = HashMap::new();
        for row in t.children().filter(|n| n.tag_name().name() == "tr") {
            let cells: Vec<_> = row
                .children()
                .filter(|n| n.tag_name().name() == "tc")
                .collect();
            if cells.len() != 2 {
                errors.push(format!("第 {} 表必须是两列", i + 1));
                continue;
            }
            if row
                .descendants()
                .any(|n| ["vMerge", "gridSpan"].contains(&n.tag_name().name()))
            {
                errors.push(format!("第 {} 表不能合并单元格", i + 1));
            }
            let value = cells[1]
                .children()
                .filter(|n| n.tag_name().name() == "p")
                .map(xml_text)
                .collect::<Vec<_>>()
                .join("\n");
            let key = xml_text(cells[0]);
            if f.insert(key.trim().to_string(), value).is_some() {
                errors.push(format!("第 {} 表字段重复", i + 1));
            }
        }
        if let Some(v) = f.get("模板版本") {
            schema = v == "1.0";
            default_bank = f.get("默认题库").cloned().unwrap_or_default();
            continue;
        }
        if !f.contains_key("题型") {
            errors.push(format!("第 {} 表无法识别，必须使用题库标准模板", i + 1));
            continue;
        }
        if f.get("题库").map(|s| s.is_empty()).unwrap_or(true) {
            f.insert("题库".into(), default_bank.clone());
        }
        for key in f.keys() {
            if !HEADERS.contains(&key.as_str()) && key != "记录元数据" {
                errors.push(format!("第 {} 表出现未知字段 {key}", i + 1));
            }
        }
        match from_fields(&f) {
            Ok(q) => qs.push(q),
            Err(e) => errors.push(format!("第 {} 表：{e}", i + 1)),
        }
    }
    if !schema {
        errors.push("缺少模板版本 1.0；旧版 Word 已迁移，请改用新模板".into());
    }
    Ok(qs)
}
pub(super) fn read_xlsx(bytes: &[u8], errors: &mut Vec<String>) -> Result<Vec<Question>> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    inspect_zip(&mut z)?;
    if z.file_names().any(|n| {
        n.starts_with("xl/media/")
            || n.starts_with("xl/drawings/")
            || n.starts_with("xl/embeddings/")
            || n.contains("vbaProject")
    }) {
        return Err("Excel 含图片、绘图、嵌入对象或宏，此版本不支持，请保留原文件".into());
    }
    let mut wb: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).map_err(err)?;
    let info = wb
        .worksheet_range("填写说明")
        .map_err(|_| "缺少填写说明工作表与模板版本")?;
    if !info.rows().any(|r| {
        r.first().map(|c| c.to_string()) == Some("模板版本".into())
            && r.get(1).map(|c| c.to_string()) == Some("1.0".into())
    }) {
        return Err("缺少模板版本 1.0".into());
    }
    let range = wb.worksheet_range("题目").map_err(|_| "找不到题目工作表")?;
    let formula = wb.worksheet_formula("题目").map_err(err)?;
    for ((row, col), _, s) in formula
        .cells()
        .filter(|(_, _, s)| !s.is_empty())
        .map(|(r, c, s)| ((r, c), 0, s))
    {
        errors.push(format!(
            "题目表第 {} 行第 {} 列含公式，请改成文本值：{}",
            row + 1,
            col + 1,
            s
        ));
    }
    let mut rows = range.rows();
    let h: Vec<String> = rows
        .next()
        .ok_or("题目表为空")?
        .iter()
        .map(ToString::to_string)
        .collect();
    if h.len() < 21 || h[..21] != HEADERS {
        return Err("表头不符合 v1 固定字段，请使用下载的模板".into());
    }
    if h.len() > 22 || h.get(21).map(|h| h != "记录元数据").unwrap_or(false) {
        return Err("发现未知列，不能静默丢弃，请使用标准表头".into());
    }
    let mut qs = vec![];
    for (i, row) in rows.enumerate() {
        if row
            .iter()
            .all(|c| matches!(c, Data::Empty) || c.to_string().trim().is_empty())
        {
            continue;
        }
        let f: HashMap<_, _> = h
            .iter()
            .enumerate()
            .map(|(j, h)| {
                (
                    h.clone(),
                    row.get(j).map(ToString::to_string).unwrap_or_default(),
                )
            })
            .collect();
        match from_fields(&f) {
            Ok(q) => qs.push(q),
            Err(e) => errors.push(format!("题目表第 {} 行：{e}", i + 2)),
        }
    }
    Ok(qs)
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
fn docx_body(body: &str) -> Result<Vec<u8>> {
    let doc=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1000\" w:right=\"1000\" w:bottom=\"1000\" w:left=\"1000\"/></w:sectPr></w:body></w:document>");
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
