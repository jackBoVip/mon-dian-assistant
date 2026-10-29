//! 角色、菜单与权限管理命令。
//!
//! 写入路径统一遵守：会话 → 操作权限 → 二次认证 → 取连接锁 → 事务。
//! 例外是权限矩阵保存（`set_role_action_permissions` / `set_role_menu_permissions`）：
//! 交付方 2026-10-22 点名取消这一步的二次确认，点「保存」直接落库；角色增删改与
//! 使用者改角色仍照旧要求近期二次认证。
//! 事务内的权限重算用于"自锁守卫"：任何改动若会让操作者失去系统管理入口，整体回滚。

use super::audit;
use crate::db::repo;
use crate::error::{AppError, Result};
use crate::rbac::{self, perm};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleAdminSummary {
    pub id: String,
    pub code: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub builtin: bool,
    pub user_count: i64,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRow {
    pub key: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: Option<String>,
}

fn validate_code(code: &str) -> Result<()> {
    let len = code.chars().count();
    if !(2..=32).contains(&len) {
        return Err(AppError::RoleCodeInvalid);
    }
    let mut chars = code.chars();
    let first = chars.next().ok_or(AppError::RoleCodeInvalid)?;
    if !first.is_ascii_lowercase() {
        return Err(AppError::RoleCodeInvalid);
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(AppError::RoleCodeInvalid);
    }
    Ok(())
}

fn clean_name(name: &str) -> Result<String> {
    let v = name.trim();
    if v.is_empty() || v.chars().count() > 32 {
        return Err(AppError::InvalidInput);
    }
    Ok(v.to_string())
}

fn clean_description(description: &str) -> Result<String> {
    let v = description.trim();
    if v.chars().count() > 200 {
        return Err(AppError::InvalidInput);
    }
    Ok(v.to_string())
}

#[cfg(test)]
fn permission_keys_of_role(conn: &Connection, role_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT p.permission_key FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id=?1 ORDER BY p.permission_key",
    )?;
    let v = stmt
        .query_map(params![role_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub(crate) fn query_permissions(conn: &Connection) -> Result<Vec<PermissionRow>> {
    let mut stmt = conn.prepare(
        "SELECT permission_key, name, type, description FROM permissions
         ORDER BY CASE type WHEN 'menu' THEN 0 ELSE 1 END, permission_key",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PermissionRow {
                key: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                description: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub(crate) fn query_roles_admin(conn: &Connection) -> Result<Vec<RoleAdminSummary>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.code, r.name, COALESCE(r.description,''), r.status, r.builtin,
                (SELECT count(*) FROM user_roles ur WHERE ur.role_id=r.id)
           FROM roles r ORDER BY r.builtin DESC, r.code",
    )?;
    let mut roles = stmt
        .query_map([], |r| {
            Ok(RoleAdminSummary {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                description: r.get(3)?,
                status: r.get(4)?,
                builtin: r.get::<_, i64>(5)? != 0,
                user_count: r.get(6)?,
                permissions: vec![],
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut by_role: HashMap<String, Vec<String>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT rp.role_id, p.permission_key FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
         ORDER BY p.permission_key",
    )?;
    let pairs = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (role_id, key) in pairs {
        by_role.entry(role_id).or_default().push(key);
    }
    for role in roles.iter_mut() {
        role.permissions = by_role.remove(&role.id).unwrap_or_default();
    }
    Ok(roles)
}

fn ensure_no_self_lockout(conn: &Connection, actor: &str, before: &[String]) -> Result<()> {
    let after = rbac::permission_keys_conn(conn, actor)?;
    // 一级入口、权限管理自己的二级入口、以及能改权限的操作键，少任一都将无法撤销本次改动。
    for key in [perm::MENU_SYSTEM, perm::MENU_NODE_PERMISSIONS, perm::SYS_ROLE_MANAGE] {
        if before.iter().any(|k| k == key) && !after.iter().any(|k| k == key) {
            return Err(AppError::SelfLockout);
        }
    }
    Ok(())
}

pub(crate) fn create_role_db(db: &crate::db::Db, code: &str, name: &str, description: &str) -> Result<String> {
    let code = code.trim();
    validate_code(code)?;
    let name = clean_name(name)?;
    let description = clean_description(description)?;
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let exists: i64 = tx.query_row("SELECT count(*) FROM roles WHERE code=?1", params![code], |r| r.get(0))?;
    if exists > 0 {
        return Err(AppError::RoleCodeTaken);
    }
    let id = format!("r-{}", uuid::Uuid::now_v7());
    let now = repo::now();
    tx.execute(
        "INSERT INTO roles (id, code, name, description, status, builtin, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', 0, ?5, ?5)",
        params![id, code, name, description, now],
    )?;
    tx.commit()?;
    Ok(id)
}

pub(crate) fn update_role_db(
    db: &crate::db::Db,
    actor: &str,
    role_id: &str,
    name: &str,
    description: &str,
    status: &str,
) -> Result<()> {
    if status != "active" && status != "disabled" {
        return Err(AppError::InvalidInput);
    }
    let name = clean_name(name)?;
    let description = clean_description(description)?;
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let builtin: Option<i64> = tx
        .query_row("SELECT builtin FROM roles WHERE id=?1", params![role_id], |r| r.get(0))
        .optional()?;
    let builtin = builtin.ok_or(AppError::NotFound)?;
    if builtin != 0 {
        return Err(AppError::RoleBuiltinImmutable);
    }
    let before = rbac::permission_keys_conn(&tx, actor)?;
    tx.execute(
        "UPDATE roles SET name=?1, description=?2, status=?3, updated_at=?4 WHERE id=?5",
        params![name, description, status, repo::now(), role_id],
    )?;
    ensure_no_self_lockout(&tx, actor, &before)?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn delete_role_db(db: &crate::db::Db, role_id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let builtin: Option<i64> = tx
        .query_row("SELECT builtin FROM roles WHERE id=?1", params![role_id], |r| r.get(0))
        .optional()?;
    let builtin = builtin.ok_or(AppError::NotFound)?;
    if builtin != 0 {
        return Err(AppError::RoleBuiltinImmutable);
    }
    let bound: i64 = tx.query_row("SELECT count(*) FROM user_roles WHERE role_id=?1", params![role_id], |r| r.get(0))?;
    if bound > 0 {
        return Err(AppError::RoleInUse);
    }
    tx.execute("DELETE FROM role_permissions WHERE role_id=?1", params![role_id])?;
    tx.execute("DELETE FROM roles WHERE id=?1", params![role_id])?;
    tx.commit()?;
    Ok(())
}

fn replace_role_permissions(db: &crate::db::Db, actor: &str, role_id: &str, keys: &[String], kind: &str) -> Result<()> {
    let mut unique = keys.to_vec();
    unique.sort();
    unique.dedup();

    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let role_exists: i64 = tx.query_row("SELECT count(*) FROM roles WHERE id=?1", params![role_id], |r| r.get(0))?;
    if role_exists == 0 {
        return Err(AppError::NotFound);
    }
    for key in &unique {
        let t: Option<String> = tx
            .query_row("SELECT type FROM permissions WHERE permission_key=?1", params![key], |r| r.get(0))
            .optional()?;
        if t.as_deref() != Some(kind) {
            return Err(AppError::InvalidInput);
        }
    }
    let before = rbac::permission_keys_conn(&tx, actor)?;
    tx.execute(
        "DELETE FROM role_permissions WHERE role_id=?1
           AND permission_id IN (SELECT id FROM permissions WHERE type=?2)",
        params![role_id, kind],
    )?;
    for key in &unique {
        tx.execute(
            "INSERT INTO role_permissions (role_id, permission_id)
             SELECT ?1, id FROM permissions WHERE permission_key=?2 AND type=?3",
            params![role_id, key, kind],
        )?;
    }
    ensure_no_self_lockout(&tx, actor, &before)?;
    tx.commit()?;
    Ok(())
}

pub(crate) fn set_role_action_permissions_db(
    db: &crate::db::Db,
    actor: &str,
    role_id: &str,
    keys: &[String],
) -> Result<()> {
    replace_role_permissions(db, actor, role_id, keys, "action")
}

pub(crate) fn set_role_menu_permissions_db(
    db: &crate::db::Db,
    actor: &str,
    role_id: &str,
    keys: &[String],
) -> Result<()> {
    replace_role_permissions(db, actor, role_id, keys, "menu")
}

pub(crate) fn set_user_roles_db(
    db: &crate::db::Db,
    actor: &str,
    target_user_id: &str,
    role_codes: &[String],
) -> Result<()> {
    let mut codes = role_codes.to_vec();
    codes.sort();
    codes.dedup();
    if codes.is_empty() {
        return Err(AppError::InvalidInput);
    }

    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let target_exists: i64 = tx.query_row(
        "SELECT count(*) FROM app_users WHERE id=?1 AND deleted_at IS NULL",
        params![target_user_id],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(AppError::NotFound);
    }
    for code in &codes {
        let exists: i64 = tx.query_row("SELECT count(*) FROM roles WHERE code=?1", params![code], |r| r.get(0))?;
        if exists == 0 {
            return Err(AppError::NotFound);
        }
    }
    let before = rbac::permission_keys_conn(&tx, actor)?;
    tx.execute("DELETE FROM user_roles WHERE user_id=?1", params![target_user_id])?;
    for code in &codes {
        tx.execute(
            "INSERT INTO user_roles (user_id, role_id) SELECT ?1, id FROM roles WHERE code=?2",
            params![target_user_id, code],
        )?;
    }
    ensure_no_self_lockout(&tx, actor, &before)?;
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn my_permissions() -> Result<Vec<String>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::permission_keys(&core.db, &user)
}

#[tauri::command]
pub fn list_permissions() -> Result<Vec<PermissionRow>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_ROLE_MANAGE)?;
    let conn = core.db.lock_conn();
    query_permissions(&conn)
}

#[tauri::command]
pub fn list_roles_admin() -> Result<Vec<RoleAdminSummary>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_ROLE_MANAGE)?;
    let conn = core.db.lock_conn();
    query_roles_admin(&conn)
}

#[tauri::command]
pub fn create_role(code: String, name: String, description: String) -> Result<String> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    let id = create_role_db(&core.db, &code, &name, &description)?;
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.role.create", Some("role"), Some(&id), true, None, "app");
    Ok(id)
}

#[tauri::command]
pub fn update_role(role_id: String, name: String, description: String, status: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    update_role_db(&core.db, &admin, &role_id, &name, &description, &status)?;
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.role.update", Some("role"), Some(&role_id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn delete_role(role_id: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    delete_role_db(&core.db, &role_id)?;
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.role.delete", Some("role"), Some(&role_id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn set_role_action_permissions(role_id: String, permission_keys: Vec<String>) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    set_role_action_permissions_db(&core.db, &admin, &role_id, &permission_keys)?;
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.role.permissions", Some("role"), Some(&role_id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn set_role_menu_permissions(role_id: String, permission_keys: Vec<String>) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    set_role_menu_permissions_db(&core.db, &admin, &role_id, &permission_keys)?;
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.role.menus", Some("role"), Some(&role_id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn set_user_roles(target_user_id: String, role_codes: Vec<String>) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    set_user_roles_db(&core.db, &admin, &target_user_id, &role_codes)?;
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.user.roles", Some("app_user"), Some(&target_user_id), true, None, "app");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::now;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory(&vec![21u8; 32]).unwrap()
    }

    fn seed_user(db: &Db, id: &str, role_code: &str) {
        let conn = db.lock_conn();
        conn.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES (?1,?2,'n','argon2id',X'00',X'00',4096,2,1,?3,?3)",
            params![id, format!("GEN-{id}"), now()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO user_roles (user_id, role_id) SELECT ?1, id FROM roles WHERE code=?2",
            params![id, role_code],
        )
        .unwrap();
    }

    fn role_id_by_code(db: &Db, code: &str) -> String {
        db.lock_conn()
            .query_row("SELECT id FROM roles WHERE code=?1", params![code], |r| r.get(0))
            .unwrap()
    }

    fn keys_of_role(db: &Db, role_id: &str) -> Vec<String> {
        permission_keys_of_role(&db.lock_conn(), role_id).unwrap()
    }

    #[test]
    fn role_code_rules() {
        assert!(validate_code("auditor").is_ok());
        assert!(validate_code("a1_b-c").is_ok());
        assert!(matches!(validate_code("A"), Err(AppError::RoleCodeInvalid)));
        assert!(matches!(validate_code("1audit"), Err(AppError::RoleCodeInvalid)));
        assert!(matches!(validate_code("a"), Err(AppError::RoleCodeInvalid)));
        assert!(matches!(validate_code("bad code"), Err(AppError::RoleCodeInvalid)));
        assert!(matches!(validate_code("角色"), Err(AppError::RoleCodeInvalid)));
    }

    #[test]
    fn custom_role_can_be_created_updated_disabled_and_deleted() {
        let d = db();
        let id = create_role_db(&d, "auditor", "审计员", "只读审计").unwrap();
        let roles = query_roles_admin(&d.lock_conn()).unwrap();
        let role = roles.iter().find(|r| r.id == id).expect("新角色应出现在列表里");
        assert_eq!(role.name, "审计员");
        assert!(!role.builtin);
        assert_eq!(role.status, "active");

        update_role_db(&d, "bootstrap", &id, "审计员（改）", "说明", "disabled").unwrap();
        let roles = query_roles_admin(&d.lock_conn()).unwrap();
        let role = roles.iter().find(|r| r.id == id).unwrap();
        assert_eq!(role.name, "审计员（改）");
        assert_eq!(role.status, "disabled");

        delete_role_db(&d, &id).unwrap();
        assert!(query_roles_admin(&d.lock_conn()).unwrap().iter().all(|r| r.id != id));
    }

    #[test]
    fn builtin_role_metadata_and_delete_are_locked() {
        let d = db();
        let id = role_id_by_code(&d, "system_admin");
        assert!(matches!(
            update_role_db(&d, "bootstrap", &id, "改名", "", "active"),
            Err(AppError::RoleBuiltinImmutable)
        ));
        assert!(matches!(delete_role_db(&d, &id), Err(AppError::RoleBuiltinImmutable)));
    }

    #[test]
    fn role_in_use_cannot_be_deleted() {
        let d = db();
        let id = create_role_db(&d, "auditor", "审计员", "").unwrap();
        seed_user(&d, "u1", "auditor");
        assert!(matches!(delete_role_db(&d, &id), Err(AppError::RoleInUse)));
        assert!(query_roles_admin(&d.lock_conn()).unwrap().iter().any(|r| r.id == id), "被拒后角色必须还在");
    }

    #[test]
    fn permission_writes_are_type_scoped() {
        let d = db();
        let id = create_role_db(&d, "auditor", "审计员", "").unwrap();
        set_role_action_permissions_db(&d, "bootstrap", &id, &["accounts.read".into(), "system.audit.read".into()]).unwrap();
        set_role_menu_permissions_db(&d, "bootstrap", &id, &["menu.accounts".into()]).unwrap();
        let mut keys = keys_of_role(&d, &id);
        assert_eq!(keys, vec!["accounts.read".to_string(), "menu.accounts".to_string(), "system.audit.read".to_string()]);

        set_role_action_permissions_db(&d, "bootstrap", &id, &["accounts.create".into()]).unwrap();
        keys = keys_of_role(&d, &id);
        assert_eq!(keys, vec!["accounts.create".to_string(), "menu.accounts".to_string()]);
        assert!(matches!(
            set_role_action_permissions_db(&d, "bootstrap", &id, &["menu.accounts".into()]),
            Err(AppError::InvalidInput)
        ));
    }

    #[test]
    fn set_user_roles_replaces_the_whole_set() {
        let d = db();
        seed_user(&d, "actor", "system_admin");
        seed_user(&d, "target", "standard_user");
        set_user_roles_db(&d, "actor", "target", &["admin".into()]).unwrap();
        assert_eq!(rbac::roles_of(&d, "target").unwrap(), vec!["admin".to_string()]);

        assert!(matches!(set_user_roles_db(&d, "actor", "target", &[]), Err(AppError::InvalidInput)));
        assert!(matches!(set_user_roles_db(&d, "actor", "target", &["ghost".into()]), Err(AppError::NotFound)));
        assert!(matches!(set_user_roles_db(&d, "actor", "missing", &["admin".into()]), Err(AppError::NotFound)));
    }

    #[test]
    fn self_lockout_rolls_back_user_roles() {
        let d = db();
        seed_user(&d, "actor", "system_admin");
        let before = rbac::permission_keys(&d, "actor").unwrap();
        assert!(matches!(
            set_user_roles_db(&d, "actor", "actor", &["standard_user".into()]),
            Err(AppError::SelfLockout)
        ));
        assert_eq!(rbac::roles_of(&d, "actor").unwrap(), vec!["system_admin".to_string()]);
        assert_eq!(rbac::permission_keys(&d, "actor").unwrap(), before);
    }

    #[test]
    fn self_lockout_rolls_back_role_permissions() {
        let d = db();
        seed_user(&d, "bootstrap", "system_admin");
        let role_id = create_role_db(&d, "operator", "操作员", "").unwrap();
        set_role_action_permissions_db(
            &d,
            "bootstrap",
            &role_id,
            &["system.role.manage".into(), "system.user.read".into()],
        )
        .unwrap();
        set_role_menu_permissions_db(&d, "bootstrap", &role_id, &["menu.system".into()]).unwrap();
        seed_user(&d, "operator", "operator");

        assert!(matches!(
            set_role_action_permissions_db(&d, "operator", &role_id, &["system.user.read".into()]),
            Err(AppError::SelfLockout)
        ));
        let keys = keys_of_role(&d, &role_id);
        assert!(keys.iter().any(|k| k == "system.role.manage"), "回滚后操作权限必须保持原样");
    }

    #[test]
    fn disabled_role_revokes_permissions() {
        let d = db();
        seed_user(&d, "bootstrap", "system_admin");
        let role_id = create_role_db(&d, "reader", "只读", "").unwrap();
        set_role_action_permissions_db(&d, "bootstrap", &role_id, &["accounts.read".into()]).unwrap();
        set_role_menu_permissions_db(&d, "bootstrap", &role_id, &["menu.accounts".into()]).unwrap();
        seed_user(&d, "reader", "reader");
        assert!(rbac::permission_keys(&d, "reader").unwrap().iter().any(|k| k == "accounts.read"));

        update_role_db(&d, "bootstrap", &role_id, "只读", "", "disabled").unwrap();
        assert!(rbac::permission_keys(&d, "reader").unwrap().is_empty());
    }

    #[test]
    fn self_lockout_covers_the_permissions_page_node() {
        let d = db();
        seed_user(&d, "bootstrap", "system_admin");
        let role_id = create_role_db(&d, "operator", "操作员", "").unwrap();
        set_role_menu_permissions_db(
            &d,
            "bootstrap",
            &role_id,
            &["menu.system".into(), "menu.node.system.permissions".into()],
        )
        .unwrap();
        set_role_action_permissions_db(&d, "bootstrap", &role_id, &["system.role.manage".into()]).unwrap();
        seed_user(&d, "operator", "operator");

        assert!(matches!(
            set_role_menu_permissions_db(&d, "operator", &role_id, &["menu.system".into()]),
            Err(AppError::SelfLockout)
        ));
        let keys = keys_of_role(&d, &role_id);
        assert!(
            keys.iter().any(|k| k == "menu.node.system.permissions"),
            "被拒后权限管理入口必须保持原样"
        );
    }

    #[test]
    fn permission_catalog_contains_both_types() {
        let d = db();
        let rows = query_permissions(&d.lock_conn()).unwrap();
        assert!(rows.iter().any(|r| r.kind == "menu" && r.key == "menu.system"));
        assert!(rows.iter().any(|r| r.kind == "action" && r.key == "system.role.manage"));
        let nodes: i64 = d
            .lock_conn()
            .query_row("SELECT count(*) FROM menu_nodes", [], |r| r.get(0))
            .unwrap();
        let menus = rows.iter().filter(|r| r.kind == "menu").count();
        assert_eq!(menus as i64, nodes, "每个菜单节点都应有一枚菜单权限");
        assert_eq!(rows.len(), 40, "种子权限目录：16 菜单 + 24 操作");
    }
}
