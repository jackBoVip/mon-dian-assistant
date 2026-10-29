//! DOCX 题库：段落走文本状态机，表格按形状二选一。
//!
//! 表格有两种常见长法：整张表就是题库（带「题干/答案」表头），或者题干在段落里、选项在表格里
//! （A|变压器、B|电流表）。前者交给列映射，后者压回成「A. 变压器」这样的文本行，
//! 否则一张两列的选项表会被当成「题干只有 A、B 两行」的脏题。
//!
//! zip 入口有配额：条目数、单条目、解压总量、压缩比都设上限，并拒绝加密条目——
//! 这些都是为了在解析前就把 zip 炸弹与异常包挡在内存之外。

use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use crate::error::{AppError, Result};
use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::word::{self, Block};

const MAX_ENTRIES: usize = 1024;
const MAX_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RATIO: u64 = 100;

fn parse_failed(where_: impl Into<String>) -> AppError {
    AppError::QuizParseFailed(where_.into())
}

/// zip 条目的准入判定。单独拎出来是为了能直接单测加密/压缩比这类造不出来的包。
fn check_entry(name: &str, size: u64, compressed: u64, encrypted: bool) -> Result<()> {
    if encrypted {
        return Err(parse_failed(format!("{name}：不支持加密的 docx，请先取消文档密码")));
    }
    if size > MAX_ENTRY_BYTES {
        return Err(AppError::QuizFileTooLarge);
    }
    if compressed > 0 && size > compressed.saturating_mul(MAX_RATIO) {
        return Err(parse_failed(format!("{name}：压缩比异常，已拒绝解析")));
    }
    Ok(())
}

fn read_document_xml(bytes: &[u8]) -> Result<String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| parse_failed("docx 无法读取：请用 Word/WPS 另存为标准 .docx 后重试"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(parse_failed(format!(
            "docx 内部条目过多（{} 个），已拒绝解析",
            archive.len()
        )));
    }

    let mut total: u64 = 0;
    let mut target: Option<usize> = None;
    for idx in 0..archive.len() {
        let entry = archive
            .by_index(idx)
            .map_err(|_| parse_failed("docx 内部条目损坏，无法读取"))?;
        let name = entry.name().to_string();
        check_entry(&name, entry.size(), entry.compressed_size(), entry.encrypted())?;
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(AppError::QuizFileTooLarge);
        }
        if name == "word/document.xml" {
            target = Some(idx);
        }
    }

    let idx = target.ok_or_else(|| parse_failed("docx 缺少 word/document.xml，不是有效的文档"))?;
    let mut file = archive
        .by_index(idx)
        .map_err(|_| parse_failed("docx 正文无法读取"))?;
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|_| parse_failed("docx 正文不是 UTF-8，请另存为 .docx 后重试"))?;
    Ok(xml)
}

#[derive(Default)]
struct Walker {
    blocks: Vec<Block>,
    para: Option<String>,
    cell: Option<String>,
    row: Option<Vec<String>>,
    table: Option<Vec<Vec<String>>>,
    skip_depth: usize,
    /// 只有 `w:t` 里的文本算正文：漂亮打印出来的缩进空白也走 Text 事件，不能算进题干。
    in_t: bool,
}

impl Walker {
    fn on_start(&mut self, name: &[u8]) {
        if self.skip_depth > 0 {
            self.skip_depth += 1;
            return;
        }
        match name {
            b"tbl" => {
                self.table = Some(Vec::new());
                self.row = None;
                self.cell = None;
            }
            b"tr" => self.row = Some(Vec::new()),
            b"tc" => self.cell = Some(String::new()),
            b"p" => self.para = Some(String::new()),
            b"t" => self.in_t = true,
            // 域代码、修订删除文本、图形（含文本框）都不算题面
            b"instrText" | b"delText" | b"drawing" => self.skip_depth = 1,
            _ => {}
        }
    }

    fn on_end(&mut self, name: &[u8]) {
        if self.skip_depth > 0 {
            self.skip_depth -= 1;
            return;
        }
        match name {
            b"t" => self.in_t = false,
            b"p" => {
                let text = self.para.take().unwrap_or_default();
                match self.cell.as_mut() {
                    Some(cell) => {
                        cell.push_str(&text);
                        cell.push('\n');
                    }
                    None => self.blocks.push(Block::Line(text)),
                }
            }
            b"tc" => {
                if let (Some(cell), Some(row)) = (self.cell.take(), self.row.as_mut()) {
                    row.push(cell.trim_end_matches(['\n', '\r', ' ', '\t']).to_string());
                }
            }
            b"tr" => {
                if let (Some(row), Some(table)) = (self.row.take(), self.table.as_mut()) {
                    table.push(row);
                }
            }
            b"tbl" => {
                if let Some(table) = self.table.take() {
                    self.blocks.push(Block::Table(table));
                }
            }
            _ => {}
        }
    }

    fn push_text(&mut self, text: &str) {
        if self.skip_depth > 0 || !self.in_t {
            return;
        }
        match self.para.as_mut().or(self.cell.as_mut()) {
            Some(buf) => buf.push_str(text),
            None => {}
        }
    }

    fn push_break(&mut self, ch: char) {
        if self.skip_depth == 0 {
            if let Some(buf) = self.para.as_mut().or(self.cell.as_mut()) {
                buf.push(ch);
            }
        }
    }
}

