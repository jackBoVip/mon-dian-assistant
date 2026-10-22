//! 快捷启动器查询串解析。
//!
//! 规则（需求 2.6.2）：
//! - 以英文逗号 `,` 或中文逗号 `，` 切分为多个条件；额外支持分号。
//! - 引号（半角/全角双引号）内部的逗号不是分隔符；未闭合引号必须报错，不得悄悄改变查询含义。
//! - 每个条件去首尾空格，空条件忽略。
//! - `字段名:值` 为显式字段条件；秘密字段（密码/Token/私钥）被明确拒绝，而不是当作普通关键词。
//! - 条件之间是 AND，不是 OR。

use crate::error::{AppError, Result};

/// 可被显式限定的字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// 目标/系统名称
    System,
    /// 网站地址、主机、IP、端口
    Address,
    /// 外部系统用户名（不是本软件的登录名）
    Username,
    /// 账号别名
    AccountAlias,
    /// 账号类型
    Type,
    /// 标签
    Tag,
    /// 分组
    Group,
    /// 无字段限定：在全部允许搜索的字段中检索
    Any,
}

impl Field {
    pub fn as_str(&self) -> &'static str {
        match self {
            Field::System => "system",
            Field::Address => "address",
            Field::Username => "username",
            Field::AccountAlias => "account_alias",
            Field::Type => "type",
            Field::Tag => "tag",
            Field::Group => "group",
            Field::Any => "any",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Field::System => "系统",
            Field::Address => "地址",
            Field::Username => "账号",
            Field::AccountAlias => "账号别名",
            Field::Type => "类型",
            Field::Tag => "标签",
            Field::Group => "分组",
            Field::Any => "关键词",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Condition {
    pub field: Field,
    pub term: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedQuery {
    pub conditions: Vec<Condition>,
}

const SYNONYMS: &[(&str, Field)] = &[
    ("系统", Field::System),
    ("目标", Field::System),
    ("名称", Field::System),
    ("system", Field::System),
    ("name", Field::System),
    ("target", Field::System),
    ("地址", Field::Address),
    ("网址", Field::Address),
    ("主机", Field::Address),
    ("url", Field::Address),
    ("host", Field::Address),
    ("ip", Field::Address),
    ("port", Field::Address),
    ("address", Field::Address),
    ("账号", Field::Username),
    ("用户名", Field::Username),
    ("username", Field::Username),
    ("user", Field::Username),
    ("账号别名", Field::AccountAlias),
    ("别名", Field::AccountAlias),
    ("alias", Field::AccountAlias),
    ("类型", Field::Type),
    ("type", Field::Type),
    ("标签", Field::Tag),
    ("tag", Field::Tag),
    ("分组", Field::Group),
    ("组", Field::Group),
    ("group", Field::Group),
];

/// 秘密字段：显式列出并拒绝，避免用户误以为可以按密码搜索。
const SECRET_FIELD_NAMES: &[&str] = &[
    "密码", "口令", "私钥", "密钥", "令牌", "秘密",
    "password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "privatekey", "private_key",
];

fn normalize_field(raw: &str) -> Option<Field> {
    let lower = raw.trim().to_lowercase();
    SYNONYMS.iter().find(|(k, _)| *k == lower).map(|(_, f)| *f)
}

fn is_secret_field(raw: &str) -> bool {
    let lower = raw.trim().to_lowercase();
    SECRET_FIELD_NAMES.iter().any(|k| *k == lower)
}

/// 值中出现的类型中文名/英文名 → 内部枚举。
pub fn normalize_type_value(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "网页" | "网站" | "web" => "web".to_string(),
        "终端" | "terminal" | "ssh" | "rdp" | "vnc" => "terminal".to_string(),
        "数据库" | "database" | "db" => "database".to_string(),
        "网络设备" | "network_device" | "设备" => "network_device".to_string(),
        "云平台" | "云服务" | "cloud_service" | "cloud" => "cloud_service".to_string(),
        "文件传输" | "file_transfer" | "sftp" | "ftp" => "file_transfer".to_string(),
        "应用" | "应用账号" | "application" | "app" => "application".to_string(),
        "其他" | "其他秘密" | "generic_secret" | "secret" | "other" => "generic_secret".to_string(),
        other => other.to_string(),
    }
}

fn is_open_quote(c: char) -> bool {
    c == '"' || c == '\u{201c}'
}

fn is_close_quote(c: char) -> bool {
    c == '"' || c == '\u{201d}'
}

fn is_sep(c: char) -> bool {
    c == ',' || c == '\u{ff0c}' || c == ';' || c == '\u{ff1b}'
}

enum Segment<'a> {
    /// 无法识别为字段前缀，整段按自由文本处理
    Free(&'a str),
    Field { key: &'a str, value: &'a str },
}

/// 识别 `字段:值`。URL（冒号后紧跟 `/`）与含空格/过长的前缀都不当作字段名。
fn split_segment(term: &str) -> Segment<'_> {
    for (idx, ch) in term.char_indices() {
        if ch != ':' && ch != '\u{ff1a}' {
            continue;
        }
        let key = &term[..idx];
        let value = &term[idx + ch.len_utf8()..];
        if key.is_empty() || key.len() > 24 || key.chars().any(|c| c.is_whitespace()) || key.contains('/') {
            return Segment::Free(term);
        }
        // http:// 与 https:// 这类协议前缀不是字段名
        if value.starts_with('/') || value.starts_with('\u{ff0f}') {
            return Segment::Free(term);
        }
        return Segment::Field { key, value };
    }
    Segment::Free(term)
}

fn build_condition(raw: &str) -> Result<Option<Condition>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match split_segment(trimmed) {
        Segment::Free(text) => Ok(Some(Condition { field: Field::Any, term: text.to_lowercase() })),
        Segment::Field { key, value } => {
            if is_secret_field(key) {
                return Err(AppError::QuerySyntax(format!(
                    "「{}」属于秘密字段，不允许作为搜索条件",
                    key.trim()
                )));
            }
            let value = value.trim();
            match normalize_field(key) {
                None => Ok(Some(Condition { field: Field::Any, term: trimmed.to_lowercase() })),
                Some(field) if value.is_empty() => Err(AppError::QuerySyntax(format!(
                    "字段「{}」缺少值",
                    field.label()
                ))),
                Some(field) => {
                    let term = match field {
                        Field::Type => normalize_type_value(value),
                        _ => value.to_lowercase(),
                    };
                    Ok(Some(Condition { field, term }))
                }
            }
        }
    }
}

