//! 题库文件解析入口：按扩展名选解析器，统一做体积、题数与文内重复三道闸。
//!
//! 文内重复（同题型 + 同归一化题干 + 同答案）不是错误：同一份资料里贴了两遍很常见。
//! 这里只把它标成 `duplicate_in_file` 并默认**不勾选**，复核表里使用者仍可手动勾回。

pub mod answer;
pub mod csv;
pub mod doc;
pub mod docx;
pub mod excel;
pub mod grid;
pub mod normalize;
pub mod rules;
pub mod txt;
pub mod word;

use std::collections::HashSet;
use std::path::Path;

use crate::error::{AppError, Result};
use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::normalize::normalize_text;

pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_QUESTIONS: usize = 20_000;

/// 解析族。族内两种扩展名共用一个解析入口（按文件头再分），存进库里的也是族名：
/// `.doc` 记 docx 族、`.xls` 记 xlsx 族，真正的扩展名由 `source_filename` 承担。
///
/// 不为此扩 `quiz_libraries.source_format` 的 CHECK：SQLite 改 CHECK 要重建表，
/// 而连接上 `PRAGMA foreign_keys=ON`，`DROP TABLE` 会级联删掉 `quiz_questions`、
/// 把 `quiz_import_jobs.published_library_id` 置空——为两个扩展名付这个代价不值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Word 文档族：.docx（OOXML 包）与 .doc（Word 97-2003 二进制）。
    Word,
    /// 纯文本：.txt。
    Text,
    /// Excel 表格族：.xlsx / .xlsm（OOXML 包）与 .xls（BIFF 二进制）。
    Excel,
    /// CSV：.csv。
    Csv,
}

impl Format {
    /// 与 `quiz_libraries.source_format` 的 CHECK 约束逐字一致。
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Word => "docx",
            Format::Text => "txt",
            Format::Excel => "xlsx",
            Format::Csv => "csv",
        }
    }

    pub fn from_extension(ext: &str) -> Option<Format> {
        match ext.to_ascii_lowercase().as_str() {
            "docx" | "doc" => Some(Format::Word),
            "txt" => Some(Format::Text),
            // .xlsm 不在选择框里，但拖进来能读——它是同一套 OOXML 表格，没理由拒绝。
            "xlsx" | "xlsm" | "xls" => Some(Format::Excel),
            "csv" => Some(Format::Csv),
            _ => None,
        }
    }
}

pub fn detect_format(path: &Path) -> Result<Format> {
    path.extension()
        .and_then(|e| e.to_str())
        .and_then(Format::from_extension)
        .ok_or(AppError::QuizUnsupportedFormat)
}

#[derive(Debug)]
pub struct ParsedFile {
    pub format: Format,
    pub questions: Vec<ParsedQuestion>,
}

