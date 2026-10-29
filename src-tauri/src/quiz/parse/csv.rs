//! CSV 题库：分隔符按前几行的出现次数嗅探（逗号 / 制表符 / 分号），其余交给表格映射。

use crate::error::{AppError, Result};
use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::{grid, txt};

fn sniff_delimiter(text: &str) -> u8 {
    let mut counts = [(b',', 0usize), (b'\t', 0usize), (b';', 0usize)];
    for line in text.lines().filter(|l| !l.trim().is_empty()).take(20) {
        for slot in counts.iter_mut() {
            let n = line.as_bytes().iter().filter(|b| **b == slot.0).count();
            if n > 0 {
                slot.1 += n;
            }
        }
    }
    counts.iter().max_by_key(|(_, n)| *n).map(|(d, _)| *d).unwrap_or(b',')
}

pub fn parse(bytes: &[u8]) -> Result<Vec<ParsedQuestion>> {
    let text = txt::decode(bytes)?;
    let delimiter = sniff_delimiter(&text);
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());
    let mut rows: Vec<Vec<String>> = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|_| AppError::QuizParseFailed("CSV 行无法解析：请检查引号是否成对".into()))?;
        rows.push(rec.iter().map(|c| c.trim().to_string()).collect());
        if rows.len() > 50_000 {
            return Err(AppError::QuizFileTooLarge);
        }
    }
    Ok(grid::parse_grid(&rows, "csv"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::QType;

    #[test]
    fn comma_separated_with_header() {
        let data = "题型,题干,选项A,选项B,答案\n单选,下列设备中属于一次设备的是,变压器,电流表,A\n";
        let qs = parse(data.as_bytes()).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].answer.display(), "A");
    }

    #[test]
    fn tab_separated_is_sniffed() {
        let data = "题干\tA\tB\t答案\n变压器可以带负荷拉合隔离开关\t对\t错\t错误\n";
        let qs = parse(data.as_bytes()).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].answer.display(), "错误");
    }

    #[test]
    fn semicolon_separated_is_sniffed() {
        let data = "题型;题干;A;B;答案\n多选;下列属于二次设备的有;继电保护;测量仪表;AB\n";
        let qs = parse(data.as_bytes()).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].qtype, QType::Multiple);
        assert_eq!(qs[0].answer.display(), "A、B");
    }

    /// 模板必须是一份「导进去就零问题」的文件——界面承诺"按同样的列填完即可导入"，
    /// 承诺的依据就是这条测试：四行示例覆盖四种题型，置信度满、无问题码、默认纳入。
    /// 模板带 BOM（给 Excel 双击打开用），这里同时守着「带 BOM 也能被本解析器读回」。
    #[test]
    fn template_imports_without_issues() {
        let csv = grid::template_csv();
        assert!(csv.starts_with('\u{feff}'), "模板要给 Excel 留 BOM，否则 Windows 上中文表头乱码");
        let qs = parse(csv.as_bytes()).unwrap();
        assert_eq!(qs.len(), 4, "{qs:#?}");
        for q in &qs {
            assert!(q.issues.is_empty(), "{} → {:?}", q.stem, q.issues);
            assert!(q.include);
            assert_eq!(q.confidence, 1.0, "{}", q.stem);
        }
        let types: Vec<QType> = qs.iter().map(|q| q.qtype).collect();
        assert_eq!(types, vec![QType::Single, QType::Multiple, QType::TrueFalse, QType::FillBlank]);
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[1].answer.display(), "A、B");
        assert_eq!(qs[2].answer.display(), "错误");
        assert_eq!(qs[3].answer.display(), "110；50");
    }
}
