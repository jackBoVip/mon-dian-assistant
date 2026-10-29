//! 表格型题库（XLSX / CSV / DOCX 表格）共用的列映射。
//!
//! 表头靠别名识别，认不出就按固定列序读——固定列序写死在这里并在界面模板里同步说明，
//! 不做「猜哪一列是答案」这种会静默错位的推断。

use crate::quiz::models::{ParsedQuestion, QType, QuizOption};
use crate::quiz::parse::answer::{build, AnswerInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Stem,
    Qtype,
    Answer,
    Tags,
    Option(char),
}

/// 认表头：全角折半角、去空白与常见分隔符后再比。
fn canonical(cell: &str) -> String {
    cell.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '_' | '-' | '.' | ':' | '：' | '/' | '\\'))
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect::<String>()
        .to_ascii_lowercase()
}

fn field_of(cell: &str) -> Option<Field> {
    let c = canonical(cell);
    match c.as_str() {
        "题干" | "题目" | "问题" | "题目内容" | "题干内容" | "question" | "stem" | "title" => Some(Field::Stem),
        "题型" | "类型" | "题目类型" | "type" | "qtype" => Some(Field::Qtype),
        "答案" | "正确答案" | "参考答案" | "answer" | "key" => Some(Field::Answer),
        "标签" | "知识点" | "考点" | "tags" | "tag" | "knowledge" => Some(Field::Tags),
        "解析" | "答案解析" | "试题解析" | "explanation" | "analysis" => None,
        _ => {
            let rest = c
                .strip_prefix("选项")
                .or_else(|| c.strip_prefix("option"))
                .unwrap_or(&c);
            let mut chars = rest.chars();
            let first = chars.next()?;
            if !('a'..='h').contains(&first) || chars.next().is_some() {
                return None;
            }
            Some(Field::Option(first.to_ascii_uppercase()))
        }
    }
}

/// 一行表头映射出的列。
struct Mapping {
    /// 数据从哪一行开始（有表头 = 表头下一行；无表头 = 0）。
    data_start: usize,
    stem: Option<usize>,
    qtype: Option<usize>,
    answer: Option<usize>,
    tags: Option<usize>,
    options: Vec<(usize, char)>,
}

fn detect_header(rows: &[Vec<String>]) -> Option<Mapping> {
    for (idx, row) in rows.iter().take(5).enumerate() {
        let mut stem = None;
        let mut qtype = None;
        let mut answer = None;
        let mut tags = None;
        let mut options: Vec<(usize, char)> = Vec::new();
        for (col, cell) in row.iter().enumerate() {
            match field_of(cell) {
                Some(Field::Stem) if stem.is_none() => stem = Some(col),
                Some(Field::Qtype) if qtype.is_none() => qtype = Some(col),
                Some(Field::Answer) if answer.is_none() => answer = Some(col),
                Some(Field::Tags) if tags.is_none() => tags = Some(col),
                Some(Field::Option(k)) => options.push((col, k)),
                _ => {}
            }
        }
        let strong = stem.is_some() && (answer.is_some() || options.len() >= 2);
        if strong {
            return Some(Mapping { data_start: idx + 1, stem, qtype, answer, tags, options });
        }
    }
    None
}

/// 界面「下载模板」给出的表头，与 `FIXED_ORDER` 同序。
/// 每个表头都必须能被 `field_of` 认回同一个字段——`template_header_maps_to_fixed_order` 是这条的判据。
pub const TEMPLATE_COLUMNS: [&str; 8] = ["题型", "题干", "选项A", "选项B", "选项C", "选项D", "答案", "标签"];