/// OLE2 复合文档头（D0CF11E0…）：Word 97-2003 与 Excel 97-2003 都长这样。
/// 扩展名写错（把 .doc 存成 .docx）时按文件头走，比"请另存为 .docx"更接近事实。
fn is_ole(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

pub fn parse_bytes(format: Format, bytes: &[u8]) -> Result<Vec<ParsedQuestion>> {
    match format {
        Format::Word => {
            if is_ole(bytes) {
                doc::parse(bytes)
            } else {
                docx::parse(bytes)
            }
        }
        Format::Text => txt::parse(bytes),
        // Excel 那一族由 calamine 自己嗅探 xls/xlsx，不再按扩展名分支。
        Format::Excel => excel::parse(bytes),
        Format::Csv => csv::parse(bytes),
    }
}

fn mark_duplicates(questions: &mut [ParsedQuestion]) -> usize {
    let mut seen: HashSet<String> = HashSet::new();
    let mut dup = 0usize;
    for q in questions.iter_mut() {
        let key = format!("{}|{}|{}", q.qtype.as_str(), normalize_text(&q.stem), q.answer.norm());
        if seen.insert(key) {
            continue;
        }
        dup += 1;
        q.include = false;
        if !q.issues.iter().any(|i| i == "duplicate_in_file") {
            q.issues.push("duplicate_in_file".to_string());
        }
    }
    dup
}

pub fn parse_file(path: &Path) -> Result<ParsedFile> {
    let format = detect_format(path)?;
    let meta = std::fs::metadata(path)
        .map_err(|_| AppError::QuizParseFailed("文件不存在或无法读取".into()))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::QuizFileTooLarge);
    }
    let bytes = std::fs::read(path)
        .map_err(|_| AppError::QuizParseFailed("文件读取失败：可能正被其他程序占用".into()))?;
    let mut questions = parse_bytes(format, &bytes)?;
    if questions.is_empty() {
        return Err(AppError::QuizParseFailed(
            "文件里没有识别到题目：请确认题干行带题号或题型标记，且答案行以「答案：」开头".into(),
        ));
    }
    if questions.len() > MAX_QUESTIONS {
        return Err(AppError::QuizFileTooLarge);
    }
    mark_duplicates(&mut questions);
    Ok(ParsedFile { format, questions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn format_is_taken_from_the_extension_case_insensitively() {
        assert_eq!(detect_format(Path::new("a.DOCX")).unwrap(), Format::Word);
        assert_eq!(detect_format(Path::new("a.doc")).unwrap(), Format::Word);
        assert_eq!(detect_format(Path::new("a.XLSX")).unwrap(), Format::Excel);
        assert_eq!(detect_format(Path::new("a.xls")).unwrap(), Format::Excel);
        assert_eq!(detect_format(Path::new("a.csv")).unwrap(), Format::Csv);
        assert_eq!(detect_format(Path::new("a.pdf")).unwrap_err().code(), "QUIZ_UNSUPPORTED_FORMAT");
        assert_eq!(detect_format(Path::new("noext")).unwrap_err().code(), "QUIZ_UNSUPPORTED_FORMAT");
    }

    /// 存库的族名必须与 `migrations/0015_quiz.sql` 的 CHECK 逐字一致，
    /// 新增列值要先过重建表那一关（见 `Format` 的注释）。
    #[test]
    fn stored_names_stay_inside_the_schema_check() {
        let names: Vec<&str> = [Format::Word, Format::Text, Format::Excel, Format::Csv]
            .iter()
            .map(|f| f.as_str())
            .collect();
        assert_eq!(names, vec!["docx", "txt", "xlsx", "csv"]);
    }

    /// 扩展名写错的 .doc（OLE 头但名字叫 .docx）按文件头走二进制解析，
    /// 报错也得说 doc，而不是让使用者去「另存为 .docx」。
    #[test]
    fn word_family_is_dispatched_by_file_header() {
        let mut ole = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        ole.extend_from_slice(&[0u8; 128]);
        let err = parse_bytes(Format::Word, &ole).unwrap_err();
        assert_eq!(err.code(), "QUIZ_PARSE_FAILED");
        assert!(err.safe_detail().contains("Word 97-2003"), "{}", err.safe_detail());
    }

    #[test]
    fn oversized_file_is_rejected_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(parse_file(&path).unwrap_err().code(), "QUIZ_FILE_TOO_LARGE");
    }

    #[test]
    fn empty_bank_reports_a_parse_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        std::fs::write(&path, "   \n\n\t\n").unwrap();
        assert_eq!(parse_file(&path).unwrap_err().code(), "QUIZ_PARSE_FAILED");
    }

    #[test]
    fn duplicates_are_flagged_and_unchecked_but_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dup.txt");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(
            f,
            "1. 变压器可以带负荷拉合隔离开关\n答案：错误\n\n\
             2. 变压器可以带负荷拉合隔离开关\n答案：错误\n\n\
             3. 电流互感器二次侧不允许开路\n答案：正确\n"
        )
        .unwrap();
        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed.questions.len(), 3);
        assert!(parsed.questions[0].include);
        assert!(!parsed.questions[1].include);
        assert!(parsed.questions[1].issues.iter().any(|i| i == "duplicate_in_file"));
        assert!(parsed.questions[2].include);
    }
}
