//! 仓储层。所有 SQL 使用参数化查询；秘密一律以 AEAD 密文入库。
//! 领域区分在此强制：`vault_targets` 是地址/系统，`vault_items` 是目标下的一条外部账号凭据。

use super::Db;
use crate::crypto::{vault_key::Sealed, VaultKey};
use crate::error::{AppError, Result};
use crate::quick_launcher::search::SearchDoc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use crate::crypto::SecretString;

pub const ITEM_TARGET_TYPE: &str = "vault_item";
pub const TARGET_TARGET_TYPE: &str = "vault_target";

/// 目标级加密元数据（URL / Origin / 主机 / 端口）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TargetSecretPayload {
    #[serde(default)]
    pub url: String,
    /// 允许自动填充的精确 Origin
    #[serde(default)]
    pub allowed_origin: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: String,
    #[serde(default)]
    pub database_name: String,
    #[serde(default)]
    pub tenant: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub extra: std::collections::BTreeMap<String, String>,
}

/// 单条凭据的加密载荷。用户名/密码是外部系统的，不是本软件的登录凭据。
/// Default 手写而不用 derive：confirm_before_fill 的出厂值是 true，
/// derive 会给 bool 填 false，等于"新构造的凭据默认免确认直接填充"。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialPayload {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: SecretString,
    #[serde(default)]
    pub token: SecretString,
    #[serde(default)]
    pub private_key: SecretString,
    #[serde(default)]
    pub passphrase: SecretString,
    /// 该凭据专属登录地址（覆盖目标默认地址），填充时仍须校验 Origin
    #[serde(default)]
    pub login_url_override: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub auth_method: String,
    #[serde(default)]
    pub browser_hint: String,
    /// 缺失该字段的历史载荷一律按"需要确认"处理：默认值必须 fail-secure。
    #[serde(default = "confirm_before_fill_default")]
    pub confirm_before_fill: bool,
    #[serde(default)]
    pub custom: std::collections::BTreeMap<String, String>,
}

fn confirm_before_fill_default() -> bool {
    true
}

impl Default for CredentialPayload {
    fn default() -> Self {
        Self {
            username: String::new(),
            password: SecretString::new(String::new()),
            token: SecretString::new(String::new()),
            private_key: SecretString::new(String::new()),
            passphrase: SecretString::new(String::new()),
            login_url_override: String::new(),
            note: String::new(),
            auth_method: String::new(),
            browser_hint: String::new(),
            confirm_before_fill: confirm_before_fill_default(),
            custom: std::collections::BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRow {
    pub id: String,
    pub target_type: String,
    pub display_name: String,
    pub group_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub credential_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRow {
    pub id: String,
    pub target_id: String,
    pub account_alias: String,
    pub item_type: String,
    pub status: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub version: i64,
    /// 当前使用者的默认账号标记（per-user preference）
    pub is_default_for_current_user: bool,
}

/// RFC3339 当前时间，全库统一使用。
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn seal_json<T: Serialize>(vk: &VaultKey, record_id: &str, kind: &str, payload: &T) -> Result<Sealed> {
    let bytes = serde_json::to_vec(payload).map_err(|_| AppError::Internal)?;
    Ok(crate::crypto::vault_key::seal_payload(vk, record_id, kind, &bytes)?)
}

fn open_json<T: for<'de> Deserialize<'de>>(vk: &VaultKey, record_id: &str, kind: &str, sealed: &Sealed) -> Result<T> {
    let bytes = crate::crypto::vault_key::open_payload(vk, record_id, kind, sealed)?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::Internal)
}

fn read_sealed(conn: &rusqlite::Connection, table: &str, pk: &str, id: &str) -> Result<Option<Sealed>> {
    let sql = format!("SELECT ciphertext, nonce, algorithm, key_version, payload_schema_version FROM {table} WHERE {pk}=?1");
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt
        .query_row(params![id], |r| {
            Ok(Sealed {
                ciphertext: r.get::<_, Vec<u8>>(0)?,
                nonce: r.get::<_, Vec<u8>>(1)?,
                algorithm: r.get(2)?,
                key_version: r.get(3)?,
                payload_schema_version: r.get(4)?,
            })
        })
        .optional()?)
}

fn write_sealed(conn: &rusqlite::Connection, table: &str, pk_col: &str, id: &str, s: &Sealed) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {table} ({pk_col}, ciphertext, algorithm, nonce, key_version, payload_schema_version, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT({pk_col}) DO UPDATE SET ciphertext=excluded.ciphertext, algorithm=excluded.algorithm,
               nonce=excluded.nonce, key_version=excluded.key_version,
               payload_schema_version=excluded.payload_schema_version, updated_at=excluded.updated_at"
        ),
        params![id, s.ciphertext, s.algorithm, s.nonce, s.key_version, s.payload_schema_version, now()],
    )?;
    Ok(())
}

// ------------------------------------------------------------------ 目标

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTarget {
    pub target_type: String,
    pub display_name: String,
    pub group_id: Option<String>,
    pub meta: TargetSecretPayload,
}

pub fn create_target(db: &Db, vk: &VaultKey, actor: &str, t: &NewTarget) -> Result<String> {
    validate_type(&t.target_type)?;
    if t.display_name.trim().is_empty() {
        return Err(AppError::InvalidInput);
    }
    let id = new_id();
    let ts = now();
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO vault_targets (id,target_type,display_name,group_id,status,created_by,updated_by,created_at,updated_at)
         VALUES (?1,?2,?3,?4,'active',?5,?5,?6,?6)",
        params![id, t.target_type, t.display_name.trim(), t.group_id, actor, ts],
    )?;
    let sealed = seal_json(vk, &id, TARGET_TARGET_TYPE, &t.meta)?;
    write_sealed(&tx, "vault_target_secrets", "target_id", &id, &sealed)?;
    tx.commit()?;
    Ok(id)
}

pub fn target_meta(vk: &VaultKey, db: &Db, target_id: &str) -> Result<TargetSecretPayload> {
    let conn = db.lock_conn();
    let sealed = read_sealed(&conn, "vault_target_secrets", "target_id", target_id)?.ok_or(AppError::NotFound)?;
    open_json(vk, target_id, TARGET_TARGET_TYPE, &sealed)
}

pub fn list_targets(db: &Db) -> Result<Vec<TargetRow>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.target_type, t.display_name, t.group_id, t.status, t.created_at, t.updated_at,
                (SELECT count(*) FROM vault_items i WHERE i.target_id=t.id AND i.deleted_at IS NULL AND i.status='active')
         FROM vault_targets t WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], target_row_from)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 列表查询条件。`limit = None` 表示不分页（导出等需要完整清单的场景）。
#[derive(Debug, Clone, Default)]
pub struct TargetQuery<'a> {
    pub item_type: Option<&'a str>,
    pub group_id: Option<&'a str>,
    pub keyword: Option<&'a str>,
    /// 按凭据标签筛选：只要该目标下有**启用且未删**的凭据带这个标签就命中（大小写不敏感）。
    pub tag: Option<&'a str>,
    pub favorite_only: bool,
    pub limit: Option<i64>,
    pub offset: i64,
}

