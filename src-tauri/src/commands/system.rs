//! 系统管理：设置、主题、审计、备份/恢复、系统信息。


use super::{audit, Result};
use crate::db::repo;
use crate::error::AppError;
use crate::rbac::{self, perm};
use crate::settings;
use crate::state::AppCore;
use serde::{Deserialize, Serialize};

/// 主题风格清单与写入校验的唯一来源在 settings（0012 起还要查自定义主题表），
/// 所以这里不再引一份列表——引了就会漂。
///
/// 外观读取视图：S 轮起只有"哪套风格"与"是否减少动态效果"两枚——明暗身份由风格携带，
/// 玻璃强度由各套主题自己钉死，所以 mode / glassIntensity 随旧主题集合一起作废。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeView {
    pub style: String,
    pub reduce_motion: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    /// 数据库加密：只有真正以 SQLCipher 密钥打开成功才报 encrypted，否则 unknown
    pub db_encrypted: String,
    /// 数据库主密钥的实际存放位置（本包默认为 local-file-0600）
    pub db_key_store: String,
    /// 该文件密钥的同意来源：consented / legacy-file / none
    pub device_key_consent: String,
    pub schema_version: i64,
    pub idle_timeout_minutes: i64,
    pub max_failed_attempts: i64,
    pub lockout_seconds: i64,
    /// `master_password_min_length` 当前生效的值（已夹紧到内置下限之上）。
    /// L 轮起它**只**作用于导出容器口令与导出面板的实时强度提示，主密码不读它；
    /// 字段名沿用设置键名，界面上的标签必须说清它管的是什么。
    pub min_password_length: i64,
    /// 检测到系统休眠/进程被挂起时是否立即锁定保险库
    pub lock_on_system_sleep: bool,
    pub copy_password_enabled: bool,
    pub copy_password_requires_reauth: bool,
    pub export_requires_reauth: bool,
    pub reveal_requires_reauth: bool,
    pub insecure_protocols_allowed: bool,
    pub last_backup_at: Option<String>,
    pub update_source_configured: bool,
    pub update_source_scheme: String,
    pub update_signature_key_configured: bool,
    pub extension_ready: bool,
    pub telemetry: String,
    pub session_started_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub id: String,
    pub ts: String,
    pub actor_id: Option<String>,
    pub actor_nickname: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub result: String,
    pub error_code: Option<String>,
    pub source: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub file_name: String,
    pub created_at: String,
    pub size_bytes: i64,
    pub schema_version: i64,
    pub encrypted: bool,
    pub sha256: String,
    pub verified_at: Option<String>,
}

#[tauri::command]
pub fn get_settings() -> Result<Vec<(String, String, String)>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    settings::all(&core.db)
}

/// 管理员可从「系统管理 · 安全策略」页读写的设置键。出厂 seed（lib.rs::seed_defaults）的每个键都必须
/// 出现在这里，否则会出现「界面显示的值没人读、读到的值没人能改」的漂移。
pub(crate) const UPDATABLE_SETTINGS: &[&str] = &[
        "session_idle_timeout_minutes",
        "max_failed_login_attempts",
        "lockout_seconds",
        "master_password_min_length",
        "lock_on_system_sleep",
        "reauth_window_seconds",
        "copy_password_requires_reauth",
        "accounts_allow_copy_password",
        "reveal_requires_reauth",
        "secret_visible_seconds",
        "export_requires_reauth",
        "allow_insecure_protocols",
        "clipboard_clear_after_seconds",
        "quick_launcher_enabled",
        "quick_launcher_show_recent",
        "quick_launcher_rank_recent_favorite",
        "quick_launcher_result_limit",
        "quick_launcher_fill_enabled",
        "update_channel",
        "update_source_url",
        "extension_id",
        "lan_discovery_enabled",
        "lan_serve_enabled",
        "lan_serve_dir",
        "lan_manual_source",
    ];

