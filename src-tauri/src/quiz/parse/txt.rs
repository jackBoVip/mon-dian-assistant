//! 纯文本题库：先定编码，再交给状态机。
//!
//! 编码顺序是 BOM → chardetng 猜测；猜完还要数一遍替换字符，U+FFFD 超过 2% 就报错而不是
//! 把满屏问号存进题库——"导入成功但全是乱码"比"导入失败"更难排查。

use crate::error::{AppError, Result};
use crate::quiz::models::ParsedQuestion;
use crate::quiz::parse::rules;

/// BOM 优先；没有 BOM 就按 chardetng 的判定解。返回解码后的文本。
pub fn decode(bytes: &[u8]) -> Result<String> {
    let (text, had_errors) = if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (cow, _, err) = enc.decode(&bytes[bom_len..]);
        (cow.into_owned(), err)
    } else {
        // 题库是本地文件、不执行脚本：ISO-2022-JP 与 UTF-8 都允许参与猜测
        let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
        detector.feed(bytes, true);
        let enc = detector.guess(None, chardetng::Utf8Detection::Allow);
        let (cow, _, err) = enc.decode(bytes);
        (cow.into_owned(), err)
    };
    let total = text.chars().count();
    let broken = text.chars().filter(|c| *c == '\u{FFFD}').count();
    if total == 0 {
        return Err(AppError::QuizParseFailed("文件是空的".into()));
    }
    if had_errors || broken * 50 > total {
        return Err(AppError::QuizParseFailed(format!(
            "无法识别文件编码：解码后约有 {}% 的字符是乱码，请另存为 UTF-8 后重试",
            (broken * 100 / total.max(1)).max(1)
        )));
    }
    Ok(text)
}

pub fn parse(bytes: &[u8]) -> Result<Vec<ParsedQuestion>> {
    let text = decode(bytes)?;
    let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    Ok(rules::parse_lines(&lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gbk(s: &str) -> Vec<u8> {
        let (bytes, _, _) = encoding_rs::GBK.encode(s);
        bytes.into_owned()
    }

    #[test]
    fn utf8_bom_and_plain_utf8_both_decode() {
        let body = "1. 变压器可以带负荷拉合隔离开关\n答案：错误\n";
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(body.as_bytes());
        assert_eq!(parse(&with_bom).unwrap().len(), 1);
        assert_eq!(parse(body.as_bytes()).unwrap().len(), 1);
    }

    #[test]
    fn gbk_is_detected() {
        let bytes = gbk("1. 变压器可以带负荷拉合隔离开关\n答案：错误\n");
        let qs = parse(&bytes).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].answer.display(), "错误");
    }

    #[test]
    fn utf16le_bom_is_honoured() {
        let text = "1. 变压器可以带负荷拉合隔离开关\n答案：错误\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(parse(&bytes).unwrap().len(), 1);
    }

    #[test]
    fn garbage_is_rejected_instead_of_stored_as_mojibake() {
        // 带 UTF-8 BOM 却全是非法字节：解码器只能给出替换字符，此时必须报错
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend(std::iter::repeat(0xFFu8).take(256));
        let err = parse(&bytes).unwrap_err();
        assert_eq!(err.code(), "QUIZ_PARSE_FAILED");
    }
}
