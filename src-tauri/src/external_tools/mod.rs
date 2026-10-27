//! 外部工具档：浏览器、终端、以及按数据库引擎可增删的客户端。
//!
//! 这一层是"跳转用哪个工具"的唯一答案：读侧给界面（含路径在本机是否还存在），
//! 写侧管校验与去重，拉起侧决定"用配置的工具还是回退系统默认"。
//! 口令一律不进交给工具的地址，也不进审计（与 `commands/launcher.rs` 的
//! "绝不把口令放进命令行参数"同一红线）。

use std::path::Path;

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::db::repo::now;
use crate::db::Db;
use crate::error::{AppError, Result};

pub const KIND_BROWSER: &str = "browser";
pub const KIND_TERMINAL: &str = "terminal";
pub const KIND_DATABASE: &str = "database";

/// 应用路径的上限：一条本地绝对路径，超出这个长度不可能是笔误之外的东西。
pub const APP_PATH_MAX_CHARS: usize = 500;
pub const LABEL_MAX_CHARS: usize = 40;
pub const ENGINE_MAX_CHARS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Browser,
    Terminal,
    Database,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Kind::Browser => KIND_BROWSER,
            Kind::Terminal => KIND_TERMINAL,
            Kind::Database => KIND_DATABASE,
        }
    }

    pub fn from_key(key: &str) -> Option<Kind> {
        match key {
            KIND_BROWSER => Some(Kind::Browser),
            KIND_TERMINAL => Some(Kind::Terminal),
            KIND_DATABASE => Some(Kind::Database),
            _ => None,
        }
    }

    /// 提示语里的槽位名。界面文案与打开动作的回话共用这一枚词，两侧不会各说一套。
    pub fn slot_word(self) -> &'static str {
        match self {
            Kind::Browser => "浏览器",
            Kind::Terminal => "终端工具",
            Kind::Database => "数据库工具",
        }
    }

    /// 固定两档出厂即存在、不可增删；数据库档由管理员自己加。
    pub fn is_fixed(self) -> bool {
        matches!(self, Kind::Browser | Kind::Terminal)
    }
}

#[derive(Debug, Clone)]
pub struct ToolRow {
    pub id: String,
    pub kind: Kind,
    pub engine: String,
    pub label: String,
    pub app_path: String,
}

/// 读侧视图：`pathExists` 由本机文件系统现算，界面据此打「路径已失效」。
/// 不返回任何口令，也不返回整条路径之外的派生信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub id: String,
    pub kind: &'static str,
    pub engine: String,
    pub label: String,
    pub app_path: String,
    pub path_exists: bool,
}

fn path_present(app_path: &str) -> bool {
    !app_path.is_empty() && Path::new(app_path).exists()
}