/// 管理员更新安装级设置。白名单校验键名与取值，避免前端任意写入设置表。
#[tauri::command]
pub fn update_setting(key: String, value: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    const ALLOWED: &[&str] = &UPDATABLE_SETTINGS;
    if !ALLOWED.contains(&key.as_str()) {
        return Err(AppError::InvalidInput);
    }
    let mut v = value.trim().to_string();
    let numeric_ok = matches!(
        key.as_str(),
        "session_idle_timeout_minutes"
            | "max_failed_login_attempts"
            | "lockout_seconds"
            | "master_password_min_length"
            | "reauth_window_seconds"
            | "secret_visible_seconds"
            | "clipboard_clear_after_seconds"
            | "quick_launcher_result_limit"
    );
    if numeric_ok && v.parse::<i64>().is_err() {
        return Err(AppError::InvalidInput);
    }
    // 布尔策略只认 true/false：写成 "yes"/"1 " 之类会被 get_bool 判成 false，等于静默关掉开关。
    const BOOL_KEYS: &[&str] = &[
        "lock_on_system_sleep",
        "copy_password_requires_reauth",
        "accounts_allow_copy_password",
        "reveal_requires_reauth",
        "export_requires_reauth",
        "allow_insecure_protocols",
        "quick_launcher_enabled",
        "quick_launcher_show_recent",
        "quick_launcher_rank_recent_favorite",
        "quick_launcher_fill_enabled",
        "lan_discovery_enabled",
        "lan_serve_enabled",
    ];
    if BOOL_KEYS.contains(&key.as_str()) && !matches!(v.as_str(), "true" | "false") {
        return Err(AppError::InvalidInput);
    }
    if key == "master_password_min_length" {
        // L 轮起这个键只喂给导出容器口令（见 auth::policy）。策略层会把越界值夹紧，但这里必须
        // 显式拒绝：写入一个永不生效的值等于骗管理员。
        let n: i64 = v.parse().map_err(|_| AppError::InvalidInput)?;
        if n < crate::auth::policy::MIN_LENGTH as i64 || n > crate::auth::policy::MAX_CONFIGURED_MIN_LENGTH {
            return Err(AppError::InvalidInput);
        }
    }
    if key == "update_source_url" && !v.is_empty() && !crate::update::is_allowed_update_url(&v) {
        return Err(AppError::InsecureUpdateSource);
    }
    // 手工局域网源允许写成 `10.0.0.5:8765`，存库前补全成 `http://10.0.0.5:8765`。
    if key == "lan_manual_source" && !v.is_empty() {
        v = crate::update::normalize_lan_source(&v).ok_or(AppError::InsecureUpdateSource)?;
    }
    if key == "lan_serve_dir" && !v.is_empty() && !std::path::Path::new(&v).is_dir() {
        return Err(AppError::InvalidInput);
    }
    if key == "extension_id" && !v.is_empty() && !crate::fill_host::is_valid_extension_id(&v) {
        // 清单里的 allowed_origins 精确到扩展 ID：写错一位等于填充通道对任何扩展都失效或错放。
        return Err(AppError::InvalidInput);
    }
    if key == "update_channel" && !matches!(v.as_str(), "stable" | "beta") {
        return Err(AppError::InvalidInput);
    }
    settings::set(&core.db, &key, &v, "install")?;
    // 局域网开关写库后立即生效：托管目录变了要重启服务，开关变了要起停监听。
    // 失败不回滚设置（开关已是管理员意图），真实错误由 `lan_status.serveError` 报给界面。
    if key.starts_with("lan_") {
        crate::lan::sync(&core);
    }
    audit(&core, Some(&user), "system.setting.update", Some("setting"), Some(&key), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn window_chrome() -> crate::window_chrome::Chrome {
    // 免会话：窗口形态不属于数据，锁屏页与失败页同样要知道该不该画那三颗钮
    //（否则"装配失败"那一屏在 Windows 上就没有任何关闭窗口的方式）。
    crate::window_chrome::chrome()
}

#[tauri::command]
pub fn get_theme() -> Result<ThemeView> {
    // 首次运行的同意闸门阶段还没有装配：这里必须回错误码，不能让进程 abort（见 state::core_or_await_consent）。
    let core = crate::state::core_or_await_consent()?;
    // 未解锁时也可读主题：外观不属于秘密数据
    let user = core.vault.active_user().unwrap_or_default();
    let style = if user.is_empty() {
        settings::get(&core.db, "theme_style")?.unwrap_or_else(|| "glass".into())
    } else {
        settings::theme_for(&core.db, &user)?
    };
    Ok(ThemeView {
        style,
        reduce_motion: settings::get_bool(&core.db, "reduce_motion", false),
    })
}

#[tauri::command]
pub fn set_theme(style: String) -> Result<()> {
    // 与 get_theme 同一道闸门：首启页（保险库还没建）与密钥同意页都可能在装配前后调这里，
    // 用 state::core() 会在未装配时 panic，release 下就是带着没关的连接一起 abort。
    let core = crate::state::core_or_await_consent()?;
    // 内置四套之外还接受表里存在的 `custom-<id>`（0012 起的自定义主题）。
    // 校验整个交给 settings::theme_style_is_known——那里是唯一事实来源，这里再抄一份枚举就会漂。
    if !settings::theme_style_is_known(&core.db, &style)? {
        return Err(AppError::InvalidInput);
    }
    match core.vault.active_user() {
        // 已有使用者：按人存，互不覆盖（原行为）
        Some(user) => settings::set_theme(&core.db, &user, &style),
        // 还没有使用者（首次运行）或会话锁定：落安装级，get_theme 会读回来，重启不丢。
        // 外观不属于秘密数据，不需要会话就能记住"用户想要哪一档"。
        None => settings::set_theme_install(&core.db, &style),
    }
}

#[tauri::command]
pub fn set_reduce_motion(enabled: bool) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    settings::set(&core.db, "reduce_motion", if enabled { "true" } else { "false" }, "install")?;
    let _ = user;
    Ok(())
}

/// 自定义主题列表（0012）。与主题读写同一档：外观不属于秘密数据，未解锁也可读，
/// 所以认证屏那六屏也认得用户自己加的档。
#[tauri::command]
pub fn list_custom_themes() -> Result<Vec<settings::CustomTheme>> {
    let core = crate::state::core_or_await_consent()?;
    settings::list_custom_themes(&core.db)
}

/// 新增一档自定义主题。`tokens` 是**已在前端逐枚校验过**的扁平 JSON 对象；
/// settings 侧会再按白名单与字面形状过一遍，不合规直接拒，库里从不存用户原文。
#[tauri::command]
pub fn add_custom_theme(id: String, name: String, tokens: String) -> Result<()> {
    let core = crate::state::core_or_await_consent()?;
    settings::add_custom_theme(&core.db, &id, &name, &tokens)
}

/// 删一档自定义主题。正选用它时 settings 侧会把那一条偏好归回 `glass`，
/// 不会留下一个"存着却查不到 CSS"的主题值。
#[tauri::command]
pub fn delete_custom_theme(id: String) -> Result<()> {
    let core = crate::state::core_or_await_consent()?;
    settings::delete_custom_theme(&core.db, &id)
}

#[tauri::command]
pub fn security_status() -> Result<SecurityStatus> {
    let core = crate::state::core();
    // 安全状态里含主密钥存放位置、备份时间、更新源等部署信息，锁定会话或未授权时一律不得读出。
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    // 数据库主密钥存放位置一律读本机标记：这里绝不再跑系统安全存储探针
    // （探针要写临时条目，未签名构建上就是多一个授权框）。
    let consent = crate::device_key_consent(&core.data_dir);
    let source = settings::get(&core.db, "update_source_url")?.unwrap_or_default();
    let scheme = source
        .split_once("://")
        .map(|(s, _)| s.to_lowercase())
        .unwrap_or_else(|| if source.is_empty() { "未配置".into() } else { "非法".into() });
    let db_encrypted = if crate::db::probe_encrypted(&core.db) { "encrypted" } else { "unknown" };
    Ok(SecurityStatus {
        db_encrypted: db_encrypted.to_string(),
        db_key_store: if crate::keystore_fallback_used(&core.data_dir) { "local-file-0600" } else { "unknown" }.to_string(),
        device_key_consent: consent.as_str().to_string(),
        schema_version: { let conn = core.db.lock_conn(); crate::db::migrate::version(&conn)? },
        idle_timeout_minutes: settings::get_i64(&core.db, "session_idle_timeout_minutes", 10),
        max_failed_attempts: settings::get_i64(&core.db, "max_failed_login_attempts", 5),
        lockout_seconds: settings::get_i64(&core.db, "lockout_seconds", 300),
        min_password_length: crate::auth::policy::min_length(&core.db) as i64,
        lock_on_system_sleep: settings::get_bool(&core.db, "lock_on_system_sleep", true),
        copy_password_enabled: settings::get_bool(&core.db, "accounts_allow_copy_password", true),
        copy_password_requires_reauth: settings::get_bool(&core.db, "copy_password_requires_reauth", true),
        export_requires_reauth: settings::get_bool(&core.db, "export_requires_reauth", false),
        reveal_requires_reauth: settings::get_bool(&core.db, "reveal_requires_reauth", true),
        insecure_protocols_allowed: settings::get_bool(&core.db, "allow_insecure_protocols", false),
        last_backup_at: settings::get(&core.db, "last_backup_at")?,
        update_source_configured: !source.is_empty(),
        update_source_scheme: scheme,
        update_signature_key_configured: crate::update::release_pubkey().is_some(),
        extension_ready: core.extension_ready(),
        // 本版本完全离线：不发送任何遥测
        telemetry: "disabled".to_string(),
        session_started_at: core.vault.started_at(),
    })
}

#[tauri::command]
pub fn list_audit_events(limit: Option<i64>) -> Result<Vec<AuditRow>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_AUDIT_READ)?;
    let events = crate::audit::list(&core.db, limit.unwrap_or(200).clamp(1, 1000))?;
    Ok(events
        .into_iter()
        .map(|e| AuditRow {
            actor_nickname: e.actor_id.as_deref().and_then(|a| super::vault::nickname_of(&core, a)),
            id: e.id,
            ts: e.ts,
            actor_id: e.actor_id,
            action: e.action,
            target_type: e.target_type,
            target_id: e.target_id,
            result: e.result,
            error_code: e.error_code,
            source: e.source,
        })
        .collect())
}

