//! 笔记存储层：页面、素材与按使用者隔离的读取。
//!
//! 隔离口径：所有 SQL 都带 `created_by = ?`，别人的笔记一律表现为「不存在」，
//! 不区分「无权限」与「没有这篇」——否则拿 id 猜一轮就能探出别人写了几篇。
//!
//! 素材字节只进 `note_assets`，出站一律转成 `data:` URL：CSP 只有 `img-src 'self' data:`，
//! 资产协议没开，前端也就不可能借笔记页面加载本机任意文件。

use base64::Engine as _;
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

use crate::db::repo::now;
use crate::db::Db;
use crate::error::{AppError, Result};

pub const TITLE_MAX_CHARS: usize = 120;
pub const UNTITLED: &str = "无标题笔记";
/// 单篇正文上限：5 MiB 的 HTML 已经相当于一本小册子，再大就该拆篇。
pub const HTML_MAX_BYTES: usize = 5 * 1024 * 1024;
/// 单张图片上限：截图与示意图远不到这个量级，超了多半是选错了文件。
pub const ASSET_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const SNIPPET_CHARS: usize = 120;

const MIMES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub title: String,
    pub content_html: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAssetDto {
    pub id: String,
    pub mime: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    pub note: NoteRecord,
    pub assets: Vec<NoteAssetDto>,
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// 标题空则回落「无标题笔记」，超长按字符截断（库里的 CHECK 卡的是 1–120 字）。
pub fn sanitize_title(raw: &str) -> String {
    let trimmed: String = raw.trim().chars().take(TITLE_MAX_CHARS).collect();
    if trimmed.is_empty() {
        UNTITLED.to_string()
    } else {
        trimmed
    }
}

/// 按魔数认图片类型。调用方给的 mime 一概不采信：剪贴板与文件名都能随口编。
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn like_pattern(q: &str) -> String {
    let mut s = String::with_capacity(q.len() + 2);
    s.push('%');
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(ch);
    }
    s.push('%');
    s
}

