//! Excel 题库（.xlsx / .xls）：每个工作表各自认表头，认不出按固定列序读。
//!
//! .xlsx（OOXML 包）与 .xls（BIFF 二进制）走同一个入口：calamine 的
//! `open_workbook_auto_from_rs` 按文件头嗅探，扩展名写错也能读。
//! 公式单元格取 Excel 存下的缓存值（calamine 的行为），本应用不执行公式；
//! 没有缓存值的公式读成空串，会在复核表里表现为缺答案，而不是静默算出一个数。

use std::io::Cursor;

use calamine::{open_workbook_auto_from_rs, Data, Reader as _};

use crate::error::{AppError, Result};
use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::grid;

const MAX_SHEETS: usize = 20;
const MAX_ROWS: usize = 50_000;

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        other => other.to_string().trim().to_string(),
    }
}

pub fn parse(bytes: &[u8]) -> Result<Vec<ParsedQuestion>> {
    let mut wb = open_workbook_auto_from_rs(Cursor::new(bytes)).map_err(|_| {
        AppError::QuizParseFailed(
            "Excel 无法读取：请用 Excel/WPS 另存为标准 .xlsx 或 .xls 后重试".into(),
        )
    })?;
    let names = wb.sheet_names();
    if names.len() > MAX_SHEETS {
        return Err(AppError::QuizParseFailed(format!(
            "工作表太多：单个文件最多 {MAX_SHEETS} 个，当前 {} 个",
            names.len()
        )));
    }

    let mut out = Vec::new();
    let mut total_rows = 0usize;
    for (idx, name) in names.iter().enumerate() {
        let range = match wb.worksheet_range_at(idx) {
            Some(Ok(range)) => range,
            Some(Err(_)) => {
                return Err(AppError::QuizParseFailed(format!("工作表「{name}」读取失败")))
            }
            None => continue,
        };
        total_rows += range.height();
        if total_rows > MAX_ROWS {
            return Err(AppError::QuizFileTooLarge);
        }
        let rows: Vec<Vec<String>> =
            range.rows().map(|row| row.iter().map(cell_text).collect()).collect();
        let label: String = name.trim().chars().take(40).collect();
        let prefix = if label.is_empty() { format!("sheet{}", idx + 1) } else { label };
        out.extend(grid::parse_grid(&rows, &prefix));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::QType;
    use rust_xlsxwriter::Workbook;

    fn workbook(sheets: &[(&str, &[&[&str]])]) -> Vec<u8> {
        let mut wb = Workbook::new();
        for (name, data) in sheets {
            let ws = wb.add_worksheet();
            ws.set_name(*name).unwrap();
            for (r, row) in data.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    ws.write_string(r as u32, c as u16, *cell).unwrap();
                }
            }
        }
        wb.save_to_buffer().unwrap()
    }

    #[test]
    fn header_row_is_detected_per_sheet() {
        let bytes = workbook(&[
            ("一次设备", &[
                &["题型", "题干", "A", "B", "答案"],
                &["单选", "下列设备中属于一次设备的是", "变压器", "电流表", "A"],
            ]),
            ("判断", &[
                &["题干", "答案", "标签"],
                &["变压器可以带负荷拉合隔离开关", "错误", "安全"],
            ]),
        ]);
        let qs = parse(&bytes).unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].source_ref.as_deref(), Some("一次设备:2"));
        assert_eq!(qs[1].qtype, QType::TrueFalse);
        assert_eq!(qs[1].tags, vec!["安全"]);
    }

    #[test]
    fn sheet_without_header_uses_fixed_order() {
        let bytes = workbook(&[("Sheet1", &[
            &["单选", "下列设备中属于一次设备的是", "变压器", "电流表", "", "", "A", ""],
        ])]);
        let qs = parse(&bytes).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].answer.display(), "A");
    }

    #[test]
    fn broken_bytes_are_reported_as_parse_failure() {
        let err = parse(b"not a zip").unwrap_err();
        assert_eq!(err.code(), "QUIZ_PARSE_FAILED");
    }

    /// Excel 97-2003 二进制（BIFF8，CFB 容器）：入口按文件头嗅探，与 .xlsx 同一条列映射。
    const BANK_XLS: &[u8] = include_bytes!("../../../tests/fixtures/quiz_bank.xls");

    #[test]
    fn a_real_xls_bank_is_read_end_to_end() {
        let qs = parse(BANK_XLS).unwrap();
        assert_eq!(qs.len(), 2, "{qs:#?}");
        assert_eq!(qs[0].stem, "下列设备中属于一次设备的是");
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[1].source_ref.as_deref(), Some("一次设备:3"));
    }
}