/// 创建加密备份：先 SQLCipher 一致性备份到临时文件，再整体 AEAD 封装落盘；
/// 只记录文件名/大小/哈希，绝不记录内容或密钥。
#[tauri::command]
pub fn create_backup() -> Result<BackupInfo> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_BACKUP)?;
    let info = crate::backup::create(&core)?;
    settings::set(&core.db, "last_backup_at", &info.created_at, "install")?;
    audit(&core, Some(&user), "system.backup.create", Some("backup"), Some(&info.id), true, None, "app");
    Ok(info)
}

#[tauri::command]
pub fn list_backups() -> Result<Vec<BackupInfo>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_BACKUP)?;
    crate::backup::list(&core)
}

#[tauri::command]
pub fn verify_backup(id: String) -> Result<BackupInfo> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_BACKUP)?;
    let info = crate::backup::verify(&core, &id)?;
    audit(&core, Some(&user), "system.backup.verify", Some("backup"), Some(&id), true, None, "app");
    Ok(info)
}

/// 恢复前强制二次确认，并先为当前状态生成回滚备份。
#[tauri::command]
pub fn restore_backup(id: String, confirmed: bool) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_BACKUP)?;
    if !confirmed {
        return Err(AppError::InvalidInput);
    }
    core.require_reauth()?;
    crate::backup::restore(&core, &id)?;
    // 文件已整体替换：必须用同一主密钥重新打开，否则后续读到的仍是旧 inode
    core.db.reopen(core.db_key.as_slice())?;
    audit(&core, Some(&user), "system.backup.restore", Some("backup"), Some(&id), true, None, "app");
    core.lock_down();
    Ok(())
}

