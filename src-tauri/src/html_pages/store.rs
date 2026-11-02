//! 页面库存储层：标题 + HTML 正文，团队共用（与外部工具档同档），不做按使用者隔离。
//!
//! `created_by` / `updated_by` 只作留痕，不参与可见性判断——同一把库里的使用者看到同一份列表。
//! 正文只进 SQLCipher 库，出站只有两条路：IPC 给编辑弹窗、回环服务给预览；两条路都先过
//! `check_session` / `peek_session` 与 `html.page.read`。

use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

use crate::db::repo::now;
use crate::db::Db;
use crate::error::{AppError, Result};

pub const TITLE_MAX_CHARS: usize = 120;
/// 单页正文上限：5 MiB 已经相当于一整本小册子，再大就该拆页。
pub const HTML_MAX_BYTES: usize = 5 * 1024 * 1024;

const SUMMARY_COLUMNS: &str = "id, title, length(CAST(content_html AS BLOB)), created_at, updated_at";
const RECORD_COLUMNS: &str =
    "id, title, content_html, length(CAST(content_html AS BLOB)), created_at, updated_at";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    pub byte_len: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecord {
    pub id: String,
    pub title: String,
    pub html: String,
    pub byte_len: i64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// 标题是唯一的必填项：库里的 CHECK 卡 1–120 字，这里给出比 SQL 更早、更可读的拒绝。
pub fn clean_title(raw: &str) -> Result<String> {
    let title = raw.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX_CHARS {
        return Err(AppError::HtmlPageTitleInvalid);
    }
    Ok(title.to_string())
}

pub fn check_size(html: &str) -> Result<()> {
    if html.len() > HTML_MAX_BYTES {
        return Err(AppError::HtmlPageTooLarge);
    }
    Ok(())
}

fn map_summary(r: &Row<'_>) -> rusqlite::Result<PageSummary> {
    Ok(PageSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        byte_len: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
    })
}

