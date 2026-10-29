//! .doc（Word 97-2003 二进制）题库。
//!
//! 二进制包的解包（FIB、piece table、PAPX 表、压缩段的码页解码）交给 undoc：
//! 中文题库两样都占——选项常排在表格里，老文件又几乎都是 GBK 压缩段，
//! 自己拆这两处在中文上最容易静默出错（表格被拍平成一行、GBK 当 cp1252 解成乱码）。
//! 这里只做格式适配：段落 → 文本行，表格 → 行列，切题规则与 .docx 共用 `parse::word`。

use std::borrow::Cow;

use undoc::{Block as DocBlock, Document, ErrorKind, Section, Table};

use crate::error::{AppError, Result};
use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::word::{self, Block};

/// CFB（OLE2 复合文档）头，也就是 .doc/.xls 的魔数。
const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const END_OF_CHAIN: u32 = 0xFFFF_FFFE;
/// 大于等于它的值是链结束/空闲/特殊扇区；小扇区号才是真实扇区下标。
const MAX_REGULAR_SECTOR: u32 = 0xFFFF_FFFA;
const HEADER_LEN: usize = 512;
/// 一个目录项固定 128 字节。
const DIR_ENTRY_LEN: usize = 128;

fn parse_failed(raw: undoc::Error) -> AppError {
    match raw.kind() {
        ErrorKind::Encrypted => {
            AppError::QuizParseFailed("不支持加密的 Word 文档，请先取消文档密码".into())
        }
        _ => AppError::QuizParseFailed(
            "doc 无法读取：请确认文件是 Word 97-2003 文档，或另存为标准 .docx 后重试".into(),
        ),
    }
}

pub fn parse(bytes: &[u8]) -> Result<Vec<ParsedQuestion>> {
    let bytes = drop_unused_minifat(bytes);
    let doc = undoc::parse_bytes(bytes.as_ref()).map_err(parse_failed)?;
    Ok(word::blocks_to_questions(to_blocks(&doc)))
}

fn read_u16(bytes: &[u8], off: usize) -> Option<u16> {
    let s = bytes.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn read_u32(bytes: &[u8], off: usize) -> Option<u32> {
    let s = bytes.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_u64(bytes: &[u8], off: usize) -> Option<u64> {
    let s = bytes.get(off..off.checked_add(8)?)?;
    let mut b = [0u8; 8];
    b.copy_from_slice(s);
    Some(u64::from_le_bytes(b))
}

fn sector(bytes: &[u8], sector_size: usize, id: u32) -> Option<&[u8]> {
    if id > MAX_REGULAR_SECTOR {
        return None;
    }
    let start = HEADER_LEN.checked_add((id as usize).checked_mul(sector_size)?)?;
    bytes.get(start..start.checked_add(sector_size)?)
}

struct Cfb<'a> {
    bytes: &'a [u8],
    sector_size: usize,
    fat: Vec<u32>,
    dir_start: u32,
    mini_cutoff: u64,
    minifat_start: u32,
    num_minifat: u32,
}

fn cfb(bytes: &[u8]) -> Option<Cfb<'_>> {
    if bytes.len() < HEADER_LEN || !bytes.starts_with(&CFB_MAGIC) {
        return None;
    }
    let sector_size = 1usize.checked_shl(read_u16(bytes, 0x1E)? as u32)?;
    if sector_size != 512 && sector_size != 4096 {
        return None;
    }
    let num_fat = read_u32(bytes, 0x2C)? as usize;
    let dir_start = read_u32(bytes, 0x30)?;
    let mini_cutoff = read_u32(bytes, 0x38)? as u64;
    let minifat_start = read_u32(bytes, 0x3C)?;
    let num_minifat = read_u32(bytes, 0x40)?;
    let difat_start = read_u32(bytes, 0x44)?;
    let num_difat = read_u32(bytes, 0x48)? as usize;

    let per_sector = sector_size / 4;
    // 头里的 DIFAT 固定 109 条，超出部分走 DIFAT 扇区链（最后一个槽是下一扇区号）。
    let mut fat_ids: Vec<u32> = Vec::new();
    for i in 0..109 {
        let id = read_u32(bytes, 0x4C + i * 4)?;
        if id <= MAX_REGULAR_SECTOR {
            fat_ids.push(id);
        }
    }
    let mut next = difat_start;
    for _ in 0..num_difat {
        if fat_ids.len() >= num_fat {
            break;
        }
        let s = sector(bytes, sector_size, next)?;
        for i in 0..per_sector - 1 {
            let id = read_u32(s, i * 4)?;
            if id <= MAX_REGULAR_SECTOR {
                fat_ids.push(id);
            }
        }
        next = read_u32(s, (per_sector - 1) * 4)?;
    }
    fat_ids.truncate(num_fat);
    if fat_ids.len() != num_fat {
        return None;
    }

    let mut fat = Vec::with_capacity(num_fat * per_sector);
    for id in fat_ids {
        let s = sector(bytes, sector_size, id)?;
        for i in 0..per_sector {
            fat.push(read_u32(s, i * 4)?);
        }
    }
    Some(Cfb { bytes, sector_size, fat, dir_start, mini_cutoff, minifat_start, num_minifat })
}

