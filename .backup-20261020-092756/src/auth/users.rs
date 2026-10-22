//! 本地使用者（App User）生命周期：初始化、解锁、改密、管理员重置。
//! 这里管理的是**本软件的解锁身份**，与账号台账中的外部系统凭据完全分开。

use super::lockout;
use super::policy;
use crate::audit;
use crate::crypto::kdf::KdfParams;
use crate::crypto::vault_key::{self, VaultKey};
use crate::crypto::CryptoError;
use crate::db::repo::now;
use crate::db::Db;
use crate::error::{AppError, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUserSummary {
    pub id: String,
    pub nickname: String,
    pub status: String,
    pub roles: Vec<String>,
    pub last_login_at: Option<String>,
    pub created_at: String,
    /// 内部标识仅供系统管理页展示，任何登录/解锁流程都不要求用户输入它
    pub generated_account_code: String,
}

struct UserRecord {
    id: String,
    verify_salt: Vec<u8>,
    verify_hash: Vec<u8>,
    wrap_salt: Vec<u8>,
    wrap_nonce: Vec<u8>,
    wrapped_dek: Vec<u8>,
    key_version: i64,
    kdf: KdfParams,
    failed_login_count: i64,
    locked_until: Option<String>,
}

fn load_user(conn: &rusqlite::Connection, user_id: &str) -> Result<Option<UserRecord>> {
    Ok(conn
        .query_row(
            "SELECT u.id, u.pwd_verify_salt, u.pwd_verify_hash,
                    w.wrap_salt, w.wrap_nonce, w.wrapped_dek, w.key_version,
                    u.pwd_kdf_m_kib, u.pwd_kdf_t, u.pwd_kdf_p, u.failed_login_count, u.locked_until
             FROM app_users u
             JOIN user_key_wrappers w ON w.app_user_id = u.id
             WHERE u.id=?1 AND u.deleted_at IS NULL
             ORDER BY w.key_version DESC LIMIT 1",
            params![user_id],
            |r| {
                Ok(UserRecord {
                    id: r.get(0)?,
                    verify_salt: r.get(1)?,
                    verify_hash: r.get(2)?,
                    wrap_salt: r.get(3)?,
                    wrap_nonce: r.get(4)?,
                    wrapped_dek: r.get(5)?,
                    key_version: r.get(6)?,
                    kdf: KdfParams { m_kib: r.get(7)?, t: r.get(8)?, p: r.get(9)? },
                    failed_login_count: r.get(10)?,
                    locked_until: r.get(11)?,
                })
            },
        )
        .optional()?)
}

/// 昵称上限（字符数，不是字节数）。同一枚常量也管首启时按设备名生成的那个昵称，
/// 两边共用一个数才不会出现在 A 处存得下、在 B 处被判过长的情况。
pub const NICKNAME_MAX_CHARS: usize = 40;

pub fn is_initialized(db: &Db) -> Result<bool> {
    let conn = db.lock_conn();
    let n: i64 = conn.query_row("SELECT count(*) FROM app_users WHERE deleted_at IS NULL", [], |r| r.get(0))?;
    Ok(n > 0)
}

pub fn user_count(db: &Db) -> Result<i64> {
    let conn = db.lock_conn();
    Ok(conn.query_row("SELECT count(*) FROM app_users WHERE status='active' AND deleted_at IS NULL", [], |r| r.get(0))?)
}

/// 首次初始化：只需要昵称 + 主密码。内部 ID 与账号标识由系统生成。
/// 首位使用者自动成为 system_admin（保险库所有者）。
pub fn initialize(db: &Db, nickname: &str, password: &str) -> Result<(String, VaultKey)> {
    if is_initialized(db)? {
        return Err(AppError::AlreadyInitialized);
    }
    let nickname = nickname.trim();
    if nickname.is_empty() {
        return Err(AppError::NicknameRequired);
    }
    policy::require_non_empty(password)?;
    let params_kdf = KdfParams::default();
    let user_id = uuid::Uuid::now_v7().to_string();
    let (vk, material) = vault_key::initialize(password, &user_id, 1, &params_kdf)?;
    let code = generated_code();
    let ts = now();

    {
        let conn = db.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,status,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,
                                    pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,failed_login_count,created_at,updated_at)
             VALUES (?1,?2,?3,'active','argon2id',?4,?5,?6,?7,?8,0,?9,?9)",
            params![
                user_id, code, nickname, material.verify_salt, material.verify_hash,
                material.kdf_m_kib, material.kdf_t, material.kdf_p, ts
            ],
        )?;
        tx.execute(
            "INSERT INTO user_key_wrappers (app_user_id,key_version,wrap_alg,wrap_salt,wrap_nonce,wrapped_dek,aad,created_at)
             VALUES (?1,1,'AES-256-GCM',?2,?3,?4,?5,?6)",
            params![user_id, material.wrap_salt, material.wrap_nonce, material.wrapped_dek, material.aad, ts],
        )?;
        tx.execute("INSERT OR IGNORE INTO key_metadata (key_version,status,created_at) VALUES (1,'active',?1)", params![ts])?;
        tx.execute(
            "INSERT INTO user_roles (user_id, role_id) SELECT ?1, id FROM roles WHERE code='system_admin'",
            params![user_id],
        )?;
        tx.commit()?;
    }
    audit::record(db, Some(&user_id), "vault.initialize", Some("app_user"), Some(&user_id), "success", None, Some("app"))?;
    Ok((user_id, vk))
}

