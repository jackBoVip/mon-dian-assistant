//! 发布说明（.docx）里的「微服务发布清单」表格解析。
//!
//! 原实现写死 `cells[3] / cells[4] / cells[5]`：文档里多插一列、或两个栏目换个顺序，
//! 它就把"备注"当镜像发出去——而且不报错。这里按**表头文字**定位列，
//! 认「服务名」「镜像」「指定镜像」三件事，位置无关。
//!
//! 同时保留原实现的另一件事：把正文里的 `http…tar` 链接收出来（那是微应用包，不是镜像）。

use serde::Serialize;

use crate::error::Result;
use crate::quiz::parse::docx;
use crate::quiz::parse::word::Block;

/// 一份清单最多收多少条：发布说明超过这个数量就该拆文档，而不是让一次发布去撞网关。
pub const MAX_ROWS: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRow {
    pub ordinal: usize,
    pub service_name: String,
    /// 「镜像」列原文：可能是 `仓库/名:tag`，也可能只写了仓库地址（tag 由准备阶段挑最新）
    pub image_hint: String,
    /// 「指定镜像」列：有值就必须精确命中那个 tag，不再挑最新
    pub designated_tag: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNotes {
    pub rows: Vec<ReleaseRow>,
    /// 正文里出现的微应用 tar 包链接（原实现也收这一项，界面上要能核对）
    pub app_tars: Vec<String>,
    /// 扫过的表格数与有没有找到表头：解析出 0 条时，界面得能说清是"文档里没有清单"还是"清单是空的"
    pub tables_seen: usize,
    pub header_seen: bool,
    pub truncated: bool,
}

struct Columns {
    name: usize,
    image: usize,
    designated: Option<usize>,
}

fn cell(row: &[String], index: usize) -> &str {
    row.get(index).map(String::as_str).unwrap_or("").trim()
}

/// 表头定位：同一格可能写"服务名称"/"微服务名"，所以按包含关系判，且优先更具体的那个。
fn find_columns(row: &[String]) -> Option<Columns> {
    let mut name: Option<usize> = None;
    let mut image: Option<usize> = None;
    let mut designated: Option<usize> = None;
    for (index, raw) in row.iter().enumerate() {
        let text = raw.trim();
        if text.is_empty() {
            continue;
        }
        if text.contains("指定") && text.contains("镜像") {
            designated = Some(index);
            continue;
        }
        if image.is_none() && text.contains("镜像") {
            image = Some(index);
            continue;
        }
        if text.contains("服务") && (text.contains("名") || text.contains("称")) {
            match name {
                // 「服务名」比「服务编号」更像名字列：先命中的胜出，除非后者带"名"而前者只带"服务"
                Some(existing) if cell(row, existing).len() >= text.len() => {}
                Some(_) => name = Some(index),
                None => name = Some(index),
            }
        }
    }
    let name = name?;
    let image = image?;
    // 指定镜像那一列本身也含"镜像"；别让两件事落在同一格上。
    if name == image || designated == Some(image) {
        return None;
    }
    Some(Columns { name, image, designated })
}

fn normalize_name(raw: &str) -> String {
    let replaced = raw.replace('\u{3000}', " ");
    replaced.split_whitespace().collect::<Vec<_>>().join("")
}

fn usable_service(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 120
        && !name.contains("://")
        && !name.contains("镜像")
        && !name.chars().next().is_some_and(|c| c.is_ascii_digit() && name.len() <= 2)
}

fn is_noise_cell(text: &str) -> bool {
    text.contains("微服务发布清单") || text.contains("发布说明")
}

/// 从一段文本里收 `http…tar` / `http…tar.gz`。不引正则：这一条规则用字符扫就够。
fn extract_tars(text: &str, out: &mut Vec<String>) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        if &bytes[i..i + 4] != b"http" {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < bytes.len() {
            let c = bytes[j];
            let stops = matches!(c, b' ' | b'\t' | b'\r' | b'\n' | b'"' | b'\'' | b'<' | b'>' | b';' | b',');
            if stops {
                break;
            }
            j += 1;
        }
        // 中文全角标点也当结束：文档里常见「链接，请核对」
        let head = &text[i..];
        let cut = head
            .char_indices()
            .find(|(_, c)| matches!(c, '，' | '。' | '；' | '、' | '）' | ']'))
            .map(|(at, _)| i + at)
            .unwrap_or(j.min(text.len()));
        let candidate = &text[i..cut];
        if candidate.ends_with(".tar") || candidate.ends_with(".tar.gz") {
            if !out.iter().any(|existing| existing == candidate) {
                out.push(candidate.to_string());
            }
            i = cut;
        } else {
            i += 4;
        }
    }
}