impl From<ToolRow> for ToolView {
    fn from(row: ToolRow) -> Self {
        Self {
            path_exists: path_present(&row.app_path),
            kind: row.kind.key(),
            id: row.id,
            engine: row.engine,
            label: row.label,
            app_path: row.app_path,
        }
    }
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ToolRow> {
    let kind_key: String = r.get(1)?;
    Ok(ToolRow {
        id: r.get(0)?,
        // kind 由 CHECK 约束钉住；读不出的那一档按浏览器处理只是兜底，正常永远不会走到
        kind: Kind::from_key(&kind_key).unwrap_or(Kind::Browser),
        engine: r.get(2)?,
        label: r.get(3)?,
        app_path: r.get(4)?,
    })
}

const SELECT_TOOL: &str = "SELECT id,kind,engine,label,app_path FROM external_tools";

pub fn list(db: &Db) -> Result<Vec<ToolView>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(&format!("{SELECT_TOOL} ORDER BY kind, sort_order, id"))?;
    let rows = stmt
        .query_map([], |r| {
            let row = map_row(r)?;
            Ok(ToolView {
                id: row.id.clone(),
                kind: row.kind.key(),
                engine: row.engine.clone(),
                label: row.label.clone(),
                app_path: row.app_path.clone(),
                path_exists: path_present(&row.app_path),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 按 id 取一条（命令层与 upsert 都用它）；`conn` 由调用方持有，避免同线程重复取锁。
fn tool_by_id(conn: &rusqlite::Connection, id: &str) -> Result<ToolRow> {
    conn.query_row(&format!("{SELECT_TOOL} WHERE id=?1"), rusqlite::params![id], map_row)
        .optional()?
        .ok_or(AppError::NotFound)
}

/// 这一档该用哪个工具。数据库档按**归一化后的引擎**精确匹配，匹配不到就等于没配置
/// ——界面对此的说法是「未配置，已交系统默认」，绝不假装连上了。
pub fn find(db: &Db, kind: Kind, engine: &str) -> Result<Option<ToolRow>> {
    let conn = db.lock_conn();
    if kind.is_fixed() {
        return Ok(conn
            .query_row(&format!("{SELECT_TOOL} WHERE kind=?1"), rusqlite::params![kind.key()], map_row)
            .optional()?);
    }
    let engine = normalize_engine(engine);
    if engine.is_empty() {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            &format!("{SELECT_TOOL} WHERE kind=?1 AND engine=?2"),
            rusqlite::params![kind.key(), engine],
            map_row,
        )
        .optional()?)
}

/// `jdbc:mysql://` 里的 `mysql`、`postgres`/`psql`/`pg` 与 `mssql` 这些写法都归到同一枚引擎。
/// 台账里的 `protocol` 是自由字符串（由连接串派生），不归一就会配出「配了 mysql 却认不出 JDBC:mysql」
/// 这种一看就没跑过的档。
pub fn normalize_engine(raw: &str) -> String {
    let mut s = raw.trim().to_lowercase();
    for wrapper in ["jdbc:", "odbc:"] {
        if let Some(stripped) = s.strip_prefix(wrapper) {
            s = stripped.to_string();
        }
    }
    // 只取 scheme 段：`mysql://host:3306/db`、`oracle:thin:@//host/xe` 都先落到引擎名
    let head = s.split([':', '/', '?', '#']).next().unwrap_or("").to_string();
    match head.as_str() {
        "pg" | "postgres" | "psql" | "postgresql" => "postgresql".to_string(),
        "mssql" | "sqlserver" => "sqlserver".to_string(),
        "maria" | "mariadb" => "mariadb".to_string(),
        "mysql" | "mysqlx" => "mysql".to_string(),
        "oracle" | "oci" | "thin" => "oracle".to_string(),
        other => other.to_string(),
    }
}

fn clean_engine(raw: &str) -> Result<String> {
    let e = normalize_engine(raw);
    if e.is_empty() || e.chars().count() > ENGINE_MAX_CHARS {
        return Err(AppError::ExternalToolRejected(format!(
            "引擎标识不能为空，且不超过 {ENGINE_MAX_CHARS} 位"
        )));
    }
    if !e.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '.')) {
        return Err(AppError::ExternalToolRejected(
            "引擎标识只能用小写字母、数字、下划线、连字符、加号或点".to_string(),
        ));
    }
    Ok(e)
}

fn clean_label(raw: &str) -> Result<String> {
    let v = raw.trim();
    if v.is_empty() || v.chars().count() > LABEL_MAX_CHARS {
        return Err(AppError::MenuLabelInvalid);
    }
    Ok(v.to_string())
}

/// 应用路径的写入侧校验：空串=清除（=交系统默认），其余必须是**本机当前存在**的绝对路径。
/// 换机/卸载后的失效不靠这里挡（那时路径曾经是真的），由读侧 `path_exists` 与拉起时回退兜住。
pub fn clean_app_path(raw: &str) -> Result<String> {
    let v = raw.trim();
    if v.is_empty() {
        return Ok(String::new());
    }
    if v.chars().count() > APP_PATH_MAX_CHARS {
        return Err(AppError::ExternalToolRejected(format!(
            "应用路径过长，最多 {APP_PATH_MAX_CHARS} 个字符"
        )));
    }
    if v.chars().any(|c| c.is_control()) {
        return Err(AppError::ExternalToolRejected(
            "应用路径含控制字符或换行".to_string(),
        ));
    }
    let path = Path::new(v);
    if !path.is_absolute() {
        return Err(AppError::ExternalToolRejected(
            "应用路径必须是绝对路径，例如 /Applications/DBeaver.app 或 C:\\Program Files\\...".to_string(),
        ));
    }
    if !path.exists() {
        return Err(AppError::ExternalToolRejected(
            "本机找不到这个应用或可执行文件，请重新选择".to_string(),
        ));
    }
    Ok(v.to_string())
}

/// 交给工具的地址不许带口令：`scheme://user:password@host` 剥成 `scheme://user@host`。
/// 用户名保留是现状（`ssh://user@host` 本来就这么交出去），只去掉口令那一段。
pub fn sanitize_address(addr: &str) -> String {
    let Some(scheme_end) = addr.find("://") else {
        return addr.to_string();
    };
    let scheme = &addr[..scheme_end];
    let rest = &addr[scheme_end + 3..];
    let authority_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_len];
    let Some(at) = authority.rfind('@') else {
        return addr.to_string();
    };
    let userinfo = &authority[..at];
    let host = &authority[at + 1..];
    let Some((user, _password)) = userinfo.split_once(':') else {
        return addr.to_string();
    };
    format!("{scheme}://{user}@{host}{}", &rest[authority_len..])
}

/// 拉起决策的纯函数部分：给 `find` 的结果与"路径还在不在"，算出该怎么开。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// 用配置的那条：(应用路径, 显示名)
    Configured(String, String),
    /// 没配置（或那一条留空）：交系统默认
    SystemDefault,
    /// 配置了但本机已找不到：交系统默认，并带上那条的名字好让界面说清是谁失效了
    Fallback(String),
}