impl Cfb<'_> {
    /// 目录里是否没有任何流住在 mini stream 里（size 为 0 的流不算）。
    fn has_no_mini_streams(&self) -> bool {
        let mut id = self.dir_start;
        for _ in 0..65_536 {
            if id > MAX_REGULAR_SECTOR {
                return true;
            }
            let Some(s) = sector(self.bytes, self.sector_size, id) else {
                return false;
            };
            for ent in s.chunks_exact(DIR_ENTRY_LEN) {
                let obj_type = ent[0x42];
                let size = read_u64(ent, 0x78).unwrap_or(0);
                if obj_type == 2 && size > 0 && size < self.mini_cutoff {
                    return false;
                }
            }
            let Some(&next) = self.fat.get(id as usize) else {
                return false;
            };
            id = next;
        }
        false
    }
}

/// 丢掉「没人用」的 MiniFAT。
///
/// cfb 这层对 MiniFAT 做严格校验（条目数不能超过 root 流容量、每个小扇区只准被指一次）。
/// 有些写得出 Word 能打开的文件、但 MiniFAT 全是 0 的生成器（macOS 的 `textutil` 就是）会
/// 被这层挡在门外——文件本身没错，只是那张表不干净。文档里既然没有任何流住在 mini stream 里，
/// 这张表就是纯摆设：把头部两条（首扇区、扇区数）清零即可，其他解析器照旧读它自己的 FAT。
///
/// 只在确认「没有小流」时动手；有一枚流真的落在 mini stream 里就原样交出去，让上层报错。
fn drop_unused_minifat(bytes: &[u8]) -> Cow<'_, [u8]> {
    let Some(cfb) = cfb(bytes) else {
        return Cow::Borrowed(bytes);
    };
    if cfb.minifat_start > MAX_REGULAR_SECTOR || cfb.num_minifat == 0 {
        return Cow::Borrowed(bytes);
    }
    if !cfb.has_no_mini_streams() {
        return Cow::Borrowed(bytes);
    }
    let mut out = bytes.to_vec();
    out[0x3C..0x40].copy_from_slice(&END_OF_CHAIN.to_le_bytes());
    out[0x40..0x44].copy_from_slice(&0u32.to_le_bytes());
    Cow::Owned(out)
}

fn to_blocks(doc: &Document) -> Vec<Block> {
    let mut out = Vec::new();
    for section in &doc.sections {
        push_section(section, &mut out);
    }
    out
}

fn push_section(section: &Section, out: &mut Vec<Block>) {
    for block in &section.content {
        match block {
            DocBlock::Paragraph(para) => {
                // Word 的软换行在 plain_text() 里就是 '\n'，拆成独立行让题号状态机看得见。
                for line in para.plain_text().split('\n') {
                    out.push(Block::Line(line.trim_end().to_string()));
                }
            }
            DocBlock::Table(table) => out.push(Block::Table(table_rows(table))),
            // 分页符 / 脚注 / 独立图片都不是题面；脚注里即使有「答案：」也是书外的话。
            _ => {}
        }
    }
}

