//! 保险库生命周期与本软件自身使用者（App User）相关命令。
//! 注意：这里的密码是「本软件主密码」，与账号管理里的外部系统凭据完全是两回事。

use std::sync::Arc;

use super::{audit, AppStatus, LockoutInfo, LoginProfile, LoginProfileUser, PasswordAssessmentView, Result};
use crate::auth::session::Session;
use crate::auth::{policy, users as user_svc};
use crate::crypto::keystore;
use crate::db::repo;
use crate::error::AppError;
use crate::quick_launcher::search::SearchIndex;
use crate::rbac::{self, perm};
use crate::settings;
use crate::state::AppCore;

pub(crate) fn nickname_of(core: &AppCore, user_id: &str) -> Option<String> {
    let conn = core.db.lock_conn();
    conn.query_row("SELECT nickname FROM app_users WHERE id=?1", rusqlite::params![user_id], |r| r.get::<_, String>(0))
        .ok()
}

fn unlock_window(core: &AppCore) -> (i64, i64) {
    (
        settings::get_i64(&core.db, "max_failed_login_attempts", 5),
        settings::get_i64(&core.db, "lockout_seconds", 300),
    )
}

/// 解锁后建立内存态：会话 + VaultKey + 授权范围内的明文搜索索引。
pub(crate) fn establish_session(core: &AppCore, user_id: &str, vk: crate::crypto::vault_key::VaultKey) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let token = core.sessions.issue(user_id);
    let session = Session {
        id: token,
        user_id: user_id.to_string(),
        started_at: now,
        last_activity: now,
        reauth_at: Some(now),
    };
    let docs = repo::build_search_index(&core.db, &vk, user_id)?;
    core.vault.unlock(session, Arc::new(vk), SearchIndex::new(docs));
    Ok(())
}

#[tauri::command]
pub fn vault_status() -> Result<AppStatus> {
    // 状态查询是主窗口挂载时第二早被调到的命令（闸门探测失败时界面会直接问状态）。
    // 未装配时如实回错误码，比让进程 abort 好得多——abort 会带着没关的数据库连接一起没。
    let core = crate::state::core_or_await_consent()?;
    AppStatus::build(&core)
}

/// 首次初始化：主密码由界面收集，昵称可以不传——空昵称时系统按本机设备名自动生成。
/// 内部标识由系统生成，任何页面都不得要求用户输入用户名/邮箱/手机号。
#[tauri::command]
pub fn vault_initialize(nickname: String, password: String) -> Result<AppStatus> {
    let core = crate::state::core();
    if user_svc::is_initialized(&core.db)? {
        return Err(AppError::AlreadyInitialized);
    }
    // 界面不再收昵称，空昵称 = 让系统按设备名起一个；users::initialize 里的非空判定照旧生效。
    let nickname = if nickname.trim().is_empty() { device_label() } else { nickname.trim().to_string() };
    policy::require_non_empty(&password)?;
    let (user_id, vk) = user_svc::initialize(&core.db, &nickname, &password)?;
    establish_session(&core, &user_id, vk)?;
    audit(&core, Some(&user_id), "vault.initialize", Some("vault"), Some(&user_id), true, None, "app");
    AppStatus::build(&core)
}