/// 导入模板（CSV）：四行示例覆盖单选 / 多选 / 判断 / 填空。
/// 内容必须能被 `csv::parse` 原样读回且零问题，否则模板本身就在教人写导入失败的文件。
///
/// 开头带 UTF-8 BOM：这份模板的用法是「双击用 Excel 打开、照着填、再导回来」，
/// 而不带 BOM 的 UTF-8 CSV 在 Windows Excel 里会把中文表头显示成乱码。
/// 本解析器读 CSV 走 `txt::decode`，BOM 会被识别并剥掉，所以带 BOM 也能原样导回。
pub fn template_csv() -> String {
    let rows: [[&str; 8]; 4] = [
        ["单选", "下列设备中属于一次设备的是", "变压器", "电流表", "电能表", "断路器", "A", "一次设备"],
        ["多选", "下列属于二次设备的有", "继电保护装置", "测量仪表", "断路器", "隔离开关", "AB", "二次设备"],
        ["判断", "变压器可以带负荷拉合隔离开关", "", "", "", "", "错误", "安全规程"],
        ["填空", "变压器的额定电压为（  ）kV，容量为（  ）kVA", "", "", "", "", "110；50", "变压器"],
    ];
    let mut out = String::from('\u{feff}');
    out.push_str(&TEMPLATE_COLUMNS.join(","));
    out.push('\n');
    for row in rows {
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// 无表头时的固定列序：题型 | 题干 | A | B | C | D | 答案 | 标签。
const FIXED_ORDER: [Field; 8] = [
    Field::Qtype,
    Field::Stem,
    Field::Option('A'),
    Field::Option('B'),
    Field::Option('C'),
    Field::Option('D'),
    Field::Answer,
    Field::Tags,
];

fn fixed_mapping() -> Mapping {
    let col = |f: Field| FIXED_ORDER.iter().position(|x| *x == f);
    Mapping {
        data_start: 0,
        stem: col(Field::Stem),
        qtype: col(Field::Qtype),
        answer: col(Field::Answer),
        tags: col(Field::Tags),
        options: FIXED_ORDER
            .iter()
            .enumerate()
            .filter_map(|(i, f)| match f {
                Field::Option(k) => Some((i, *k)),
                _ => None,
            })
            .collect(),
    }
}

/// 这张表是不是「自带表头」的整表题库。DOCX 用它区分「整表题库」与「题干里的选项表格」：
/// 前者按列映射读，后者压回成文本行交给状态机。
pub fn looks_like_header(rows: &[Vec<String>]) -> bool {
    detect_header(rows).is_some()
}

fn split_tags(cell: &str) -> Vec<String> {
    cell.split(['，', ',', '、', ';', '；', ' ', '\t'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 选项单元格若是「A. 变压器」这种自带字母的写法，把字母摘掉（字母以列映射为准）。
fn option_text(cell: &str, key: char) -> String {
    let t = cell.trim();
    let mut chars = t.chars();
    if let Some(first) = chars.next() {
        if first.to_ascii_uppercase() == key {
            let rest = chars.as_str();
            if let Some(sep) = rest.chars().next() {
                if matches!(sep, '.' | '、' | '．' | ')' | '）' | ':' | '：') {
                    return rest[sep.len_utf8()..].trim_start().to_string();
                }
            }
        }
    }
    t.to_string()
}

/// `source_prefix` 形如 `sheet1` / `csv`，行号取表格里的原始行号（表头也算一行）。
pub fn parse_grid(rows: &[Vec<String>], source_prefix: &str) -> Vec<ParsedQuestion> {
    use std::collections::HashMap;

    if rows.is_empty() {
        return Vec::new();
    }
    let mapping = match detect_header(rows) {
        Some(m) => m,
        None => fixed_mapping(),
    };
    let mut out = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        if idx < mapping.data_start {
            continue;
        }
        let cell = |col: Option<usize>| -> String {
            col.and_then(|c| row.get(c)).map(|v| v.trim().to_string()).unwrap_or_default()
        };
        // 整行空白：跳过，不产出「只有行号」的脏题
        if row.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let stem = cell(mapping.stem);
        if stem.is_empty() {
            // 有内容却没有题干：不是一道可用的题，直接跳过而不是造一条待复核的空题
            continue;
        }
        let qtype_raw = cell(mapping.qtype);
        let qtype_hint = if qtype_raw.is_empty() { None } else { QType::parse(&qtype_raw) };

        let mut options: Vec<QuizOption> = Vec::new();
        let mut seen: HashMap<char, bool> = HashMap::new();
        for (col, key) in &mapping.options {
            let raw = row.get(*col).map(|v| v.trim()).unwrap_or("");
            if raw.is_empty() {
                continue;
            }
            if seen.insert(*key, true).is_some() {
                continue;
            }
            options.push(QuizOption { key: key.to_string(), text: option_text(raw, *key) });
        }
        options.sort_by(|a, b| a.key.cmp(&b.key));

        let answer_raw = cell(mapping.answer);
        let tags = split_tags(&cell(mapping.tags));

        out.push(build(AnswerInput {
            qtype_hint,
            stem: &stem,
            options,
            answer_raw: &answer_raw,
            tags,
            source_ref: Some(format!("{source_prefix}:{}", idx + 1)),
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(data: &[&[&str]]) -> Vec<Vec<String>> {
        data.iter().map(|r| r.iter().map(|c| (*c).to_string()).collect()).collect()
    }

    #[test]
    fn header_aliases_are_recognised() {
        let grid = rows(&[
            &["题型", "题目", "选项 A", "选项B", "答案", "知识点"],
            &["单选", "下列设备中属于一次设备的是", "变压器", "电流表", "A", "一次设备"],
            &["判断", "变压器可以带负荷拉合隔离开关", "", "", "错误", ""],
        ]);
        let qs = parse_grid(&grid, "sheet1");
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[0].tags, vec!["一次设备"]);
        assert_eq!(qs[1].qtype, QType::TrueFalse);
        assert_eq!(qs[1].source_ref.as_deref(), Some("sheet1:3"));
    }

    #[test]
    fn fixed_order_is_used_without_a_header() {
        let grid = rows(&[
            &["单选", "下列设备中属于一次设备的是", "变压器", "电流表", "", "", "A", ""],
            &["多选", "下列属于二次设备的有", "继电保护", "测量仪表", "", "", "AB", ""],
        ]);
        let qs = parse_grid(&grid, "csv");
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[1].answer.display(), "A、B");
    }

    #[test]
    fn option_cells_with_letters_are_trimmed() {
        let grid = rows(&[
            &["题干", "A", "B", "答案"],
            &["下列设备中属于一次设备的是", "A. 变压器", "B、电流表", "A"],
        ]);
        let qs = parse_grid(&grid, "sheet1");
        assert_eq!(qs[0].options[0].text, "变压器");
        assert_eq!(qs[0].options[1].text, "电流表");
    }

    #[test]
    fn empty_stem_rows_are_skipped() {
        let grid = rows(&[
            &["题干", "答案"],
            &["", "A"],
            &["变压器可以带负荷拉合隔离开关", "错误"],
        ]);
        let qs = parse_grid(&grid, "sheet1");
        assert_eq!(qs.len(), 1);
    }

    /// 模板表头与固定列序是一件事的两种写法：谁改了 `TEMPLATE_COLUMNS` 的顺序而没动 `FIXED_ORDER`，
    /// 无表头的文件与「下载模板」给出的文件就会错列，这条测试先炸。
    #[test]
    fn template_header_maps_to_fixed_order() {
        assert_eq!(TEMPLATE_COLUMNS.len(), FIXED_ORDER.len());
        let header: Vec<String> = TEMPLATE_COLUMNS.iter().map(|c| (*c).to_string()).collect();
        let m = detect_header(&[header]).expect("模板表头必须被认出来");
        let pos = |f: Field| FIXED_ORDER.iter().position(|x| *x == f).unwrap();
        assert_eq!(m.data_start, 1);
        assert_eq!(m.qtype, Some(pos(Field::Qtype)));
        assert_eq!(m.stem, Some(pos(Field::Stem)));
        assert_eq!(m.answer, Some(pos(Field::Answer)));
        assert_eq!(m.tags, Some(pos(Field::Tags)));
        let mut got = m.options.clone();
        got.sort_by_key(|(col, _)| *col);
        let want: Vec<(usize, char)> = FIXED_ORDER
            .iter()
            .enumerate()
            .filter_map(|(i, f)| match f {
                Field::Option(k) => Some((i, *k)),
                _ => None,
            })
            .collect();
        assert_eq!(got, want);
    }
}
