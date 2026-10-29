//! 答案裁定：把题库里五花八门的写法收敛成 `QuizAnswer`，并把「哪里可疑」记成问题码。
//!
//! 这里绝不猜：缺答案就是缺答案，选项对不上就记 `answer_not_in_options`，绝不从题库里
//! 找一道相近的题把答案补上——那等于替使用者编一个可能错的答案。

use crate::quiz::models::{ParsedQuestion, QType, QuizAnswer, QuizOption};
use crate::quiz::parse::normalize::{normalize_tags, normalize_text};

pub const CONFIDENCE_LOW: f64 = 0.6;

/// 从「A」「A、C」「ABC」「答案：B」里取出选项字母。只认 A–H，且只取独立出现的大写/小写字母。
pub fn parse_choice_keys(raw: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let folded = raw.trim();
    for c in folded.chars() {
        let up = c.to_ascii_uppercase();
        if ('A'..='H').contains(&up) {
            let k = up.to_string();
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    keys
}

/// 判断题答案：`对/√/T/正确/是/true` → true，`错/×/F/错误/否/false` → false。
pub fn parse_bool(raw: &str) -> Option<bool> {
    let t = raw
        .trim()
        .trim_matches(|c: char| c.is_whitespace() || matches!(c, '。' | '.' | '；' | ';' | '：' | ':'))
        .to_ascii_lowercase();
    match t.as_str() {
        "对" | "正确" | "是" | "√" | "✓" | "t" | "true" | "y" | "yes" => Some(true),
        "错" | "错误" | "否" | "×" | "✗" | "x" | "f" | "false" | "n" | "no" => Some(false),
        _ => None,
    }
}

/// 填空答案：按 `；`/`;`/换行切分，去空、去首尾空白。
pub fn split_blanks(raw: &str) -> Vec<String> {
    raw.split(['；', ';', '\n', '\r'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn is_blank_filler(c: char) -> bool {
    c.is_whitespace() || c == '_' || c == '＿'
}

fn count_placeholders(stem: &str) -> usize {
    let chars: Vec<char> = stem.chars().collect();
    let mut in_bracket = vec![false; chars.len()];
    let mut count = 0usize;
    // 只认括号里空着的那种空位：题库里同样大量存在「工作票（卡）」「《电业安全工作规程（发电厂
    // 和变电所电气部分）》」这样的正文括号，若把成对括号一律当空位，复核表就会给本来正确的
    // 填空题挂上 `blank_count_mismatch`。
    for (open, close) in [('（', '）'), ('(', ')')] {
        let mut stack: Vec<usize> = Vec::new();
        for (i, &c) in chars.iter().enumerate() {
            if c == open {
                stack.push(i);
            } else if c == close {
                if let Some(start) = stack.pop() {
                    in_bracket[start..=i].iter_mut().for_each(|m| *m = true);
                    if chars[start + 1..i].iter().all(|&c| is_blank_filler(c)) {
                        count += 1;
                    }
                }
            }
        }
    }
    // 下划线式空：连续两个及以上的 _ 或 ＿ 算一处。`（____）` 已在上面算过一次，
    // 括号里的下划线不再重复计。
    let mut run = 0usize;
    for (i, &c) in chars.iter().enumerate() {
        if (c == '_' || c == '＿') && !in_bracket[i] {
            run += 1;
        } else {
            if run >= 2 {
                count += 1;
            }
            run = 0;
        }
    }
    if run >= 2 {
        count += 1;
    }
    count
}

fn push_issue(issues: &mut Vec<String>, code: &str) {
    if !issues.iter().any(|x| x == code) {
        issues.push(code.to_string());
    }
}

/// 一行的全部输入。`qtype_hint` 来自题型标记或表格的题型列；没有就按选项与答案形态推断。
pub struct AnswerInput<'a> {
    pub qtype_hint: Option<QType>,
    pub stem: &'a str,
    pub options: Vec<QuizOption>,
    pub answer_raw: &'a str,
    pub tags: Vec<String>,
    pub source_ref: Option<String>,
}

pub fn build(input: AnswerInput<'_>) -> ParsedQuestion {
    let stem = input.stem.trim().to_string();
    let mut issues: Vec<String> = Vec::new();
    let mut confidence = 1.0f64;

    // 选项键去重、补齐大小写；重复键保留第一条并记问题
    let mut options: Vec<QuizOption> = Vec::new();
    for o in input.options {
        let key = o.key.trim().to_ascii_uppercase();
        if key.is_empty() || !('A'..='H').contains(&key.chars().next().unwrap_or('A')) || key.len() != 1 {
            continue;
        }
        if options.iter().any(|x| x.key == key) {
            push_issue(&mut issues, "duplicate_option_key");
            confidence -= 0.3;
            continue;
        }
        options.push(QuizOption { key, text: o.text.trim().to_string() });
    }
    let option_keys: Vec<String> = options.iter().map(|o| o.key.clone()).collect();
    if !options.is_empty() {
        let contiguous = option_keys
            .iter()
            .enumerate()
            .all(|(i, k)| k.as_bytes()[0] == b'A' + i as u8);
        let has_blank_option = options.iter().any(|o| o.text.is_empty());
        if !contiguous || has_blank_option || options.len() < 2 {
            push_issue(&mut issues, "option_gap");
            confidence -= 0.2;
        }
    }

    let raw_keys = parse_choice_keys(input.answer_raw);
    let qtype = match input.qtype_hint {
        Some(q) => q,
        None => {
            if !options.is_empty() {
                if !raw_keys.is_empty() {
                    if raw_keys.len() > 1 {
                        QType::Multiple
                    } else {
                        QType::Single
                    }
                } else if parse_bool(input.answer_raw).is_some() {
                    // 「对/错」两枚选项的判断题：答案写的是「错误」而不是字母
                    QType::TrueFalse
                } else {
                    QType::Single
                }
            } else if parse_bool(input.answer_raw).is_some() {
                QType::TrueFalse
            } else {
                QType::FillBlank
            }
        }
    };

    let answer = match qtype {
        QType::Single => {
            if raw_keys.is_empty() {
                push_issue(&mut issues, "missing_answer");
                confidence = 0.1;
                QuizAnswer::Choice { keys: Vec::new() }
            } else {
                if raw_keys.len() > 1 {
                    push_issue(&mut issues, "ambiguous_type");
                    confidence -= 0.15;
                }
                QuizAnswer::Choice { keys: vec![raw_keys[0].clone()] }
            }
        }
        QType::Multiple => {
            if raw_keys.is_empty() {
                push_issue(&mut issues, "missing_answer");
                confidence = 0.1;
                QuizAnswer::Choice { keys: Vec::new() }
            } else {
                let mut keys = raw_keys;
                keys.sort();
                QuizAnswer::Choice { keys }
            }
        }
        QType::TrueFalse => match parse_bool(input.answer_raw) {
            Some(value) => QuizAnswer::Bool { value },
            None => {
                push_issue(&mut issues, "missing_answer");
                confidence = 0.1;
                QuizAnswer::Bool { value: false }
            }
        },
        QType::FillBlank => {
            let blanks = split_blanks(input.answer_raw);
            if blanks.is_empty() {
                push_issue(&mut issues, "missing_answer");
                confidence = 0.1;
                QuizAnswer::Text { blanks }
            } else {
                let holes = count_placeholders(&stem);
                if holes > 0 && holes != blanks.len() {
                    push_issue(&mut issues, "blank_count_mismatch");
                    confidence -= 0.1;
                }
                QuizAnswer::Text { blanks }
            }
        }
    };

    if let QuizAnswer::Choice { keys } = &answer {
        if !keys.is_empty() && keys.iter().any(|k| !option_keys.contains(k)) {
            push_issue(&mut issues, "answer_not_in_options");
            confidence -= 0.5;
        }
    }

    // 题干太短：归一化后不足 4 个字基本是噪声行（页码、题型标题），匹配层也不该拿它去搜
    if normalize_text(&stem).chars().count() < 4 {
        push_issue(&mut issues, "stem_too_short");
        confidence -= 0.2;
    }

    ParsedQuestion {
        qtype,
        stem,
        options,
        answer,
        tags: normalize_tags(&input.tags),
        confidence: confidence.clamp(0.01, 1.0),
        issues,
        source_ref: input.source_ref,
        include: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> Vec<QuizOption> {
        pairs.iter().map(|(k, t)| QuizOption { key: (*k).into(), text: (*t).into() }).collect()
    }

    fn q(qtype: Option<QType>, stem: &str, options: Vec<QuizOption>, answer: &str) -> ParsedQuestion {
        build(AnswerInput { qtype_hint: qtype, stem, options, answer_raw: answer, tags: vec![], source_ref: None })
    }

    #[test]
    fn multiple_keys_are_sorted_and_deduplicated() {
        let p = q(Some(QType::Multiple), "下列哪些属于一次设备", opts(&[("A", "变压器"), ("B", "断路器"), ("C", "电流表"), ("D", "刀闸")]), "D、B、b");
        assert_eq!(p.answer, QuizAnswer::Choice { keys: vec!["B".into(), "D".into()] });
        assert!(p.issues.is_empty(), "{:?}", p.issues);
        assert_eq!(p.answer.display(), "B、D");
    }

    #[test]
    fn missing_answer_is_flagged_not_guessed() {
        let p = q(Some(QType::Single), "下列设备中属于一次设备的是", opts(&[("A", "变压器"), ("B", "电流表")]), "");
        assert_eq!(p.issues, vec!["missing_answer"]);
        assert!(p.confidence < 0.2);
    }

    #[test]
    fn answer_outside_options_is_flagged() {
        let p = q(Some(QType::Single), "下列设备中属于一次设备的是", opts(&[("A", "变压器"), ("B", "电流表")]), "C");
        assert!(p.issues.iter().any(|i| i == "answer_not_in_options"));
    }

    #[test]
    fn true_false_accepts_the_common_spellings() {
        for raw in ["对", "√", "T", "正确", "是"] {
            let p = q(Some(QType::TrueFalse), "变压器可以带负荷拉合隔离开关", vec![], raw);
            assert_eq!(p.answer, QuizAnswer::Bool { value: true }, "raw={raw}");
        }
        for raw in ["错", "×", "F", "错误", "否"] {
            let p = q(Some(QType::TrueFalse), "变压器可以带负荷拉合隔离开关", vec![], raw);
            assert_eq!(p.answer, QuizAnswer::Bool { value: false }, "raw={raw}");
        }
    }

    #[test]
    fn fill_blank_splits_on_semicolons_and_reports_hole_mismatch() {
        let p = q(Some(QType::FillBlank), "变压器的额定电压为（  ）kV，容量为（  ）kVA", vec![], "110；50");
        assert_eq!(p.answer, QuizAnswer::Text { blanks: vec!["110".into(), "50".into()] });
        assert!(p.issues.is_empty(), "{:?}", p.issues);

        let bad = q(Some(QType::FillBlank), "变压器的额定电压为（  ）kV，容量为（  ）kVA", vec![], "110");
        assert!(bad.issues.iter().any(|i| i == "blank_count_mismatch"));
    }

    #[test]
    fn only_empty_parens_count_as_blanks() {
        let p = q(Some(QType::FillBlank), "工作票（卡）由（  ）签发，（ ）许可", vec![], "工作票签发人；工作许可人");
        assert!(p.issues.is_empty(), "{:?}", p.issues);

        // 全篇只有正文括号时，一个空位都不该算出来，答案也就不会被判成数量不符
        let only = q(
            Some(QType::FillBlank),
            "《电业安全工作规程（发电厂和变电所电气部分）》规定的试验周期是",
            vec![],
            "三个月",
        );
        assert!(only.issues.is_empty(), "{:?}", only.issues);

        // 括号里划线同样是空位
        let underlined = q(Some(QType::FillBlank), "变压器的额定电压为（____）kV", vec![], "110");
        assert!(underlined.issues.is_empty(), "{:?}", underlined.issues);
    }

    #[test]
    fn type_is_inferred_when_no_marker() {
        let single = q(None, "下列设备中属于一次设备的是", opts(&[("A", "变压器"), ("B", "电流表")]), "A");
        assert_eq!(single.qtype, QType::Single);

        let multi = q(None, "下列哪些属于一次设备", opts(&[("A", "变压器"), ("B", "断路器")]), "AB");
        assert_eq!(multi.qtype, QType::Multiple);

        let judge = q(None, "变压器可以带负荷拉合隔离开关", vec![], "错");
        assert_eq!(judge.qtype, QType::TrueFalse);

        let fill = q(None, "变压器的额定容量是____kVA", vec![], "50");
        assert_eq!(fill.qtype, QType::FillBlank);
    }

    #[test]
    fn short_stem_is_flagged() {
        let p = q(Some(QType::Single), "3. 对", opts(&[("A", "甲"), ("B", "乙")]), "A");
        assert!(p.issues.iter().any(|i| i == "stem_too_short"));
    }
}