pub fn plan_launch(row: Option<&ToolRow>) -> Plan {
    match row {
        None => Plan::SystemDefault,
        Some(r) if r.app_path.is_empty() => Plan::SystemDefault,
        Some(r) if path_present(&r.app_path) => Plan::Configured(r.app_path.clone(), r.label.clone()),
        Some(r) => Plan::Fallback(r.label.clone()),
    }
}

/// 一次拉起的结果，供调用方拼那句"用的是哪个工具"。
#[derive(Debug, Clone)]
pub struct Outcome {
    pub plan: Plan,
    pub used_configured: bool,
}

impl Outcome {
    /// 「用的哪一个」这一句的唯一拼法。动词由调用方按领域自己接（打开/连接/交给），
    /// 因为对数据库客户端承诺"已连接"是兑不了的：能不能自动建连取决于那个客户端吃不吃 argv。
    pub fn tool_note(&self, slot: &str) -> String {
        match &self.plan {
            Plan::Configured(_, label) if self.used_configured => format!("已交给{slot}「{label}」"),
            Plan::Configured(_, label) | Plan::Fallback(label) => {
                format!("配置的{slot}「{label}」在本机没能拉起，已回退系统默认")
            }
            Plan::SystemDefault => format!("未配置{slot}，已交系统默认"),
        }
    }
}

/// 按档拉起：配置在且路径存在 → 交给那个应用；否则交系统默认。
/// 两条路都失败才报错——回退成功就不该把"配置失效"报成"打开失败"。
pub fn open(db: &Db, kind: Kind, engine: &str, addr: &str) -> Result<Outcome> {
    let row = find(db, kind, engine)?;
    let plan = plan_launch(row.as_ref());
    if let Plan::Configured(path, _) = &plan {
        if open::with(addr, path).is_ok() {
            return Ok(Outcome { plan, used_configured: true });
        }
    }
    open::that(addr).map_err(|e| AppError::internal("拉起外部工具", &e))?;
    Ok(Outcome { plan, used_configured: false })
}