/// 系统生成的内部账号标识，用户无需知道或输入。
fn generated_code() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let body: String = (0..8).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect();
    format!("MDA-{body}")
}

/// 解锁页所需信息：单使用者时只输入密码，多使用者时先选昵称/头像。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProfile {
    pub initialized: bool,
    pub single_user: bool,
    pub users: Vec<AppUserSummary>,
}

pub fn login_profile(db: &Db) -> Result<LoginProfile> {
    let users = list_users(db)?;
    Ok(LoginProfile { initialized: !users.is_empty(), single_user: users.len() == 1, users })
}

pub fn list_users(db: &Db) -> Result<Vec<AppUserSummary>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT u.id, u.nickname, u.status, u.last_login_at, u.created_at, u.generated_account_code
         FROM app_users u WHERE u.deleted_at IS NULL ORDER BY u.created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AppUserSummary {
                id: r.get(0)?,
                nickname: r.get(1)?,
                status: r.get(2)?,
                last_login_at: r.get(3)?,
                created_at: r.get(4)?,
                generated_account_code: r.get(5)?,
                roles: vec![],
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut out = rows;
    for u in out.iter_mut() {
        u.roles = roles_of(&conn, &u.id)?;
    }
    Ok(out)
}

fn roles_of(conn: &rusqlite::Connection, user_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?1")?;
    let v = stmt.query_map(params![user_id], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockOutcome {
    pub user: AppUserSummary,
    pub session_token: String,
}

/// 校验主密码并返回解锁后的密钥。失败时更新计数与锁定，并写审计（不记录密码）。
pub fn unlock(db: &Db, user_id: &str, password: &str, max_attempts: i64, lockout_seconds: i64) -> Result<VaultKey> {
    let now_ts = chrono::Utc::now().timestamp();
    let rec = {
        let conn = db.lock_conn();
        load_user(&conn, user_id)?.ok_or(AppError::NotFound)?
    };
    let status = lockout::evaluate(rec.failed_login_count, rec.locked_until.as_deref(), max_attempts, now_ts);
    if status.locked {
        audit::record(db, Some(user_id), "auth.unlock", Some("app_user"), Some(user_id), "denied", Some("TOO_MANY_ATTEMPTS"), Some("app"))?;
        return Err(AppError::TooManyAttempts);
    }
    let result = vault_key::unlock(
        password,
        &rec.id,
        rec.key_version,
        &rec.verify_salt,
        &rec.verify_hash,
        &rec.wrap_salt,
        &rec.wrap_nonce,
        &rec.wrapped_dek,
        &rec.kdf,
    );
    match result {
        Ok(vk) => {
            let conn = db.lock_conn();
            conn.execute(
                "UPDATE app_users SET failed_login_count=0, locked_until=NULL, last_login_at=?1, updated_at=?1 WHERE id=?2",
                params![now(), user_id],
            )?;
            drop(conn);
            audit::record(db, Some(user_id), "auth.unlock", Some("app_user"), Some(user_id), "success", None, Some("app"))?;
            Ok(vk)
        }
        Err(e) => {
            let is_auth = matches!(e, CryptoError::AuthenticationFailed);
            let conn = db.lock_conn();
            let new_count = rec.failed_login_count + 1;
            let locked = is_auth && lockout::should_lock(new_count, max_attempts);
            conn.execute(
                "UPDATE app_users SET failed_login_count=?1, locked_until=?2, updated_at=?3 WHERE id=?4",
                params![new_count, if locked { Some(lockout::locked_until_rfc3339(now_ts, lockout_seconds)) } else { None }, now(), user_id],
            )?;
            drop(conn);
            audit::record(db, Some(user_id), "auth.unlock", Some("app_user"), Some(user_id), "failure", Some(if locked { "LOCKED" } else { "WRONG_PASSWORD" }), Some("app"))?;
            // 对外统一提示，不泄露该使用者是否存在
            if locked {
                Err(AppError::TooManyAttempts)
            } else {
                Err(AppError::WrongPassword)
            }
        }
    }
}

/// 修改主密码：DEK 不变，只重封装，因此已有台账保持可解密。
pub fn change_password(db: &Db, user_id: &str, current: &str, new: &str) -> Result<VaultKey> {
    policy::require_non_empty(new)?;
    let rec = {
        let conn = db.lock_conn();
        load_user(&conn, user_id)?.ok_or(AppError::NotFound)?
    };
    let (vk, material) = vault_key::change_password(
        current,
        new,
        &rec.id,
        rec.key_version,
        &rec.verify_salt,
        &rec.verify_hash,
        &rec.wrap_salt,
        &rec.wrap_nonce,
        &rec.wrapped_dek,
        &rec.kdf,
    )?;
    let ts = now();
    {
        let conn = db.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE app_users SET pwd_verify_salt=?1, pwd_verify_hash=?2, pwd_kdf_m_kib=?3, pwd_kdf_t=?4, pwd_kdf_p=?5, updated_at=?6 WHERE id=?7",
            params![material.verify_salt, material.verify_hash, material.kdf_m_kib, material.kdf_t, material.kdf_p, ts, user_id],
        )?;
        tx.execute(
            "INSERT INTO user_key_wrappers (app_user_id,key_version,wrap_alg,wrap_salt,wrap_nonce,wrapped_dek,aad,created_at)
             VALUES (?1,?2,'AES-256-GCM',?3,?4,?5,?6,?7)
             ON CONFLICT(app_user_id,key_version) DO UPDATE SET wrap_salt=excluded.wrap_salt, wrap_nonce=excluded.wrap_nonce,
               wrapped_dek=excluded.wrapped_dek, aad=excluded.aad, created_at=excluded.created_at",
            params![user_id, rec.key_version, material.wrap_salt, material.wrap_nonce, material.wrapped_dek, material.aad, ts],
        )?;
        tx.commit()?;
    }
    audit::record(db, Some(user_id), "auth.change_password", Some("app_user"), Some(user_id), "success", None, Some("app"))?;
    Ok(vk)
}

/// 改自己的昵称：只动显示名。绝不碰 pwd_* 验证材料与密钥封装，所以改名之后
/// 旧主密码照常能解锁，已加密的台账照常能解密。
pub fn update_nickname(db: &Db, user_id: &str, nickname: &str) -> Result<()> {
    let nickname = nickname.trim();
    if nickname.is_empty() {
        return Err(AppError::NicknameRequired);
    }
    if nickname.chars().count() > NICKNAME_MAX_CHARS {
        return Err(AppError::NicknameTooLong);
    }
    let changed = {
        let conn = db.lock_conn();
        conn.execute(
            "UPDATE app_users SET nickname=?1, updated_at=?2 WHERE id=?3 AND deleted_at IS NULL",
            params![nickname, now(), user_id],
        )?
    };
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// 管理员重置其他使用者密码。要求管理员已在已解锁上下文中提供 DEK，
/// 用同一 DEK 为该使用者重新封装——绝不出现「改了哈希但数据密钥不可用」。
pub fn admin_reset_password(db: &Db, admin_id: &str, target_user_id: &str, new_password: &str, current_dek: &VaultKey) -> Result<()> {
    policy::require_non_empty(new_password)?;
    if admin_id == target_user_id {
        return Err(AppError::Forbidden);
    }
    let next_version: i64 = {
        let conn = db.lock_conn();
        let exists: i64 = conn.query_row("SELECT count(*) FROM app_users WHERE id=?1 AND deleted_at IS NULL", params![target_user_id], |r| r.get(0))?;
        if exists == 0 {
            return Err(AppError::NotFound);
        }
        let v: Option<i64> = conn
            .query_row("SELECT MAX(key_version) FROM user_key_wrappers WHERE app_user_id=?1", params![target_user_id], |r| r.get(0))
            .optional()?;
        v.unwrap_or(0) + 1
    };
    let p = KdfParams::default();
    let material = vault_key::wrap_dek(new_password, target_user_id, next_version, &current_dek.dek, &p)?;
    let ts = now();
    {
        let conn = db.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE app_users SET pwd_verify_salt=?1, pwd_verify_hash=?2, pwd_kdf_m_kib=?3, pwd_kdf_t=?4, pwd_kdf_p=?5,
                    failed_login_count=0, locked_until=NULL, updated_at=?6 WHERE id=?7",
            params![material.verify_salt, material.verify_hash, material.kdf_m_kib, material.kdf_t, material.kdf_p, ts, target_user_id],
        )?;
        tx.execute(
            "INSERT INTO user_key_wrappers (app_user_id,key_version,wrap_alg,wrap_salt,wrap_nonce,wrapped_dek,aad,created_at)
             VALUES (?1,?2,'AES-256-GCM',?3,?4,?5,?6,?7)",
            params![target_user_id, next_version, material.wrap_salt, material.wrap_nonce, material.wrapped_dek, material.aad, ts],
        )?;
        tx.commit()?;
    }
    audit::record(db, Some(admin_id), "auth.admin_reset", Some("app_user"), Some(target_user_id), "success", None, Some("app"))?;
    Ok(())
}

/// 新增本地使用者（管理员操作）。内部 ID 自动生成，界面不出现用户名输入框。
pub fn create_app_user(db: &Db, admin_id: &str, nickname: &str, initial_password: &str, role_code: &str, dek: &VaultKey) -> Result<String> {
    if nickname.trim().is_empty() {
        return Err(AppError::NicknameRequired);
    }
    policy::require_non_empty(initial_password)?;
    let user_id = uuid::Uuid::now_v7().to_string();
    let p = KdfParams::default();
    let material = vault_key::wrap_dek(initial_password, &user_id, 1, &dek.dek, &p)?;
    let ts = now();
    {
        let conn = db.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,status,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,
                                    pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES (?1,?2,?3,'active','argon2id',?4,?5,?6,?7,?8,?9,?9)",
            params![user_id, generated_code(), nickname.trim(), material.verify_salt, material.verify_hash, material.kdf_m_kib, material.kdf_t, material.kdf_p, ts],
        )?;
        tx.execute(
            "INSERT INTO user_key_wrappers (app_user_id,key_version,wrap_alg,wrap_salt,wrap_nonce,wrapped_dek,aad,created_at)
             VALUES (?1,1,'AES-256-GCM',?2,?3,?4,?5,?6)",
            params![user_id, material.wrap_salt, material.wrap_nonce, material.wrapped_dek, material.aad, ts],
        )?;
        let linked = tx.execute(
            "INSERT INTO user_roles (user_id, role_id) SELECT ?1, id FROM roles WHERE code=?2",
            params![user_id, role_code],
        )?;
        if linked == 0 {
            return Err(AppError::NotFound);
        }
        tx.commit()?;
    }
    audit::record(db, Some(admin_id), "system.user.create", Some("app_user"), Some(&user_id), "success", None, Some("app"))?;
    Ok(user_id)
}

