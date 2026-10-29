//! 纯文本题库的状态机：题干 / 选项 / 答案 / 解析四段在 TXT 与 DOCX 段落里都长这样。
//!
//! 只认「版式确定」的那几类行；不确定的行一律并入上一段（多行题干、跨行答案），
//! 这样宁可把一段解析并进题干，也不会把一道题劈成两道去污染题库。

use crate::quiz::models::{ParsedQuestion, QType, QuizOption};
use crate::quiz::parse::answer::{build, AnswerInput};

#[derive(Debug, Default)]
struct RawQuestion {
    qtype_hint: Option<QType>,
    stem_lines: Vec<String>,
    options: Vec<QuizOption>,
    answer: String,
    tags: Vec<String>,
    start_line: usize,
}

impl RawQuestion {
    fn has_body(&self) -> bool {
        !self.stem_lines.is_empty() || !self.options.is_empty() || !self.answer.is_empty()
    }

    /// 有答案或已有选项就视为「这一题已经说完了」，空行可以安全地把它收掉。
    fn is_complete_enough(&self) -> bool {
        !self.answer.is_empty() || !self.options.is_empty()
    }

    fn finish(self) -> Option<ParsedQuestion> {
        if self.stem_lines.is_empty() {
            return None;
        }
        let stem = self.stem_lines.join("\n");
        Some(build(AnswerInput {
            qtype_hint: self.qtype_hint,
            stem: &stem,
            options: self.options,
            answer_raw: &self.answer,
            tags: self.tags,
            source_ref: Some(format!("line:{}", self.start_line)),
        }))
    }
}

/// 把 `【单选题】` / `[多选]` 从行首摘下来；只认含题型字样的括号。
fn take_type_marker(line: &str) -> (Option<QType>, &str) {
    let t = line.trim_start();
    for (open, close) in [('【', '】'), ('[', ']'), ('［', '］')] {
        if let Some(after) = t.strip_prefix(open) {
            if let Some(pos) = after.find(close) {
                let inner = &after[..pos];
                if let Some(q) = QType::parse(inner) {
                    return (Some(q), after[pos + close.len_utf8()..].trim_start());
                }
            }
        }
    }
    (None, t)
}

/// 判断题干行首的题号；返回题号之后的正文。「3.」「第3题：」这类。
fn strip_question_number(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if let Some(after) = t.strip_prefix("第") {
        let mut idx = 0usize;
        let mut digit = false;
        for c in after.chars() {
            if c.is_ascii_digit() || c == ' ' {
                digit |= c.is_ascii_digit();
                idx += c.len_utf8();
                continue;
            }
            break;
        }
        if digit && after[idx..].starts_with('题') {
            let tail = &after[idx + '题'.len_utf8()..];
            let tail = tail.trim_start();
            let tail = tail.strip_prefix([':', '：', '.', '、', '．']).unwrap_or(tail);
            return Some(tail.trim_start());
        }
    }
    let first = t.chars().next()?;
    let (rest, paren) = match first {
        '(' | '（' => (&t[first.len_utf8()..], true),
        _ => (t, false),
    };
    let mut idx = 0usize;
    let mut digit = false;
    for c in rest.chars() {
        if c.is_ascii_digit() {
            digit = true;
            idx += c.len_utf8();
            continue;
        }
        break;
    }
    if !digit {
        return None;
    }
    let tail = &rest[idx..];
    let sep = tail.chars().next()?;
    if paren {
        return matches!(sep, ')' | '）').then(|| tail[sep.len_utf8()..].trim_start());
    }
    matches!(sep, '.' | '、' | '．' | ')' | '）' | ':' | '：')
        .then(|| tail[sep.len_utf8()..].trim_start())
}

fn parse_option(line: &str) -> Option<QuizOption> {
    let t = line.trim_start();
    let mut chars = t.chars();
    let key = chars.next()?;
    if !('A'..='H').contains(&key.to_ascii_uppercase()) {
        return None;
    }
    let rest = chars.as_str();
    let sep = rest.chars().next()?;
    if !matches!(sep, '.' | '、' | '．' | ')' | '）' | ':' | '：') {
        return None;
    }
    // 「A.」后面必须真的跟内容或有空白；避免把 "A.B 两地" 当成选项
    let text = rest[sep.len_utf8()..].trim_start();
    Some(QuizOption { key: key.to_ascii_uppercase().to_string(), text: text.to_string() })
}

