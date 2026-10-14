use crate::{
    db::{Hit, Store},
    model::{err, normalize, Choice, Question, Result},
};
use regex::Regex;
use rusqlite::params;
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::LazyLock,
    time::Instant,
};

static OPTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)(?:^|[\n\t ]+)([A-Ha-h])(?:\s*[.、:)]+\s*|[\t ]+)").unwrap());
static ANSWER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(?:参考|正确)?(?:答案|解析)\s*[:：]").unwrap());
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:第\s*)?\d{1,5}\s*[.、)题]\s*").unwrap());
static TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[\[【(]?\s*(?:单选|多选|判断)题\s*[\]】):：]?\s*").unwrap());

#[derive(Serialize)]
pub struct Parsed {
    pub stem: String,
    pub options: Vec<Choice>,
    pub multiple_questions: bool,
}
#[derive(Serialize)]
pub struct Candidate {
    pub hit: Hit,
    pub similarity: f64,
    pub exact_stem: bool,
    pub options_matched: bool,
    pub answer: String,
    pub answer_scope: &'static str,
    pub answer_details: Vec<String>,
}
#[derive(Serialize)]
pub struct Matches {
    pub parsed: Parsed,
    pub candidates: Vec<Candidate>,
    pub automatic: bool,
    pub message: String,
    pub elapsed_ms: f64,
}

