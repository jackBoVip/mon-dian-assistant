//! RBAC：权限常量 + 后端强制校验。
//! 前端隐藏菜单只是体验优化，真正的拒绝必须发生在这里。

use crate::db::Db;
use crate::error::{AppError, Result};
use rusqlite::OptionalExtension;

pub mod perm {
    // 菜单
    pub const MENU_ACCOUNTS: &str = "menu.accounts";
    pub const MENU_SYSTEM: &str = "menu.system";
    pub const MENU_QUICK_LAUNCHER: &str = "menu.quick_launcher";
    // 账号台账（外部系统凭据）
    pub const ACC_READ: &str = "accounts.read";
    pub const ACC_CREATE: &str = "accounts.create";
    pub const ACC_UPDATE: &str = "accounts.update";
    pub const ACC_DISABLE: &str = "accounts.disable";
    pub const ACC_DELETE: &str = "accounts.delete";
    pub const ACC_VIEW_SECRET: &str = "accounts.view_secret";
    pub const ACC_COPY_PASSWORD: &str = "accounts.copy_password";
    pub const ACC_AUTOFILL: &str = "accounts.autofill";
    pub const ACC_SET_DEFAULT: &str = "accounts.set_default";
    pub const ACC_IMPORT: &str = "accounts.import";
    pub const ACC_EXPORT: &str = "accounts.export";
    // 系统管理（本软件自身）
    pub const SYS_USER_READ: &str = "system.user.read";
    pub const SYS_USER_MANAGE: &str = "system.user.manage";
    pub const SYS_ROLE_MANAGE: &str = "system.role.manage";
    pub const SYS_SECURITY: &str = "system.security.config";
    pub const SYS_AUDIT_READ: &str = "system.audit.read";
    pub const SYS_BACKUP: &str = "system.backup.manage";
    pub const SYS_UPDATE_INSTALL: &str = "system.update.install";
    pub const SYS_UPDATE_CONFIG: &str = "system.update.config";
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuEntry {
    pub key: String,
    pub label: String,
    pub order: i64,
}

/// 左侧菜单：第一项账号管理，第二项系统管理，顺序固定。
pub fn visible_menus(db: &Db, user_id: &str) -> Result<Vec<MenuEntry>> {
    let all = vec![
        (perm::MENU_ACCOUNTS, "账号管理", 1),
        (perm::MENU_SYSTEM, "系统管理", 2),
    ];
    let mut out = Vec::new();
    for (key, label, order) in all {
        if has_permission(db, user_id, key)? {
            out.push(MenuEntry { key: key.to_string(), label: label.to_string(), order });
        }
    }
    Ok(out)
}

pub fn has_permission(db: &Db, user_id: &str, permission_key: &str) -> Result<bool> {
    let conn = db.lock_conn();
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
           JOIN permissions p ON p.id = rp.permission_id
           JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id=?1 AND p.permission_key=?2 AND r.status='active'
           AND ur.user_id IN (SELECT id FROM app_users WHERE status='active' AND deleted_at IS NULL)",
        rusqlite::params![user_id, permission_key],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 未授权即返回 Forbidden，由调用方写入审计。
pub fn require(db: &Db, user_id: &str, permission_key: &str) -> Result<()> {
    if has_permission(db, user_id, permission_key)? {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

pub fn roles_of(db: &Db, user_id: &str) -> Result<Vec<String>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare("SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?1")?;
    let v = stmt.query_map(rusqlite::params![user_id], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn is_member_of(db: &Db, user_id: &str, role_code: &str) -> Result<bool> {
    let conn = db.lock_conn();
    let n: Option<i64> = conn.query_row(
        "SELECT count(*) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?1 AND r.code=?2",
        rusqlite::params![user_id, role_code],
        |r| r.get(0),
    ).optional()?;
    Ok(n.unwrap_or(0) > 0)
}

pub fn assign_role(db: &Db, user_id: &str, role_code: &str) -> Result<()> {
    let conn = db.lock_conn();
    let role_id: Option<String> = conn.query_row("SELECT id FROM roles WHERE code=?1", rusqlite::params![role_code], |r| r.get(0)).optional()?;
    let role_id = role_id.ok_or(AppError::NotFound)?;
    conn.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?1,?2)", rusqlite::params![user_id, role_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repo::now as now_stub;
    use crate::db::Db;

    fn seed(db: &Db, id: &str, role: &str) {
        let conn = db.lock_conn();
        conn.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES (?1,?2,'n','argon2id',X'00',X'00',4096,2,1,?3,?3)",
            rusqlite::params![id, format!("GEN-{id}"), now_stub()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO user_roles (user_id, role_id) SELECT ?1, id FROM roles WHERE code=?2",
            rusqlite::params![id, role],
        )
        .unwrap();
    }

    fn db() -> Db {
        Db::open_in_memory(&vec![21u8; 32]).unwrap()
    }

    #[test]
    fn admin_sees_both_menus_in_order() {
        let d = db();
        seed(&d, "u1", "system_admin");
        let menus = visible_menus(&d, "u1").unwrap();
        assert_eq!(menus.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(), vec!["账号管理", "系统管理"]);
    }

    #[test]
    fn standard_user_cannot_see_system_menu() {
        let d = db();
        seed(&d, "u2", "standard_user");
        let menus = visible_menus(&d, "u2").unwrap();
        assert_eq!(menus.len(), 1);
        assert_eq!(menus[0].key, perm::MENU_ACCOUNTS);
        assert!(!has_permission(&d, "u2", perm::MENU_SYSTEM).unwrap());
        assert!(matches!(require(&d, "u2", perm::MENU_SYSTEM), Err(AppError::Forbidden)));
    }

    #[test]
    fn standard_user_cannot_export_or_install_updates() {
        let d = db();
        seed(&d, "u2", "standard_user");
        assert!(!has_permission(&d, "u2", perm::ACC_EXPORT).unwrap());
        assert!(!has_permission(&d, "u2", perm::SYS_UPDATE_INSTALL).unwrap());
        assert!(has_permission(&d, "u2", perm::ACC_CREATE).unwrap());
    }

    #[test]
    fn disabled_user_loses_all_permissions() {
        let d = db();
        seed(&d, "u3", "system_admin");
        assert!(has_permission(&d, "u3", perm::MENU_SYSTEM).unwrap());
        d.lock_conn().execute("UPDATE app_users SET status='disabled' WHERE id='u3'", []).unwrap();
        assert!(!has_permission(&d, "u3", perm::MENU_SYSTEM).unwrap());
    }

    #[test]
    fn unknown_user_has_no_permissions() {
        let d = db();
        assert!(!has_permission(&d, "ghost", perm::ACC_READ).unwrap());
    }
}