/// 列表摘要用的纯文本：去标签、解少量实体、压空白。只用于展示，不写回库。
fn plain_snippet(html: &str) -> String {
    const BLOCK_TAGS: &[&str] = &[
        "p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr",
        "td", "th", "blockquote", "pre", "hr",
    ];
    let mut text = String::with_capacity(html.len().min(4096));
    let mut rest = html;
    while let Some(pos) = rest.find('<') {
        text.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let Some(end) = find_tag_end(tail) else {
            text.push_str(tail);
            rest = "";
            break;
        };
        // 行内标签（b/em/mark…）不插空格，否则「检查油位」会被拆成「检查 油位」
        let name = tail[1..]
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if BLOCK_TAGS.contains(&name.as_str()) {
            text.push(' ');
        }
        rest = &tail[end + 1..];
    }
    text.push_str(rest);
    for (from, to) in [
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
    ] {
        text = text.replace(from, to);
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(SNIPPET_CHARS).collect()
}

fn map_summary(r: &Row) -> rusqlite::Result<NoteSummary> {
    let html: String = r.get(2)?;
    Ok(NoteSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        snippet: plain_snippet(&html),
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn map_record(r: &Row) -> rusqlite::Result<NoteRecord> {
    Ok(NoteRecord {
        id: r.get(0)?,
        title: r.get(1)?,
        content_html: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

const RECORD_COLUMNS: &str = "id, title, content_html, created_at, updated_at";

pub fn list(db: &Db, user: &str, q: Option<&str>) -> Result<Vec<NoteSummary>> {
    let pattern = q
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(like_pattern);
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html, created_at, updated_at
           FROM note_pages
          WHERE created_by = ?1
            AND (?2 IS NULL OR title LIKE ?2 ESCAPE '\\' OR content_html LIKE ?2 ESCAPE '\\')
          ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt
        .query_map(params![user, pattern], map_summary)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 浮层全局搜索用：关键字命中自己的笔记，只回摘要，一定带 `LIMIT`。
///
/// 与 `list` 同一条隔离口径（`created_by = ?`，别人的笔记表现为不存在）和同一个 LIKE 转义。
/// 两处不同是有意的：
/// - `list` 无关键字时要返回全部（左栏就是那个形状），这条只有关键字且带上限——
///   正文最大 5 MiB/篇，没有 LIMIT 就是一次无界全表扫。
/// - 摘要锚在命中处（[`hit_window`]）。`list` 的摘要取正文开头，那里本来就该是篇首；
///   浮层里一个命中正文中段的词若还显示篇首 120 字，那一行就解释不了它为什么会被搜到。
pub fn search(db: &Db, user: &str, q: &str, limit: i64) -> Result<Vec<NoteSummary>> {
    let needle = q.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = like_pattern(&needle);
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, content_html, created_at, updated_at
           FROM note_pages
          WHERE created_by = ?2
            AND (title LIKE ?1 ESCAPE '\\' OR content_html LIKE ?1 ESCAPE '\\')
          ORDER BY updated_at DESC, id DESC
          LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![pattern, user, limit], |r| {
            let title: String = r.get(1)?;
            let html: String = r.get(2)?;
            // 标题命中时正文摘要取篇首即可——标题本身已经说明了这一行为什么出现。
            let snippet = if title.to_lowercase().contains(&needle) {
                plain_snippet(&html)
            } else {
                hit_window(&html, &needle).unwrap_or_else(|| plain_snippet(&html))
            };
            Ok(NoteSummary {
                id: r.get(0)?,
                snippet,
                title,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 命中窗口：在原始 HTML 里找到关键词第一次出现的位置，前后各取一段字节预算，再走同一套去标签。
///
/// 只处理这一小段：整篇去标签再找词的话，每敲一次输入都要搬一遍最大 5 MiB 的正文。
/// 预算按字节给（CJK 一字 3 字节），命中点前 200 B、后 600 B，而去标签只会让文本变短，
/// 所以命中处一定还留在 [`SNIPPET_CHARS`] 的窗口里。
fn hit_window(html: &str, term: &str) -> Option<String> {
    let pos = html.to_lowercase().find(term)?;
    let from = floor_char_boundary(html, pos.saturating_sub(200));
    let to = ceil_char_boundary(html, (pos + term.len() + 600).min(html.len()));
    let text = plain_snippet(&html[from..to]);
    if text.is_empty() {
        return None;
    }
    // 前面截掉了内容就说一声，否则读者会以为这段就是笔记的开头
    Some(if from > 0 { format!("…{text}") } else { text })
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// 浮层「打开这一篇」落点前的一句确认：这一篇在不在、叫什么。
///
/// 只取标题，不走 `get`：`get` 会把这篇的全部图片素材读出来转成 data URL，
/// 而这里要的只是"存在且有权限"这一个结论和那句提示里的名字。
pub fn title(db: &Db, user: &str, id: &str) -> Result<String> {
    let conn = db.lock_conn();
    conn.query_row(
        "SELECT title FROM note_pages WHERE id = ?1 AND created_by = ?2",
        params![id, user],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .ok_or(AppError::NotFound)
}

pub fn get(db: &Db, user: &str, id: &str) -> Result<NoteDetail> {
    let conn = db.lock_conn();
    let note = conn
        .query_row(
            &format!("SELECT {RECORD_COLUMNS} FROM note_pages WHERE id = ?1 AND created_by = ?2"),
            params![id, user],
            map_record,
        )
        .optional()?
        .ok_or(AppError::NotFound)?;
    let mut stmt = conn.prepare(
        "SELECT id, mime, data FROM note_assets WHERE note_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let assets = stmt
        .query_map(params![id], |r| {
            let mime: String = r.get(1)?;
            let bytes: Vec<u8> = r.get(2)?;
            Ok(NoteAssetDto { id: r.get(0)?, mime: mime.clone(), data_url: data_url(&mime, &bytes) })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(NoteDetail { note, assets })
}

/// 上一篇/下一篇列表页的正文也要一并取回：界面切笔记时只发这一条命令。
pub fn create(db: &Db, user: &str) -> Result<NoteDetail> {
    let id = new_id();
    let ts = now();
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO note_pages (id, title, content_html, created_by, created_at, updated_at)
         VALUES (?1, ?2, '', ?3, ?4, ?4)",
        params![id, UNTITLED, user, ts],
    )?;
    drop(conn);
    get(db, user, &id)
}

pub fn update(db: &Db, user: &str, id: &str, title: &str, html: &str) -> Result<NoteRecord> {
    if html.len() > HTML_MAX_BYTES {
        return Err(AppError::NoteTooLarge);
    }
    let title = sanitize_title(title);
    let ts = now();
    let conn = db.lock_conn();
    let changed = conn.execute(
        "UPDATE note_pages SET title = ?1, content_html = ?2, updated_at = ?3
          WHERE id = ?4 AND created_by = ?5",
        params![title, html, ts, id, user],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    let record = conn.query_row(
        &format!("SELECT {RECORD_COLUMNS} FROM note_pages WHERE id = ?1 AND created_by = ?2"),
        params![id, user],
        map_record,
    )?;
    Ok(record)
}

pub fn delete(db: &Db, user: &str, id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let changed = conn.execute(
        "DELETE FROM note_pages WHERE id = ?1 AND created_by = ?2",
        params![id, user],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

fn owns(conn: &rusqlite::Connection, user: &str, note_id: &str) -> Result<()> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM note_pages WHERE id = ?1 AND created_by = ?2",
        params![note_id, user],
        |r| r.get(0),
    )?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// 插入一张素材并回传 data URL，界面拿到就能立刻插进编辑器。
pub fn add_asset(db: &Db, user: &str, note_id: &str, bytes: &[u8]) -> Result<NoteAssetDto> {
    if bytes.is_empty() || bytes.len() > ASSET_MAX_BYTES {
        return Err(if bytes.is_empty() {
            AppError::FileFormatInvalid
        } else {
            AppError::NoteTooLarge
        });
    }
    let mime = sniff_image_mime(bytes).ok_or(AppError::NoteAssetUnsupported)?;
    debug_assert!(MIMES.contains(&mime));
    let id = new_id();
    let conn = db.lock_conn();
    owns(&conn, user, note_id)?;
    conn.execute(
        "INSERT INTO note_assets (id, note_id, mime, byte_len, data, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, note_id, mime, bytes.len() as i64, bytes, now()],
    )?;
    Ok(NoteAssetDto { id, mime: mime.to_string(), data_url: data_url(mime, bytes) })
}

/// 导出用：当前使用者的全部笔记与素材原始字节（打包在 export.rs 里）。
pub struct ExportNote {
    pub record: NoteRecord,
    pub assets: Vec<(String, String, Vec<u8>)>,
}

pub fn all_for_export(db: &Db, user: &str) -> Result<Vec<ExportNote>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        &format!(
            "SELECT {RECORD_COLUMNS} FROM note_pages WHERE created_by = ?1 ORDER BY updated_at DESC, id DESC"
        ),
    )?;
    let records = stmt
        .query_map(params![user], map_record)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut asset_stmt = conn.prepare(
        "SELECT id, mime, data FROM note_assets WHERE note_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let mut out = Vec::with_capacity(records.len());
    for record in records {
        let assets = asset_stmt
            .query_map(params![record.id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Vec<u8>>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out.push(ExportNote { record, assets });
    }
    Ok(out)
}

/// 导入落库：调用方已把材料读进内存并换好 id，这里只做单事务写入。
pub struct ImportNote {
    pub id: String,
    pub title: String,
    pub content_html: String,
    pub created_at: String,
    pub updated_at: String,
    pub assets: Vec<(String, String, Vec<u8>)>,
}

pub fn insert_imported(db: &Db, user: &str, notes: &[ImportNote]) -> Result<(usize, usize)> {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let mut note_count = 0usize;
    let mut asset_count = 0usize;
    for note in notes {
        tx.execute(
            "INSERT INTO note_pages (id, title, content_html, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![note.id, note.title, note.content_html, user, note.created_at, note.updated_at],
        )?;
        for (asset_id, mime, bytes) in &note.assets {
            tx.execute(
                "INSERT INTO note_assets (id, note_id, mime, byte_len, data, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![asset_id, note.id, mime, bytes.len() as i64, bytes, note.created_at],
            )?;
            asset_count += 1;
        }
        note_count += 1;
    }
    tx.commit()?;
    Ok((note_count, asset_count))
}

/// 导入（外部 zip）进来的 HTML 只保内容：
/// 脚本/内联框架/表单类整块丢弃，标签与属性按白名单重写，`src` 一律不保留
/// （图片只认 `data-mda-asset` 指向的保险库素材），`href` 只放行 http(s)/mailto/相对链接。
/// 编辑器自己产出的 HTML 不走这里——`notes_update` 存的是 ProseMirror 规范化后的结果。
pub fn sanitize_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('<') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        if tail.starts_with("<!--") {
            match tail.find("-->") {
                Some(end) => rest = &tail[end + 3..],
                None => rest = "",
            }
            continue;
        }
        let Some(end) = find_tag_end(tail) else {
            // 没有闭合的 '<'：当普通文本原样保留
            out.push_str(tail);
            rest = "";
            break;
        };
        let tag_text = &tail[..=end];
        rest = &tail[end + 1..];
        let inner = tag_text[1..tag_text.len() - 1].trim();
        if inner.starts_with('!') || inner.starts_with('?') {
            continue;
        }
        let closing = inner.starts_with('/');
        let body = if closing { inner[1..].trim_start() } else { inner };
        let name_end = body.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(body.len());
        let name = body[..name_end].to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let self_closing = body.trim_end().ends_with('/');
        if DROP_CONTENT_TAGS.contains(&name.as_str()) {
            if !closing && !self_closing {
                if let Some(skip) = skip_to_close(rest, &name) {
                    rest = &rest[skip..];
                }
            }
            continue;
        }
        if !ALLOWED_TAGS.contains(&name.as_str()) {
            // 认不出的标签只丢标签本身，里面的文字照留
            continue;
        }
        if closing {
            out.push_str("</");
            out.push_str(&name);
            out.push('>');
            continue;
        }
        let attrs = parse_attrs(&body[name_end..]);
        // `<input>` 在这份内容里只有一种存在的理由：任务列表那颗勾。type 不是 checkbox 的
        // （text/hidden/…）连标签一起丢。
        if name == "input" && !attrs.iter().any(|(k, v)| k == "type" && v == "checkbox") {
            continue;
        }
        out.push('<');
        out.push_str(&name);
        for (key, value) in attrs {
            if !ALLOWED_ATTRS.contains(&key.as_str()) {
                continue;
            }
            if key == "href" && !is_safe_url(&value) {
                continue;
            }
            let value = if key == "style" {
                match sanitize_style(&value) {
                    Some(clean) => clean,
                    None => continue,
                }
            } else {
                escape_attr(&value)
            };
            out.push(' ');
            out.push_str(&key);
            out.push_str("=\"");
            out.push_str(&value);
            out.push('"');
        }
        out.push('>');
    }
    out.push_str(rest);
    out
}

/// style 是唯一"值里能写出结构"的属性，所以它同时过两道闸：**属性名**要在这八枚里，
/// **值形状**按属性各自认（颜色认 hex / `var(--t-…)` 令牌 / 裸色名，尺寸认带单位的数，
/// 对齐认四个关键字，行距认裸数或带单位的数）。认不出的整条丢掉，宁缺不猜。
const STYLE_PROPS: &[&str] = &[
    "color",
    "background-color",
    "font-size",
    "text-align",
    "line-height",
    "margin-left",
    "width",
    "min-width",
];

/// 一个元素上最多留几档声明：正常排版用不到 3 条以上，超了就是有人在往里塞东西。
const STYLE_MAX_DECLS: usize = 8;

fn sanitize_style(raw: &str) -> Option<String> {
    let mut kept: Vec<(String, String)> = Vec::new();
    for decl in raw.split(';') {
        let Some((prop, value)) = decl.split_once(':') else { continue };
        let prop = prop.trim().to_ascii_lowercase();
        let value = value.trim().to_ascii_lowercase();
        if !STYLE_PROPS.contains(&prop.as_str()) || !is_safe_style_value(&prop, &value) {
            continue;
        }
        // 同名属性后写的赢（与 CSS 一致），所以覆盖而不是追加
        match kept.iter_mut().find(|(p, _)| *p == prop) {
            Some(slot) => slot.1 = value,
            None => kept.push((prop, value)),
        }
        if kept.len() >= STYLE_MAX_DECLS {
            break;
        }
    }
    if kept.is_empty() {
        return None;
    }
    let joined = kept
        .iter()
        .map(|(p, v)| format!("{p}: {v}"))
        .collect::<Vec<_>>()
        .join("; ");
    Some(escape_attr(&joined))
}

fn is_safe_style_value(prop: &str, value: &str) -> bool {
    match prop {
        "color" | "background-color" => is_hex_color(value) || is_token_var(value) || is_bare_word(value),
        "text-align" => matches!(value, "left" | "center" | "right" | "justify"),
        "line-height" => is_unitless_number(value) || is_length(value),
        "font-size" => is_length(value),
        "margin-left" | "width" | "min-width" => value == "auto" || is_length(value),
        _ => false,
    }
}

/// `#rgb` / `#rrggbb` / `#rrggbbaa`。
fn is_hex_color(v: &str) -> bool {
    let Some(digits) = v.strip_prefix('#') else { return false };
    (3..=8).contains(&digits.len()) && digits.chars().all(|c| c.is_ascii_hexdigit())
}

/// 只认设计令牌那一档 `var(--t-xxx)`：色板存令牌而不是存实色，四套主题才各自适配，
/// 源文件里也不必出现字面色值（`themeContrast.test.ts` 的口径）。
fn is_token_var(v: &str) -> bool {
    let Some(inner) = v.strip_prefix("var(").and_then(|s| s.strip_suffix(')')) else { return false };
    let Some(name) = inner.strip_prefix("--t-") else { return false };
    !name.is_empty()
        && name.len() <= 40
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// CSS 具名色：纯字母（red / darkslategray）。不带括号引号与冒号，写不出结构。
fn is_bare_word(v: &str) -> bool {
    (3..=20).contains(&v.len()) && v.chars().all(|c| c.is_ascii_alphabetic())
}

/// 带单位的尺寸：整数位最多三位（`100000px` 那种撑爆版面的不算），单位只认这五种。
fn is_length(v: &str) -> bool {
    let split = v
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(v.len());
    let (num, unit) = (&v[..split], &v[split..]);
    if !["px", "em", "rem", "pt", "%"].contains(&unit) {
        return false;
    }
    is_plain_number(num)
}

/// 裸数（行距那一档）：0.5 到 10 之间，最多一位小数点。
fn is_unitless_number(v: &str) -> bool {
    is_plain_number(v) && v.parse::<f32>().map(|n| (0.5..=10.0).contains(&n)).unwrap_or(false)
}

fn is_plain_number(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 5
        && v.chars().all(|c| c.is_ascii_digit() || c == '.')
        && v.chars().filter(|c| *c == '.').count() <= 1
        && !v.starts_with('.')
        && !v.ends_with('.')
}

const ALLOWED_TAGS: &[&str] = &[
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
    "strong", "b", "em", "i", "u", "s", "del", "mark", "hr", "a", "img", "table", "thead", "tbody",
    "tfoot", "tr", "th", "td", "colgroup", "col", "span", "div", "details", "summary", "label", "input",
];

/// 这些标签连同内容一起丢：里面的文字也不该出现在笔记里。
/// `input` 不在这一列——它由标签循环里那道「type 必须是 checkbox」的闸单独管。
const DROP_CONTENT_TAGS: &[&str] = &[
    "script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "form",
    "textarea", "select", "button", "link", "meta", "base", "title", "head", "video", "audio",
    "source", "track", "canvas",
];

const ALLOWED_ATTRS: &[&str] = &[
    "data-mda-asset",
    "alt",
    "title",
    "href",
    "target",
    "rel",
    "class",
    "style",
    "colspan",
    "rowspan",
    "colwidth",
    "start",
    "type",
    "checked",
    "data-type",
    "data-checked",
    "data-color",
    "data-language",
    "language",
];

fn find_tag_end(s: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, ch) in s.char_indices().skip(1) {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                }
            }
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                '>' => return Some(i),
                _ => {}
            },
        }
    }
    None
}

fn skip_to_close(s: &str, name: &str) -> Option<usize> {
    let needle = format!("</{name}");
    let lower = s.to_ascii_lowercase();
    let pos = lower.find(&needle)?;
    let end = find_tag_end(&s[pos..])?;
    Some(pos + end + 1)
}

fn parse_attrs(mut s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    loop {
        s = s.trim_start();
        if s.is_empty() {
            break;
        }
        let name_end = s.find(|c: char| c.is_whitespace() || c == '=' || c == '/').unwrap_or(s.len());
        if name_end == 0 {
            s = &s[1..];
            continue;
        }
        let name = s[..name_end].to_ascii_lowercase();
        let rest = s[name_end..].trim_start();
        if let Some(after_eq) = rest.strip_prefix('=') {
            let after_eq = after_eq.trim_start();
            let (value, next) = match after_eq.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    let inner = &after_eq[1..];
                    match inner.find(q) {
                        Some(i) => (inner[..i].to_string(), &inner[i + 1..]),
                        None => (inner.to_string(), ""),
                    }
                }
                _ => {
                    let end = after_eq.find(char::is_whitespace).unwrap_or(after_eq.len());
                    (after_eq[..end].to_string(), &after_eq[end..])
                }
            };
            out.push((name, value));
            s = next;
        } else {
            out.push((name, String::new()));
            s = rest;
        }
    }
    out
}

fn is_safe_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        return true;
    }
    match lower.find(':') {
        None => true,
        Some(colon) => {
            let boundary = lower.find(|c: char| c == '/' || c == '?' || c == '#').unwrap_or(usize::MAX);
            colon > boundary
        }
    }
}

fn escape_attr(value: &str) -> String {
    value
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "u1";
    const OTHER: &str = "u2";

    fn db() -> Db {
        Db::open_in_memory(&vec![9u8; 32]).unwrap()
    }

    #[test]
    fn crud_round_trip_and_snippet() {
        let db = db();
        let created = create(&db, USER).unwrap();
        assert_eq!(created.note.title, UNTITLED);
        assert!(created.note.content_html.is_empty());

        let rec = update(
            &db,
            USER,
            &created.note.id,
            "  变压器检修  ",
            "<h1>计划</h1><p>检查<b>油位</b>&nbsp;与温度</p>",
        )
        .unwrap();
        assert_eq!(rec.title, "变压器检修");
        let summaries = list(&db, USER, None).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].snippet, "计划 检查油位 与温度");

        assert_eq!(list(&db, USER, Some("油位")).unwrap().len(), 1);
        assert!(list(&db, USER, Some("不存在的词")).unwrap().is_empty());
        // LIKE 的通配符不能被查询串当成语法
        assert!(list(&db, USER, Some("%")).unwrap().is_empty());
    }

    #[test]
    fn notes_are_isolated_per_user() {
        let db = db();
        let note = create(&db, USER).unwrap();
        update(&db, USER, &note.note.id, "私有", "<p>x</p>").unwrap();

        assert!(get(&db, OTHER, &note.note.id).is_err());
        assert!(update(&db, OTHER, &note.note.id, "改", "").is_err());
        assert!(delete(&db, OTHER, &note.note.id).is_err());
        assert!(list(&db, OTHER, None).unwrap().is_empty());
        assert_eq!(list(&db, USER, None).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_note_cascades_its_assets() {
        let db = db();
        let note = create(&db, USER).unwrap();
        let png = [
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0,
        ];
        let asset = add_asset(&db, USER, &note.note.id, &png).unwrap();
        assert_eq!(asset.mime, "image/png");
        assert!(asset.data_url.starts_with("data:image/png;base64,"));

        delete(&db, USER, &note.note.id).unwrap();
        let c = db.lock_conn();
        let left: i64 = c
            .query_row("SELECT count(*) FROM note_assets WHERE note_id = ?1", params![note.note.id], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "删笔记必须级联清掉素材字节");
    }

    #[test]
    fn asset_mime_comes_from_magic_bytes_not_from_the_caller() {
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0x00]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a......"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"not an image"), None);
    }

    #[test]
    fn upload_rejects_foreign_or_oversized_bytes() {
        let db = db();
        let note = create(&db, USER).unwrap();
        assert!(matches!(
            add_asset(&db, USER, &note.note.id, b"plain text"),
            Err(AppError::NoteAssetUnsupported)
        ));
        assert!(matches!(add_asset(&db, USER, &note.note.id, &[]), Err(AppError::FileFormatInvalid)));
    }

    #[test]
    fn title_falls_back_and_truncates() {
        assert_eq!(sanitize_title("   "), UNTITLED);
        let long = "字".repeat(TITLE_MAX_CHARS + 20);
        assert_eq!(sanitize_title(&long).chars().count(), TITLE_MAX_CHARS);
    }

    /// 导入 extern 来源的 HTML 只保内容：脚本、内联事件、远程 src 一律丢。
    #[test]
    fn sanitize_strips_scripts_handlers_and_remote_sources() {
        let dirty = concat!(
            "<p onclick=\"steal()\">hi</p>",
            "<script>alert(1)</script>",
            "<img src=\"http://evil/x.png\" data-mda-asset=\"a1\" onerror=\"x()\">",
            "<a href=\"javascript:alert(1)\">bad</a>",
            "<a href=\"https://example.com\">ok</a>",
        );
        let clean = sanitize_html(dirty);
        assert!(!clean.contains("script"));
        assert!(!clean.contains("onclick"));
        assert!(!clean.contains("onerror"));
        assert!(!clean.contains("javascript:"));
        assert!(!clean.contains("http://evil"));
        assert!(clean.contains("data-mda-asset=\"a1\""));
        assert!(clean.contains("href=\"https://example.com\""));
        assert!(clean.contains("<p>hi</p>"));
    }

    #[test]
    fn sanitize_keeps_editor_markup_intact() {
        let doc = concat!(
            "<h2>标题</h2><p><strong>粗</strong><em>斜</em><mark>高亮</mark><code>x</code></p>",
            "<ul><li><p>一</p></li></ul>",
            "<pre><code class=\"language-rust\">fn main() {}</code></pre>",
            "<table><colgroup><col style=\"min-width: 25px\"></colgroup>",
            "<tbody><tr><th colspan=\"1\" rowspan=\"1\" colwidth=\"120\"><p>a</p></th>",
            "<td colspan=\"1\" rowspan=\"1\"><p>b</p></td></tr></tbody></table>",
            "<img data-mda-asset=\"asset-1\" alt=\"图\">",
        );
        let clean = sanitize_html(doc);
        for keep in [
            "<h2>标题</h2>",
            "<strong>粗</strong>",
            "<mark>高亮</mark>",
            "class=\"language-rust\"",
            "colspan=\"1\"",
            "colwidth=\"120\"",
            "data-mda-asset=\"asset-1\"",
            "alt=\"图\"",
        ] {
            assert!(clean.contains(keep), "丢了 {keep}：{clean}");
        }
    }

    /// 排版属性（颜色/字号/对齐/行距/缩进）走 `style`，所以 style 必须放行——但只放行
    /// 白名单里的属性 × 白名单里的值形状。色板存的是 `var(--t-…)` 令牌引用而不是实色，
    /// 这样四套主题下同一篇笔记的字色会各自适配，源文件里也就不必出现字面色值。
    #[test]
    fn sanitize_keeps_whitelisted_style_and_drops_the_rest() {
        let dirty = concat!(
            "<p style=\"text-align: center; position: fixed; color: var(--t-danger); font-size: 18px\">中</p>",
            "<span style=\"background-color:#12ab34; behavior: url(http://evil/x.htc)\">底</span>",
            "<p style=\"line-height: 1.75; margin-left: 2em\">距</p>",
        );
        let clean = sanitize_html(dirty);
        assert!(clean.contains("text-align: center"), "对齐被误删：{clean}");
        assert!(clean.contains("color: var(--t-danger)"), "令牌色被误删：{clean}");
        assert!(clean.contains("font-size: 18px"), "字号被误删：{clean}");
        assert!(clean.contains("background-color: #12ab34"), "底色被误删：{clean}");
        assert!(clean.contains("line-height: 1.75"), "行距被误删：{clean}");
        assert!(clean.contains("margin-left: 2em"), "缩进被误删：{clean}");
        assert!(!clean.contains("position"), "position 漏进白名单：{clean}");
        assert!(!clean.contains("behavior"), "behavior 漏进白名单：{clean}");
        assert!(!clean.contains("url("), "url() 值没挡住：{clean}");
    }

    /// style 是注入面：`}`、`<`、引号、`expression(`、多出来的冒号都可能被解析器当结构读，
    /// 所以值只认那几种形状，认不出的整条丢，属性名不在白名单的也整条丢。
    #[test]
    fn sanitize_rejects_malicious_and_malformed_style_values() {
        let cases = [
            "<p style=\"color: red; } body { display: none\">花括号</p>",
            "<p style=\"color: expression(alert(1))\">IE 表达式</p>",
            "<p style=\"color: javascript:alert(1)\">伪协议</p>",
            "<p style=\"font-size: 100000px\">超大字号</p>",
            "<p style=\"color: var(--t-danger); --x: url(javascript:1)\">夹带</p>",
            "<p style=\"text-align: left<script\">尖括号</p>",
            "<p style=\"line-height: -1\">负行距</p>",
        ];
        for dirty in cases {
            let clean = sanitize_html(dirty);
            for banned in ["}", "{", "expression", "javascript", "url(", "<script", "100000", "-1", "--x"] {
                assert!(!clean.contains(banned), "{banned:?} 漏进产物：{clean}（源 {dirty}）");
            }
            // 正文文字本身不能因为样式被丢而消失
            assert!(clean.contains("花括号") || clean.contains("IE 表达式") || clean.contains("伪协议")
                || clean.contains("超大字号") || clean.contains("夹带") || clean.contains("尖括号")
                || clean.contains("负行距"), "正文被吞了：{clean}");
        }
        // 唯一该留下的那一条
        assert!(sanitize_html("<p style=\"color: var(--t-danger); --x: url(javascript:1)\">夹带</p>")
            .contains("color: var(--t-danger)"));
    }

    /// 多色高亮的画法是 `<mark data-color="…" style="background-color: …; color: inherit">`：
    /// `data-color` 丢了的话，下次读出来那档底色就退回默认高亮色（编辑器按 data-color 认档）。
    #[test]
    fn sanitize_keeps_multicolor_highlight_mark() {
        let doc = "<p>巡检 <mark data-color=\"var(--t-warning-soft)\" style=\"background-color: var(--t-warning-soft); color: inherit\">重点</mark></p>";
        let clean = sanitize_html(doc);
        assert!(clean.contains("data-color=\"var(--t-warning-soft)\""), "data-color 丢了：{clean}");
        assert!(clean.contains("background-color: var(--t-warning-soft)"), "底色丢了：{clean}");
        assert!(clean.contains("color: inherit"), "字色继承丢了：{clean}");
    }

    /// 任务列表的画法是 `<ul data-type="taskList"><li …><label><input type="checkbox">…`：：
    /// `label`/`input` 之前不在标签白名单里，导入一篇带勾选项的笔记会把勾全丢光。
    /// 只放行 checkbox——`type` 换成别的（text/radio/submit）就没有存在的理由。
    #[test]
    fn sanitize_keeps_task_list_checkbox_only() {
        let doc = "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\">\
                   <label><input type=\"checkbox\" checked><span></span></label><div><p>巡检</p></div></li></ul>";
        let clean = sanitize_html(doc);
        for keep in [
            "data-type=\"taskList\"",
            "data-type=\"taskItem\"",
            "data-checked=\"true\"",
            "<label>",
            "type=\"checkbox\"",
            "checked",
            "<p>巡检</p>",
        ] {
            assert!(clean.contains(keep), "丢了 {keep}：{clean}");
        }

        let sneaky = "<p><input type=\"text\" name=\"pw\"><input type=\"hidden\" value=\"k\"></p>";
        let clean = sanitize_html(sneaky);
        assert!(!clean.contains("type=\"text\""), "非 checkbox 的 input 漏进来：{clean}");
        assert!(!clean.contains("type=\"hidden\""), "hidden input 漏进来：{clean}");
        assert!(!clean.contains("name="), "name 属性不该保留：{clean}");
    }

    /// 浮层的摘要必须锚在命中处：命中正文中段的词，若摘要还是篇首 120 字，
    /// 那一行就解释不了它为什么会被搜到。前面截掉了内容要用省略号说一声，
    /// 否则读者会以为那段就是笔记的开头。
    #[test]
    fn search_snippet_is_anchored_at_the_match() {
        let d = db();
        let created = create(&d, USER).unwrap();
        let filler = "准".repeat(300);
        update(
            &d,
            USER,
            &created.note.id,
            "巡检记录",
            &format!("<p>篇首内容</p><p>{filler}</p><p>变压器油位异常需上报</p><p>结尾</p>"),
        )
        .unwrap();

        let by_body = search(&d, USER, "油位", 5).unwrap();
        assert_eq!(by_body.len(), 1);
        assert!(by_body[0].snippet.contains("油位"), "摘要里没有命中的词：{}", by_body[0].snippet);
        assert!(by_body[0].snippet.starts_with('…'), "命中处前面截掉了内容要说明：{}", by_body[0].snippet);

        // 标题命中时不必挪窗口：标题已经说明了这一行为什么出现，摘要取篇首即可。
        let by_title = search(&d, USER, "巡检", 5).unwrap();
        assert_eq!(by_title.len(), 1);
        assert!(!by_title[0].snippet.starts_with('…'), "标题命中却给了一个中段窗口：{}", by_title[0].snippet);
    }

    /// 隔离口径与 `list` 同一条；空关键字与上限都得守住。
    #[test]
    fn search_is_owner_scoped_and_bounded() {
        let d = db();
        let mine = create(&d, USER).unwrap();
        update(&d, USER, &mine.note.id, "我的电碳台账", "<p>采集</p>").unwrap();
        let theirs = create(&d, OTHER).unwrap();
        update(&d, OTHER, &theirs.note.id, "别人的电碳台账", "<p>采集</p>").unwrap();

        let rows = search(&d, USER, "电碳", 10).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            vec![mine.note.id.clone()],
            "别人的笔记必须表现为不存在，连命中条数都不能泄露"
        );

        assert!(search(&d, USER, "", 10).unwrap().is_empty(), "空关键字不得退化成 LIKE '%%' 全表返回");
        assert_eq!(search(&d, USER, "电碳", 1).unwrap().len(), 1, "上限要真的下推到 SQL");
    }
}