pub fn parse(input: &str) -> Result<ParsedQuery> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut quote: Option<char> = None;

    for ch in input.chars() {
        if let Some(opened) = quote {
            let closes = ch == opened || (opened != '"' && is_close_quote(ch));
            if closes {
                quote = None;
            } else {
                buf.push(ch);
            }
            continue;
        }
        if is_open_quote(ch) {
            quote = Some(ch);
            continue;
        }
        if ch == '\u{201d}' {
            return Err(AppError::QuerySyntax("引号顺序错误：出现了未配对的右引号".into()));
        }
        if is_sep(ch) {
            push(&mut out, &buf)?;
            buf.clear();
            continue;
        }
        buf.push(ch);
    }

    if quote.is_some() {
        return Err(AppError::QuerySyntax("引号未闭合，已拒绝执行以避免误解查询含义".into()));
    }
    push(&mut out, &buf)?;

    Ok(ParsedQuery { conditions: out })
}

fn push(out: &mut Vec<Condition>, raw: &str) -> Result<()> {
    if let Some(c) = build_condition(raw)? {
        out.push(c);
    }
    Ok(())
}

/// 供 UI 展示的搜索语法提示。
pub fn syntax_help() -> Vec<(&'static str, &'static str)> {
    vec![
        ("系统:名称", "按目标/系统名称筛选"),
        ("地址:10.0.0.22", "按网站地址、主机、IP、端口筛选"),
        ("账号:root", "按外部系统用户名筛选"),
        ("账号别名:日常办公", "按账号别名筛选"),
        ("类型:网页", "按账号类型筛选，支持中文或英文"),
        ("标签:生产", "按标签筛选"),
        ("分组:运维", "按分组筛选"),
        ("逗号分隔", "英文 , 或中文 ，表示 AND，全部命中才返回"),
        ("双引号", "包裹含逗号的关键词，如 \"OA,门户\""),
        ("不可搜索", "密码、Token、私钥等秘密字段"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(q: &str) -> Vec<(Field, String)> {
        parse(q).unwrap().conditions.iter().map(|c| (c.field, c.term.clone())).collect()
    }

    #[test]
    fn english_comma_splits_into_and_conditions() {
        assert_eq!(terms("OA, zhangsan"), vec![(Field::Any, "oa".into()), (Field::Any, "zhangsan".into())]);
    }

    #[test]
    fn chinese_comma_splits_too() {
        assert_eq!(terms("运维账号，数据库"), vec![(Field::Any, "运维账号".into()), (Field::Any, "数据库".into())]);
    }

    #[test]
    fn three_explicit_fields() {
        assert_eq!(
            terms("系统:内部门户, 账号别名:日常办公, 类型:网页"),
            vec![
                (Field::System, "内部门户".into()),
                (Field::AccountAlias, "日常办公".into()),
                (Field::Type, "web".into()),
            ]
        );
    }

    #[test]
    fn mixed_fullwidth_colon_and_synonyms() {
        assert_eq!(
            terms("地址：10.0.0.22，用户名：root"),
            vec![(Field::Address, "10.0.0.22".into()), (Field::Username, "root".into())]
        );
    }

    #[test]
    fn empty_and_repeated_separators_are_ignored() {
        assert_eq!(terms("OA,,  ，  zhangsan ,"), vec![
            (Field::Any, "oa".into()),
            (Field::Any, "zhangsan".into()),
        ]);
    }

    #[test]
    fn whitespace_only_is_empty_query() {
        assert!(parse("   ，  ").unwrap().conditions.is_empty());
    }

    #[test]
    fn quoted_comma_is_not_a_separator() {
        assert_eq!(terms("\"OA,门户\""), vec![(Field::Any, "oa,门户".into())]);
    }

    #[test]
    fn fullwidth_quotes_work() {
        assert_eq!(terms("“OA,门户”"), vec![(Field::Any, "oa,门户".into())]);
    }

    #[test]
    fn unclosed_quote_is_rejected_not_silently_reinterpreted() {
        assert!(matches!(parse("系统:\"OA, 门户"), Err(AppError::QuerySyntax(_))));
    }

    #[test]
    fn stray_closing_quote_is_rejected() {
        assert!(matches!(parse("OA”门户"), Err(AppError::QuerySyntax(_))));
    }

    #[test]
    fn field_without_value_is_rejected() {
        assert!(matches!(parse("系统:"), Err(AppError::QuerySyntax(_))));
    }

    #[test]
    fn password_field_is_never_searchable() {
        for name in ["密码", "口令", "私钥", "token", "Token", "password", "api_key", "密钥"] {
            let r = parse(&format!("{name}:hunter2"));
            assert!(matches!(r, Err(AppError::QuerySyntax(_))), "{name} 不应可作为搜索字段, got {r:?}");
        }
    }

    #[test]
    fn unknown_prefix_falls_back_to_free_text_without_losing_the_colon() {
        assert_eq!(terms("备注:生产环境"), vec![(Field::Any, "备注:生产环境".into())]);
    }

    #[test]
    fn type_values_normalized_bilingually() {
        assert_eq!(terms("类型:数据库")[0].1, "database");
        assert_eq!(terms("类型:WEB")[0].1, "web");
        assert_eq!(terms("类型:SSH")[0].1, "terminal");
    }

    #[test]
    fn url_with_protocol_is_not_treated_as_field() {
        assert_eq!(terms("地址:https://oa.example.cn/login"), vec![
            (Field::Address, "https://oa.example.cn/login".into())
        ]);
        assert_eq!(terms("https://oa.example.cn:8443/login"), vec![
            (Field::Any, "https://oa.example.cn:8443/login".into())
        ]);
    }

    #[test]
    fn ascii_input_is_lowercased_cjk_preserved() {
        assert_eq!(terms("系统:Portal")[0].1, "portal");
        assert_eq!(terms("系统:门户")[0].1, "门户");
    }

    #[test]
    fn semicolon_also_splits() {
        assert_eq!(terms("OA; zhangsan").len(), 2);
    }
}
