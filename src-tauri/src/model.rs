use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn normalize(s: &str) -> String {
    s.nfkc().flat_map(char::to_lowercase).collect()
}
fn schema() -> String {
    "1.0".into()
}
fn revision() -> u64 {
    1
}
fn status() -> String {
    "unreviewed".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub key: String,
    pub content: String,
    #[serde(default)]
    pub option_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    #[serde(default = "schema")]
    pub schema_version: String,
    #[serde(default)]
    pub question_id: String,
    #[serde(default = "revision")]
    pub base_revision: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub stem: String,
    #[serde(default)]
    pub options: Vec<Choice>,
    pub answer: Value,
    #[serde(default)]
    pub external_id: String,
    #[serde(default)]
    pub bank: String,
    #[serde(default)]
    pub chapter: String,
    #[serde(default)]
    pub explanation: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub difficulty: String,
    #[serde(default)]
    pub applicable_version: String,
    #[serde(default)]
    pub source_note: String,
    #[serde(default = "status")]
    pub status: String,
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub sources: Vec<Value>,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Value::is_null")]
    pub extensions: Value,
}
impl Question {
    pub fn prepare(&mut self) {
        if self.question_id.is_empty() {
            self.question_id = uid();
        }
        for o in &mut self.options {
            if o.option_id.is_empty() {
                o.option_id = uid();
            }
        }
    }
    pub fn validate(&self, legacy: bool) -> Result<()> {
        if self.schema_version != "1.0" {
            return Err("不支持的 schema_version".into());
        }
        if !["single", "multiple", "true_false"].contains(&self.kind.as_str()) {
            return Err("题型只能是单选、多选或判断".into());
        }
        if self.stem.trim().is_empty() {
            return Err("题干不能为空".into());
        }
        if serde_json::to_vec(self).map_err(err)?.len() > 1_000_000 {
            return Err("单题内容超过 1 MB".into());
        }
        if !self.attachments.is_empty() || !self.extensions.is_null() {
            return Err("此版本尚不支持附件或扩展对象，请保留原文件".into());
        }
        if !["unreviewed", "needs_review", "verified"].contains(&self.status.as_str()) {
            return Err("未知的审核状态".into());
        }
        if !["", "easy", "medium", "hard"].contains(&self.difficulty.as_str()) {
            return Err("难度必须为 easy、medium、hard 或空值".into());
        }
        if self.base_revision == 0 {
            return Err("基准修订号必须大于零".into());
        }
        if !self.question_id.is_empty() && uuid::Uuid::parse_str(&self.question_id).is_err() {
            return Err("系统 ID 必须是 UUID".into());
        }
        let mut option_ids = std::collections::HashSet::new();
        for o in &self.options {
            if !o.option_id.is_empty()
                && (uuid::Uuid::parse_str(&o.option_id).is_err()
                    || !option_ids.insert(&o.option_id))
            {
                return Err("选项 ID 必须是互不重复的 UUID".into());
            }
        }
        if self.kind == "true_false" {
            if !self.options.is_empty()
                || !(self.answer.is_boolean()
                    || (legacy
                        && self.status == "needs_review"
                        && self.answer.is_null()
                        && !self.sources.is_empty()))
            {
                return Err("判断题选项须留空，答案必须是正确或错误".into());
            }
        } else {
            if !(2..=8).contains(&self.options.len()) {
                if !(legacy && self.status == "needs_review") {
                    return Err("选择题需要 2 至 8 个选项".into());
                }
            }
            for (i, o) in self.options.iter().enumerate() {
                if o.key != ((b'A' + i as u8) as char).to_string() || o.content.trim().is_empty() {
                    return Err("选项必须从 A 连续排列且内容不能为空".into());
                }
            }
            if legacy
                && self.status == "needs_review"
                && self.answer.is_null()
                && !self.sources.is_empty()
            {
                return Ok(());
            }
            let a = self.answer.as_array().ok_or("选择题答案须为数组")?;
            if !legacy || self.status != "needs_review" {
                if (self.kind == "single" && a.len() != 1)
                    || (self.kind == "multiple" && a.len() < 2)
                {
                    return Err("单选须有 1 个答案，多选须至少有 2 个答案".into());
                }
            }
            let mut seen = std::collections::HashSet::new();
            for v in a {
                let key = v.as_str().ok_or("答案只能包含选项字母")?;
                if !self.options.iter().any(|o| o.key == key) || !seen.insert(key) {
                    return Err("答案引用了不存在或重复的选项".into());
                }
            }
        }
        Ok(())
    }
    pub fn search_text(&self) -> String {
        normalize(&format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            self.stem,
            self.options
                .iter()
                .map(|o| o.content.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            self.tags.join(" "),
            self.external_id,
            self.question_id,
            self.chapter
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bank {
    pub id: String,
    pub name: String,
    pub read_only: bool,
    pub version: i64,
    pub updated_at: String,
    pub content_hash: String,
    pub count: i64,
    pub review_count: i64,
    pub provenance: String,
}

pub fn short_tokens(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = std::collections::BTreeSet::new();
    for (i, c) in chars.iter().enumerate() {
        if c.is_whitespace() {
            continue;
        }
        tokens.insert(format!("u{:x}", *c as u32));
        if let Some(n) = chars.get(i + 1) {
            if !n.is_whitespace() {
                tokens.insert(format!("u{:x}x{:x}", *c as u32, *n as u32));
            }
        }
    }
    tokens.into_iter().collect::<Vec<_>>().join(" ")
}
pub fn short_query(s: &str) -> String {
    format!(
        "u{}",
        s.chars()
            .map(|c| format!("{:x}", c as u32))
            .collect::<Vec<_>>()
            .join("x")
    )
}
