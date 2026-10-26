//! RBAC：权限常量 + 后端强制校验。
//! 前端隐藏菜单只是体验优化，真正的拒绝必须发生在这里。

use crate::db::Db;
use crate::error::{AppError, Result};
use rusqlite::Connection;

pub mod perm {
    // 菜单
    pub const MENU_ACCOUNTS: &str = "menu.accounts";
    pub const MENU_SYSTEM: &str = "menu.system";
    pub const MENU_QUICK_LAUNCHER: &str = "menu.quick_launcher";
    /// 权限管理自己的入口（二级节点）。少了它，操作者无法回到本页撤销任何改动。
    pub const MENU_NODE_PERMISSIONS: &str = "menu.node.system.permissions";
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
    /// 开放入站端口是运维暴露面，单独授权：有「改更新源」不等于该让这台机器当分发点。
    pub const SYS_UPDATE_SERVE: &str = "system.update.serve";
}

/// 当前使用者的全部权限键（菜单 + 操作）。
/// 停用角色、停用使用者、软删使用者都不授予任何权限。
pub fn permission_keys_conn(conn: &Connection, user_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.permission_key
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
           JOIN app_users u ON u.id = ur.user_id
         WHERE ur.user_id=?1 AND r.status='active'
           AND u.status='active' AND u.deleted_at IS NULL
         ORDER BY p.permission_key",
    )?;
    let v = stmt
        .query_map(rusqlite::params![user_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn permission_keys(db: &Db, user_id: &str) -> Result<Vec<String>> {
    let conn = db.lock_conn();
    permission_keys_conn(&conn, user_id)
}

pub fn has_permission_conn(conn: &Connection, user_id: &str, permission_key: &str) -> Result<bool> {
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

pub fn has_permission(db: &Db, user_id: &str, permission_key: &str) -> Result<bool> {
    let conn = db.lock_conn();
    has_permission_conn(&conn, user_id, permission_key)
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
    fn admin_has_menu_and_action_permissions() {
        let d = db();
        seed(&d, "u1", "system_admin");
        let keys = permission_keys(&d, "u1").unwrap();
        for key in [perm::MENU_ACCOUNTS, perm::MENU_SYSTEM, perm::MENU_QUICK_LAUNCHER, perm::SYS_ROLE_MANAGE, perm::ACC_EXPORT] {
            assert!(keys.iter().any(|k| k == key), "system_admin 应包含 {key}");
        }
    }

    #[test]
    fn standard_user_has_no_system_menu_or_role_management() {
        let d = db();
        seed(&d, "u2", "standard_user");
        let keys = permission_keys(&d, "u2").unwrap();
        assert!(keys.iter().any(|k| k == perm::MENU_ACCOUNTS));
        assert!(keys.iter().any(|k| k == perm::MENU_QUICK_LAUNCHER));
        assert!(!keys.iter().any(|k| k == perm::MENU_SYSTEM));
        assert!(!keys.iter().any(|k| k == perm::SYS_ROLE_MANAGE));
        assert!(matches!(require(&d, "u2", perm::MENU_SYSTEM), Err(AppError::Forbidden)));
        assert!(!has_permission(&d, "u2", perm::ACC_EXPORT).unwrap());
        assert!(has_permission(&d, "u2", perm::ACC_CREATE).unwrap());
    }

    #[test]
    fn disabled_role_grants_nothing() {
        let d = db();
        seed(&d, "u2", "standard_user");
        d.lock_conn().execute("UPDATE roles SET status='disabled' WHERE code='standard_user'", []).unwrap();
        assert!(permission_keys(&d, "u2").unwrap().is_empty());
        assert!(!has_permission(&d, "u2", perm::MENU_ACCOUNTS).unwrap());
    }

    #[test]
    fn disabled_user_loses_all_permissions() {
        let d = db();
        seed(&d, "u3", "system_admin");
        assert!(has_permission(&d, "u3", perm::MENU_SYSTEM).unwrap());
        d.lock_conn().execute("UPDATE app_users SET status='disabled' WHERE id='u3'", []).unwrap();
        assert!(permission_keys(&d, "u3").unwrap().is_empty());
        assert!(!has_permission(&d, "u3", perm::MENU_SYSTEM).unwrap());
    }

    #[test]
    fn soft_deleted_user_loses_all_permissions() {
        let d = db();
        seed(&d, "u4", "system_admin");
        d.lock_conn().execute("UPDATE app_users SET deleted_at=?1 WHERE id='u4'", rusqlite::params![now_stub()]).unwrap();
        assert!(permission_keys(&d, "u4").unwrap().is_empty());
        assert!(!has_permission(&d, "u4", perm::MENU_SYSTEM).unwrap());
    }

    #[test]
    fn unknown_user_has_no_permissions() {
        let d = db();
        assert!(permission_keys(&d, "ghost").unwrap().is_empty());
        assert!(!has_permission(&d, "ghost", perm::ACC_READ).unwrap());
    }
}