/// 解析已经解好包的块序列（测试直接喂合成块，生产走 [`parse_bytes`]）。
pub fn parse(blocks: &[Block]) -> ParsedNotes {
    let mut notes = ParsedNotes::default();
    let mut tars = Vec::new();

    for block in blocks {
        match block {
            Block::Line(text) => extract_tars(text, &mut tars),
            Block::Table(rows) => {
                notes.tables_seen += 1;
                let mut columns: Option<Columns> = None;
                for row in rows {
                    for text in row.iter() {
                        extract_tars(text, &mut tars);
                    }
                    if is_noise_cell(cell(row, 0)) && columns.is_none() {
                        continue;
                    }
                    if let Some(found) = find_columns(row) {
                        // 长文档每页重复表头：更新列位，别把表头当数据行收进去
                        columns = Some(found);
                        notes.header_seen = true;
                        continue;
                    }
                    let Some(cols) = columns.as_ref() else { continue };
                    let service = normalize_name(cell(row, cols.name));
                    if !usable_service(&service) {
                        continue;
                    }
                    let hint = cell(row, cols.image).trim().to_string();
                    // 「要发哪个 tag」的结论在这里就定死，且只在 Rust 一侧判：
                    // 指定列优先，其次镜像串自带的 `:tag`，都没有才留给准备阶段挑最新。
                    let designated = cols
                        .designated
                        .and_then(|index| {
                            let raw = cell(row, index);
                            (!raw.is_empty()).then(|| normalize_name(raw))
                        })
                        .filter(|tag| !tag.is_empty())
                        .or_else(|| super::image_ref::tag_from_hint(&hint));
                    if hint.is_empty() && designated.is_none() {
                        // 镜像两列都空：这一行还没填，不算待发服务
                        continue;
                    }
                    if notes.rows.len() >= MAX_ROWS {
                        notes.truncated = true;
                        continue;
                    }
                    notes.rows.push(ReleaseRow {
                        ordinal: notes.rows.len(),
                        service_name: service,
                        image_hint: hint,
                        designated_tag: designated,
                    });
                }
            }
        }
    }
    notes.app_tars = tars;
    notes
}