/// LIKE 的通配符必须按字面量处理：搜 "100%" 不该匹配到一切。`!` 是下面语句用的 ESCAPE 字符。
fn like_needle(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if matches!(c, '%' | '_' | '!') {
            out.push('!');
        }
        out.push(c);
    }
    out
}

/// 筛选条件只写这一次：分页查询与总数统计共用，避免"页内容按一套条件、共 N 条按另一套条件"。
const TARGET_FILTER_FROM_WHERE: &str = "FROM vault_targets t \
     WHERE t.deleted_at IS NULL \
     AND (?1 IS NULL OR t.target_type = ?1) \
     AND (?2 IS NULL OR t.group_id = ?2) \
     AND (?3 IS NULL OR LOWER(t.display_name) LIKE '%' || ?3 || '%' ESCAPE '!') \
     AND (?4 = 0 OR EXISTS (SELECT 1 FROM vault_items i WHERE i.target_id = t.id \
                            AND i.deleted_at IS NULL AND i.status = 'active' AND i.favorite = 1)) \
     AND (?5 IS NULL OR t.id IN (SELECT i.target_id FROM vault_items i \
                                 JOIN vault_item_tags g ON g.item_id = i.id \
                                 WHERE i.deleted_at IS NULL AND i.status = 'active' \
                                 AND LOWER(g.tag) = LOWER(?5)))";

fn target_row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<TargetRow> {
    Ok(TargetRow {
        id: r.get(0)?,
        target_type: r.get(1)?,
        display_name: r.get(2)?,
        group_id: r.get(3)?,
        status: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        credential_count: r.get(7)?,
    })
}

/// 先按条件过滤、再切片：返回当页与符合条件的总数。
pub fn query_targets(db: &Db, q: &TargetQuery) -> Result<(Vec<TargetRow>, i64)> {
    let needle = q.keyword.and_then(|k| {
        let t = k.trim().to_lowercase();
        if t.is_empty() {
            None
        } else {
            Some(like_needle(&t))
        }
    });
    let fav = q.favorite_only as i64;
    let tag = q.tag.map(|t| t.trim()).filter(|t| !t.is_empty());
    let conn = db.lock_conn();
    let total: i64 = conn.query_row(
        &format!("SELECT count(*) {TARGET_FILTER_FROM_WHERE}"),
        params![q.item_type, q.group_id, needle, fav, tag],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id, t.target_type, t.display_name, t.group_id, t.status, t.created_at, t.updated_at,
                (SELECT count(*) FROM vault_items i WHERE i.target_id=t.id AND i.deleted_at IS NULL AND i.status='active')
         {TARGET_FILTER_FROM_WHERE} ORDER BY t.updated_at DESC LIMIT ?6 OFFSET ?7"
    ))?;
    let rows = stmt
        .query_map(
            params![q.item_type, q.group_id, needle, fav, tag, q.limit.unwrap_or(i64::MAX), q.offset],
            target_row_from,
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok((rows, total))
}

/// 按地址提示可能重复的目标。仅提示，绝不自动归并。
pub fn find_similar_targets(db: &Db, vk: &VaultKey, address: &str) -> Result<Vec<TargetRow>> {
    let needle = address.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(vec![]);
    }
    let targets = list_targets(db)?;
    let mut out = Vec::new();
    for t in targets {
        if let Ok(meta) = target_meta(vk, db, &t.id) {
            let hay = format!("{} {} {}", meta.url, meta.host, meta.allowed_origin).to_lowercase();
            if hay.contains(&needle) {
                out.push(t);
            }
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ 凭据

/// 台账里出现过的标签（用于筛选下拉）。只统计启用且未删凭据上的标签。
pub fn list_item_tags(db: &Db) -> Result<Vec<String>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT g.tag FROM vault_item_tags g JOIN vault_items i ON i.id = g.item_id \
         WHERE i.deleted_at IS NULL AND i.status = 'active' \
         GROUP BY LOWER(g.tag) ORDER BY g.tag",
    )?;
    let out = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(out)
}

/// 「最近访问」条目：需求 §2.2 要求台账首页有此入口，且只给非秘密摘要。
/// 因此这里刻意不取用户名/口令/备注——`last_accessed_at` 由填充与复制动作写入。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentAccessRow {
    pub item_id: String,
    pub target_id: String,
    pub target_name: String,
    pub item_type: String,
    pub account_alias: String,
    pub last_accessed_at: String,
}

pub fn recent_access(db: &Db, limit: i64) -> Result<Vec<RecentAccessRow>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT i.id, i.target_id, t.display_name, i.item_type, i.account_alias, i.last_accessed_at \
         FROM vault_items i JOIN vault_targets t ON t.id = i.target_id \
         WHERE i.deleted_at IS NULL AND t.deleted_at IS NULL AND i.status = 'active' \
         AND i.last_accessed_at IS NOT NULL \
         ORDER BY i.last_accessed_at DESC LIMIT ?1",
    )?;
    let out = stmt
        .query_map(params![limit.max(1).min(100)], |r| {
            Ok(RecentAccessRow {
                item_id: r.get(0)?,
                target_id: r.get(1)?,
                target_name: r.get(2)?,
                item_type: r.get(3)?,
                account_alias: r.get(4)?,
                last_accessed_at: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub target_id: String,
    pub account_alias: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub payload: CredentialPayload,
    /// 是否同时把该凭据设为当前使用者在此目标下的默认账号
    pub set_as_default: bool,
}

pub fn create_item(db: &Db, vk: &VaultKey, actor: &str, it: &NewItem) -> Result<String> {
    if it.account_alias.trim().is_empty() {
        return Err(AppError::InvalidInput);
    }
    let conn = db.lock_conn();
    let target_type: String = conn
        .query_row("SELECT target_type FROM vault_targets WHERE id=?1 AND deleted_at IS NULL", params![it.target_id], |r| r.get(0))
        .map_err(|_| AppError::NotFound)?;
    let id = new_id();
    let ts = now();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO vault_items (id,target_id,account_alias,item_type,group_id,favorite,status,created_by,updated_by,created_at,updated_at,version)
         VALUES (?1,?2,?3,?4,NULL,?5,'active',?6,?6,?7,?7,1)",
        params![id, it.target_id, it.account_alias.trim(), target_type, it.favorite as i64, actor, ts],
    )?;
    let sealed = seal_json(vk, &id, ITEM_TARGET_TYPE, &it.payload)?;
    write_sealed(&tx, "vault_item_secrets", "item_id", &id, &sealed)?;
    for tag in &it.tags {
        let t = tag.trim();
        if !t.is_empty() {
            tx.execute("INSERT OR IGNORE INTO vault_item_tags (item_id,tag) VALUES (?1,?2)", params![id, t])?;
        }
    }
    // 首条凭据自动设为该使用者默认；已有默认时不覆盖
    ensure_default_after_insert(&tx, actor, &it.target_id, &id, it.set_as_default)?;
    tx.commit()?;
    Ok(id)
}

fn ensure_default_after_insert(conn: &rusqlite::Connection, user_id: &str, target_id: &str, item_id: &str, explicit: bool) -> Result<()> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT default_vault_item_id FROM vault_target_preferences WHERE app_user_id=?1 AND target_id=?2",
            params![user_id, target_id],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() && !explicit {
        return Ok(());
    }
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM vault_items WHERE target_id=?1 AND deleted_at IS NULL AND status='active'",
        params![target_id],
        |r| r.get(0),
    )?;
    // 只有「首条」或「用户明确要求」才写默认
    if count <= 1 || explicit {
        conn.execute(
            "INSERT INTO vault_target_preferences (app_user_id,target_id,default_vault_item_id,updated_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(app_user_id,target_id) DO UPDATE SET default_vault_item_id=excluded.default_vault_item_id, updated_at=excluded.updated_at",
            params![user_id, target_id, item_id, now()],
        )?;
    }
    Ok(())
}