// Ignore layout whitespace outside quoted strings, but keep punctuation/operators
// and whitespace inside literals. Dropping commas or '?' can change code answers.
pub fn canonical(text: &str) -> String {
    let mut quote = None;
    let mut escaped = false;
    unicode_normalization::UnicodeNormalization::nfkc(text)
        .map(|c| match c {
            '“' | '”' => '"',
            '‘' | '’' => '\'',
            other => other,
        })
        .filter(|&c| {
            if let Some(delimiter) = quote {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == delimiter {
                    quote = None;
                }
                true
            } else {
                if matches!(c, '\'' | '"' | '`') {
                    quote = Some(c);
                }
                !c.is_whitespace()
            }
        })
        .collect::<String>()
}
fn clean_stem(text: &str) -> String {
    let mut s = text.trim();
    for _ in 0..3 {
        if let Some(m) = TYPE.find(s) {
            s = &s[m.end()..];
            continue;
        }
        if let Some(m) = NUMBER.find(s) {
            // Never turn "12.5" into "5".
            if !s[m.end()..].starts_with(|c: char| c.is_ascii_digit()) {
                s = &s[m.end()..];
                continue;
            }
        }
        break;
    }
    s.trim().to_string()
}
pub fn parse(text: &str) -> Parsed {
    let text: String = unicode_normalization::UnicodeNormalization::nfkc(text).collect();
    let text = ANSWER
        .find(&text)
        .map_or(text.as_str(), |m| &text[..m.start()]);
    let markers: Vec<_> = OPTION.captures_iter(text).collect();
    let Some(first) = markers.iter().position(|m| m[1].eq_ignore_ascii_case("A")) else {
        return Parsed {
            stem: clean_stem(text),
            options: vec![],
            multiple_questions: false,
        };
    };
    let markers = &markers[first..];
    // An isolated A variable is not an option list.
    if markers.len() < 2 || !markers[1][1].eq_ignore_ascii_case("B") {
        return Parsed {
            stem: clean_stem(text),
            options: vec![],
            multiple_questions: false,
        };
    }
    let mut options = Vec::new();
    let mut multiple_questions = false;
    for (i, marker) in markers.iter().enumerate() {
        let key = marker[1].to_uppercase();
        if key != ((b'A' + i as u8) as char).to_string() {
            multiple_questions = true;
            break;
        }
        let start = marker.get(0).unwrap().end();
        let end = markers
            .get(i + 1)
            .map_or(text.len(), |m| m.get(0).unwrap().start());
        options.push(Choice {
            key,
            content: text[start..end].trim().into(),
            option_id: String::new(),
        });
    }
    Parsed {
        stem: clean_stem(&text[..markers[0].get(0).unwrap().start()]),
        options,
        multiple_questions,
    }
}
fn grams(text: &str, n: usize) -> BTreeSet<String> {
    let chars: Vec<_> = text.chars().collect();
    chars.windows(n).map(|part| part.iter().collect()).collect()
}
fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.;
    }
    if a.is_empty() || b.is_empty() {
        return 0.;
    }
    let ga = grams(a, 2);
    let gb = grams(b, 2);
    if ga.is_empty() || gb.is_empty() {
        return 0.;
    }
    let dice = 2. * ga.intersection(&gb).count() as f64 / (ga.len() + gb.len()) as f64;
    let containment = if a.contains(b) || b.contains(a) {
        (a.chars().count().min(b.chars().count()) as f64
            / a.chars().count().max(b.chars().count()) as f64)
            .sqrt()
    } else {
        0.
    };
    dice.max(containment)
}
fn candidate(hit: Hit, parsed: &Parsed) -> Candidate {
    let q = &hit.question;
    let a = canonical(&parsed.stem);
    let b = canonical(&q.stem);
    let stem_score = similarity(&a, &b);
    let mut mapping = Vec::new();
    let mut used = HashSet::new();
    let mut option_score = 0.;
    for original in &q.options {
        let normalized = canonical(&original.content);
        let best = parsed
            .options
            .iter()
            .map(|p| similarity(&normalized, &canonical(&p.content)))
            .fold(0., f64::max);
        option_score += best;
        let matches: Vec<_> = parsed
            .options
            .iter()
            .filter(|p| canonical(&p.content) == normalized)
            .collect();
        if matches.len() == 1 && used.insert(matches[0].key.clone()) {
            mapping.push((original.key.as_str(), matches[0].key.clone()));
        }
    }
    let options_matched = !q.options.is_empty()
        && mapping.len() == q.options.len()
        && parsed.options.len() == q.options.len();
    let score = if parsed.options.is_empty() || q.options.is_empty() {
        stem_score
    } else {
        0.8 * stem_score + 0.2 * option_score / q.options.len() as f64
    };
    let answer_scope = if options_matched { "image" } else { "bank" };
    let mut answer_details = Vec::new();
    let answer = if let Some(value) = q.answer.as_bool() {
        if value { "正确" } else { "错误" }.into()
    } else if let Some(keys) = q.answer.as_array() {
        let mut display_keys = Vec::new();
        for key in keys.iter().filter_map(|k| k.as_str()) {
            let displayed = if options_matched {
                mapping.iter().find(|(k, _)| *k == key).unwrap().1.clone()
            } else {
                key.into()
            };
            if let Some(option) = q.options.iter().find(|o| o.key == key) {
                answer_details.push(format!("{displayed}. {}", option.content));
            }
            display_keys.push(displayed);
        }
        display_keys.sort();
        answer_details.sort();
        if display_keys.is_empty() {
            "待核对".into()
        } else {
            display_keys.join("、")
        }
    } else {
        "待核对".into()
    };
    Candidate {
        hit,
        similarity: (score * 1000.).round() / 1000.,
        exact_stem: a == b,
        options_matched,
        answer,
        answer_scope,
        answer_details,
    }
}
fn answer_signature(q: &Question) -> String {
    if let Some(keys) = q.answer.as_array() {
        let mut answers: Vec<_> = keys
            .iter()
            .filter_map(|k| {
                q.options
                    .iter()
                    .find(|o| Some(o.key.as_str()) == k.as_str())
            })
            .map(|o| canonical(&o.content))
            .collect();
        answers.sort();
        return answers.join("\n");
    }
    q.answer.to_string()
}