#[tauri::command]
pub fn system_info() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let _ = core.check_session()?;
    // 连接锁不可重入：必须先在独立作用域里读出 schemaVersion，
    // 否则 guard 会活到整个 json! 表达式结束，后面的 list_targets 加锁就会同线程死锁。
    let schema_version = { crate::db::migrate::version(&core.db.lock_conn())? };
    let target_count = repo::list_targets(&core.db).map(|v| v.len()).unwrap_or(0);
    // 诊断信息剔除用户数据、绝对路径、密钥与凭据
    Ok(serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
        "schemaVersion": schema_version,
        "targetCount": target_count,
        "dbKeyStore": if crate::keystore_fallback_used(&core.data_dir) { "local-file-0600" } else { "unknown" },
        "telemetry": "disabled",
    }))
}

#[tauri::command]
pub fn extension_channel_status() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let _ = core.check_session()?;
    Ok(channel_state(&core))
}

/// 通道就绪状态：不含端口、令牌与任何凭据。
pub(crate) fn channel_state(core: &AppCore) -> serde_json::Value {
    serde_json::json!({
        "ready": core.extension_ready(),
        "hostManifestPath": crate::fill_host::manifest_install_path().map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
        "channelFilePresent": crate::ipc::channel_file(&core.data_dir).exists(),
        "pendingTickets": core.tickets.pending_count(),
        "note": if core.extension_ready() { "扩展已连接" } else { "未检测到浏览器扩展/Native Messaging 宿主：填充功能降级为手动复制" }
    })
}