fn map_record(r: &Row<'_>) -> rusqlite::Result<PageRecord> {
    Ok(PageRecord {
        id: r.get(0)?,
        title: r.get(1)?,
        html: r.get(2)?,
        byte_len: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub fn list(db: &Db) -> Result<Vec<PageSummary>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM html_pages ORDER BY updated_at DESC, id DESC"
    ))?;
    let rows = stmt
        .query_map([], map_summary)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// LIKE 的通配符必须按字面量处理：搜 "100%" 不该匹配到一切。
/// 与 `notes::store::like_pattern` 同一口径（含 ESCAPE 用反斜杠），所以两条语句能共用同一个判据。
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

/// 浮层全局搜索用：只按标题找，一定带 `LIMIT`。
///
/// 正文不参与：页面正文是 HTML 与脚本，关键字命中 `function`、`div` 这类词全是噪音，
/// 而每次输入都要对最大 5 MiB/页的字段做一次 LIKE 扫描（这张表没有正文索引）。
/// 命中的是标题，落点就是左栏那一行的标题，两边对得上。
pub fn search(db: &Db, q: &str, limit: i64) -> Result<Vec<PageSummary>> {
    let needle = q.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = like_pattern(needle);
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM html_pages
          WHERE title LIKE ?1 ESCAPE '\\'
          ORDER BY updated_at DESC, id DESC
          LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![pattern, limit], map_summary)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 浮层「选中这一页」落点前的一句确认：这一页在不在、叫什么。
///
/// 只取标题，不走 `get`：`get` 会把整页正文（最大 5 MiB）读进内存，
/// 而这里要的只是"存在且有权限"这一个结论和那句提示里的名字。
pub fn title(db: &Db, id: &str) -> Result<String> {
    let conn = db.lock_conn();
    conn.query_row("SELECT title FROM html_pages WHERE id = ?1", params![id], |r| r.get::<_, String>(0))
        .optional()?
        .ok_or(AppError::NotFound)
}

pub fn get(db: &Db, id: &str) -> Result<PageRecord> {
    let conn = db.lock_conn();
    conn.query_row(
        &format!("SELECT {RECORD_COLUMNS} FROM html_pages WHERE id = ?1"),
        params![id],
        map_record,
    )
    .optional()?
    .ok_or(AppError::NotFound)
}

/// 预览服务只认正文：标题不参与渲染，也就不往那条通道上多带一个字段。
pub fn content(db: &Db, id: &str) -> Result<String> {
    let conn = db.lock_conn();
    conn.query_row("SELECT content_html FROM html_pages WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?
        .ok_or(AppError::NotFound)
}

pub fn create(db: &Db, user: &str, title: &str, html: &str) -> Result<PageRecord> {
    let title = clean_title(title)?;
    check_size(html)?;
    let id = new_id();
    let ts = now();
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO html_pages (id, title, content_html, created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5)",
        params![id, title, html, user, ts],
    )?;
    drop(conn);
    get(db, &id)
}

pub fn update(db: &Db, user: &str, id: &str, title: &str, html: &str) -> Result<PageRecord> {
    let title = clean_title(title)?;
    check_size(html)?;
    let ts = now();
    let conn = db.lock_conn();
    let changed = conn.execute(
        "UPDATE html_pages SET title = ?1, content_html = ?2, updated_by = ?3, updated_at = ?4
          WHERE id = ?5",
        params![title, html, user, ts, id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    drop(conn);
    get(db, id)
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let changed = conn.execute("DELETE FROM html_pages WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory(&vec![9u8; 32]).unwrap()
    }

    #[test]
    fn create_list_and_get_round_trip() {
        let d = db();
        let created = create(&d, "u-a", "  演示页  ", "<h1>你好</h1>").unwrap();
        assert_eq!(created.title, "演示页", "标题要 trim 掉两端空白");
        assert_eq!(created.html, "<h1>你好</h1>");
        assert_eq!(created.byte_len, "<h1>你好</h1>".len() as i64, "byteLen 是字节数不是字符数");

        let rows = list(&d).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, created.id);

        let fetched = get(&d, &created.id).unwrap();
        assert_eq!(fetched.html, created.html);
        assert_eq!(content(&d, &created.id).unwrap(), created.html);
    }

    #[test]
    fn pages_are_shared_across_users() {
        let d = db();
        let page = create(&d, "u-a", "共用页", "<p>x</p>").unwrap();
        let rows = list(&d).unwrap();
        assert_eq!(rows.len(), 1, "页面库不做按使用者隔离：换个人也看得见");
        assert_eq!(get(&d, &page.id).unwrap().title, "共用页");
    }

    #[test]
    fn update_touches_updated_at_and_owner_stamp() {
        let d = db();
        let page = create(&d, "u-a", "旧名", "<p>1</p>").unwrap();
        let updated = update(&d, "u-b", &page.id, "新名", "<p>2</p>").unwrap();
        assert_eq!(updated.title, "新名");
        assert_eq!(updated.html, "<p>2</p>");
        assert_eq!(updated.created_at, page.created_at);
        let by: String = {
            let c = d.lock_conn();
            c.query_row("SELECT updated_by FROM html_pages WHERE id=?1", params![page.id], |r| r.get(0)).unwrap()
        };
        assert_eq!(by, "u-b");
    }

    #[test]
    fn delete_removes_the_row_and_second_delete_is_not_found() {
        let d = db();
        let page = create(&d, "u-a", "待删", "").unwrap();
        delete(&d, &page.id).unwrap();
        assert!(list(&d).unwrap().is_empty());
        assert!(matches!(delete(&d, &page.id), Err(AppError::NotFound)));
        assert!(matches!(get(&d, &page.id), Err(AppError::NotFound)));
    }

    #[test]
    fn title_and_size_limits_are_enforced_before_sql() {
        let d = db();
        assert!(matches!(create(&d, "u-a", "   ", "<p/>"), Err(AppError::HtmlPageTitleInvalid)));
        let long = "字".repeat(TITLE_MAX_CHARS + 1);
        assert!(matches!(create(&d, "u-a", &long, "<p/>"), Err(AppError::HtmlPageTitleInvalid)));
        let ok = "字".repeat(TITLE_MAX_CHARS);
        assert!(create(&d, "u-a", &ok, "<p/>").is_ok(), "正好 120 字要放行");

        let big = "a".repeat(HTML_MAX_BYTES + 1);
        assert!(matches!(create(&d, "u-a", "大页", &big), Err(AppError::HtmlPageTooLarge)));
        assert!(matches!(update(&d, "u-a", "missing", "大页", &big), Err(AppError::HtmlPageTooLarge)));
    }

    #[test]
    fn update_and_delete_on_unknown_id_are_not_found() {
        let d = db();
        assert!(matches!(update(&d, "u-a", "nope", "t", ""), Err(AppError::NotFound)));
        assert!(matches!(delete(&d, "nope"), Err(AppError::NotFound)));
        assert!(matches!(content(&d, "nope"), Err(AppError::NotFound)));
    }

    #[test]
    fn list_orders_by_updated_at_desc() {
        let d = db();
        let a = create(&d, "u-a", "A", "").unwrap();
        let b = create(&d, "u-a", "B", "").unwrap();
        // 两次 create 可能落在同一毫秒，排序断言要自己摆确定的时间戳，不靠时钟时序。
        let stamp = |id: &str, ts: &str| {
            let c = d.lock_conn();
            c.execute("UPDATE html_pages SET updated_at=?1 WHERE id=?2", params![ts, id]).unwrap();
        };
        stamp(&a.id, "2099-01-01T00:00:00+00:00");
        stamp(&b.id, "2000-01-01T00:00:00+00:00");
        assert_eq!(list(&d).unwrap()[0].id, a.id);

        stamp(&a.id, "1999-01-01T00:00:00+00:00");
        assert_eq!(list(&d).unwrap()[0].id, b.id);
    }

    /// 浮层只按标题找：正文里的词不算命中——正文是 HTML 与脚本，命中 `div` 这类词全是噪音，
    /// 而每次输入都要对最大 5 MiB/页的字段做一次无索引 LIKE。
    #[test]
    fn search_matches_titles_not_bodies() {
        let d = db();
        let hit = create(&d, "u-a", "电碳采集看板", "<div>无关正文</div>").unwrap();
        create(&d, "u-a", "另一页", "<div>这一段正文里也写了电碳采集看板</div>").unwrap();

        let rows = search(&d, "电碳", 5).unwrap();
        assert_eq!(rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![hit.id.clone()]);
    }

    /// 空输入与 `LIMIT` 都要守住：前者会退化成 `LIKE '%%'` 把整张表端回来。
    #[test]
    fn search_refuses_empty_term_and_honours_the_limit() {
        let d = db();
        create(&d, "u-a", "电碳采集看板", "").unwrap();
        assert!(search(&d, "", 5).unwrap().is_empty());
        assert!(search(&d, "   ", 5).unwrap().is_empty());
        assert!(search(&d, "电碳", 0).unwrap().is_empty(), "LIMIT 0 必须一条都不给");
    }

    /// 搜 "100%" 不该匹配到一切：通配符必须按字面量处理。
    /// 反过来，真含百分号的那一页**必须**被搜到——转义做过头会把字面百分号也吞了。
    #[test]
    fn search_treats_like_wildcards_as_literals() {
        let d = db();
        let percent = create(&d, "u-a", "线损率100%达成", "").unwrap();
        create(&d, "u-a", "负荷率统计", "").unwrap();

        assert_eq!(
            search(&d, "100%", 5).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            vec![percent.id.clone()]
        );
        assert_eq!(
            search(&d, "%", 5).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            vec![percent.id.clone()],
            "一个百分号该按字面量匹配：只命中真含 % 的那一页，不该把所有页面都端回来"
        );
    }
}