fn walk(xml: &str) -> Result<Vec<Block>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut walker = Walker::default();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => walker.on_start(e.name().local_name().as_ref()),
            Ok(Event::Empty(e)) => match e.name().local_name().as_ref() {
                b"br" | b"cr" => walker.push_break('\n'),
                b"tab" => walker.push_break('\t'),
                _ => {}
            },
            Ok(Event::Text(t)) => {
                let text = t
                    .unescape()
                    .map_err(|_| parse_failed("docx 正文 XML 实体无法解析"))?;
                walker.push_text(&text);
            }
            Ok(Event::End(e)) => walker.on_end(e.name().local_name().as_ref()),
            Ok(Event::Eof) => break,
            Err(_) => return Err(parse_failed("docx 正文 XML 解析失败")),
            _ => {}
        }
    }
    Ok(walker.blocks)
}

pub fn parse(bytes: &[u8]) -> Result<Vec<ParsedQuestion>> {
    let xml = read_document_xml(bytes)?;
    let blocks = walk(&xml)?;
    Ok(word::blocks_to_questions(blocks))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::QType;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    const HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#;
    const TAIL: &str = "</w:body></w:document>";

    fn docx(body: &str) -> Vec<u8> {
        let xml = format!("{HEAD}{body}{TAIL}");
        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zw.start_file("word/document.xml", SimpleFileOptions::default()).unwrap();
        zw.write_all(xml.as_bytes()).unwrap();
        zw.finish().unwrap().into_inner()
    }

    fn para(text: &str) -> String {
        format!("<w:p><w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>")
    }

    #[test]
    fn paragraphs_go_through_the_text_state_machine() {
        let body = format!(
            "{}{}{}{}{}{}",
            para("1. 下列设备中属于一次设备的是（  ）"),
            para("A. 变压器"),
            para("B. 电流表"),
            para("答案：A"),
            para("解析：一次设备直接参与电能生产。"),
            para("2. 变压器可以带负荷拉合隔离开关"),
        ) + &para("答案：错误");
        let qs = parse(&docx(&body)).unwrap();
        assert_eq!(qs.len(), 2, "{qs:#?}");
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[1].qtype, QType::TrueFalse);
    }

    #[test]
    fn field_codes_and_drawings_are_ignored() {
        let body = format!(
            "{}{}{}",
            para("1. 变压器可以带负荷拉合隔离开关"),
            "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:drawing><w:t>图 1</w:t></w:drawing></w:r></w:p>",
            para("答案：错误"),
        );
        let qs = parse(&docx(&body)).unwrap();
        assert_eq!(qs.len(), 1);
        assert!(!qs[0].stem.contains("PAGE"));
        assert!(!qs[0].stem.contains("图 1"));
    }

    #[test]
    fn header_table_is_read_as_a_grid_bank() {
        let body = format!(
            "<w:tbl><w:tr><w:tc>{}</w:tc><w:tc>{}</w:tc><w:tc>{}</w:tc><w:tc>{}</w:tc></w:tr>\
             <w:tr><w:tc>{}</w:tc><w:tc>{}</w:tc><w:tc>{}</w:tc><w:tc>{}</w:tc></w:tr></w:tbl>",
            para("题干"),
            para("A"),
            para("B"),
            para("答案"),
            para("下列设备中属于一次设备的是"),
            para("变压器"),
            para("电流表"),
            para("A"),
        );
        let qs = parse(&docx(&body)).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].answer.display(), "A");
    }

    #[test]
    fn option_table_inside_a_text_bank_is_flattened() {
        let body = format!(
            "{}{}{}{}",
            para("1. 下列设备中属于一次设备的是"),
            "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>变压器</w:t></w:r></w:p></w:tc></w:tr>\
             <w:tr><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>电流表</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
            para("答案：A"),
            "",
        );
        let qs = parse(&docx(&body)).unwrap();
        assert_eq!(qs.len(), 1, "{qs:#?}");
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].options[0].text, "变压器");
    }

    #[test]
    fn missing_document_xml_is_rejected() {
        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zw.start_file("word/other.xml", SimpleFileOptions::default()).unwrap();
        zw.write_all(b"<x/>").unwrap();
        let bytes = zw.finish().unwrap().into_inner();
        let err = parse(&bytes).unwrap_err();
        assert_eq!(err.code(), "QUIZ_PARSE_FAILED");
        assert!(err.safe_detail().contains("document.xml"));
    }

    #[test]
    fn entry_guards_reject_encrypted_oversized_and_zip_bombs() {
        assert_eq!(check_entry("a", 10, 10, true).unwrap_err().code(), "QUIZ_PARSE_FAILED");
        assert_eq!(
            check_entry("a", MAX_ENTRY_BYTES + 1, 10, false).unwrap_err().code(),
            "QUIZ_FILE_TOO_LARGE"
        );
        assert_eq!(check_entry("a", 10_000, 1, false).unwrap_err().code(), "QUIZ_PARSE_FAILED");
        assert!(check_entry("a", 10_000, 100, false).is_ok());
    }

    #[test]
    fn too_many_entries_are_rejected() {
        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for i in 0..=MAX_ENTRIES {
            zw.start_file(format!("e{i}"), opts).unwrap();
            zw.write_all(b"x").unwrap();
        }
        let bytes = zw.finish().unwrap().into_inner();
        let err = parse(&bytes).unwrap_err();
        assert_eq!(err.code(), "QUIZ_PARSE_FAILED");
        assert!(err.safe_detail().contains("条目过多"));
    }
}