pub fn find(store: &Store, bank_id: &str, text: &str) -> Result<Matches> {
    let started = Instant::now();
    if bank_id.is_empty() {
        return Err("请先选择一个题库".into());
    }
    if text.chars().count() > 16000 {
        return Err("文字过长，请每次识别一道题（最多 16000 字）".into());
    }
    let bank = store.bank(bank_id)?;
    let parsed = parse(text);
    let mut result = Matches {
        parsed,
        candidates: vec![],
        automatic: false,
        message: String::new(),
        elapsed_ms: 0.,
    };
    if canonical(&result.parsed.stem).chars().count() < 3 {
        result.message = "请提供至少三个字的题干，可包含选项".into();
        return Ok(result);
    }
    let c = store.conn()?;
    let source = normalize(&result.parsed.stem);
    let mut exact = c.prepare("SELECT q.rowid,q.data FROM search_tri CROSS JOIN questions q ON q.rowid=search_tri.rowid WHERE search_tri MATCH ?1 AND q.bank_id=?2 AND q.deleted=0 ORDER BY search_tri.rowid LIMIT 200").map_err(err)?;
    let phrase = format!("\"{}\"", source.replace('"', "\"\""));
    let rows = exact
        .query_map(params![phrase, bank_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?;
    let mut exact_retrieved = 0;
    for row in rows {
        exact_retrieved += 1;
        let (rowid, data) = row.map_err(err)?;
        let value = candidate(
            Hit {
                rowid,
                bank_id: bank_id.into(),
                bank_name: bank.name.clone(),
                question: serde_json::from_str(&data).map_err(err)?,
            },
            &result.parsed,
        );
        if value.exact_stem {
            result.candidates.push(value);
        }
    }
    if !result.candidates.is_empty() {
        return Ok(finish(result, exact_retrieved, started));
    }
    // Bounded posting lists are much cheaper than computing complete fts5vocab
    // frequencies or ranking every common match in a large bank. Sample short and
    // longer anchors, combine their votes, then hydrate at most 200 candidates.
    let compact = normalize(&canonical(&result.parsed.stem));
    let mut anchors = BTreeSet::new();
    for input in [&source, &compact] {
        for size in [6, 3] {
            let all: Vec<_> = grams(input, size)
                .into_iter()
                .filter(|s| s.chars().any(char::is_alphanumeric))
                .collect();
            let stride = all.len().div_ceil(8).max(1);
            anchors.extend(all.into_iter().step_by(stride).take(8));
        }
    }
    let mut anchor_query = c.prepare("SELECT q.rowid FROM search_tri CROSS JOIN questions q ON q.rowid=search_tri.rowid WHERE search_tri MATCH ?1 AND q.bank_id=?2 AND q.deleted=0 ORDER BY search_tri.rowid LIMIT 129").map_err(err)?;
    let mut votes: HashMap<i64, f64> = HashMap::new();
    let mut truncated = false;
    for anchor in anchors {
        let query = format!("\"{}\"", anchor.replace('"', "\"\""));
        let ids = anchor_query
            .query_map(params![query, bank_id], |r| r.get::<_, i64>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        truncated |= ids.len() == 129;
        let weight = anchor.chars().count() as f64 / (ids.len() + 1) as f64;
        for rowid in ids {
            *votes.entry(rowid).or_default() += weight;
        }
    }
    let mut ranked: Vec<_> = votes.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let retrieved = if truncated { 200 } else { ranked.len() };
    ranked.truncate(200);
    let mut question_query = c
        .prepare("SELECT data FROM questions WHERE rowid=?1 AND bank_id=?2 AND deleted=0")
        .map_err(err)?;
    for (rowid, _) in ranked {
        let data: String = question_query
            .query_row(params![rowid, bank_id], |r| r.get(0))
            .map_err(err)?;
        let value = candidate(
            Hit {
                rowid,
                bank_id: bank_id.into(),
                bank_name: bank.name.clone(),
                question: serde_json::from_str(&data).map_err(err)?,
            },
            &result.parsed,
        );
        if value.similarity >= 0.42 {
            result.candidates.push(value);
        }
    }
    Ok(finish(result, retrieved, started))
}
fn finish(mut result: Matches, retrieved: usize, started: Instant) -> Matches {
    result.candidates.sort_by(|a, b| {
        b.similarity
            .total_cmp(&a.similarity)
            .then(a.hit.rowid.cmp(&b.hit.rowid))
    });
    if let Some(top) = result.candidates.first() {
        let ambiguous = result.candidates.iter().skip(1).any(|other| {
            other.exact_stem
                && (!top.options_matched || other.options_matched)
                && answer_signature(&other.hit.question) != answer_signature(&top.hit.question)
        });
        result.automatic = retrieved < 200
            && top.exact_stem
            && !result.parsed.multiple_questions
            && top.answer != "待核对"
            && !ambiguous
            && (result.parsed.options.is_empty()
                || top.options_matched
                || top.hit.question.kind == "true_false");
        result.message = if result.parsed.multiple_questions {
            "检测到多组题目，请每次截取或粘贴一道题"
        } else if result.automatic && top.options_matched {
            "题干与选项已匹配，答案已按本次选项顺序对应"
        } else if result.automatic {
            "题干已匹配，显示题库中的答案"
        } else {
            "找到相近题目，请核对题干与选项后查看答案"
        }
        .into();
    } else {
        result.message = "当前题库没有找到匹配题目，可修改识别文字后重试".into();
    }
    result.candidates.truncate(8);
    result.elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
    result
}