/// docx 字节 → 清单。zip 配额与 XML 状态机与题库共用同一套（见 `quiz::parse::docx`）。
pub fn parse_bytes(bytes: &[u8]) -> Result<ParsedNotes> {
    Ok(parse(&docx::blocks(bytes)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[&[&str]]) -> Block {
        Block::Table(
            rows.iter()
                .map(|row| row.iter().map(|c| c.to_string()).collect())
                .collect(),
        )
    }

    #[test]
    fn columns_are_found_by_header_text_not_by_position() {
        // 前面多一列序号、后面多一列备注，且"镜像""服务名"顺序换了
        let blocks = vec![table(&[
            &["序号", "本次变更镜像", "服务名称", "备注"],
            &["1", "harbor/ns/order:20261030", "order-service", "只改镜像"],
            &["2", "harbor/ns/pay", "pay-service", ""],
        ])];
        let notes = parse(&blocks);
        assert!(notes.header_seen);
        assert_eq!(notes.rows.len(), 2);
        assert_eq!(notes.rows[0].service_name, "order-service");
        assert_eq!(notes.rows[0].image_hint, "harbor/ns/order:20261030");
        assert_eq!(notes.rows[1].service_name, "pay-service");
        assert_eq!(notes.rows[0].ordinal, 0);
        // 没有「指定镜像」列时，镜像串自带的 :tag 就是结论；第二行两处都没写 tag → 由准备阶段挑最新
        assert_eq!(notes.rows[0].designated_tag.as_deref(), Some("20261030"));
        assert_eq!(notes.rows[1].designated_tag, None);
    }

    #[test]
    fn designated_column_is_captured_and_header_repeats_are_skipped() {
        let blocks = vec![
            Block::Line("微服务发布清单".to_string()),
            table(&[
                &["服务名", "镜像", "指定镜像"],
                &["order-service", "harbor/ns/order:20261030", "20261029"],
                &["服务名", "镜像", "指定镜像"],
                &["pay-service", "harbor/ns/pay", ""],
                &["settle-service", "harbor/ns/settle:20261031", ""],
            ]),
        ];
        let notes = parse(&blocks);
        assert_eq!(notes.rows.len(), 3, "重复表头不得当成数据行");
        assert_eq!(notes.rows[0].designated_tag.as_deref(), Some("20261029"), "指定列优先");
        assert_eq!(notes.rows[1].designated_tag, None, "两处都没写 tag 才算没指定");
        assert_eq!(notes.rows[2].designated_tag.as_deref(), Some("20261031"), "指定列空但镜像串写了 tag，结论就是那个 tag");
    }

    #[test]
    fn empty_image_rows_and_other_tables_are_not_collected() {
        let blocks = vec![
            // 与本任务无关的表（没有镜像/服务名两件事）
            table(&[&["题号", "得分"], &["1", "90"]]),
            table(&[
                &["服务名", "镜像"],
                &["order-service", ""],
                &["", "harbor/ns/x:1"],
                &["pay-service", "harbor/ns/pay:1"],
            ]),
        ];
        let notes = parse(&blocks);
        assert_eq!(notes.tables_seen, 2);
        assert_eq!(notes.rows.len(), 1);
        assert_eq!(notes.rows[0].service_name, "pay-service");
    }

    #[test]
    fn tar_links_come_from_cells_and_paragraphs_deduped() {
        let blocks = vec![
            Block::Line("微应用包：https://repo.example.com/app/order.tar 请核对".to_string()),
            table(&[
                &["服务名", "镜像"],
                &["order-service", "harbor/ns/order:1"],
                &["", "http://repo.example.com/app/pay.tar.gz"],
            ]),
            Block::Line("重复一次 https://repo.example.com/app/order.tar。".to_string()),
        ];
        let notes = parse(&blocks);
        assert_eq!(
            notes.app_tars,
            vec!["https://repo.example.com/app/order.tar".to_string(), "http://repo.example.com/app/pay.tar.gz".to_string()]
        );
    }

    #[test]
    fn names_are_normalised_and_a_full_document_gets_a_ceiling() {
        let mut owned: Vec<Vec<String>> = vec![vec!["服务名".into(), "镜像".into()]];
        for i in 0..(MAX_ROWS + 20) {
            owned.push(vec![format!("svc-{i}"), format!("harbor/ns/svc:{i}")]);
        }
        let notes = parse(&[Block::Table(owned)]);
        assert_eq!(notes.rows.len(), MAX_ROWS);
        assert!(notes.truncated, "超过上限要如实说，不能悄悄丢");

        let spaced = vec![table(&[&["服务名", "镜像"], &["　order - service　", "harbor/ns/order:1"]])];
        let notes = parse(&spaced);
        assert_eq!(notes.rows[0].service_name, "order-service", "全角空格与内部空白都要收掉");
    }
}