fn table_rows(table: &Table) -> Vec<Vec<String>> {
    table
        .rows
        .iter()
        .map(|row| {
            let mut cells = Vec::new();
            for cell in &row.cells {
                cells.push(cell.plain_text().replace('\n', " "));
                // 合并单元格占多列：补空列，后面的列才不会整体左移、错认成别的字段。
                for _ in 1..cell.col_span.max(1) {
                    cells.push(String::new());
                }
            }
            cells
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::QType;
    use undoc::{Cell, Paragraph, Row};

    fn para(text: &str) -> DocBlock {
        DocBlock::Paragraph(Paragraph::with_text(text))
    }

    fn table(headers: &[&str], row: &[&str]) -> DocBlock {
        let mut t = Table::new();
        let mut head = Row::new();
        for h in headers {
            head.add_cell(Cell::header(*h));
        }
        let mut body = Row::new();
        for c in row {
            body.add_cell(Cell::with_text(*c));
        }
        t.add_row(head);
        t.add_row(body);
        DocBlock::Table(t)
    }

    fn parse_blocks(blocks: Vec<DocBlock>) -> Vec<ParsedQuestion> {
        let mut doc = Document::new();
        let mut section = Section::new(0);
        section.content = blocks;
        doc.add_section(section);
        word::blocks_to_questions(to_blocks(&doc))
    }

    #[test]
    fn paragraphs_go_through_the_text_state_machine() {
        let qs = parse_blocks(vec![
            para("1. 下列设备中属于一次设备的是（  ）"),
            para("A. 变压器"),
            para("B. 电流表"),
            para("答案：A"),
            para("2. 变压器可以带负荷拉合隔离开关"),
            para("答案：错误"),
        ]);
        assert_eq!(qs.len(), 2, "{qs:#?}");
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[1].qtype, QType::TrueFalse);
    }

    #[test]
    fn a_header_table_is_read_as_a_grid_bank() {
        let qs = parse_blocks(vec![table(
            &["题干", "A", "B", "答案"],
            &["下列设备中属于一次设备的是", "变压器", "电流表", "A"],
        )]);
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].qtype, QType::Single);
        assert_eq!(qs[0].answer.display(), "A");
    }

    #[test]
    fn an_option_table_inside_a_text_bank_is_flattened() {
        let mut t = Table::new();
        for (k, v) in [("A", "变压器"), ("B", "电流表")] {
            let mut row = Row::new();
            row.add_cell(Cell::with_text(k));
            row.add_cell(Cell::with_text(v));
            t.add_row(row);
        }
        let qs = parse_blocks(vec![
            para("1. 下列设备中属于一次设备的是"),
            DocBlock::Table(t),
            para("答案：A"),
        ]);
        assert_eq!(qs.len(), 1, "{qs:#?}");
        assert_eq!(qs[0].options.len(), 2);
        assert_eq!(qs[0].options[0].text, "变压器");
    }

    #[test]
    fn merged_cells_keep_the_later_columns_aligned() {
        let mut t = Table::new();
        let mut row = Row::new();
        row.add_cell(Cell::header("题干"));
        let mut merged = Cell::header("选项");
        merged.col_span = 2;
        row.add_cell(merged);
        let mut answer = Cell::header("答案");
        answer.col_span = 1;
        row.add_cell(answer);
        t.add_row(row);
        let grid = table_rows(&t);
        assert_eq!(grid, vec![vec!["题干", "选项", "", "答案"]]);
    }

    #[test]
    fn broken_bytes_are_reported_as_parse_failure() {
        let err = parse(b"not a word document").unwrap_err();
        assert_eq!(err.code(), "QUIZ_PARSE_FAILED");
        assert!(err.safe_detail().contains("doc"));
    }

    /// 真文件：Word 97-2003 二进制（由 macOS textutil 写出，全部是普通扇区、
    /// MiniFAT 表却是脏的——正好把 `drop_unused_minifat` 与解析两条路一起验了）。
    /// 前半段是段落题，后半段是「题干 / A / B / 答案」表头的整表题。
    const BANK_DOC: &[u8] = include_bytes!("../../../tests/fixtures/quiz_bank.doc");

    #[test]
    fn a_real_doc_bank_is_read_end_to_end() {
        let qs = parse(BANK_DOC).unwrap();
        assert_eq!(qs.len(), 4, "{qs:#?}");
        assert_eq!(qs[0].stem, "下列设备中属于一次设备的是（ ）");
        assert_eq!(qs[0].options.len(), 3);
        assert_eq!(qs[0].answer.display(), "A");
        assert_eq!(qs[1].qtype, QType::TrueFalse);
        assert_eq!(qs[2].stem, "电流互感器二次侧不允许开路");
        assert_eq!(qs[2].answer.display(), "A");
        assert!(qs.iter().all(|q| q.issues.is_empty()), "{qs:#?}");
    }

    #[test]
    fn an_unused_but_dirty_minifat_is_dropped() {
        // 夹具原样：MiniFAT 表里 128 条全写 0（严格校验判成「小扇区 0 被指两次」）。
        assert_eq!(read_u32(BANK_DOC, 0x40), Some(1));
        let fixed = drop_unused_minifat(BANK_DOC);
        let Cow::Owned(fixed) = fixed else {
            panic!("应当改写头部");
        };
        assert_eq!(read_u32(&fixed, 0x3C), Some(END_OF_CHAIN));
        assert_eq!(read_u32(&fixed, 0x40), Some(0));
        assert_eq!(fixed.len(), BANK_DOC.len());
    }

    #[test]
    fn a_non_cfb_file_is_left_untouched() {
        assert!(matches!(drop_unused_minifat(b"PK\x03\x04zip"), Cow::Borrowed(_)));
        assert!(matches!(drop_unused_minifat(&[]), Cow::Borrowed(_)));
        assert!(matches!(drop_unused_minifat(&[0xD0, 0xCF]), Cow::Borrowed(_)));
    }
}