/// 固定两档（浏览器/终端）改路径；空串=清除=回到系统默认。
pub fn set_fixed_path(db: &Db, kind: Kind, app_path: &str) -> Result<ToolRow> {
    if !kind.is_fixed() {
        return Err(AppError::ExternalToolRejected(
            "数据库工具请用新增/删除，不走这一条".to_string(),
        ));
    }
    let path = clean_app_path(app_path)?;
    let conn = db.lock_conn();
    let changed = conn.execute(
        "UPDATE external_tools SET app_path=?1, updated_at=?2 WHERE kind=?3",
        rusqlite::params![path, now(), kind.key()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    // UNIQUE(kind, '') 保证固定档最多一行，按 kind 取回来就是刚写进去的那一条
    conn.query_row(&format!("{SELECT_TOOL} WHERE kind=?1"), rusqlite::params![kind.key()], map_row)
        .optional()?
        .ok_or(AppError::NotFound)
}

/// 新增或修改一条数据库工具档。`id` 为空即新增（引擎归一化后撞车就拒绝，不让两条 mysql 并存）。
pub fn upsert_database(db: &Db, id: Option<&str>, engine: &str, label: &str, app_path: &str) -> Result<ToolRow> {
    let engine = clean_engine(engine)?;
    let label = clean_label(label)?;
    let path = clean_app_path(app_path)?;
    let conn = db.lock_conn();
    let ts = now();

    if let Some(id) = id.map(str::trim).filter(|s| !s.is_empty()) {
        let kind: String = conn
            .query_row("SELECT kind FROM external_tools WHERE id=?1", rusqlite::params![id], |r| r.get(0))
            .optional()?
            .ok_or(AppError::NotFound)?;
        if kind != KIND_DATABASE {
            return Err(AppError::ExternalToolRejected(
                "浏览器与终端工具是固定档，只能改路径，不能改引擎或名称".to_string(),
            ));
        }
        // 改引擎时不许撞上另一条已有引擎
        let clash: i64 = conn.query_row(
            "SELECT count(*) FROM external_tools WHERE kind='database' AND engine=?1 AND id<>?2",
            rusqlite::params![engine, id],
            |r| r.get(0),
        )?;
        if clash > 0 {
            return Err(AppError::ExternalToolRejected(format!(
                "引擎「{engine}」已经有一条工具档了，请直接改那一条"
            )));
        }
        conn.execute(
            "UPDATE external_tools SET engine=?1, label=?2, app_path=?3, updated_at=?4 WHERE id=?5",
            rusqlite::params![engine, label, path, ts, id],
        )?;
        return tool_by_id(&conn, id);
    }

    let max_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order),0) FROM external_tools WHERE kind='database'",
            [],
            |r| r.get(0),
        )?;
    // 先自己查一遍再插：让 UNIQUE(kind,engine) 挡下的那一撞报出「引擎已经有了」，
    // 而不是把 SQLite 的约束原文丢给界面
    let clash: i64 = conn.query_row(
        "SELECT count(*) FROM external_tools WHERE kind='database' AND engine=?1",
        rusqlite::params![engine],
        |r| r.get(0),
    )?;
    if clash > 0 {
        return Err(AppError::ExternalToolRejected(format!(
            "引擎「{engine}」已经有一条工具档了，请直接改那一条"
        )));
    }
    // id 用裸 UUID，不加 `et-db-` 前缀：审计界面那条"UUID 不上屏"的判据（auditLabels.ts::OPAQUE_ID）
    // 认的就是这一形状，加了前缀等于把那串谁都读不出来的字符重新请回界面上。
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO external_tools (id,kind,engine,label,app_path,sort_order,created_at,updated_at)
         VALUES (?1,'database',?2,?3,?4,?5,?6,?6)",
        rusqlite::params![id, engine, label, path, max_order + 10, ts],
    )?;
    tool_by_id(&conn, &id)
}