/// 首启页按原型重绘后没有昵称输入框：昵称取本机设备名。
/// 依次试环境变量与 `hostname` 命令，都拿不到就退回中性常量。
/// 只在建库那一次跑，绝不参与密钥派生，也不写进日志正文。
fn device_label() -> String {
    let from_env = ["COMPUTERNAME", "HOSTNAME", "NODE_NAME"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .unwrap_or_default();
    let raw = if from_env.trim().is_empty() { hostname_command() } else { from_env };
    normalize_device_label(&raw)
}

/// `hostname` 命令的输出（拿不到就是空串）。
#[cfg(not(test))]
fn hostname_command() -> String {
    use std::process::Command;
    Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// 测试里不真起进程：设备名只由环境变量决定，没有就走兜底常量。
#[cfg(test)]
fn hostname_command() -> String {
    String::new()
}

/// 清洗规则单独成函数，好让它能被直接断言（不依赖真实环境变量与本机设置）。
/// 上限与手动改名共用 `NICKNAME_MAX_CHARS`：这枚昵称要落在解锁页的使用者选择里，过长会把那一行挤成一团。
fn normalize_device_label(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(user_svc::NICKNAME_MAX_CHARS)
        .collect();
    if cleaned.is_empty() {
        "本机用户".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub fn password_strength(password: String) -> Result<PasswordAssessmentView> {
    let core = crate::state::core();
    // 只返回不可逆的评估结果，绝不缓存或记录密码。这一条现在只服务导出面板的容器口令提示：
    // 主密码没有任何强度要求（L 轮），位数下限取当前配置，提示才与容器闸门一致。
    Ok(policy::assess_with(&password, policy::min_length(&core.db)).into())
}

#[tauri::command]
pub fn login_profile() -> Result<LoginProfile> {
    let core = crate::state::core();
    let p = user_svc::login_profile(&core.db)?;
    Ok(LoginProfile {
        initialized: p.initialized,
        single_user: p.single_user,
        users: p
            .users
            .iter()
            .map(|u| LoginProfileUser {
                id: u.id.clone(),
                nickname: u.nickname.clone(),
                internal_code: u.generated_account_code.clone(),
            })
            .collect(),
        // L 轮起这里不再带 password_policy：主密码没有任何强度要求，
        // 把 min_length 搬到来路不明的接口上只会让解锁页显示一条不会生效的"策略提示"。
        lockout: p.users.first().and_then(|u| {
            let st = user_svc::status_of(&core.db, &u.id).ok()?;
            Some(LockoutInfo {
                locked: st.locked,
                failed_count: st.failed_count,
                seconds_remaining: st.seconds_remaining,
                attempts_remaining: st.attempts_remaining,
            })
        }),
    })
}

#[tauri::command]
pub fn vault_unlock(app_user_id: String, password: String) -> Result<AppStatus> {
    let core = crate::state::core();
    let (max, secs) = unlock_window(&core);
    let vk = user_svc::unlock(&core.db, &app_user_id, &password, max, secs)?;
    establish_session(&core, &app_user_id, vk)?;
    AppStatus::build(&core)
}

#[tauri::command]
pub fn vault_lock() -> Result<()> {
    let core = crate::state::core();
    let u = core.vault.active_user();
    core.lock_down();
    audit(&core, u.as_deref(), "session.lock", Some("session"), u.as_deref(), true, None, "app");
    Ok(())
}

/// 二次认证：敏感动作（复制密码、导出、恢复备份、安装更新、改权限）前重新验证主密码。
#[tauri::command]
pub fn reauthenticate(password: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    let (max, secs) = unlock_window(&core);
    user_svc::verify_master_password(&core.db, &user, &password, max, secs)?;
    let now = chrono::Utc::now().timestamp();
    core.vault.grant_reauth(now);
    audit(&core, Some(&user), "session.reauth", Some("session"), Some(&user), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn change_master_password(current: String, next: String) -> Result<AppStatus> {
    let core = crate::state::core();
    let user = core.check_session()?;
    policy::require_non_empty(&next)?;
    let vk = user_svc::change_password(&core.db, &user, &current, &next)?;
    // 只重封装密钥：DEK 必须保持不变，否则已有台账会不可恢复
    let same = core
        .vault
        .with_vk(|old| Ok(old.dek.0 == vk.dek.0))?;
    if !same {
        core.lock_down();
        return Err(AppError::Internal);
    }
    // 用新会话替换旧会话，避免旧令牌继续有效
    establish_session(&core, &user, vk)?;
    core.rebuild_index()?;
    AppStatus::build(&core)
}

/// 个人信息页改自己的昵称。只改显示名，不需要主密码：这里没有任何秘密可保护，
/// 二次认证留给复制口令、导出这类动作。空昵称与超长昵称由 `user_svc::update_nickname` 判定。
#[tauri::command]
pub fn update_own_nickname(nickname: String) -> Result<AppStatus> {
    let core = crate::state::core();
    let user = core.check_session()?;
    user_svc::update_nickname(&core.db, &user, &nickname)?;
    audit(&core, Some(&user), "profile.nickname", Some("app_user"), Some(&user), true, None, "app");
    AppStatus::build(&core)
}

#[tauri::command]
pub fn list_app_users() -> Result<Vec<user_svc::AppUserSummary>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_USER_READ)?;
    user_svc::list_users(&core.db)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSummary {
    pub code: String,
    pub name: String,
    pub description: String,
    pub builtin: bool,
    /// 停用角色仍会出现在列表里（否则无法展示/编辑既有绑定），但不授予任何权限。
    pub status: String,
}

/// roles 的查询体。
///
/// 为什么单拆出来：`roles` 表**没有 `deleted_at` 列**（它的停用语义是 `status`，见
/// `migrations/0001_init.sql` 的建表），而这条 SQL 原先带着 `WHERE deleted_at IS NULL`——
/// rusqlite 在 `prepare` 阶段就报 `no such column`，于是 `list_roles` 每次都失败，
/// 使用者页的角色下拉恒为错误态。命令层调 `state::core()`，测试进不来（`set_global_core`
/// 只在 `finish_boot` 里调用），所以把查询拆成接收 `&Connection` 的纯函数，让下面那条
/// 测试能直接对着已迁移的内存库跑同一份 SQL——缺陷就是这么漏过 398 条测试的。
fn query_roles(conn: &rusqlite::Connection) -> Result<Vec<RoleSummary>> {
    let mut stmt = conn.prepare("SELECT code, name, description, builtin, status FROM roles ORDER BY builtin DESC, code")?;
    let rows = stmt.query_map([], |r| {
        Ok(RoleSummary {
            code: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            builtin: r.get::<_, i64>(3)? != 0,
            status: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn list_roles() -> Result<Vec<RoleSummary>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_USER_READ)?;
    let conn = core.db.lock_conn();
    query_roles(&conn)
}

#[tauri::command]
pub fn create_app_user(nickname: String, initial_password: String, role_key: String) -> Result<user_svc::AppUserSummary> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_USER_MANAGE)?;
    core.require_reauth()?;
    if nickname.trim().is_empty() {
        return Err(AppError::NicknameRequired);
    }
    policy::require_non_empty(&initial_password)?;
    let vk = core.vault.current_vk().ok_or(AppError::Locked)?;
    let new_id = user_svc::create_app_user(&core.db, &admin, &nickname, &initial_password, &role_key, &vk)?;
    drop(vk);
    user_svc::list_users(&core.db)?
        .into_iter()
        .find(|u| u.id == new_id)
        .ok_or(AppError::Internal)
}

#[tauri::command]
pub fn set_user_status(target_user_id: String, status: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_USER_MANAGE)?;
    core.require_reauth()?;
    if status != "active" && status != "disabled" {
        return Err(AppError::InvalidInput);
    }
    if admin == target_user_id {
        return Err(AppError::Forbidden);
    }
    let conn = core.db.lock_conn();
    let n = conn.execute(
        "UPDATE app_users SET status=?1, updated_at=?2 WHERE id=?3 AND deleted_at IS NULL",
        rusqlite::params![status, repo::now(), target_user_id],
    )?;
    drop(conn);
    if n == 0 {
        return Err(AppError::NotFound);
    }
    if status == "disabled" {
        core.sessions.revoke_user(&target_user_id);
    }
    // 审查 F27/B10：可见范围随角色/状态变化，内存索引必须作废。
    // 标记是 O(1)（见 AppCore::mark_index_dirty），真正重建发生在下一次读索引之前。
    core.mark_index_dirty();
    audit(&core, Some(&admin), "system.user.status", Some("app_user"), Some(&target_user_id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn admin_reset_password(target_user_id: String, new_password: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_USER_MANAGE)?;
    core.require_reauth()?;
    policy::require_non_empty(&new_password)?;
    let vk = core.vault.current_vk().ok_or(AppError::Locked)?;
    user_svc::admin_reset_password(&core.db, &admin, &target_user_id, &new_password, &vk)?;
    drop(vk);
    core.sessions.revoke_user(&target_user_id);
    Ok(())
}

/// 数据库主密钥存放位置的诊断。
/// 本包默认用本机 0600 文件密钥（操作者 2026-10-17 的决定，见 docs/密钥生命周期与加密边界.md），
/// 所以这里**不再探测系统安全存储**——探针要写一条临时条目，未签名构建上就是又一个授权框。
#[tauri::command]
pub fn keystore_diagnostics() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let _ = core.check_session()?;
    // 绝不返回密钥本身或其派生材料，只返回存放位置与同意来源。
    let consent = crate::device_key_consent(&core.data_dir);
    let file_key = crate::keystore_fallback_used(&core.data_dir);
    Ok(serde_json::json!({
        "dbKeyStore": if file_key { "local-file-0600" } else { "unknown" },
        // 旧存放位置的名字只用于说明"那份旧库的密钥原本放在哪"，是纯字符串，不会因此访问钥匙串。
        "legacyBackend": keystore::platform_backend(),
        // 显式同意状态：consented=本次版本经操作者确认；legacy-file=加设闸门之前留下的文件；none=读不到本机标记
        "deviceKeyConsent": consent.as_str(),
        "note": match consent {
            crate::DeviceKeyConsent::Consented =>
                "数据库主密钥保存在本机 0600 权限文件，这是本包按操作者决定采用的默认存放位置；保险库数据本身是 SQLCipher/AEAD 密文。该文件没有系统级访问控制，删除它等于永久无法打开数据库。",
            crate::DeviceKeyConsent::LegacyFile =>
                "数据库主密钥保存在本机 0600 权限文件，但本机没有对应的显式同意记录（加设同意闸门之前的版本遗留）。请在本机安全状态页确认后重新取得一次同意记录。",
            crate::DeviceKeyConsent::None =>
                "读不到本机密钥文件的存放标记：数据库主密钥的实际位置无法确认，请勿删除数据目录，先查 vault.device.key 是否存在。",
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::normalize_device_label;

    /// 首启页没有昵称输入框，昵称完全由这一串规则决定：清洗、截断、兜底都得能被断言。
    #[test]
    fn device_label_is_trimmed_sanitized_and_capped() {
        assert_eq!(normalize_device_label("  MacBook-Pro-4  "), "MacBook-Pro-4");
        assert_eq!(normalize_device_label("has\tcontrol\nchars"), "hascontrolchars");
        assert_eq!(normalize_device_label(&"x".repeat(60)).chars().count(), 40, "昵称要能在解锁页那一行里站住");
        assert_eq!(normalize_device_label("   "), "本机用户", "拿不到设备名时也得有一个非空昵称，users::initialize 不接受空");
        assert_eq!(normalize_device_label(""), "本机用户");
    }

    /// 审查 F1 的回归：`roles` 没有 `deleted_at` 列，带那个条件的 SQL 在 `prepare` 就失败，
    /// 而命令层因为要 `state::core()` 进不了单元测试——这条直接对着已迁移的内存库跑同一份 SQL。
    #[test]
    fn list_roles_sql_runs_against_the_migrated_schema() {
        use super::query_roles;
        use crate::db::Db;
        let db = Db::open_in_memory(&vec![21u8; 32]).expect("内存库应能装配并跑完全部迁移");
        let roles = query_roles(&db.lock_conn()).expect("list_roles 的查询必须能在真实 schema 上 prepare 并执行");
        assert_eq!(roles.len(), 3, "出厂三档角色：system_admin / standard_user / 只读，少一档就是迁移或查询变了");
        assert!(roles.iter().all(|r| !r.code.is_empty() && !r.name.is_empty()));
        assert!(roles.iter().any(|r| r.code == "system_admin"), "管理员档必须在列表里，否则新建用户没法分配最高权限");
        // 排序契约：builtin 在前，同档按 code 升序——前端下拉直接吃这个顺序，不自己排。
        let builtin_flags: Vec<bool> = roles.iter().map(|r| r.builtin).collect();
        assert!(builtin_flags.windows(2).all(|w| w[0] || !w[1]), "builtin 必须整体排在非 builtin 之前");
    }
}
