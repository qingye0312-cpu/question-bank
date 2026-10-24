#!/usr/bin/env python3
"""Convert the 06.25 DOCX into a legacy-review bank.

The source document contains questions and options but no answer key.  The
generated questions therefore deliberately use answer=null and status=
needs_review, with a source record on every question.  This is accepted by
the cloud promotion validator's historical import path and keeps the answer
review explicit.  Programming questions keep their full statement and
answer-area scaffold in the stem so both desktop and mobile clients can
display the source faithfully.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import uuid
from collections import Counter
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET


NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NSMAP = {"w": NS}
QUESTION_RE = re.compile(r"^\*{0,2}\s*(\d{1,4})\s*[\.．。、]\s*(.*)$")

# A marker may be written as A., A、, A: or as the common malformed forms
# “A Object” and “A应用”.  It is intentionally limited to ASCII A-H.
INLINE_OPTION_RE = re.compile(
    r"(?<![A-Za-z0-9_])([A-H])"
    r"(?:(?:\s*[\.．、，:：]\s*)|(?=[\u4e00-\u9fff]))"
)
INLINE_PUNCT_OPTION_RE = re.compile(r"([A-H])\s*[\.．、，:：]\s*")
LINE_OPTION_RE = re.compile(
    r"^\s*([A-Z])(?:(?:\s*[\.．、，:：]\s*)|(?:\s+(?=\S))|(?=[\u4e00-\u9fff]))"
)

PROGRAM_HEADING_RE = re.compile(r"^(?:[1-9]|1[0-2])\s*[\.．、]\s*(.*)$")
PROGRAM_UNNUMBERED = {
    "“阶乘和数” 判断": 3,
    "字母大小写转换": 6,
}


def paragraph_text(paragraph: ET.Element) -> str:
    chunks: list[str] = []
    for node in paragraph.iter():
        tag = node.tag.rsplit("}", 1)[-1]
        if tag == "t":
            chunks.append(node.text or "")
        elif tag in {"br", "cr"}:
            chunks.append("\n")
        elif tag == "tab":
            chunks.append("\t")
    return "".join(chunks).replace("\r", "").replace("\u00a0", " ")


def read_paragraphs(source: Path) -> list[str]:
    with ZipFile(source) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    result = []
    for paragraph in root.findall(".//w:body/w:p", NSMAP):
        result.append(paragraph_text(paragraph).strip())
    return result


def split_sections(paragraphs: list[str]) -> list[tuple[str, int]]:
    return [(value, i) for i, value in enumerate(paragraphs) if value in {"单选题", "多选题", "编程题"}]


def choice_blocks(paragraphs: list[str], section: str, start: int, end: int) -> list[dict]:
    blocks: list[dict] = []
    current: dict | None = None
    for index in range(start + 1, end):
        value = paragraphs[index]
        match = QUESTION_RE.match(value)
        if match:
            if current is not None:
                blocks.append(current)
            current = {
                "section": section,
                "number": int(match.group(1)),
                "start": index + 1,
                "lines": [match.group(2)],
            }
        elif current is not None:
            current["lines"].append(value)
    if current is not None:
        blocks.append(current)
    # The trailing 544./310. markers in the source are empty placeholders.
    return [b for b in blocks if any(line.strip() for line in b["lines"])]


def parse_options(block: dict) -> tuple[str, list[dict], list[str], list[str]]:
    stem_parts: list[str] = []
    options: list[dict] = []
    labels: list[str] = []
    current: list[str] | None = None
    expected = 0
    first_marker_label: str | None = None
    first_marker_stem_index: int | None = None

    def start_option(label: str, before: str) -> None:
        nonlocal current, expected, first_marker_label
        if before:
            (current if current is not None else stem_parts).append(before)
        labels.append(label)
        current = []
        options.append({"label": label, "parts": current})
        expected += 1
        if first_marker_label is None:
            first_marker_label = label

    for line_index, line in enumerate(block["lines"]):
        cursor = 0
        found = False
        while cursor < len(line):
            # A label at the beginning of a paragraph is much stronger than
            # an inline match.  Accept OCR typos such as O. and report them;
            # the normalized option keys remain contiguous for review.
            line_match = LINE_OPTION_RE.match(line[cursor:]) if cursor == 0 else None
            if line_match:
                label = line_match.group(1)
                if label in "ABCDEFGH" and ord(label) - ord("A") < expected:
                    line_match = None
                else:
                    start_option(label, line[: line_match.start()])
                    cursor = line_match.end()
                    found = True
                    continue

            # Inline labels are only accepted for the next expected A-H key.
            # On the first paragraph require question punctuation or a code
            # terminator before the marker, preventing team names such as
            # “A、B、C、D” from being mistaken for four options.
            if expected >= 8:
                break
            expected_label = chr(ord("A") + expected)
            inline = None
            candidates = list(INLINE_OPTION_RE.finditer(line, cursor)) + list(INLINE_PUNCT_OPTION_RE.finditer(line, cursor))
            for candidate in sorted(candidates, key=lambda value: value.start()):
                if candidate.group(1) != expected_label:
                    continue
                prefix = line[: candidate.start()]
                if line_index == 0 and not (
                    any(mark in prefix for mark in ("?", "？"))
                    or prefix.rstrip().endswith(("}", ")", "]", "】", "**"))
                ):
                    continue
                inline = candidate
                break
            # A few pages contain OCR such as “BEL1” for “B. EL1”.
            if inline is None:
                no_separator = re.search(rf"{re.escape(expected_label)}(?=[A-Z][A-Z0-9.]{{1,}})", line[cursor:])
                if no_separator and no_separator.start() == 0 and cursor == 0:
                    inline = no_separator
            if inline is None:
                break
            start_option(expected_label, line[cursor : inline.start()])
            cursor = inline.end()
            found = True

        tail = line[cursor:]
        if tail:
            (current if current is not None else stem_parts).append(tail)
        elif not found and current is None and not line:
            stem_parts.append(line)

    # Some source pages omit the A marker immediately before B.  In those
    # blocks the final stem line is the complete A option (for example the
    # first answer after a code listing).  Recover it without guessing any
    # answer value.
    if first_marker_label == "B" and len(options) >= 3 and stem_parts:
        last = stem_parts[-1].strip()
        if last:
            stem_parts = stem_parts[:-1]
            synthetic = {"label": "A", "parts": [last]}
            options.insert(0, synthetic)
            labels.insert(0, "(missing A)")

    clean = lambda value: value.strip().replace("\r", "")
    stem = clean("\n".join(stem_parts))
    stem = re.sub(r"^\*{2}\s*", "", stem)
    stem = re.sub(r"\s*\*{2}$", "", stem)
    normalized: list[dict] = []
    for option in options:
        content = clean("\n".join(option["parts"]))
        if content:
            normalized.append({"label": option["label"], "content": content})
    issues: list[str] = []
    expected_labels = [chr(ord("A") + i) for i in range(len(normalized))]
    actual_labels = [o["label"] for o in normalized]
    if actual_labels != expected_labels:
        issues.append(f"原文选项标签异常：{','.join(actual_labels) or '无'}")
    if not (2 <= len(normalized) <= 8):
        issues.append(f"选项数量为{len(normalized)}，需人工核对")
    return stem, normalized, issues, labels


def programming_blocks(paragraphs: list[str], start: int) -> list[dict]:
    blocks: list[dict] = []
    current: dict | None = None
    for index in range(start + 1, len(paragraphs)):
        value = paragraphs[index]
        number_match = PROGRAM_HEADING_RE.match(value)
        number = int(value.split(".", 1)[0]) if number_match else PROGRAM_UNNUMBERED.get(value)
        if number is not None:
            if current is not None:
                blocks.append(current)
            title = number_match.group(1).strip() if number_match else value
            current = {"question_no": number, "title": title, "start": index + 1, "lines": [value]}
        elif current is not None:
            current["lines"].append(value)
    if current is not None:
        blocks.append(current)
    return blocks


def question_id(source_sha: str, section: str, ordinal: int, number: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"qbank:{source_sha}:{section}:{ordinal}:{number}"))


def build_question(
    block: dict,
    ordinal: int,
    source_sha: str,
    name: str,
) -> tuple[dict, dict]:
    stem, parsed_options, parse_issues, raw_labels = parse_options(block)
    qid = question_id(source_sha, block["section"], ordinal, block["number"])
    options = [
        {
            "key": chr(ord("A") + i),
            "content": option["content"],
            "option_id": str(uuid.uuid5(uuid.UUID(qid), f"option:{i}")),
        }
        for i, option in enumerate(parsed_options)
    ]
    issues = ["原始 DOCX 未提供答案，待核对", *parse_issues]
    raw = "\n".join(block["lines"]).strip()
    question = {
        "schema_version": "1.0",
        "question_id": qid,
        "base_revision": 1,
        "type": "single" if block["section"] == "单选题" else "multiple",
        "stem": stem or "（题干为空，待核对）",
        "options": options,
        "answer": None,
        "bank": name,
        "external_id": f"{'S' if block['section'] == '单选题' else 'M'}-{ordinal:04d}",
        "chapter": "",
        "tags": ["06.25高级题库(1).docx", "待核对答案"],
        "explanation": "",
        "status": "needs_review",
        "difficulty": "",
        "applicable_version": "",
        "source_note": "原始 DOCX 未提供答案，待核对",
        "issues": issues,
        "sources": [
            {
                "kind": "source_document",
                "file": "06.25高级题库(1).docx",
                "section": block["section"],
                "question_no": block["number"],
                "occurrence": ordinal,
                "answer_origin": "unknown",
                "source_sha256": source_sha,
                "raw_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            }
        ],
        "attachments": [],
    }
    audit = {
        "external_id": question["external_id"],
        "section": block["section"],
        "question_no": block["number"],
        "occurrence": ordinal,
        "stem": stem,
        "source_labels": raw_labels,
        "parse_issues": parse_issues,
        "raw": raw,
    }
    return question, audit


def build_programming_question(
    block: dict,
    ordinal: int,
    source_sha: str,
    name: str,
) -> dict:
    raw = "\n".join(block["lines"]).strip()
    qid = question_id(source_sha, "编程题", ordinal, block["question_no"])
    return {
        "schema_version": "1.0",
        "question_id": qid,
        "base_revision": 1,
        "type": "programming",
        "stem": raw or "（编程题正文为空，待核对）",
        "options": [],
        "answer": None,
        "bank": name,
        "external_id": f"P-{ordinal:04d}",
        "chapter": "",
        "tags": ["06.25高级题库(1).docx", "编程题", "待核对答案"],
        "explanation": "",
        "status": "needs_review",
        "difficulty": "",
        "applicable_version": "",
        "source_note": "原始 DOCX 编程题，暂无标准答案；答题区已保留",
        "issues": ["原始 DOCX 未提供标准答案，待核对"],
        "sources": [
            {
                "kind": "source_document",
                "file": "06.25高级题库(1).docx",
                "section": "编程题",
                "question_no": block["question_no"],
                "occurrence": ordinal,
                "answer_origin": "unknown",
                "source_sha256": source_sha,
                "raw_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            }
        ],
        "attachments": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--bank-id", required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", args.bank_id):
        raise SystemExit("bank id must be a UUID")

    source_bytes = args.source.read_bytes()
    source_sha = hashlib.sha256(source_bytes).hexdigest()
    paragraphs = read_paragraphs(args.source)
    sections = split_sections(paragraphs)
    choice_sections = []
    all_questions: list[dict] = []
    audit: list[dict] = []
    anomalies: list[dict] = []
    for section, start in sections:
        end = next((i for value, i in sections if i > start), len(paragraphs))
        if section not in {"单选题", "多选题"}:
            continue
        blocks = choice_blocks(paragraphs, section, start, end)
        choice_sections.append({"section": section, "count": len(blocks)})
        for ordinal, block in enumerate(blocks, 1):
            question, item_audit = build_question(block, ordinal, source_sha, args.name)
            all_questions.append(question)
            audit.append(item_audit)
            if item_audit["parse_issues"]:
                anomalies.append({k: item_audit[k] for k in ("external_id", "section", "question_no", "parse_issues")})

    programming = []
    programming_questions: list[dict] = []
    programming_start = next((i for section, i in sections if section == "编程题"), None)
    if programming_start is not None:
        for ordinal, block in enumerate(programming_blocks(paragraphs, programming_start), 1):
            programming_questions.append(build_programming_question(block, ordinal, source_sha, args.name))
            programming.append({
                "question_no": block["question_no"],
                "title": block["title"],
                "raw": "\n".join(block["lines"]).strip(),
            })

    args.output.mkdir(parents=True, exist_ok=True)
    all_questions.extend(programming_questions)
    snapshot = {"bank_id": args.bank_id, "name": args.name, "questions": all_questions}
    (args.output / "snapshot.json").write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    (args.output / "questions.jsonl").write_text("".join(json.dumps(q, ensure_ascii=False, separators=(",", ":")) + "\n" for q in all_questions), encoding="utf-8")
    (args.output / "source-audit.jsonl").write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in audit), encoding="utf-8")
    (args.output / "programming-questions.jsonl").write_text("".join(json.dumps(q, ensure_ascii=False, separators=(",", ":")) + "\n" for q in programming_questions), encoding="utf-8")
    (args.output / "programming-sidecar.json").write_text(json.dumps({
        "format": "qbank-programming-sidecar-1",
        "source": "06.25高级题库(1).docx",
        "source_sha256": source_sha,
        "items": programming,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report = {
        "source": str(args.source),
        "source_sha256": source_sha,
        "bank_id": args.bank_id,
        "name": args.name,
        "choice_sections": choice_sections,
        "question_count": len(all_questions),
        "type_counts": dict(Counter(q["type"] for q in all_questions)),
        "programming_count": len(programming_questions),
        "programming_numbers": [p["question_no"] for p in programming],
        "duplicate_question_numbers": {
            section: [number for number, count in Counter(a["question_no"] for a in audit if a["section"] == section).items() if count > 1]
            for section in ("单选题", "多选题")
        },
        "anomalies": anomalies,
        "answer_policy": "题库原文未提供答案键；choice questions use answer=null/status=needs_review and remain reviewable.",
    }
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"question_count": len(all_questions), "programming_count": len(programming), "anomalies": len(anomalies), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