pub fn status_of(db: &Db, user_id: &str) -> Result<lockout::LockoutStatus> {
    // 必须先读设置再取连接锁：settings::get 内部同样要锁 conn，同线程重入会永久死锁。
    let max = crate::settings::get_i64(db, "max_failed_login_attempts", 5);
    let rec = {
        let conn = db.lock_conn();
        load_user(&conn, user_id)?.ok_or(AppError::NotFound)?
    };
    Ok(lockout::evaluate(rec.failed_login_count, rec.locked_until.as_deref(), max, chrono::Utc::now().timestamp()))
}

/// 二次认证：复用同一套 Argon2id 校验与失败计数/锁定策略，只验证不重建索引。
pub fn verify_master_password(db: &Db, user_id: &str, password: &str, max_attempts: i64, lockout_seconds: i64) -> Result<()> {
    let vk = unlock(db, user_id, password, max_attempts, lockout_seconds)?;
    let same = {
        let conn = db.lock_conn();
        let v: i64 = conn.query_row("SELECT key_version FROM app_users WHERE id=?1", params![user_id], |r| r.get(0))?;
        v == vk.key_version
    };
    drop(vk);
    if same {
        Ok(())
    } else {
        Err(AppError::Internal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory(&vec![41u8; 32]).unwrap()
    }

    #[test]
    fn initialize_requires_only_nickname_and_password() {
        let d = db();
        assert!(!is_initialized(&d).unwrap());
        let (uid, _vk) = initialize(&d, "周红波", "MengDian#2026x").unwrap();
        assert!(is_initialized(&d).unwrap());
        let prof = login_profile(&d).unwrap();
        assert!(prof.initialized);
        assert!(prof.single_user);
        assert_eq!(prof.users[0].nickname, "周红波");
        // 内部标识由系统生成，非用户输入
        assert!(prof.users[0].generated_account_code.starts_with("MDA-"));
        assert!(prof.users[0].roles.contains(&"system_admin".to_string()));
        assert!(!uid.is_empty());
    }

    #[test]
    fn second_initialize_is_refused() {
        let d = db();
        initialize(&d, "a", "MengDian#2026x").unwrap();
        assert!(matches!(initialize(&d, "b", "MengDian#2026y"), Err(AppError::AlreadyInitialized)));
    }

    /// L 轮口径：建库只要求口令非空。"short" 这类口令以前会被策略拒掉，现在必须能建库；
    /// 空口令仍然不行，且失败时不得留下半成品库。
    #[test]
    fn accepts_any_non_empty_password_and_requires_nickname() {
        let d = db();
        assert!(initialize(&d, "a", "short").is_ok(), "短口令应能建库（策略已于 L 轮取消）");
        let d = db();
        assert!(matches!(initialize(&d, "a", ""), Err(AppError::WeakPassword(_))));
        assert!(matches!(initialize(&d, "a", "   "), Err(AppError::WeakPassword(_))));
        assert!(matches!(initialize(&d, "   ", "MengDian#2026x"), Err(AppError::NicknameRequired)));
        assert!(!is_initialized(&d).unwrap());
    }

    #[test]
    fn no_default_admin_credentials_exist() {
        let d = db();
        initialize(&d, "owner", "MengDian#2026x").unwrap();
        let conn = d.lock_conn();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM app_users WHERE nickname IN ('admin','Administrator','root','test')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn unlock_with_correct_and_wrong_password() {
        let d = db();
        let (uid, _) = initialize(&d, "owner", "MengDian#2026x").unwrap();
        assert!(unlock(&d, &uid, "MengDian#2026x", 5, 300).is_ok());
        assert!(matches!(unlock(&d, &uid, "wrong-password-1", 5, 300), Err(AppError::WrongPassword)));
        assert!(matches!(unlock(&d, &uid, "wrong-password-1", 5, 300), Err(AppError::WrongPassword)));
        let st = status_of(&d, &uid).unwrap();
        assert_eq!(st.failed_count, 2);
        assert!(unlock(&d, &uid, "MengDian#2026x", 5, 300).is_ok());
        assert_eq!(status_of(&d, &uid).unwrap().failed_count, 0);
    }

    #[test]
    fn lockout_after_max_attempts_then_recovers() {
        let d = db();
        let (uid, _) = initialize(&d, "owner", "MengDian#2026x").unwrap();
        for _ in 0..5 {
            let _ = unlock(&d, &uid, "bad-password-here", 5, 3600);
        }
        assert!(matches!(unlock(&d, &uid, "MengDian#2026x", 5, 3600), Err(AppError::TooManyAttempts)));
        assert!(status_of(&d, &uid).unwrap().locked);
        // 解锁窗口过期后正确密码可用
        d.lock_conn().execute("UPDATE app_users SET locked_until=NULL, failed_login_count=0 WHERE id=?1", params![uid]).unwrap();
        assert!(unlock(&d, &uid, "MengDian#2026x", 5, 3600).is_ok());
    }

    #[test]
    fn change_password_keeps_vault_decryptable() {
        let d = db();
        let (uid, vk) = initialize(&d, "owner", "MengDian#2026x").unwrap();
        let target = crate::db::repo::create_target(
            &d, &vk, &uid,
            &crate::db::repo::NewTarget {
                target_type: "web".into(),
                display_name: "OA".into(),
                group_id: None,
                meta: crate::db::repo::TargetSecretPayload { url: "https://oa.nmgdl.cn".into(), ..Default::default() },
            },
        )
        .unwrap();
        let item = crate::db::repo::create_item(
            &d, &vk, &uid,
            &crate::db::repo::NewItem {
                target_id: target,
                account_alias: "日常办公".into(),
                tags: vec![],
                favorite: false,
                payload: crate::db::repo::CredentialPayload {
                    username: "zhangsan".into(),
                    password: crate::crypto::SecretString::new("Ext#Pass1"),
                    ..Default::default()
                },
                set_as_default: false,
            },
        )
        .unwrap();

        let vk2 = change_password(&d, &uid, "MengDian#2026x", "NewMengDian#2027").unwrap();
        // 旧密码失效，新密码可解锁
        assert!(unlock(&d, &uid, "MengDian#2026x", 5, 300).is_err());
        assert!(unlock(&d, &uid, "NewMengDian#2027", 5, 300).is_ok());
        // 已有台账在新密码下仍可解密
        let p = crate::db::repo::item_payload(&vk2, &d, &item).unwrap();
        assert_eq!(p.password.expose(), "Ext#Pass1");
        assert_eq!(p.username, "zhangsan");
    }

    #[test]
    fn admin_reset_keeps_target_decryptable_for_that_user() {
        let d = db();
        let (admin_id, vk) = initialize(&d, "管理员", "Admin#Pass2026").unwrap();
        let user_id = create_app_user(&d, &admin_id, "张三", "Zhang#Pass2026", "standard_user", &vk).unwrap();
        assert_eq!(user_count(&d).unwrap(), 2);
        // 新使用者用初始密码解锁得到同一 DEK
        let vk_user = unlock(&d, &user_id, "Zhang#Pass2026", 5, 300).unwrap();
        assert_eq!(vk_user.dek.as_slice(), vk.dek.as_slice());
        // 重置后旧密码不可用，新密码可用，且 DEK 不变
        admin_reset_password(&d, &admin_id, &user_id, "Reset#Pass99", &vk).unwrap();
        assert!(unlock(&d, &user_id, "Zhang#Pass2026", 5, 300).is_err());
        let vk_after = unlock(&d, &user_id, "Reset#Pass99", 5, 300).unwrap();
        assert_eq!(vk_after.dek.as_slice(), vk.dek.as_slice());
    }

    #[test]
    fn duplicate_nicknames_are_allowed_and_ids_stay_unique() {
        let d = db();
        let (admin_id, vk) = initialize(&d, "张三", "Admin#Pass2026").unwrap();
        let b = create_app_user(&d, &admin_id, "张三", "Other#Pass2026", "standard_user", &vk).unwrap();
        let users = list_users(&d).unwrap();
        assert_eq!(users.len(), 2);
        assert_eq!(users.iter().filter(|u| u.nickname == "张三").count(), 2, "昵称允许重复");
        assert_ne!(admin_id, b);
        assert_ne!(users[0].generated_account_code, users[1].generated_account_code);
    }

    #[test]
    fn login_profile_never_exposes_password_material() {
        let d = db();
        initialize(&d, "owner", "MengDian#2026x").unwrap();
        let json = serde_json::to_string(&login_profile(&d).unwrap()).unwrap();
        for forbidden in ["pwd_verify", "wrapped_dek", "salt", "MengDian#2026x"] {
            assert!(!json.contains(forbidden), "登录页资料不得包含 {forbidden}");
        }
    }

    /// 个人信息页改昵称：改名要同时出现在解锁页（login_profile）、系统管理列表（list_users）
    /// 与 AppStatus 取名的那条查询里；内部标识与主密码材料一条都不许动。
    #[test]
    fn own_nickname_change_reaches_every_display_and_keeps_credentials() {
        let d = db();
        let (uid, vk) = initialize(&d, "本机用户", "MengDian#2026x").unwrap();
        update_nickname(&d, &uid, "周红波").unwrap();

        assert_eq!(login_profile(&d).unwrap().users[0].nickname, "周红波");
        assert_eq!(list_users(&d).unwrap()[0].nickname, "周红波");
        let conn = d.lock_conn();
        let code: String = conn
            .query_row("SELECT generated_account_code FROM app_users WHERE id=?1", params![uid], |r| r.get(0))
            .unwrap();
        drop(conn);
        assert!(code.starts_with("MDA-"), "改名不能动系统生成的内部标识");
        // 主密码仍然认得，且解出来的 DEK 与改名前逐字节相同：昵称只是显示名，
        // 一次写错列的 UPDATE 会让这个人永久解不开自己的库，所以这一条比"名字变了"更该被钉住。
        let vk_after = unlock(&d, &uid, "MengDian#2026x", 5, 300).unwrap();
        assert_eq!(vk_after.dek.as_slice(), vk.dek.as_slice(), "改名不得触碰密钥封装");
    }

    /// 空白昵称不接受（与 initialize 同一道防线），超长昵称要停下——
    /// 界面按 40 个字排版，写进去只会让解锁页那一行被省略号吃掉的字段看不见。
    #[test]
    fn nickname_change_rejects_blank_and_overlong() {
        let d = db();
        let (uid, _) = initialize(&d, "本机用户", "MengDian#2026x").unwrap();
        assert!(matches!(update_nickname(&d, &uid, "   "), Err(AppError::NicknameRequired)));
        assert!(matches!(
            update_nickname(&d, &uid, &"字".repeat(NICKNAME_MAX_CHARS + 1)),
            Err(AppError::NicknameTooLong)
        ));
        assert_eq!(login_profile(&d).unwrap().users[0].nickname, "本机用户", "两次失败都不该落库");

        // 恰好到上限可以存，前后空白存进去会被去掉
        update_nickname(&d, &uid, &format!("  {}  ", "字".repeat(NICKNAME_MAX_CHARS))).unwrap();
        assert_eq!(login_profile(&d).unwrap().users[0].nickname.chars().count(), NICKNAME_MAX_CHARS);

        // 改的是一个不存在/已删除的使用者：如实报找不到，不假装成功
        assert!(matches!(update_nickname(&d, "u-不存在", "张三"), Err(AppError::NotFound)));
    }
}