/// 设置默认账号：事务内校验归属、启用状态，且同一使用者+目标只有一个有效默认。
pub fn set_default_credential(db: &Db, actor: &str, target_id: &str, item_id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let row: Option<(String, String, Option<String>)> = tx
        .query_row(
            "SELECT target_id, status, deleted_at FROM vault_items WHERE id=?1",
            params![item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (item_target, status, deleted) = row.ok_or(AppError::NotFound)?;
    if item_target != target_id {
        return Err(AppError::TargetCredentialMismatch);
    }
    if deleted.is_some() || status != "active" {
        return Err(AppError::CredentialDisabled);
    }
    let target_ok: i64 = tx.query_row(
        "SELECT count(*) FROM vault_targets WHERE id=?1 AND deleted_at IS NULL AND status='active'",
        params![target_id],
        |r| r.get(0),
    )?;
    if target_ok == 0 {
        return Err(AppError::NotFound);
    }
    tx.execute(
        "INSERT INTO vault_target_preferences (app_user_id,target_id,default_vault_item_id,updated_at)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(app_user_id,target_id) DO UPDATE SET default_vault_item_id=excluded.default_vault_item_id, updated_at=excluded.updated_at",
        params![actor, target_id, item_id, now()],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn default_credential(db: &Db, user_id: &str, target_id: &str) -> Result<Option<String>> {
    let conn = db.lock_conn();
    Ok(conn
        .query_row(
            "SELECT p.default_vault_item_id FROM vault_target_preferences p
             JOIN vault_items i ON i.id=p.default_vault_item_id
             WHERE p.app_user_id=?1 AND p.target_id=?2 AND i.deleted_at IS NULL AND i.status='active'",
            params![user_id, target_id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn list_items_for_target(db: &Db, target_id: &str, user_id: &str) -> Result<Vec<ItemRow>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT i.id, i.target_id, i.account_alias, i.item_type, i.status, i.favorite, i.created_at, i.updated_at, i.version,
                (SELECT p.default_vault_item_id FROM vault_target_preferences p WHERE p.app_user_id=?2 AND p.target_id=i.target_id)
         FROM vault_items i WHERE i.target_id=?1 AND i.deleted_at IS NULL ORDER BY i.created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![target_id, user_id], |r| {
            let default_id: Option<String> = r.get(9)?;
            let id: String = r.get(0)?;
            Ok(ItemRow {
                is_default_for_current_user: default_id.as_deref() == Some(id.as_str()),
                id,
                target_id: r.get(1)?,
                account_alias: r.get(2)?,
                item_type: r.get(3)?,
                status: r.get(4)?,
                favorite: r.get::<_, i64>(5)? != 0,
                tags: vec![],
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                version: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut rows = rows;
    for row in rows.iter_mut() {
        row.tags = item_tags(&conn, &row.id)?;
    }
    Ok(rows)
}

pub fn item_tags(conn: &rusqlite::Connection, item_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM vault_item_tags WHERE item_id=?1 ORDER BY tag")?;
    let v = stmt.query_map(params![item_id], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn get_item_row(db: &Db, user_id: &str, item_id: &str) -> Result<ItemRow> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT i.id, i.target_id, i.account_alias, i.item_type, i.status, i.favorite, i.created_at, i.updated_at, i.version,
                (SELECT p.default_vault_item_id FROM vault_target_preferences p WHERE p.app_user_id=?2 AND p.target_id=i.target_id)
         FROM vault_items i WHERE i.id=?1 AND i.deleted_at IS NULL",
    )?;
    let mut rows = stmt
        .query_map(params![item_id, user_id], |r| {
            let default_id: Option<String> = r.get(9)?;
            let id: String = r.get(0)?;
            Ok(ItemRow {
                is_default_for_current_user: default_id.as_deref() == Some(id.as_str()),
                id,
                target_id: r.get(1)?,
                account_alias: r.get(2)?,
                item_type: r.get(3)?,
                status: r.get(4)?,
                favorite: r.get::<_, i64>(5)? != 0,
                tags: vec![],
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                version: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let row = rows.pop().ok_or(AppError::NotFound)?;
    let mut row = row;
    row.tags = item_tags(&conn, &row.id)?;
    Ok(row)
}

pub fn get_target_row(db: &Db, target_id: &str) -> Result<TargetRow> {
    list_targets(db)?
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or(AppError::NotFound)
}

/// 目标是否处于可操作状态（未删除且启用）。
pub fn target_is_active(db: &Db, target_id: &str) -> Result<bool> {
    let conn = db.lock_conn();
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM vault_targets WHERE id=?1 AND deleted_at IS NULL AND status='active'",
        params![target_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn item_is_active(db: &Db, item_id: &str) -> Result<bool> {
    let conn = db.lock_conn();
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM vault_items WHERE id=?1 AND deleted_at IS NULL AND status='active'",
        params![item_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn item_payload(vk: &VaultKey, db: &Db, item_id: &str) -> Result<CredentialPayload> {
    let conn = db.lock_conn();
    let sealed = read_sealed(&conn, "vault_item_secrets", "item_id", item_id)?.ok_or(AppError::NotFound)?;
    open_json(vk, item_id, ITEM_TARGET_TYPE, &sealed)
}

pub fn update_item_payload(db: &Db, vk: &VaultKey, actor: &str, item_id: &str, payload: &CredentialPayload, alias: Option<&str>, tags: Option<&[String]>) -> Result<()> {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let target_id: String = tx
        .query_row("SELECT target_id FROM vault_items WHERE id=?1 AND deleted_at IS NULL", params![item_id], |r| r.get(0))
        .map_err(|_| AppError::NotFound)?;
    let _ = target_id;
    if let Some(a) = alias {
        tx.execute(
            "UPDATE vault_items SET account_alias=?1, version=version+1, updated_by=?2, updated_at=?3 WHERE id=?4",
            params![a.trim(), actor, now(), item_id],
        )?;
    } else {
        tx.execute("UPDATE vault_items SET version=version+1, updated_by=?1, updated_at=?2 WHERE id=?3", params![actor, now(), item_id])?;
    }
    let sealed = seal_json(vk, item_id, ITEM_TARGET_TYPE, payload)?;
    write_sealed(&tx, "vault_item_secrets", "item_id", item_id, &sealed)?;
    if let Some(tags) = tags {
        tx.execute("DELETE FROM vault_item_tags WHERE item_id=?1", params![item_id])?;
        for t in tags {
            let t = t.trim();
            if !t.is_empty() {
                tx.execute("INSERT OR IGNORE INTO vault_item_tags (item_id,tag) VALUES (?1,?2)", params![item_id, t])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn set_item_status(db: &Db, actor: &str, item_id: &str, status: &str) -> Result<()> {
    let conn = db.lock_conn();
    let n = conn.execute(
        "UPDATE vault_items SET status=?1, updated_by=?2, updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
        params![status, actor, now(), item_id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// 软删除。触发器会同时清除指向该凭据的默认偏好。
pub fn soft_delete_item(db: &Db, actor: &str, item_id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let n = conn.execute(
        "UPDATE vault_items SET deleted_at=?1, updated_by=?2, updated_at=?1 WHERE id=?3 AND deleted_at IS NULL",
        params![now(), actor, item_id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub fn set_favorite(db: &Db, item_id: &str, favorite: bool) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute("UPDATE vault_items SET favorite=?1, updated_at=?2 WHERE id=?3 AND deleted_at IS NULL", params![favorite as i64, now(), item_id])?;
    Ok(())
}

// ------------------------------------------------------------------ 内存搜索索引

/// 解锁后为当前使用者授权范围构建短生命周期内存索引。
/// 只解密搜索所需的最小字段，绝不把密码/Token/私钥放进索引。
pub fn build_search_index(db: &Db, vk: &VaultKey, user_id: &str) -> Result<Vec<SearchDoc>> {
    let conn = db.lock_conn();
    struct Row {
        item_id: String,
        target_id: String,
        alias: String,
        item_type: String,
        favorite: bool,
        is_default: bool,
        last_accessed: Option<String>,
        count: i64,
    }
    let mut stmt = conn.prepare(
        "SELECT i.id, i.target_id, i.account_alias, i.item_type, i.favorite,
                (SELECT p.default_vault_item_id FROM vault_target_preferences p WHERE p.app_user_id=?1 AND p.target_id=i.target_id),
                i.last_accessed_at,
                (SELECT count(*) FROM vault_items x WHERE x.target_id=i.target_id AND x.deleted_at IS NULL AND x.status='active')
         FROM vault_items i
         JOIN vault_targets t ON t.id=i.target_id
         WHERE i.deleted_at IS NULL AND i.status='active' AND t.deleted_at IS NULL AND t.status='active'
         ORDER BY i.updated_at DESC",
    )?;
    let rows = stmt
        .query_map(params![user_id], |r| {
            let default_id: Option<String> = r.get(5)?;
            let item_id: String = r.get(0)?;
            Ok(Row {
                is_default: default_id.as_deref() == Some(item_id.as_str()),
                item_id,
                target_id: r.get(1)?,
                alias: r.get(2)?,
                item_type: r.get(3)?,
                favorite: r.get::<_, i64>(4)? != 0,
                last_accessed: r.get(6)?,
                count: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<Row>, _>>()?;
    drop(stmt);

    let mut target_cache: std::collections::HashMap<String, (String, TargetSecretPayload)> = std::collections::HashMap::new();
    let mut docs = Vec::with_capacity(rows.len());
    for row in rows {
        if !can_access_item(&conn, user_id, &row.item_id)? {
            continue;
        }
        let (system_name, meta) = match target_cache.get(&row.target_id) {
            Some(v) => (v.0.clone(), v.1.clone()),
            None => {
                let name: String = conn.query_row("SELECT display_name FROM vault_targets WHERE id=?1", params![row.target_id], |r| r.get(0))?;
                let sealed = read_sealed(&conn, "vault_target_secrets", "target_id", &row.target_id)?;
                let meta: TargetSecretPayload = match sealed {
                    Some(s) => open_json(vk, &row.target_id, TARGET_TARGET_TYPE, &s).unwrap_or_default(),
                    None => TargetSecretPayload::default(),
                };
                target_cache.insert(row.target_id.clone(), (name.clone(), meta.clone()));
                (name, meta)
            }
        };
        let sealed = match read_sealed(&conn, "vault_item_secrets", "item_id", &row.item_id)? {
            Some(s) => s,
            None => continue,
        };
        let payload: CredentialPayload = match open_json(vk, &row.item_id, ITEM_TARGET_TYPE, &sealed) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let tags: Vec<String> = item_tags(&conn, &row.item_id)?.into_iter().map(|t| t.to_lowercase()).collect();
        let address = if !meta.url.is_empty() {
            meta.url.clone()
        } else if !meta.host.is_empty() {
            if meta.port.is_empty() { meta.host.clone() } else { format!("{}:{}", meta.host, meta.port) }
        } else {
            String::new()
        };
        docs.push(SearchDoc {
            target_id: row.target_id.clone(),
            item_id: row.item_id.clone(),
            system_name,
            address,
            host: meta.host.clone(),
            port: meta.port.clone(),
            username: payload.username.to_lowercase(),
            account_alias: row.alias.clone(),
            item_type: row.item_type.clone(),
            group_name: String::new(),
            tags,
            note: payload.note.clone(),
            favorite: row.favorite,
            is_default: row.is_default,
            last_accessed_at: row.last_accessed.clone(),
            credential_count: row.count.max(1) as usize,
        });
    }
    Ok(docs)
}

/// 记录级 ACL 与 RBAC 叠加检查。默认：创建者或管理员可见。
pub fn can_access_item(conn: &rusqlite::Connection, user_id: &str, item_id: &str) -> Result<bool> {
    let allowed: i64 = conn.query_row(
        "SELECT (
            SELECT count(*) FROM vault_items i WHERE i.id=?2 AND i.created_by=?1
          ) + (
            SELECT count(*) FROM vault_item_acl a
              WHERE a.item_id=?2 AND (
                (a.subject_type='user' AND a.subject_id=?1)
                OR (a.subject_type='role' AND a.subject_id IN (SELECT role_id FROM user_roles WHERE user_id=?1))
              )
          ) + (
            SELECT count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id
              WHERE ur.user_id=?1 AND r.code='system_admin'
          )",
        params![user_id, item_id],
        |r| r.get(0),
    )?;
    Ok(allowed > 0)
}

pub fn touch_last_accessed(db: &Db, item_id: &str) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute("UPDATE vault_items SET last_accessed_at=?1 WHERE id=?2", params![now(), item_id])?;
    Ok(())
}

/// 八种凭据类型（§2.2.1）。列表筛选、导入校验与统计共用。
pub const ALL_TYPES: &[&str] = &["web", "terminal", "database", "network_device", "cloud_service", "file_transfer", "application", "generic_secret"];

/// 恢复被软删除的凭据；恢复后不会自动成为默认账号（默认值由使用者显式设置）。
pub fn restore_item(db: &Db, actor: &str, item_id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let n = conn.execute(
        "UPDATE vault_items SET deleted_at=NULL, status='active', updated_by=?1, updated_at=?2 WHERE id=?3 AND deleted_at IS NOT NULL",
        params![actor, now(), item_id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub target_count: i64,
}

pub fn list_groups(db: &Db) -> Result<Vec<GroupRow>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, g.parent_id,
                (SELECT count(*) FROM vault_targets t WHERE t.group_id=g.id AND t.deleted_at IS NULL)
         FROM vault_groups g ORDER BY g.name",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(GroupRow {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                target_count: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn create_group(db: &Db, actor: &str, name: &str, parent_id: Option<&str>) -> Result<String> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput);
    }
    let _ = actor;
    let id = new_id();
    let conn = db.lock_conn();
    // vault_groups 表没有 created_by 列（分组的建组人记在审计日志里）：
    // 早先这里多写了一列，导致任何建分组操作都失败。
    conn.execute(
        "INSERT INTO vault_groups (id, name, parent_id, created_at) VALUES (?1,?2,?3,?4)",
        params![id, name.trim(), parent_id, now()],
    )?;
    Ok(id)
}

/// 更新目标的地址类元数据（不改动任何凭据内容）。
pub fn update_target_meta(db: &Db, vk: &VaultKey, actor: &str, target_id: &str, meta: &TargetSecretPayload, display_name: Option<&str>, group_id: Option<Option<&str>>) -> Result<()> {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let sealed = seal_json(vk, target_id, TARGET_TARGET_TYPE, meta)?;
    write_sealed(&tx, "vault_target_secrets", "target_id", target_id, &sealed)?;
    if let Some(n) = display_name {
        tx.execute(
            "UPDATE vault_targets SET display_name=?1, updated_by=?2, updated_at=?3 WHERE id=?4",
            params![n.trim(), actor, now(), target_id],
        )?;
    }
    if let Some(g) = group_id {
        tx.execute(
            "UPDATE vault_targets SET group_id=?1, updated_by=?2, updated_at=?3 WHERE id=?4",
            params![g, actor, now(), target_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn set_target_status(db: &Db, actor: &str, target_id: &str, status: &str) -> Result<()> {
    if status != "active" && status != "disabled" {
        return Err(AppError::InvalidInput);
    }
    let conn = db.lock_conn();
    let n = conn.execute(
        "UPDATE vault_targets SET status=?1, updated_by=?2, updated_at=?3 WHERE id=?4 AND deleted_at IS NULL",
        params![status, actor, now(), target_id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// 目标下有效凭据条数（用于「同一地址多账号」展示）。
pub fn active_item_count(db: &Db, target_id: &str) -> Result<i64> {
    let conn = db.lock_conn();
    Ok(conn.query_row(
        "SELECT count(*) FROM vault_items WHERE target_id=?1 AND deleted_at IS NULL AND status='active'",
        params![target_id],
        |r| r.get(0),
    )?)
}

fn validate_type(t: &str) -> Result<()> {
    const OK: &[&str] = &["web", "terminal", "database", "network_device", "cloud_service", "file_transfer", "application", "generic_secret"];
    if OK.contains(&t) {
        Ok(())
    } else {
        Err(AppError::InvalidInput)
    }
}

/// 弱协议风险判定：Telnet / FTP 默认禁用。
pub fn is_insecure_protocol(target_type: &str, protocol: &str) -> bool {
    let p = protocol.to_lowercase();
    target_type == "file_transfer" && p == "ftp" || (target_type == "terminal" && p == "telnet")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::vault_key;
    use crate::db::Db;

    fn setup() -> (Db, VaultKey) {
        let db = Db::open_in_memory(&vec![11u8; 32]).unwrap();
        let (vk, m) = vault_key::initialize("Master#2026", "u1", 1, &Default::default()).unwrap();
        let conn = db.lock_conn();
        conn.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES ('u1','GEN-U1','测试者','argon2id',?1,?2,4096,2,1,?3,?3)",
            params![m.verify_salt, m.verify_hash, now()],
        )
        .unwrap();
        drop(conn);
        (db, vk)
    }

    fn web_target(db: &Db, vk: &VaultKey, name: &str, url: &str) -> String {
        create_target(
            db,
            vk,
            "u1",
            &NewTarget {
                target_type: "web".into(),
                display_name: name.into(),
                group_id: None,
                meta: TargetSecretPayload { url: url.into(), allowed_origin: url.into(), ..Default::default() },
            },
        )
        .unwrap()
    }

    fn add_item(db: &Db, vk: &VaultKey, target: &str, alias: &str, user: &str, pwd: &str) -> String {
        create_item(
            db,
            vk,
            "u1",
            &NewItem {
                target_id: target.into(),
                account_alias: alias.into(),
                tags: vec![],
                favorite: false,
                payload: CredentialPayload { username: user.into(), password: SecretString::new(pwd), ..Default::default() },
                set_as_default: false,
            },
        )
        .unwrap()
    }

    #[test]
    fn paging_returns_every_target_exactly_once_and_total_stays_the_same() {
        let (db, vk) = setup();
        for i in 0..7 {
            web_target(&db, &vk, &format!("系统{i}"), "https://a.nmgdl.cn");
        }
        let (all, total) = query_targets(&db, &TargetQuery::default()).unwrap();
        assert_eq!(total, 7);
        assert_eq!(all.len(), 7);

        let mut seen: Vec<String> = vec![];
        for page in 0..4 {
            let (rows, t) = query_targets(&db, &TargetQuery { limit: Some(2), offset: page * 2, ..Default::default() }).unwrap();
            assert_eq!(t, 7, "翻页不得改变总数");
            assert!(rows.len() <= 2, "一次最多取一页：不能把全表都带回去");
            seen.extend(rows.into_iter().map(|r| r.display_name));
        }
        seen.sort();
        let mut full = all.into_iter().map(|r| r.display_name).collect::<Vec<_>>();
        full.sort();
        assert_eq!(seen, full, "分页合起来必须等于全量——既不重复也不漏");
    }

    #[test]
    fn page_beyond_the_end_is_empty_but_total_still_reports_the_real_count() {
        let (db, vk) = setup();
        for i in 0..3 {
            web_target(&db, &vk, &format!("目标{i}"), "https://a.nmgdl.cn");
        }
        let (rows, total) = query_targets(&db, &TargetQuery { limit: Some(10), offset: 500, ..Default::default() }).unwrap();
        assert!(rows.is_empty());
        assert_eq!(total, 3, "越界页只说明没数据，不代表总数是 0");
    }

    #[test]
    fn favorite_only_keeps_only_targets_having_an_active_favorited_credential() {
        let (db, vk) = setup();
        let a = web_target(&db, &vk, "有收藏系统", "https://a.cn");
        let b = web_target(&db, &vk, "无收藏系统", "https://b.cn");
        let fav = add_item(&db, &vk, &a, "个人", "lisi", "p1");
        add_item(&db, &vk, &b, "个人", "ops", "p2");
        set_favorite(&db, &fav, true).unwrap();

        let (rows, total) = query_targets(&db, &TargetQuery { favorite_only: true, ..Default::default() }).unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows.iter().map(|r| r.display_name.as_str()).collect::<Vec<_>>(), vec!["有收藏系统"]);

        // 取消收藏后同一条件立刻不成立
        set_favorite(&db, &fav, false).unwrap();
        let (_, total) = query_targets(&db, &TargetQuery { favorite_only: true, ..Default::default() }).unwrap();
        assert_eq!(total, 0, "「仅收藏」不能是个不起作用的开关");
    }

    #[test]
    fn keyword_matches_substring_and_treats_like_wildcards_as_literals() {
        let (db, vk) = setup();
        web_target(&db, &vk, "生产数据库", "https://db.cn");
        web_target(&db, &vk, "100%完成度系统", "https://pct.cn");

        let (_, total) = query_targets(&db, &TargetQuery { keyword: Some("数据库"), ..Default::default() }).unwrap();
        assert_eq!(total, 1);

        let (rows, total) = query_targets(&db, &TargetQuery { keyword: Some("%"), ..Default::default() }).unwrap();
        assert_eq!(total, 1, "搜「%」只能命中名字里真有 % 的目标，不得当成任意匹配");
        assert_eq!(rows[0].display_name, "100%完成度系统");

        let (_, total) = query_targets(&db, &TargetQuery { keyword: Some("   "), ..Default::default() }).unwrap();
        assert_eq!(total, 2, "空白关键字等于不过滤");
    }

    #[test]
    fn type_group_and_keyword_combine_before_the_page_is_cut() {
        let (db, vk) = setup();
        let g = create_group(&db, "u1", "生产", None).unwrap();
        let target_of = |ty: &str, name: &str, group: Option<&str>| {
            create_target(
                &db,
                &vk,
                "u1",
                &NewTarget {
                    target_type: ty.into(),
                    display_name: name.into(),
                    group_id: group.map(str::to_string),
                    meta: TargetSecretPayload { url: "https://x.cn".into(), allowed_origin: "https://x.cn".into(), ..Default::default() },
                },
            )
            .unwrap()
        };
        target_of("web", "OA门户", Some(&g));
        target_of("web", "OA测试", None);
        target_of("web", "OA生产", Some(&g));
        target_of("terminal", "SSH跳板", Some(&g));

        let q = TargetQuery { item_type: Some("web"), group_id: Some(&g), keyword: Some("OA"), ..Default::default() };
        let (rows, total) = query_targets(&db, &q).unwrap();
        assert_eq!(total, 2, "三个条件必须同时成立（AND）");
        let mut got = rows.into_iter().map(|r| r.display_name).collect::<Vec<_>>();
        got.sort();
        assert_eq!(got, vec!["OA生产", "OA门户"]);

        // 分页取的是「过滤之后」的两条，而不是全表切两刀再过滤
        let (p1, t1) = query_targets(&db, &TargetQuery { limit: Some(1), offset: 0, ..q.clone() }).unwrap();
        let (p2, t2) = query_targets(&db, &TargetQuery { limit: Some(1), offset: 1, ..q }).unwrap();
        assert_eq!((t1, t2), (2, 2));
        assert_eq!(p1.len() + p2.len(), 2);
    }

    fn tagged_item(db: &Db, vk: &VaultKey, target: &str, alias: &str, tags: &[&str]) -> String {
        create_item(
            db,
            vk,
            "u1",
            &NewItem {
                target_id: target.into(),
                account_alias: alias.into(),
                tags: tags.iter().map(|t| t.to_string()).collect(),
                favorite: false,
                payload: CredentialPayload {
                    username: "someone".into(),
                    password: SecretString::new("S3cret#x"),
                    ..Default::default()
                },
                set_as_default: false,
            },
        )
        .unwrap()
    }

    fn names(rows: &[TargetRow]) -> Vec<&str> {
        rows.iter().map(|r| r.display_name.as_str()).collect()
    }

    /// 需求 §2.2 台账首页要有「标签」筛选：标签挂在凭据上，命中判定必须落到目标这一层。
    #[test]
    fn tag_filter_hits_targets_by_credential_tag_and_is_case_insensitive() {
        let (db, vk) = setup();
        let a = web_target(&db, &vk, "带标签系统", "https://a.cn");
        let b = web_target(&db, &vk, "无标签系统", "https://b.cn");
        tagged_item(&db, &vk, &a, "运维", &["生产", "Ops-Prod"]);
        add_item(&db, &vk, &b, "个人", "ops", "p2");

        let (rows, total) = query_targets(&db, &TargetQuery { tag: Some("生产"), ..Default::default() }).unwrap();
        assert_eq!(total, 1);
        assert_eq!(names(&rows), vec!["带标签系统"]);

        let (rows, _) = query_targets(&db, &TargetQuery { tag: Some("  ops-PROD  "), ..Default::default() }).unwrap();
        assert_eq!(names(&rows), vec!["带标签系统"], "标签匹配大小写不敏感，两端空白不该让筛选失效");

        let (_, total) = query_targets(&db, &TargetQuery { tag: Some("不存在的标签"), ..Default::default() }).unwrap();
        assert_eq!(total, 0);

        let (_, total) = query_targets(&db, &TargetQuery { tag: Some("   "), ..Default::default() }).unwrap();
        assert_eq!(total, 2, "空白标签等于不过滤");
    }

    #[test]
    fn tag_filter_ignores_disabled_and_deleted_credentials() {
        let (db, vk) = setup();
        let a = web_target(&db, &vk, "唯一带标签的目标", "https://a.cn");
        let item = tagged_item(&db, &vk, &a, "运维", &["临时"]);

        let (_, total) = query_targets(&db, &TargetQuery { tag: Some("临时"), ..Default::default() }).unwrap();
        assert_eq!(total, 1);

        set_item_status(&db, "u1", &item, "disabled").unwrap();
        let (_, total) = query_targets(&db, &TargetQuery { tag: Some("临时"), ..Default::default() }).unwrap();
        assert_eq!(total, 0, "停用的凭据不能再把标签命中算进来");

        set_item_status(&db, "u1", &item, "active").unwrap();
        soft_delete_item(&db, "u1", &item).unwrap();
        let (_, total) = query_targets(&db, &TargetQuery { tag: Some("临时"), ..Default::default() }).unwrap();
        assert_eq!(total, 0, "已删进回收站的凭据同样不算命中");
    }

    #[test]
    fn list_item_tags_only_lists_tags_of_active_credentials_without_duplicates() {
        let (db, vk) = setup();
        let a = web_target(&db, &vk, "A", "https://a.cn");
        let b = web_target(&db, &vk, "B", "https://b.cn");
        tagged_item(&db, &vk, &a, "一", &["生产"]);
        tagged_item(&db, &vk, &b, "二", &["测试", "生产"]);
        let gone = tagged_item(&db, &vk, &b, "三", &["只在回收站"]);
        soft_delete_item(&db, "u1", &gone).unwrap();

        let mut tags = list_item_tags(&db).unwrap();
        tags.sort();
        assert_eq!(tags, vec!["测试", "生产"], "同标签在两条凭据上只出现一次，已删凭据的标签不列出");
        // 标签文本本身不是秘密，但绝不该带出口令/用户名
        assert!(serde_json::to_string(&tags).unwrap().find("S3cret").is_none());
    }

    /// 「最近访问」只给非秘密摘要：结构体里就没有用户名/口令字段，这条测试把住序列化后的键名。
    #[test]
    fn recent_access_orders_by_time_and_carries_no_secret_fields() {
        let (db, vk) = setup();
        let a = web_target(&db, &vk, "营销系统", "https://a.cn");
        let b = web_target(&db, &vk, "OA门户", "https://b.cn");
        let old = add_item(&db, &vk, &a, "个人账号", "zhang", "S3cret#old");
        let fresh = add_item(&db, &vk, &b, "运维账号", "ops", "S3cret#new");
        add_item(&db, &vk, &a, "只读账号", "guest", "S3cret#never");

        {
            let conn = db.lock_conn();
            conn
                .execute("UPDATE vault_items SET last_accessed_at=?1 WHERE id=?2", params!["2026-01-01T00:00:00Z", old])
                .unwrap();
            conn
                .execute("UPDATE vault_items SET last_accessed_at=?1 WHERE id=?2", params!["2026-02-01T00:00:00Z", fresh])
                .unwrap();
        }
        let got = recent_access(&db, 10).unwrap();
        assert_eq!(got.len(), 2, "从未访问过的凭据不该出现在最近访问里");
        assert_eq!(got[0].item_id, fresh, "按访问时间倒序");
        assert_eq!(got[0].account_alias, "运维账号");
        assert_eq!(got[0].target_name, "OA门户");

        // 上限确实生效（界面传 1 就只回 1 条）
        assert_eq!(recent_access(&db, 1).unwrap().len(), 1);

        // 停用后不再出现
        set_item_status(&db, "u1", &fresh, "disabled").unwrap();
        let after = recent_access(&db, 10).unwrap();
        assert_eq!(after.iter().map(|r| r.item_id.as_str()).collect::<Vec<_>>(), vec![old.as_str()]);

        let json = serde_json::to_string(&recent_access(&db, 10).unwrap()).unwrap();
        for forbidden in ["password", "username", "note", "S3cret"] {
            assert!(!json.contains(forbidden), "最近访问里出现了不该有的字段/内容：{forbidden}");
        }
    }

    #[test]
    fn same_url_accepts_multiple_accounts_without_overwrite() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA办公系统", "https://oa.nmgdl.cn");
        let a = add_item(&db, &vk, &t, "个人账号", "lisi", "p1");
        let b = add_item(&db, &vk, &t, "运维账号", "ops", "p2");
        let c = add_item(&db, &vk, &t, "只读账号", "guest", "p3");
        assert_ne!(a, b);
        assert_ne!(b, c);
        let items = list_items_for_target(&db, &t, "u1").unwrap();
        assert_eq!(items.len(), 3, "同一 URL 下的多条凭据都不得被去重覆盖");
        assert_eq!(item_payload(&vk, &db, &b).unwrap().username, "ops");
        assert_eq!(item_payload(&vk, &db, &b).unwrap().password.expose(), "p2");
    }

    #[test]
    fn first_credential_becomes_default_and_more_do_not_overwrite() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA", "https://oa.nmgdl.cn");
        let a = add_item(&db, &vk, &t, "个人", "lisi", "p1");
        assert_eq!(default_credential(&db, "u1", &t).unwrap().as_deref(), Some(a.as_str()));
        let b = add_item(&db, &vk, &t, "运维", "ops", "p2");
        assert_eq!(default_credential(&db, "u1", &t).unwrap().as_deref(), Some(a.as_str()), "新增账号不得自动覆盖默认");
        // 显式更换默认
        set_default_credential(&db, "u1", &t, &b).unwrap();
        assert_eq!(default_credential(&db, "u1", &t).unwrap().as_deref(), Some(b.as_str()));
        // 更换默认不改变其他凭据内容
        assert_eq!(item_payload(&vk, &db, &a).unwrap().username, "lisi");
    }

    #[test]
    fn default_is_per_local_user() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA", "https://oa.nmgdl.cn");
        let a = add_item(&db, &vk, &t, "个人", "lisi", "p1");
        let b = add_item(&db, &vk, &t, "运维", "ops", "p2");
        let conn = db.lock_conn();
        conn.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES ('u2','GEN-U2','另一人','argon2id',X'00',X'00',4096,2,1,?1,?1)",
            params![now()],
        )
        .unwrap();
        conn.execute("INSERT INTO vault_target_preferences (app_user_id,target_id,default_vault_item_id,updated_at) VALUES ('u2',?1,?2,?3)", params![t, b, now()]).unwrap();
        drop(conn);
        assert_eq!(default_credential(&db, "u1", &t).unwrap().as_deref(), Some(a.as_str()));
        assert_eq!(default_credential(&db, "u2", &t).unwrap().as_deref(), Some(b.as_str()));
    }

    #[test]
    fn cross_target_default_is_rejected() {
        let (db, vk) = setup();
        let t1 = web_target(&db, &vk, "OA", "https://oa.nmgdl.cn");
        let t2 = web_target(&db, &vk, "GitLab", "https://git.nmgdl.cn");
        let it2 = add_item(&db, &vk, &t2, "devops", "devops", "x");
        assert!(matches!(set_default_credential(&db, "u1", &t1, &it2), Err(AppError::TargetCredentialMismatch)));
    }

    #[test]
    fn disabled_credential_cannot_be_default_and_default_clears_on_disable() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA", "https://oa.nmgdl.cn");
        let a = add_item(&db, &vk, &t, "个人", "lisi", "p1");
        let b = add_item(&db, &vk, &t, "运维", "ops", "p2");
        set_item_status(&db, "u1", &b, "disabled").unwrap();
        assert!(matches!(set_default_credential(&db, "u1", &t, &b), Err(AppError::CredentialDisabled)));
        assert_eq!(default_credential(&db, "u1", &t).unwrap().as_deref(), Some(a.as_str()));
        // 停用当前默认凭据 → 默认被清除，不自动随机改选
        set_item_status(&db, "u1", &a, "disabled").unwrap();
        assert_eq!(default_credential(&db, "u1", &t).unwrap(), None);
    }

    #[test]
    fn soft_delete_clears_default_preference() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA", "https://oa.nmgdl.cn");
        let a = add_item(&db, &vk, &t, "个人", "lisi", "p1");
        soft_delete_item(&db, "u1", &a).unwrap();
        assert_eq!(default_credential(&db, "u1", &t).unwrap(), None);
    }

    #[test]
    fn target_secrets_are_encrypted_at_rest() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA", "https://oa.nmgdl.cn/login");
        let a = add_item(&db, &vk, &t, "个人", "lisi", "SuperSecret#1");
        let raw = {
            let conn = db.lock_conn();
            let ct: Vec<u8> = conn.query_row("SELECT ciphertext FROM vault_item_secrets WHERE item_id=?1", params![a], |r| r.get(0)).unwrap();
            ct
        };
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("SuperSecret"), "凭据密文不得包含明文密码");
        let tct = {
            let conn = db.lock_conn();
            conn.query_row("SELECT ciphertext FROM vault_target_secrets WHERE target_id=?1", params![t], |r| r.get::<_, Vec<u8>>(0)).unwrap()
        };
        assert!(!String::from_utf8_lossy(&tct).contains("oa.nmgdl.cn"), "目标地址必须加密保存");
    }

    #[test]
    fn search_index_excludes_secrets_and_disabled_records() {
        let (db, vk) = setup();
        let t = web_target(&db, &vk, "OA办公系统", "https://oa.nmgdl.cn");
        let a = add_item(&db, &vk, &t, "日常办公", "zhangsan", "Pa55w0rd!");
        let docs = build_search_index(&db, &vk, "u1").unwrap();
        assert_eq!(docs.len(), 1);
        let d = &docs[0];
        assert_eq!(d.username, "zhangsan");
        assert_eq!(d.item_id, a);
        let serialized = format!("{:?}", docs);
        assert!(!serialized.contains("Pa55w0rd"), "索引中不得出现密码");
        set_item_status(&db, "u1", &a, "disabled").unwrap();
        assert!(build_search_index(&db, &vk, "u1").unwrap().is_empty());
    }

    #[test]
    fn insecure_protocols_are_flagged() {
        assert!(is_insecure_protocol("terminal", "telnet"));
        assert!(is_insecure_protocol("file_transfer", "FTP"));
        assert!(!is_insecure_protocol("file_transfer", "sftp"));
        assert!(!is_insecure_protocol("terminal", "ssh"));
    }

    /// 填充前确认是 fail-secure 的：载荷里缺少该字段（历史数据/手工构造）时必须仍要求确认。
    #[test]
    fn missing_confirm_before_fill_field_defaults_to_requiring_confirmation() {
        let p: CredentialPayload = serde_json::from_str(r#"{"username":"root"}"#).unwrap();
        assert!(p.confirm_before_fill, "字段缺失不得等于免确认填充");
        assert!(CredentialPayload::default().confirm_before_fill);
        let off: CredentialPayload =
            serde_json::from_str(r#"{"confirm_before_fill":false}"#).unwrap();
        assert!(!off.confirm_before_fill, "显式 false 才是关掉确认");
    }

    /// 建分组曾经因为 INSERT 写了表里没有的 created_by 列而全部失败（界面与导入都受影响）。
    #[test]
    fn create_group_persists_and_counts_targets() {
        let (db, vk) = setup();
        let g = create_group(&db, "u1", "  生产环境  ", None).unwrap();
        let parent = list_groups(&db).unwrap();
        assert_eq!(parent.len(), 1);
        assert_eq!(parent[0].name, "生产环境", "组名应去掉首尾空格");
        assert_eq!(parent[0].id, g);

        let t = create_target(
            &db,
            &vk,
            "u1",
            &NewTarget {
                target_type: "web".into(),
                display_name: "OA办公系统".into(),
                group_id: Some(g.clone()),
                meta: TargetSecretPayload { url: "https://oa.nmgdl.cn".into(), ..Default::default() },
            },
        )
        .unwrap();
        let g2 = list_groups(&db).unwrap();
        assert_eq!(g2[0].target_count, 1, "组内目标数应统计未删除的目标");
        assert_eq!(get_target_row(&db, &t).unwrap().group_id.as_deref(), Some(g.as_str()));

        // 子组：建组要能带 parent_id，供层级分组使用
        let sub = create_group(&db, "u1", "核心业务", Some(&g)).unwrap();
        assert_eq!(list_groups(&db).unwrap().iter().find(|x| x.id == sub).unwrap().parent_id.as_deref(), Some(g.as_str()));
        assert!(create_group(&db, "u1", "   ", None).is_err(), "空组名不得入库");
    }

    #[test]
    fn update_target_meta_rewrites_the_whole_sealed_payload_not_only_the_fields_you_sent() {
        let (db, vk) = setup();
        let t = create_target(
            &db,
            &vk,
            "u1",
            &NewTarget {
                target_type: "web".into(),
                display_name: "蒙电OA".into(),
                group_id: None,
                meta: TargetSecretPayload { url: "https://oa.nmgdl.cn".into(), allowed_origin: "https://oa.nmgdl.cn".into(), tenant: "租户A".into(), ..Default::default() },
            },
        )
        .unwrap();
        let item = add_item(&db, &vk, &t, "台账账号", "oa-user", "S3cret#2026");

        update_target_meta(&db, &vk, "u1", &t, &TargetSecretPayload { url: "https://new.nmgdl.cn".into(), allowed_origin: "https://new.nmgdl.cn".into(), ..Default::default() }, Some("  蒙电OA（新）  "), None)
            .unwrap();

        let meta = target_meta(&vk, &db, &t).unwrap();
        assert_eq!(meta.url, "https://new.nmgdl.cn");
        assert_eq!(meta.tenant, "", "这一份是整块密封载荷的重写：调用方没带的字段会被清掉，不是按字段合并");
        assert_eq!(get_target_row(&db, &t).unwrap().display_name, "蒙电OA（新）", "名称入库前 trim");
        assert_eq!(item_payload(&vk, &db, &item).unwrap().password.expose(), "S3cret#2026", "改元数据不得碰任何凭据内容");
    }

    #[test]
    fn update_target_meta_tells_group_unchanged_apart_from_group_cleared() {
        let (db, vk) = setup();
        let g = create_group(&db, "u1", "办公系统", None).unwrap();
        let t = create_target(
            &db,
            &vk,
            "u1",
            &NewTarget { target_type: "web".into(), display_name: "蒙电OA".into(), group_id: None, meta: TargetSecretPayload { url: "https://oa.nmgdl.cn".into(), ..Default::default() } },
        )
        .unwrap();
        let blank = TargetSecretPayload::default();

        update_target_meta(&db, &vk, "u1", &t, &blank, None, Some(Some(g.as_str()))).unwrap();
        assert_eq!(get_target_row(&db, &t).unwrap().group_id.as_deref(), Some(g.as_str()));

        // None = 这一栏不动：只改名称不该把系统移出分组
        update_target_meta(&db, &vk, "u1", &t, &blank, Some("只改名字"), None).unwrap();
        assert_eq!(get_target_row(&db, &t).unwrap().group_id.as_deref(), Some(g.as_str()), "group_id 传 None 是\"不改\"，不是\"清空\"");

        // Some(None) = 明确移到未分组（前端表单里分组下拉空值走的就是这一支）
        update_target_meta(&db, &vk, "u1", &t, &blank, None, Some(None)).unwrap();
        assert_eq!(get_target_row(&db, &t).unwrap().group_id, None);

        // display_name 传 None 时名称也不该被清空
        assert_eq!(get_target_row(&db, &t).unwrap().display_name, "只改名字");
    }
}

/// 回收站里的一条：凭据行 + 所属系统名 + 删除时间（都不含秘密）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedItemRow {
    pub item: ItemRow,
    pub target_name: String,
    pub deleted_at: String,
}

/// 已软删除的凭据列表。恢复只能逐条显式指定，绝不批量改回其他账号。
pub fn list_deleted_items(db: &Db, user_id: &str, limit: i64) -> Result<Vec<DeletedItemRow>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT i.id, i.target_id, t.display_name, i.account_alias, i.item_type, i.status, i.favorite,
                i.created_at, i.updated_at, i.version, i.deleted_at,
                (SELECT p.default_vault_item_id FROM vault_target_preferences p WHERE p.app_user_id=?1 AND p.target_id=i.target_id)
         FROM vault_items i JOIN vault_targets t ON t.id = i.target_id
         WHERE i.deleted_at IS NOT NULL
         ORDER BY i.deleted_at DESC
         LIMIT ?2",
    )?;
    let mut rows = stmt
        .query_map(params![user_id, limit], |r| {
            let default_id: Option<String> = r.get(11)?;
            let id: String = r.get(0)?;
            Ok(DeletedItemRow {
                target_name: r.get(2)?,
                deleted_at: r.get(10)?,
                item: ItemRow {
                    is_default_for_current_user: default_id.as_deref() == Some(id.as_str()),
                    id,
                    target_id: r.get(1)?,
                    account_alias: r.get(3)?,
                    item_type: r.get(4)?,
                    status: r.get(5)?,
                    favorite: r.get::<_, i64>(6)? != 0,
                    tags: vec![],
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                    version: r.get(9)?,
                },
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    for row in rows.iter_mut() {
        row.item.tags = item_tags(&conn, &row.item.id)?;
    }
    Ok(rows)
}