fn strip_answer_label(line: &str) -> Option<String> {
    let t = line.trim_start();
    for label in ["参考答案", "正确答案", "答案"] {
        if let Some(after) = t.strip_prefix(label) {
            let after = after.trim_start();
            let after = after.strip_prefix([':', '：']).unwrap_or(after);
            return Some(after.trim_start().to_string());
        }
    }
    None
}

fn is_explanation(line: &str) -> bool {
    let t = line.trim_start();
    ["解析", "答案解析", "试题解析", "【解析】", "[解析]"]
        .iter()
        .any(|m| t.starts_with(m))
}

fn take_tags(line: &str) -> Option<Vec<String>> {
    let t = line.trim_start();
    for label in ["标签", "知识点"] {
        if let Some(after) = t.strip_prefix(label) {
            let after = after.trim_start();
            let after = after.strip_prefix([':', '：']).unwrap_or(after);
            let after = after.trim();
            if after.is_empty() {
                return Some(Vec::new());
            }
            return Some(after.split(['，', ',', '、', ';', '；']).map(|s| s.trim().to_string()).collect());
        }
    }
    None
}

/// 解析一段已经解码好的文本行。空行在「上一题已经有答案或选项」时收题，否则只是排版空白。
pub fn parse_lines(lines: &[String]) -> Vec<ParsedQuestion> {
    let mut out: Vec<ParsedQuestion> = Vec::new();
    let mut cur: Option<RawQuestion> = None;
    let mut in_explanation = false;
    let mut collecting_answer = false;

    let flush = |cur: &mut Option<RawQuestion>, out: &mut Vec<ParsedQuestion>| {
        if let Some(q) = cur.take() {
            if let Some(done) = q.finish() {
                out.push(done);
            }
        }
    };

    for (idx, raw) in lines.iter().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            in_explanation = false;
            collecting_answer = false;
            if cur.as_ref().map(|q| q.is_complete_enough()).unwrap_or(false) {
                flush(&mut cur, &mut out);
            }
            continue;
        }
        if in_explanation {
            // 解析段一直吃到空行；但下一道题自己的题号/题型标记必须把它截断，
            // 否则一段解析把后面整份题库都吞掉（DOCX 段落之间常常没有空行）。
            let (marker, after_marker) = take_type_marker(line);
            if marker.is_some() || strip_question_number(after_marker).is_some() {
                in_explanation = false;
            } else {
                continue;
            }
        }
        if is_explanation(line) {
            in_explanation = true;
            collecting_answer = false;
            continue;
        }
        if let Some(tags) = take_tags(line) {
            if let Some(q) = cur.as_mut() {
                q.tags.extend(tags);
            }
            continue;
        }
        if let Some(text) = strip_answer_label(line) {
            if let Some(q) = cur.as_mut() {
                // 「答案：A 解析：……」同一行时只取答案部分
                let answer = match ["解析", "答案解析", "试题解析"].iter().find_map(|m| text.find(m)) {
                    Some(pos) => text[..pos].trim().to_string(),
                    None => text,
                };
                q.answer = answer;
                collecting_answer = true;
            }
            continue;
        }
        let (marker, after_marker) = take_type_marker(line);
        if marker.is_some() && after_marker.trim().is_empty() {
            // 题型标记单独一行：挂到当前题上；没有当前题就先记着，下一行题干会用到它
            match cur.as_mut() {
                Some(q) => q.qtype_hint = marker,
                None => cur = Some(RawQuestion { qtype_hint: marker, start_line: idx + 1, ..Default::default() }),
            }
            collecting_answer = false;
            continue;
        }
        if let Some(body) = strip_question_number(after_marker) {
            flush(&mut cur, &mut out);
            cur = Some(RawQuestion {
                qtype_hint: marker,
                stem_lines: if body.is_empty() { Vec::new() } else { vec![body.to_string()] },
                start_line: idx + 1,
                ..Default::default()
            });
            collecting_answer = false;
            continue;
        }
        if !collecting_answer {
            if let Some(opt) = parse_option(after_marker) {
                match cur.as_mut() {
                    Some(q) => q.options.push(opt),
                    None => {
                        cur = Some(RawQuestion {
                            qtype_hint: marker,
                            options: vec![opt],
                            start_line: idx + 1,
                            ..Default::default()
                        });
                    }
                }
                continue;
            }
        }
        if marker.is_some() && cur.as_ref().map(|q| q.has_body()).unwrap_or(false) {
            // 题中忽然出现一枚题型标记 = 下一题开始了（无题号的题库常见写法）
            flush(&mut cur, &mut out);
            cur = Some(RawQuestion {
                qtype_hint: marker,
                stem_lines: vec![after_marker.trim().to_string()],
                start_line: idx + 1,
                ..Default::default()
            });
            collecting_answer = false;
            continue;
        }
        if let Some(q) = cur.as_mut() {
            if collecting_answer {
                if !q.answer.is_empty() {
                    q.answer.push('\n');
                }
                q.answer.push_str(after_marker.trim());
            } else {
                q.stem_lines.push(after_marker.trim().to_string());
                if marker.is_some() {
                    q.qtype_hint = marker;
                }
            }
        } else {
            cur = Some(RawQuestion {
                qtype_hint: marker,
                stem_lines: vec![after_marker.trim().to_string()],
                start_line: idx + 1,
                ..Default::default()
            });
        }
    }
    if cur.as_ref().map(|q| q.has_body()).unwrap_or(false) {
        flush(&mut cur, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(|l| l.to_string()).collect()
    }

    #[test]
    fn parses_a_numbered_text_bank() {
        let text = "\
1. 下列设备中属于一次设备的是（  ）
A. 变压器
B. 电流表
C. 电能表
D. 继电保护装置
答案：A
解析：一次设备直接参与电能生产、变换与分配。

2. 【多选题】下列属于二次设备的有（  ）
A. 电流互感器二次侧
B. 继电保护装置
C. 测量仪表
D. 断路器
答案：ABC
";
        let qs = parse_lines(&lines(text));
        assert_eq!(qs.len(), 2, "{qs:#?}");
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].stem, "下列设备中属于一次设备的是（  ）");
        assert_eq!(qs[0].options.len(), 4);
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[0].source_ref.as_deref(), Some("line:1"));
        assert_eq!(qs[1].qtype, QType::Multiple);
        assert_eq!(qs[1].answer.display(), "A、B、C");
    }

    #[test]
    fn multi_line_stem_and_answer_stay_together() {
        let text = "\
1. 某 110kV 变电站
主变容量为 50MVA，
下列说法正确的是
A. 甲
B. 乙
答案：B
";
        let qs = parse_lines(&lines(text));
        assert_eq!(qs.len(), 1);
        assert!(qs[0].stem.contains("主变容量为 50MVA"));
        assert_eq!(qs[0].answer.display(), "B");
    }

    #[test]
    fn explanation_is_dropped_and_does_not_become_a_stem() {
        let text = "\
1. 变压器可以带负荷拉合隔离开关
答案：错误
解析：
这道题考的是安全规程。
\n\
2. 电流互感器二次侧不允许开路
答案：正确
";
        let qs = parse_lines(&lines(text));
        assert_eq!(qs.len(), 2);
        assert!(qs.iter().all(|q| !q.stem.contains("安全规程")));
        assert_eq!(qs[1].qtype, QType::TrueFalse);
    }

    #[test]
    fn unnumbered_questions_split_on_blank_lines_only() {
        let text = "\
下列设备中属于一次设备的是
A. 变压器
B. 电流表
答案：A

变压器可以带负荷拉合隔离开关
答案：错误
";
        let qs = parse_lines(&lines(text));
        assert_eq!(qs.len(), 2, "{qs:#?}");
    }

    #[test]
    fn fill_blank_answer_keeps_multiple_lines() {
        let text = "\
1. 请填写：变压器的额定电压为（  ）kV，容量为（  ）kVA
答案：110
50
";
        let qs = parse_lines(&lines(text));
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].answer, crate::quiz::models::QuizAnswer::Text { blanks: vec!["110".into(), "50".into()] });
    }

    #[test]
    fn option_letters_inside_stem_are_not_options() {
        let qs = parse_lines(&lines("1. A.B 两地之间的线路，下列说法正确的是\n答案：A"));
        assert_eq!(qs.len(), 1);
        assert!(qs[0].options.is_empty(), "题干里的 A.B 不是选项：{:?}", qs[0].options);
    }
}
