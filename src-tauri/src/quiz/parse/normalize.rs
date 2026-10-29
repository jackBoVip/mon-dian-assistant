//! 归一化：把「看起来一样、字符不一样」的题干收敛成同一个键。
//!
//! 只做确定性替换，不做同义词或纠错——OCR 会把「的」认成「昀」这种错误留给匹配打分去容忍，
//! 归一化一旦开始猜词，误匹配就再也没有可解释的边界了。

/// 全角转半角（U+FF01–U+FF5E → ASCII）、表意空格转普通空格、ASCII 小写化。
fn width_fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let c = match ch {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch),
            _ => ch,
        };
        out.push(c);
    }
    out.to_ascii_lowercase()
}

fn is_cjk_or_alnum(c: char) -> bool {
    c.is_alphanumeric()
}

/// 题干文首的题号与题型标记：「第 3 题」「3.」「3、」「(3)」「【单选题】」。
/// 题号是版式噪声：同一道题在不同题库里编号必然不同，留着会把两库的同一题算成两题。
fn strip_leading_noise(s: &str) -> String {
    let mut rest = s.trim_start();
    loop {
        let t = rest.trim_start();
        if let Some(next) = strip_bracket_marker(t) {
            rest = next;
            continue;
        }
        if let Some(next) = strip_di_ti(t) {
            rest = next;
            continue;
        }
        if let Some(next) = strip_number_prefix(t) {
            rest = next;
            continue;
        }
        return t.to_string();
    }
}

/// `【单选题】` / `［多选］` / `[判断]`：只认含题型字样的括号，正文里的方括号不动。
fn strip_bracket_marker(t: &str) -> Option<&str> {
    let (open, close) = match t.chars().next()? {
        '【' => ('【', '】'),
        '[' => ('[', ']'),
        '［' => ('［', '］'),
        _ => return None,
    };
    let after_open = &t[open.len_utf8()..];
    let pos = after_open.find(close)?;
    let inner = &after_open[..pos];
    let known = ["单选", "多选", "判断", "填空", "单项选择", "多项选择"];
    if !known.iter().any(|k| inner.contains(k)) {
        return None;
    }
    Some(&after_open[pos + close.len_utf8()..])
}

/// `第 12 题` / `第12题`。
fn strip_di_ti(t: &str) -> Option<&str> {
    let after_di = t.strip_prefix('第')?;
    let mut idx = 0usize;
    let mut saw_digit = false;
    for c in after_di.chars() {
        if c.is_ascii_digit() || c == ' ' {
            saw_digit |= c.is_ascii_digit();
            idx += c.len_utf8();
            continue;
        }
        break;
    }
    if !saw_digit || !after_di[idx..].starts_with('题') {
        return None;
    }
    Some(&after_di[idx + '题'.len_utf8()..])
}

/// `3.` / `3、` / `3)` / `(3)` / `（3）` / `3：`：数字后必须紧跟分隔符，否则不动。
fn strip_number_prefix(t: &str) -> Option<&str> {
    let first = t.chars().next()?;
    let (mut rest, parenthesised) = match first {
        '(' | '（' => (&t[first.len_utf8()..], true),
        _ => (t, false),
    };
    if parenthesised {
        rest = rest.trim_start();
    }
    let mut idx = 0usize;
    let mut saw_digit = false;
    for c in rest.chars() {
        if c.is_ascii_digit() {
            saw_digit = true;
            idx += c.len_utf8();
            continue;
        }
        break;
    }
    if !saw_digit {
        return None;
    }
    let tail = &rest[idx..];
    let sep = tail.chars().next()?;
    if parenthesised {
        return matches!(sep, ')' | '）').then(|| &tail[sep.len_utf8()..]);
    }
    matches!(sep, '.' | '、' | '．' | ')' | '）' | ':' | '：' | '。').then(|| &tail[sep.len_utf8()..])
}

/// 匹配用的归一化：题号/题型标记剥离 → 全角折半角 → 小写 → 非字母数字转空格 → 压空白。
pub fn normalize_text(s: &str) -> String {
    let stripped = strip_leading_noise(s);
    let folded = width_fold(&stripped);
    let mut out = String::with_capacity(folded.len());
    let mut last_space = true;
    for c in folded.chars() {
        if is_cjk_or_alnum(c) {
            out.push(c);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

/// 选项拼成一整段：键也参与检索（有人直接搜「B 选项的内容」不常见，但选项字母是题面的一部分）。
pub fn normalize_options(options: &[crate::quiz::models::QuizOption]) -> String {
    let mut parts = Vec::with_capacity(options.len());
    for o in options {
        let text = normalize_text(&o.text);
        if text.is_empty() {
            continue;
        }
        parts.push(format!("{} {}", o.key.to_ascii_lowercase(), text));
    }
    parts.join(" ")
}

/// 标签清洗：去空白、去重、保序。
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let v = t.trim();
        if v.is_empty() {
            continue;
        }
        if !out.iter().any(|x| x == v) {
            out.push(v.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_and_punctuation_are_folded() {
        assert_eq!(normalize_text("ＡＢＣ，１２３"), "abc 123");
        assert_eq!(normalize_text("下列（  ）是正确的？"), "下列 是正确的");
        assert_eq!(normalize_text("PowerShell 的 cmdlet"), "powershell 的 cmdlet");
    }

    #[test]
    fn numbering_and_type_markers_are_stripped() {
        for raw in [
            "1. 下列设备中属于一次设备的是",
            "第 12 题：下列设备中属于一次设备的是",
            "（3）下列设备中属于一次设备的是",
            "【单选题】下列设备中属于一次设备的是",
            "[多选]下列设备中属于一次设备的是",
        ] {
            assert_eq!(normalize_text(raw), "下列设备中属于一次设备的是", "raw={raw}");
        }
    }

    #[test]
    fn numbers_inside_the_sentence_survive() {
        assert_eq!(normalize_text("100kVA 变压器的额定电流"), "100kva 变压器的额定电流");
    }
}