/// 只删数据库档；固定两档停用不靠删除，靠把路径清空。
pub fn delete_database(db: &Db, id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let row = tool_by_id(&conn, id)?;
    if row.kind.is_fixed() {
        return Err(AppError::ExternalToolRejected(
            "浏览器与终端工具是固定档，不能删除；要回退系统默认请把路径清空".to_string(),
        ));
    }
    conn.execute("DELETE FROM external_tools WHERE id=?1", rusqlite::params![id])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory(&vec![21u8; 32]).unwrap()
    }

    fn fixed(db: &Db, kind: Kind) -> ToolRow {
        find(db, kind, "").unwrap().expect("固定两档必须由迁移播种")
    }

    #[test]
    fn seeds_two_fixed_slots_both_unconfigured() {
        let d = db();
        let rows = list(&d).unwrap();
        assert_eq!(rows.len(), 2, "出厂只有浏览器与终端两档");
        for row in &rows {
            assert_eq!(row.app_path, "", "出厂值必须留空=交系统默认，不能预填任何本机路径");
            assert!(!row.path_exists);
            assert!(matches!(row.kind, KIND_BROWSER | KIND_TERMINAL));
        }
        assert_eq!(fixed(&d, Kind::Browser).id, "et-browser");
        assert_eq!(fixed(&d, Kind::Terminal).id, "et-terminal");
    }

    /// 固定两档的唯一性由表约束守住，不靠命令层的自觉。
    #[test]
    fn second_fixed_slot_is_rejected_by_the_schema() {
        let d = db();
        let err = d
            .lock_conn()
            .execute(
                "INSERT INTO external_tools (id,kind,engine,label,app_path,sort_order,created_at,updated_at)
                 VALUES ('x','browser','','再一枚浏览器','',30,'t','t')",
                [],
            )
            .unwrap_err();
        assert!(matches!(err, rusqlite::Error::SqliteFailure(_, _)));
    }

    #[test]
    fn engine_normalization_is_the_single_table() {
        for raw in ["MySQL", " jdbc:MySQL://H:3306/db ", "mysql://host", "MYSQLX"] {
            assert_eq!(normalize_engine(raw), "mysql", "{raw}");
        }
        for raw in ["PG", "postgres", "psql", "postgresql", "jdbc:postgresql://h/db"] {
            assert_eq!(normalize_engine(raw), "postgresql", "{raw}");
        }
        assert_eq!(normalize_engine("jdbc:oracle:thin:@//h:1521/xe"), "oracle");
        assert_eq!(normalize_engine("MSSQL"), "sqlserver");
        assert_eq!(normalize_engine("dm"), "dm", "认不出的引擎原样保留，管理员自己建档");
        assert_eq!(normalize_engine("  "), "");
    }

    #[test]
    fn engine_lookup_is_exact_after_normalizing() {
        let d = db();
        let row = upsert_database(&d, None, "  PostgreSQL ", "PG 客户端", "/usr/bin/open").unwrap();
        assert_eq!(row.engine, "postgresql");
        let found = find(&d, Kind::Database, "pg").unwrap().expect("别名要能命中标准后的引擎");
        assert_eq!(found.id, row.id);
        assert!(find(&d, Kind::Database, "oracle").unwrap().is_none(), "没配的引擎就是没配");
        assert!(find(&d, Kind::Database, "").unwrap().is_none());
    }

    #[test]
    fn duplicate_engine_is_rejected_on_create_and_on_rename() {
        let d = db();
        upsert_database(&d, None, "mysql", "MySQL 客户端", "/usr/bin/open").unwrap();
        assert!(matches!(
            upsert_database(&d, None, "MySQL", "第二枚", "/usr/bin/open"),
            Err(AppError::ExternalToolRejected(_))
        ));
        let pg = upsert_database(&d, None, "pg", "PG", "/usr/bin/open").unwrap();
        assert!(matches!(
            upsert_database(&d, Some(&pg.id), "mysql", "PG", "/usr/bin/open"),
            Err(AppError::ExternalToolRejected(_))
        ));
        assert_eq!(find(&d, Kind::Database, "mysql").unwrap().unwrap().label, "MySQL 客户端");
    }

    #[test]
    fn fixed_slots_cannot_be_upserted_or_deleted() {
        let d = db();
        let browser = fixed(&d, Kind::Browser).id;
        assert!(matches!(
            upsert_database(&d, Some(&browser), "mysql", "冒充", "/usr/bin/open"),
            Err(AppError::ExternalToolRejected(_))
        ));
        assert!(matches!(delete_database(&d, &browser), Err(AppError::ExternalToolRejected(_))));
        assert_eq!(list(&d).unwrap().len(), 2, "固定档不许被删掉");
    }

    #[test]
    fn app_path_validation_rejects_relative_missing_and_control_chars() {
        assert_eq!(clean_app_path("   ").unwrap(), "", "留空即清除");
        for bad in [
            "DBeaver",
            "/Applications/绝对不存在-请别创建.DBeaver",
            "../相对路径.app",
            "/tmp/带\n换行",
        ] {
            assert!(matches!(clean_app_path(bad), Err(AppError::ExternalToolRejected(_))), "{bad} 竟被接受");
        }
        let this_file = std::env::current_exe().unwrap().to_string_lossy().to_string();
        assert_eq!(clean_app_path(&this_file).unwrap(), this_file);
    }

    #[test]
    fn sanitize_strips_only_the_password() {
        assert_eq!(sanitize_address("mysql://root:pw@10.0.0.1:3306/db"), "mysql://root@10.0.0.1:3306/db");
        assert_eq!(sanitize_address("jdbc:mysql://root:pw@h/db?useSSL=false"), "jdbc:mysql://root@h/db?useSSL=false");
        assert_eq!(sanitize_address("ssh://user@10.0.0.1"), "ssh://user@10.0.0.1", "没有口令位就一字不动");
        assert_eq!(sanitize_address("10.0.0.1:22"), "10.0.0.1:22");
        assert_eq!(sanitize_address("https://example.cn/login"), "https://example.cn/login");
        assert!(!sanitize_address("https://u:p@h/x").contains(":p@"), "口令不许留下");
    }

    #[test]
    fn plan_launch_three_states() {
        let row = |path: &str| ToolRow {
            id: "x".into(),
            kind: Kind::Browser,
            engine: String::new(),
            label: "Chrome".into(),
            app_path: path.into(),
        };
        assert_eq!(plan_launch(None), Plan::SystemDefault);
        assert_eq!(plan_launch(Some(&row(""))), Plan::SystemDefault);
        let missing = row("/Applications/绝对不存在-请别创建.app");
        assert_eq!(plan_launch(Some(&missing)), Plan::Fallback("Chrome".into()));
        let here = std::env::current_exe().unwrap().to_string_lossy().to_string();
        assert_eq!(plan_launch(Some(&row(&here))), Plan::Configured(here.clone(), "Chrome".into()));
    }

    /// 提示必须点名用的哪一个工具、并区分"没配"与"配了但失效"——文案说得出，界面才兑得了。
    #[test]
    fn notes_name_the_tool_and_the_reason() {
        let configured = Outcome { plan: Plan::Configured("/p".into(), "Chrome".into()), used_configured: true };
        assert_eq!(configured.tool_note("浏览器"), "已交给浏览器「Chrome」");
        let broken = Outcome { plan: Plan::Fallback("Chrome".into()), used_configured: false };
        assert_eq!(broken.tool_note("浏览器"), "配置的浏览器「Chrome」在本机没能拉起，已回退系统默认");
        let none = Outcome { plan: Plan::SystemDefault, used_configured: false };
        assert_eq!(none.tool_note("数据库工具"), "未配置数据库工具，已交系统默认");
    }

    #[test]
    fn setting_and_clearing_the_fixed_path_round_trips() {
        let d = db();
        let here = std::env::current_exe().unwrap().to_string_lossy().to_string();
        assert_eq!(set_fixed_path(&d, Kind::Browser, &here).unwrap().app_path, here);
        assert_eq!(find(&d, Kind::Browser, "").unwrap().unwrap().app_path, here);
        assert_eq!(set_fixed_path(&d, Kind::Browser, "").unwrap().app_path, "", "清空即回退系统默认");
        assert!(matches!(set_fixed_path(&d, Kind::Database, ""), Err(AppError::ExternalToolRejected(_))));
    }

    #[test]
    fn empty_label_and_bad_engine_are_rejected() {
        let d = db();
        assert!(matches!(
            upsert_database(&d, None, "mysql", "   ", "/usr/bin/open"),
            Err(AppError::MenuLabelInvalid)
        ));
        assert!(matches!(
            upsert_database(&d, None, "不合法 引擎", "x", "/usr/bin/open"),
            Err(AppError::ExternalToolRejected(_))
        ));
        assert!(matches!(
            upsert_database(&d, None, "", "x", "/usr/bin/open"),
            Err(AppError::ExternalToolRejected(_))
        ));
    }
}
