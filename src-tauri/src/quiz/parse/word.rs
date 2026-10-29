//! Word 系（.docx / .doc）共用的「块序列 → 题目」那一段。
//!
//! 两个解析器只负责把各自的二进制格式摊成一串 [`Block`]：段落行与表格行列。
//! 切题规则只写一份——表格认得出表头就按列映射读（整表题库），认不出就压回文本行
//! 交给题号状态机（题干在段落里、选项在表格里的那种长法）。

use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::{grid, rules};

pub enum Block {
    Line(String),
    Table(Vec<Vec<String>>),
}

/// 表格压回文本行：首列已是「A. 文本」就原样保留；首列只是字母就补上「. 」再拼第二列；
/// 其余按空格拼成一行（选项表之外的表格本来就不是题库，拼一行也不会丢内容）。
fn flatten_table(rows: &[Vec<String>]) -> Vec<String> {
    let mut out = Vec::new();
    for row in rows {
        let cells: Vec<&str> = row.iter().map(|c| c.trim()).collect();
        if cells.iter().all(|c| c.is_empty()) {
            out.push(String::new());
            continue;
        }
        let first = cells.first().copied().unwrap_or("");
        let letter = {
            let mut chars = first.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if ('A'..='H').contains(&c.to_ascii_uppercase()) => {
                    Some(c.to_ascii_uppercase())
                }
                _ => None,
            }
        };
        if let Some(key) = letter {
            let rest = cells[1..].iter().filter(|c| !c.is_empty()).copied().collect::<Vec<_>>().join(" ");
            out.push(if rest.is_empty() { first.to_string() } else { format!("{key}. {rest}") });
        } else {
            out.push(cells.iter().filter(|c| !c.is_empty()).copied().collect::<Vec<_>>().join(" "));
        }
    }
    out
}

pub fn blocks_to_questions(blocks: Vec<Block>) -> Vec<ParsedQuestion> {
    let mut out = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut table_no = 0usize;
    for block in blocks {
        match block {
            Block::Line(line) => pending.push(line),
            Block::Table(rows) => {
                table_no += 1;
                if grid::looks_like_header(&rows) {
                    if !pending.is_empty() {
                        let lines = std::mem::take(&mut pending);
                        out.extend(rules::parse_lines(&lines));
                    }
                    out.extend(grid::parse_grid(&rows, &format!("table{table_no}")));
                } else {
                    pending.extend(flatten_table(&rows));
                }
            }
        }
    }
    if !pending.is_empty() {
        out.extend(rules::parse_lines(&pending));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::QType;

    fn rows(data: &[&[&str]]) -> Vec<Vec<String>> {
        data.iter().map(|r| r.iter().map(|c| (*c).to_string()).collect()).collect()
    }

    #[test]
    fn option_tables_are_flattened_into_option_lines() {
        let qs = blocks_to_questions(vec![
            Block::Line("1. 下列设备中属于一次设备的是".into()),
            Block::Table(rows(&[&["A", "变压器"], &["B", "电流表"]])),
            Block::Line("答案：A".into()),
        ]);
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].options[1].text, "电流表");
    }

    #[test]
    fn header_tables_are_read_as_a_grid_bank() {
        let qs = blocks_to_questions(vec![Block::Table(rows(&[
            &["题干", "A", "B", "答案"],
            &["下列设备中属于一次设备的是", "变压器", "电流表", "A"],
        ]))]);
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[0].source_ref.as_deref(), Some("table1:2"));
    }
}
