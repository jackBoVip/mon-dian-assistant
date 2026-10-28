//! 应用装配层：目录与密钥引导、数据库打开、插件与命令注册、启动器窗口与本机通道。
//!
//! 安全约束在本层的体现：
//! - 数据库主密钥只存在于系统安全存储（或用户显式同意后的 0600 本机密钥文件），
//!   绝不明文写入保险库同目录，也不下发给前端；
//! - 系统安全存储不可用时必须让界面可见地告警，不静默降级；
//! - 空闲超时由后台计时线程触发锁定，清空明文索引与密钥。

pub mod audit;
pub mod auth;
pub mod backup;
pub mod commands;
pub mod crypto;
pub mod db;
pub mod error;
pub mod external_tools;
pub mod fill_host;
pub mod importexport;
pub mod ipc;
pub mod lan;
pub mod launcher;
pub mod menu;
pub mod quick_launcher;
pub mod rbac;
pub mod secfile;
pub mod settings;
pub mod state;
pub mod update;
pub mod window_chrome;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Manager, RunEvent};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};

use crate::crypto::{keystore, SecretBytes};
use crate::db::Db;
use crate::error::{AppError, Result};
use crate::state::{AppCore, SharedCore};

/// 保险库数据库文件名（SQLCipher）。
const DB_FILE: &str = "vault.db";
/// 系统安全存储不可用时使用的本机密钥文件名。
const KEY_FILE: &str = "vault.device.key";
/// 操作者显式同意使用本机文件密钥之后写入的记录文件，内容只有一个时间戳，不含密钥材料。
const CONSENT_FILE: &str = "keystore-consent.flag";

/// 启动时因为"尚未获得显式同意"而无法取得数据库密钥时，挂到应用上的待确认状态。
/// 界面据此渲染一次性确认屏；同意后由 `commands::devicekey::grant_device_key_fallback` 完成装配。
pub struct PendingDeviceKey {
    pub data_dir: PathBuf,
    /// 确认屏上要如实说清的那一句：全新安装是"本包默认用文件密钥"，
    /// 旧库迁移是"要把系统安全存储里那把旧密钥复制过来"。
    pub reason: &'static str,
}

impl PendingDeviceKey {
    /// 询问理由的稳定字面量：界面按它选文案。
    pub const REASON_FRESH: &'static str = "fresh";
    pub const REASON_LEGACY_VAULT: &'static str = "legacy-vault";
}

/// 启动装配失败时挂到应用上的状态。
///
/// 为什么需要它：Tauri 在调用 `setup` 钩子**之前**就按配置把窗口创建好了
/// （`tauri-2.12.3/src/app.rs:2688` 的 `fn setup`），而钩子返回 `Err` 会让
/// `App::run_return` 在 Ready 事件里 `panic!("Failed to setup app: …")`（同一文件 1443 行）。
/// 本项目的 release 配置是 `panic = "abort"`，于是一个可恢复的启动故障表现为"窗口闪一下、进程没了"，
/// 运维拿不到任何原因。改成挂这条状态并让事件循环继续，界面就能把失败如实显示出来。
///
/// 字段只有错误码、失败阶段、后端那句中文说明和数据目录路径：不含密钥材料、口令、数据库内容或路径以外的用户数据。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootFailure {
    pub stage: &'static str,
    pub code: &'static str,
    pub message: String,
    pub data_dir: String,
}

impl BootFailure {
    /// 失败阶段：稳定字面量，界面按它决定额外提示什么，绝不拿它当权限判断。
    pub const STAGE_DATA_DIR: &'static str = "data-dir";
    pub const STAGE_DEVICE_KEY: &'static str = "device-key";
    pub const STAGE_ASSEMBLY: &'static str = "assembly";

    pub fn new(stage: &'static str, err: &AppError, data_dir: Option<&Path>) -> Self {
        BootFailure {
            stage,
            code: err.code(),
            // AppError 的 Display 本来就是给界面显示的中文短句（每条命令的返回值一直这么做），
            // 这里不额外拼接任何来自库内容的信息。
            message: err.to_string(),
            data_dir: data_dir.map(|p| p.display().to_string()).unwrap_or_default(),
        }
    }
}

/// 解析数据目录。宿主进程（Native Messaging host）通过 MDA_DATA_DIR 找到同一目录。
pub fn resolve_data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    if let Ok(d) = std::env::var("MDA_DATA_DIR") {
        let p = PathBuf::from(d);
        std::fs::create_dir_all(&p).map_err(|e| AppError::internal("启动装配与密钥文件写入", &e))?;
        return Ok(p);
    }
    app.path()
        .app_data_dir()
        .map(|p| {
            let _ = std::fs::create_dir_all(&p);
            p
        })
        .map_err(|e| AppError::internal("启动装配与密钥文件写入", &e))
}

/// 数据库主密钥的来源决策。抽成纯函数是因为它决定了"什么时候才允许生成一把新密钥"，
/// 而这条判断一旦写错就是不可逆的数据损毁：设备密钥被换掉之后，已有的 `vault.db`
/// 再也解不开。它还决定第二件事——**什么时候才允许打开系统安全存储**，
/// 因为每一次钥匙串访问在未签名构建上都可能弹一次授权框，那是现场要人手点的。
#[derive(Debug, PartialEq, Eq)]
pub enum KeyDecision {
    /// 本机已有 0600 文件密钥（含同意闸门之前留下的遗留文件），直接用它，不访问系统安全存储。
    UseDeviceKeyFile,
    /// 保险库文件在、本机没有文件密钥：这份库是由旧版本放在系统安全存储里的，
    /// 只有这一格允许读一次钥匙串，读到就迁移成本机文件密钥。
    TryMigrateFromKeystore,
    /// 全新安装：先要显式同意，才允许建文件密钥。全程不访问系统安全存储。
    ConsentRequired,
}

/// `bootstrap_db_key` 的判定表。`vault.db` 一旦存在且本机没有文件密钥，就只能走迁移那一格，
/// 迁移读不到密钥时绝不新建（新建等于把旧库永久锁死）。
pub fn decide_key_source(keyfile_exists: bool, vault_exists: bool) -> KeyDecision {
    if keyfile_exists {
        return KeyDecision::UseDeviceKeyFile;
    }
    if !vault_exists {
        return KeyDecision::ConsentRequired;
    }
    KeyDecision::TryMigrateFromKeystore
}

/// 数据库主密钥引导：**本机 0600 文件密钥是本包的默认存放位置**（操作者 2026-10-17 的决定，
/// 需求 §7.2 的"系统安全存储优先"在本包不启用，理由见 docs/密钥生命周期与加密边界.md）。
/// 系统安全存储只在"旧版本用它建过库"这一格被读一次，读完即迁移，之后不再访问。
///
/// 仍然保留的两条硬边界：新建密钥必须先拿到操作者显式同意；未获同意时不写任何字节。
/// 任何分支都不会把保险库数据本身明文落盘。
///
/// `consent_granted` 只在"本机还没有密钥文件"时起作用：false 表示还没问过/还没同意，
/// 此时返回 `DEVICE_KEY_CONSENT_REQUIRED`，由界面用一次性显式确认后再来装配（见 `commands::devicekey`）。
pub fn bootstrap_db_key(data_dir: &Path, consent_granted: bool) -> Result<SecretBytes> {
    let keyfile_exists = data_dir.join(KEY_FILE).exists();
    let vault_exists = data_dir.join(DB_FILE).exists();
    match decide_key_source(keyfile_exists, vault_exists) {
        KeyDecision::UseDeviceKeyFile | KeyDecision::ConsentRequired => {
            load_or_create_device_key_file(data_dir, consent_granted)
        }
        KeyDecision::TryMigrateFromKeystore => {
            // 本进程唯一一处钥匙串访问。放在这一格是因为这里的库是旧版本建的，
            // 主密钥只在系统安全存储里有一份；跳过它就只能报"密钥丢了"，把还能用的数据判死。
            log::info!("检测到保险库文件但没有本机密钥文件：尝试从系统安全存储读取旧密钥以完成一次性迁移（未签名构建可能弹一次授权对话框）");
            match keystore::load_db_key() {
                Ok(key) => store_migrated_device_key(data_dir, key, consent_granted),
                Err(e) => {
                    log::error!("保险库文件已存在、本机没有密钥文件、系统安全存储也没读到密钥（{e}）：不会生成新密钥，换掉设备密钥会让已有数据永久无法解密");
                    Err(AppError::DeviceKeyLostVaultIntact)
                }
            }
        }
    }
}

/// 启动路径上的引导：本机已有同意记录才算"已同意"，否则一律先征求同意。
pub fn bootstrap_for_startup(data_dir: &Path) -> Result<SecretBytes> {
    let granted = device_key_consent(data_dir) == DeviceKeyConsent::Consented;
    bootstrap_db_key(data_dir, granted)
}

/// 把一把已经存在的密钥落成本机 0600 文件（新建与迁移共用这一段，保证两条路留下的痕迹一致）。
/// 调用方负责先过同意闸门与"不许覆盖已有文件"这两道检查。
fn write_device_key_file(data_dir: &Path, key: &[u8]) -> Result<()> {
    let keyfile = data_dir.join(KEY_FILE);
    crate::secfile::write_private(&keyfile, key)?;
    // 告警标记：安全状态页据此显示"未使用系统安全存储"
    crate::secfile::write_state_flag(data_dir, "keystore-fallback.flag", b"file-0600");
    // 同意记录：只写时间戳，不含任何密钥材料。用于区分"显式同意过的降级"和"旧版本留下的降级"。
    crate::secfile::write_state_flag(data_dir, CONSENT_FILE, db::repo::now().as_bytes());
    Ok(())
}

/// 本机文件密钥分支。已有文件时照常读取（加设同意闸门之前留下的库不能被锁死，
/// 只能在安全状态页如实标注为遗留），需要新建文件时必须先获得显式同意。
pub fn load_or_create_device_key_file(data_dir: &Path, consent_granted: bool) -> Result<SecretBytes> {
    let keyfile = data_dir.join(KEY_FILE);
    if keyfile.exists() {
        let raw = std::fs::read(&keyfile).map_err(|e| AppError::internal("启动装配与密钥文件写入", &e))?;
        if raw.len() == crate::crypto::KEY_LEN {
            return Ok(SecretBytes::new(raw));
        }
        return Err(AppError::Crypto(crate::crypto::CryptoError::MalformedInput));
    }
    if device_key_consent(data_dir) != DeviceKeyConsent::Consented && !consent_granted {
        log::warn!("尚未获得显式同意：未写入任何密钥文件，需要操作者确认后才能继续");
        return Err(AppError::DeviceKeyConsentRequired);
    }
    // 再守一道：只有"本机还没有保险库文件"才允许新建密钥。已有 vault.db 时写一把新密钥，
    // 等于用一句"同意"把旧库永久锁死，所以这条不依赖上游决策表是否正确。
    if data_dir.join(DB_FILE).exists() {
        log::error!("保险库文件已存在却没有可用的设备密钥，已拒绝新建本机文件密钥");
        return Err(AppError::DeviceKeyLostVaultIntact);
    }
    let key = crate::crypto::random_key();
    write_device_key_file(data_dir, key.as_slice())?;
    log::warn!("已按操作者的显式同意使用本机 0600 文件密钥（本包不使用系统安全存储）；删除该文件等于永久销毁数据库");
    Ok(key)
}

/// 一次性迁移：把系统安全存储里那把旧主密钥原样复制成本机 0600 文件密钥。
/// 与新建分支同样要先有显式同意（"把主密钥落到磁盘"这个动作本身就要人点头），
/// 同样绝不覆盖已有文件密钥——两个存放位置同时有密钥时，覆盖哪一个都可能锁死另一份库。
/// 系统安全存储里的原条目**不删除**：迁移后的文件密钥一旦被误删，它就是唯一的回滚凭据。
pub fn store_migrated_device_key(data_dir: &Path, key: SecretBytes, consent_granted: bool) -> Result<SecretBytes> {
    if data_dir.join(KEY_FILE).exists() {
        log::error!("本机文件密钥已存在，已拒绝用系统安全存储里的旧密钥覆盖它");
        return Err(AppError::DeviceKeyLostVaultIntact);
    }
    if device_key_consent(data_dir) != DeviceKeyConsent::Consented && !consent_granted {
        log::warn!("尚未获得显式同意：未把系统安全存储里的旧密钥迁移到本机文件");
        return Err(AppError::DeviceKeyConsentRequired);
    }
    if key.len() != crate::crypto::KEY_LEN {
        return Err(AppError::Crypto(crate::crypto::CryptoError::MalformedInput));
    }
    write_device_key_file(data_dir, key.as_slice())?;
    log::warn!("已把数据库主密钥从系统安全存储迁移为本机 0600 文件密钥；系统安全存储条目原样保留未删除，此后本包不再访问它");
    Ok(key)
}

/// 本机文件密钥的同意状态。
#[derive(Debug, PartialEq, Eq)]
pub enum DeviceKeyConsent {
    /// 既没有密钥文件也没有同意记录：尚未降级。
    None,
    /// 由操作者显式同意后写入。
    Consented,
    /// 密钥文件存在但没有同意记录——加设同意闸门之前（或从旧版本升级）留下的，需如实标注。
    LegacyFile,
}

impl DeviceKeyConsent {
    /// 给界面与审计用的稳定字面量。
    pub fn as_str(&self) -> &'static str {
        match self {
            DeviceKeyConsent::None => "none",
            DeviceKeyConsent::Consented => "consented",
            DeviceKeyConsent::LegacyFile => "legacy-file",
        }
    }
}

pub fn device_key_consent(data_dir: &Path) -> DeviceKeyConsent {
    let consented = data_dir.join(CONSENT_FILE).exists();
    let file_exists = data_dir.join(KEY_FILE).exists();
    match (consented, file_exists) {
        (true, _) => DeviceKeyConsent::Consented,
        (false, true) => DeviceKeyConsent::LegacyFile,
        (false, false) => DeviceKeyConsent::None,
    }
}

pub fn keystore_fallback_used(data_dir: &Path) -> bool {
    data_dir.join("keystore-fallback.flag").exists()
}

/// 完成装配：建库、注入共享状态、启动本机通道/快捷键/空闲锁定。
/// 首次启动（setup）与"操作者在界面上确认之后"（`commands::devicekey::grant_device_key_fallback`）
/// 共用这一条路径，保证两条路走出来的运行时完全一致。重复调用直接返回已装配的状态。
pub fn finish_boot(app: &tauri::AppHandle, data_dir: PathBuf, db_key: SecretBytes) -> Result<SharedCore> {
    if let Some(core) = state::try_core() {
        return Ok(core);
    }
    let db = Db::open(&data_dir.join(DB_FILE), db_key.as_slice())?;
    let core: SharedCore = Arc::new(AppCore::new(db, db_key, data_dir));
    core.set_app_handle(app.clone());
    app.manage(core.clone());
    state::set_global_core(core.clone());

    // 运维排查用的两行事实：库结构版本、是否已初始化。只报版本号和人数，不碰任何内容。
    // 必须先放开连接锁再调 user_count：conn 锁是非可重入的，嵌套加锁会自锁。
    let schema_version = {
        let conn = core.db.lock_conn();
        crate::db::migrate::version(&conn)
    };
    match (schema_version, crate::auth::users::user_count(&core.db)) {
        (Ok(v), Ok(n)) => log::info!("数据库已就绪：schema v{v}，本地使用者 {n} 名"),
        (v, n) => log::warn!("数据库状态读取失败：version={v:?} users={n:?}"),
    }

    // 本机通道：宿主进程据此找到桌面端
    if let Err(e) = ipc::start(core.clone()) {
        log::warn!("本机通道未启动：{}", e.code());
    }
    // 局域网更新通道：发现线程常驻；托管服务仅在开关打开时监听
    lan::start(&core);
    // 启动器窗口预先创建（隐藏），保证快捷键第一下就能唤起
    let _ = launcher::ensure_window(app);
    if let Some(accel) = launcher::bootstrap(app, &core) {
        log::info!("全局快捷键已注册：{accel}");
    }
    spawn_idle_lock(core.clone());
    Ok(core)
}

/// 安全策略出厂默认值的**契约声明**：唯一真正写入的地方是迁移 SQL
/// （`migrations/0002_seed.sql` + `0003_policy_defaults.sql`）。两处各写一份曾经漂移
/// （clipboard_clear_after_seconds 在 SQL 里是 30、在 Rust 里是 20），所以键与取值
/// 由 `tests::factory_defaults_match_migration_sql` 双向校验，启动流程不再重复 seed。
#[cfg(test)]
pub(crate) const DEFAULT_SETTINGS: &[(&str, &str)] = &[
    ("session_idle_timeout_minutes", "10"),
    ("lock_on_system_sleep", "true"),
    ("master_password_min_length", "12"),
    ("max_failed_login_attempts", "5"),
    ("lockout_seconds", "300"),
    ("allow_insecure_protocols", "false"),
    ("accounts_allow_copy_password", "true"),
    ("copy_password_requires_reauth", "false"),
    ("reveal_requires_reauth", "true"),
    ("export_requires_reauth", "false"),
    ("secret_visible_seconds", "10"),
    ("clipboard_clear_after_seconds", "30"),
    ("reauth_window_seconds", "120"),
    ("quick_launcher_enabled", "true"),
    ("quick_launcher_show_recent", "true"),
    ("quick_launcher_rank_recent_favorite", "true"),
    ("quick_launcher_fill_enabled", "true"),
    ("quick_launcher_result_limit", "20"),
    ("update_channel", "stable"),
    ("update_source_url", ""),
    ("extension_id", ""),
    ("lan_discovery_enabled", "true"),
    ("lan_serve_enabled", "false"),
    ("lan_serve_dir", ""),
    ("lan_manual_source", ""),
];

fn sleep_gap_detected(wall_gap_secs: u64, tick_secs: u64) -> bool {
    wall_gap_secs >= tick_secs * 4
}

/// 后台会话守卫：每 30 秒检查空闲超时；空闲超时或检测到休眠间隔即锁定保险库。
fn spawn_idle_lock(core: SharedCore) {
    const TICK_SECS: u64 = 30;
    std::thread::spawn(move || {
        let tick = std::time::Duration::from_secs(TICK_SECS);
        let mut last = std::time::SystemTime::now();
        loop {
            std::thread::sleep(tick);
            let now = std::time::SystemTime::now();
            // 系统时钟被向回调时 duration_since 会报错，按"无间隔"处理，绝不能用它去判超时。
            let gap = now.duration_since(last).unwrap_or(std::time::Duration::ZERO).as_secs();
            last = now;
            if !core.vault.is_unlocked() {
                continue;
            }
            if sleep_gap_detected(gap, TICK_SECS) && settings::get_bool(&core.db, "lock_on_system_sleep", true) {
                core.lock_down();
                let _ = crate::audit::record(&core.db, None, "session.sleep_lock", Some("session"), None, "success", None, Some("system"));
                continue;
            }
            if core.check_session().is_err() {
                let _ = crate::audit::record(&core.db, None, "session.auto_lock", Some("session"), None, "success", None, Some("system"));
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 二次启动只把已有窗口拉到前台，不重复打开数据库
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            ShortcutBuilder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let Some(core) = app.try_state::<SharedCore>() else { return };
                    let registered = shortcut.to_string();
                    if crate::quick_launcher::shortcut::equivalent(&registered, &core.shortcut.lock()) {
                        crate::launcher::toggle(app, &core);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // 这里**绝不**向 Tauri 返回 Err。装配失败时窗口其实已经建好了（Tauri 在调用本钩子之前就按配置建窗），
            // 而返回 Err 会变成 `App::run_return` 里的一句 panic；本项目 release 是 `panic = "abort"`，
            // 于是"数据目录不可用""库打不开""迁移失败"这些可恢复故障统一表现为进程消失、运维查不到原因。
            // 现在改为挂一条 BootFailure 并让事件循环继续：界面第一句就问它，问到就渲染失败页（含错误码与数据目录）。
            // 窗口形态先办：Windows/Linux 在这一步去框（配置里那两行 titleBarStyle/hiddenTitle
            // 是 macOS 专属，另两端不处理就会顶着系统标题栏与自绘顶栏叠成两条）。
            // 它不依赖装配结果，所以放在最前面，且失败只记日志。
            window_chrome::apply(app.handle());
            let handle = app.handle().clone();
            let data_dir = match resolve_data_dir(&handle) {
                Ok(d) => d,
                Err(e) => {
                    log::error!("启动阶段解析数据目录失败（{}）：{}", e.code(), e);
                    app.manage(BootFailure::new(BootFailure::STAGE_DATA_DIR, &e, None));
                    return Ok(());
                }
            };
            std::env::set_var("MDA_DATA_DIR", &data_dir);
            // 系统安全存储不可用时绝不静默写本机密钥文件：先只探测，装配留到操作者显式同意之后
            // （界面走 commands::devicekey）。其余失败一律挂成可见的启动失败页，不再带走进程。
            match bootstrap_for_startup(&data_dir) {
                Ok(db_key) => {
                    if let Err(e) = finish_boot(&handle, data_dir.clone(), db_key) {
                        log::error!("启动阶段装配保险库失败（{}）：{}", e.code(), e);
                        app.manage(BootFailure::new(BootFailure::STAGE_ASSEMBLY, &e, Some(&data_dir)));
                    }
                }
                Err(AppError::DeviceKeyConsentRequired) => {
                    // 走到这里说明本机还没有密钥文件。区分两种问法：全新安装只是"要不要按本包
                    // 默认把主密钥放成 0600 文件"；有库无密钥则是"要不要把系统安全存储里那把旧的搬过来"。
                    let legacy_vault = data_dir.join(DB_FILE).exists();
                    let reason = if legacy_vault {
                        PendingDeviceKey::REASON_LEGACY_VAULT
                    } else {
                        PendingDeviceKey::REASON_FRESH
                    };
                    log::warn!("本机尚无密钥文件（原因={reason}）：等待操作者显式确认后才会写入，未获得同意前不访问也不写入任何密钥存放位置");
                    app.manage(PendingDeviceKey { data_dir, reason });
                }
                Err(e) => {
                    log::error!("启动阶段取用数据库密钥失败（{}）：{}", e.code(), e);
                    app.manage(BootFailure::new(BootFailure::STAGE_DEVICE_KEY, &e, Some(&data_dir)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot::boot_failure_status,
            commands::vault::vault_status,
            commands::vault::vault_initialize,
            commands::vault::password_strength,
            commands::vault::login_profile,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::reauthenticate,
            commands::vault::change_master_password,
            commands::vault::update_own_nickname,
            commands::vault::list_app_users,
            commands::vault::list_roles,
            commands::vault::create_app_user,
            commands::vault::set_user_status,
            commands::vault::admin_reset_password,
            commands::vault::keystore_diagnostics,
            commands::rbac::my_permissions,
            commands::rbac::list_permissions,
            commands::rbac::list_roles_admin,
            commands::menus::list_menu_nodes,
            commands::menus::create_menu_node,
            commands::menus::rename_menu_node,
            commands::menus::move_menu_node,
            commands::menus::set_menu_node_status,
            commands::menus::delete_menu_node,
            commands::rbac::create_role,
            commands::rbac::update_role,
            commands::rbac::delete_role,
            commands::rbac::set_role_action_permissions,
            commands::rbac::set_role_menu_permissions,
            commands::rbac::set_user_roles,
            commands::devicekey::device_key_consent_status,
            commands::devicekey::grant_device_key_fallback,
            commands::devicekey::decline_and_exit,
            commands::accounts::vault_stats,
            commands::accounts::list_targets,
            commands::accounts::list_targets_paged,
            commands::accounts::list_groups,
            commands::accounts::list_item_tags,
            commands::accounts::recent_access,
            commands::accounts::create_group,
            commands::accounts::target_items,
            commands::accounts::target_detail,
            commands::accounts::item_detail,
            commands::accounts::find_similar_targets,
            commands::accounts::create_target,
            commands::accounts::update_target,
            commands::accounts::set_target_status,
            commands::accounts::soft_delete_target,
            commands::accounts::create_item,
            commands::accounts::update_item,
            commands::accounts::set_item_status,
            commands::accounts::soft_delete_item,
            commands::accounts::list_deleted_items,
            commands::accounts::restore_item,
            commands::accounts::set_favorite,
            commands::accounts::set_default_credential,
            commands::accounts::reveal_secret,
            commands::accounts::copy_username,
            commands::accounts::copy_password,
            commands::launcher::quick_search,
            commands::launcher::quick_action,
            commands::launcher::open_target,
            commands::launcher::open_and_fill,
            commands::launcher::connect_target,
            commands::launcher::launcher_preferences,
            commands::launcher::set_launcher_shortcut,
            commands::launcher::set_launcher_enabled,
            commands::launcher::launcher_visibility,
            commands::external_tools::list_external_tools,
            commands::external_tools::set_external_tool,
            commands::external_tools::upsert_database_tool,
            commands::external_tools::delete_external_tool,
            commands::system::get_settings,
            commands::system::window_chrome,
            commands::system::update_setting,
            commands::system::get_theme,
            commands::system::set_theme,
            commands::system::set_reduce_motion,
            commands::system::list_custom_themes,
            commands::system::add_custom_theme,
            commands::system::delete_custom_theme,
            commands::system::security_status,
            commands::system::list_audit_events,
            commands::system::create_backup,
            commands::system::list_backups,
            commands::system::verify_backup,
            commands::system::restore_backup,
            commands::system::system_info,
            commands::system::extension_channel_status,
            commands::data::import_template,
            commands::data::import_preview,
            commands::data::import_commit,
            commands::data::container_preview,
            commands::data::container_commit,
            commands::data::export_preview,
            commands::data::export_commit,
            commands::data::check_update,
            commands::data::download_update,
            commands::data::install_update,
            commands::data::extension_host_status,
            commands::data::extension_host_install,
            commands::data::extension_host_uninstall,
            commands::lan::lan_status,
            commands::lan::lan_set_serve,
            commands::lan::lan_check,
            commands::lan::lan_download,
        ])
        .build(tauri::generate_context!())
        .expect("启动失败：无法构建应用")
        .run(move |app, event| match event {
            RunEvent::Exit => {
                lan::stop();
                if let Some(core) = app.try_state::<SharedCore>() {
                    core.lock_connections();
                    ipc::remove_channel_file(&core.data_dir);
                } else if let Ok(dir) = std::env::var("MDA_DATA_DIR") {
                    ipc::remove_channel_file(Path::new(&dir));
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 降级标记必须真实反映落盘事实：界面据此显示"未使用系统安全存储"，
    /// 没有标记文件时绝不能报出降级告警，也不能反过来隐瞒。
    #[test]
    fn keystore_fallback_flag_tracks_marker_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!keystore_fallback_used(dir.path()));
        std::fs::write(dir.path().join("keystore-fallback.flag"), b"file-0600").unwrap();
        assert!(keystore_fallback_used(dir.path()));
        std::fs::remove_file(dir.path().join("keystore-fallback.flag")).unwrap();
        assert!(!keystore_fallback_used(dir.path()));
    }

    /// 没拿到显式同意之前，一个字节都不许写：这是"不得静默降级/不得留下明文备份密钥"的硬边界。
    #[test]
    fn device_key_file_requires_explicit_consent_before_any_write() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_or_create_device_key_file(dir.path(), false).unwrap_err();
        assert_eq!(err.code(), "DEVICE_KEY_CONSENT_REQUIRED");
        assert_eq!(device_key_consent(dir.path()), DeviceKeyConsent::None);
        assert!(!dir.path().join(KEY_FILE).exists(), "未同意不得写出密钥文件");
        assert!(!dir.path().join("keystore-fallback.flag").exists());
        assert!(!dir.path().join(CONSENT_FILE).exists());
        // 目录里除了 tempdir 自身不该多出任何文件
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    /// 设备密钥决策表：`vault.db` 一旦存在，任何"新建一把密钥"的分支都不许走。
    /// 换掉设备密钥 = 已有保险库永久无法解密，这是不可逆损毁，所以逐格钉住。
    /// 本包按操作者的决定把本机 0600 文件密钥作为默认存放位置，系统安全存储只在
    /// "库已在、本机没有文件密钥"这一格被读一次（旧存放位置迁移），所以判定仍是纯函数。
    #[test]
    fn key_source_decision_never_rekeys_an_existing_vault() {
        use KeyDecision::*;
        // 本机已有文件密钥：无条件用它，连"保险库在不在"都不参与判断（这条分支不读钥匙串）
        assert_eq!(decide_key_source(true, false), UseDeviceKeyFile);
        assert_eq!(decide_key_source(true, true), UseDeviceKeyFile);
        // 全新安装：既没有文件密钥也没有库 → 只能先要显式同意，不许碰系统安全存储
        assert_eq!(decide_key_source(false, false), ConsentRequired);
        // 库在、本机没有文件密钥 → 这是旧存放位置（系统安全存储）建的库，唯一允许读钥匙串的一格
        assert_eq!(decide_key_source(false, true), TryMigrateFromKeystore);
    }

    /// 钥匙串访问点必须只有一个，而且只能在迁移那一格；写入路径一个字节都不许留。
    /// 为什么用源码文本断言而不是跑出来看：真实分支会碰系统安全存储（未签名构建会弹授权框），
    /// 测试里没法摆出"钥匙串里有一把旧密钥"这个状态，而"换包首启不再弹窗"正是本次改动的验收点。
    /// 被匹配的字符串一律用 format! 拼：字面量写在这里会被 include_str! 自己读进去，断言就恒假。
    #[test]
    fn production_source_has_no_keystore_writes() {
        let lib = include_str!("lib.rs");
        let load = format!("keystore::{}(", "load_db_key");
        assert_eq!(
            lib.matches(&load).count(),
            1,
            "lib.rs 里只该有一次钥匙串读取（迁移那一格），多一处就多一个授权框"
        );
        for name in ["store_db_key", "generate_and_store", "is_available"] {
            let call = format!("keystore::{name}(");
            assert!(!lib.contains(&call), "lib.rs 不得再调用 {name}()：写入与探针都会弹授权框");
        }
        // 整个 crates 的钥匙串侧只剩"读"：写入 API 一旦出现，未签名构建就会再来一次授权框。
        let keystore_rs = include_str!("crypto/keystore.rs");
        assert!(!keystore_rs.contains(".set_password("), "钥匙串侧只读：不得再有写入调用");
        assert!(!keystore_rs.contains(".delete_credential("), "钥匙串侧只读：不得删条目（旧条目是唯一的回滚凭据）");
        // 界面每次拉诊断都会走到 commands/*，那里任何一次探针都等于把弹窗从启动页赶进设置页。
        for file in ["commands/mod.rs", "commands/vault.rs", "commands/system.rs", "commands/devicekey.rs"] {
            let src = std::fs::read_to_string(format!("{}/src/{}", env!("CARGO_MANIFEST_DIR"), file))
                .unwrap_or_else(|e| panic!("读 {file} 失败：{e}"));
            assert!(!src.contains("is_available"), "{file} 不得再探测系统安全存储可用性（探针会写临时条目＝弹授权框）");
        }
    }

    /// 迁移分支：同意后把系统安全存储里那把旧密钥原样落成 0600 文件，字节必须一致；
    /// 未同意时一个字节都不许写。
    #[test]
    fn migrated_key_is_written_as_0600_only_after_consent() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = crate::crypto::random_key();
        let err = store_migrated_device_key(dir.path(), legacy.clone(), false).unwrap_err();
        assert_eq!(err.code(), "DEVICE_KEY_CONSENT_REQUIRED");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "未同意不得留下任何文件");

        std::fs::write(dir.path().join(DB_FILE), b"placeholder-encrypted-vault").unwrap();
        let got = store_migrated_device_key(dir.path(), legacy.clone(), true).unwrap();
        assert_eq!(got.as_slice(), legacy.as_slice(), "迁移必须原样搬那把旧密钥，不能换成新生成的");
        assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), legacy.as_slice());
        assert!(keystore_fallback_used(dir.path()));
        assert_eq!(device_key_consent(dir.path()), DeviceKeyConsent::Consented);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(KEY_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "迁移出来的密钥文件必须只有属主可读写");
        }
    }

    /// 两个存放位置同时有密钥时，绝不用钥匙串那把覆盖本机文件——覆盖等于锁死以文件密钥建的那份库。
    #[test]
    fn migration_never_overwrites_an_existing_file_key() {
        let dir = tempfile::tempdir().unwrap();
        let current = crate::crypto::random_key();
        std::fs::write(dir.path().join(KEY_FILE), current.as_slice()).unwrap();
        let err = store_migrated_device_key(dir.path(), crate::crypto::random_key(), true).unwrap_err();
        assert_eq!(err.code(), "DEVICE_KEY_LOST_VAULT_INTACT");
        assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), current.as_slice(), "原有密钥文件必须一字不变");
        assert!(!dir.path().join(CONSENT_FILE).exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "只该有原来那个密钥文件");
    }

    /// 已经拿到"显式同意"也不许给现存保险库新建文件密钥：同意的是"降级存放方式"，
    /// 不是"把旧库锁死"。上游决策表之外再守一道，防止以后有人直接调这个写文件函数。
    #[test]
    fn consented_file_key_creation_is_refused_while_a_vault_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DB_FILE), b"placeholder-encrypted-vault").unwrap();
        let err = load_or_create_device_key_file(dir.path(), true).unwrap_err();
        assert_eq!(err.code(), "DEVICE_KEY_LOST_VAULT_INTACT");
        assert!(!dir.path().join(KEY_FILE).exists(), "拒绝换密钥时不得写出任何密钥文件");
        assert!(!dir.path().join(CONSENT_FILE).exists());
        assert!(!dir.path().join("keystore-fallback.flag").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "目录里只该有那个 vault.db");
    }

    /// 同意之后：0600 密钥文件 + 降级标记 + 同意记录，三者齐全；同意记录里不得有密钥材料。
    #[test]
    fn explicit_consent_writes_0600_key_and_records_consent() {
        let dir = tempfile::tempdir().unwrap();
        let key = load_or_create_device_key_file(dir.path(), true).unwrap();
        assert_eq!(key.as_slice().len(), crate::crypto::KEY_LEN);
        let raw = std::fs::read(dir.path().join(KEY_FILE)).unwrap();
        assert_eq!(raw, key.as_slice());
        assert!(keystore_fallback_used(dir.path()));
        assert_eq!(device_key_consent(dir.path()), DeviceKeyConsent::Consented);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(KEY_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "密钥文件必须只有属主可读写");
        }
        // 同意记录只是一个时间戳，不含密钥材料
        let record = std::fs::read(dir.path().join(CONSENT_FILE)).unwrap();
        assert!(record.len() <= 40);
        assert!(!record.contains(&0u8));
        assert!(!record.windows(8).any(|w| w == &raw[..8]), "同意记录里不得出现密钥");
    }

    /// 加设闸门之前留下的库（或从旧版本升级）不能被锁死：文件照常可读，但必须如实标注为未经同意的遗留降级。
    #[test]
    fn legacy_key_file_still_opens_and_is_flagged_as_unconsented() {
        let dir = tempfile::tempdir().unwrap();
        let existing = crate::crypto::random_key();
        std::fs::write(dir.path().join(KEY_FILE), existing.as_slice()).unwrap();
        let got = load_or_create_device_key_file(dir.path(), false).unwrap();
        assert_eq!(got.as_slice(), existing.as_slice());
        assert_eq!(device_key_consent(dir.path()), DeviceKeyConsent::LegacyFile);
        assert!(!dir.path().join(CONSENT_FILE).exists(), "读旧文件不等于补写同意记录");
    }

    /// 一次同意管后续：文件已存在时不再询问，且长度不对的文件要被拒而不是被覆盖。
    #[test]
    fn consent_is_needed_once_and_truncated_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_device_key_file(dir.path(), true).unwrap();
        // 第二次没有再给同意也必须成功（闸门只管"新建"）
        let again = load_or_create_device_key_file(dir.path(), false).unwrap();
        assert_eq!(again.as_slice(), first.as_slice());
        // 被截断的密钥文件：报错，绝不原地重新生成（重新生成等于销毁已有库）
        std::fs::write(dir.path().join(KEY_FILE), b"too-short").unwrap();
        let err = load_or_create_device_key_file(dir.path(), true).unwrap_err();
        assert_eq!(err.code(), "CRYPTO_ERROR");
        assert_eq!(std::fs::read(dir.path().join(KEY_FILE)).unwrap(), b"too-short");
    }

    /// 休眠判定只看「墙上时间跳跃 vs 定时间隔」：正常 tick 抖动不该锁，
    /// 真正的睡眠/挂起（跳跃远大于间隔）必须锁。
    #[test]
    fn sleep_gap_detection_needs_a_clear_jump() {
        assert!(!sleep_gap_detected(30, 30), "正常一次 tick 不算休眠");
        assert!(!sleep_gap_detected(59, 30), "定时线程被延迟一两个周期不算休眠");
        assert!(sleep_gap_detected(120, 30), "4 个周期以上的空洞说明进程根本没在跑");
        assert!(sleep_gap_detected(3600, 30));
        assert!(!sleep_gap_detected(0, 30), "时钟向回调时必须当作无间隔");
    }

    /// 出厂值必须真的被策略读到、而且管理员真的能改：曾经 seed 写 "max_failed_attempts"
    /// 而策略读 "max_failed_login_attempts"，出厂配置成了永不生效的孤儿行。
    #[test]
    fn every_seeded_default_is_read_and_admin_editable() {
        use crate::commands::system::UPDATABLE_SETTINGS;
        let d = Db::open_in_memory(&vec![41u8; 32]).unwrap();
        for (k, v) in DEFAULT_SETTINGS {
            assert!(UPDATABLE_SETTINGS.contains(k), "{k} 是出厂键却不在管理员可改白名单里");
            assert_eq!(settings::get(&d, k).unwrap().as_deref(), Some(*v), "{k} 的出厂值不是 {v}");
        }
        // 逐项核对读取侧的键名（写错一个字符，出厂值就等于没配）
        assert_eq!(settings::get_i64(&d, "session_idle_timeout_minutes", -1), 10);
        assert_eq!(settings::get_i64(&d, "max_failed_login_attempts", -1), 5);
        assert_eq!(settings::get_i64(&d, "lockout_seconds", -1), 300);
        assert_eq!(settings::get_i64(&d, "reauth_window_seconds", -1), 120);
        assert_eq!(settings::get_i64(&d, "clipboard_clear_after_seconds", -1), 30);
        assert_eq!(crate::auth::policy::min_length(&d), 12);
        assert!(settings::get_bool(&d, "lock_on_system_sleep", false));
        assert!(!settings::get_bool(&d, "copy_password_requires_reauth", true), "复制密码出厂不再要求再验一次主密码（交付方 2026-10-20）；机制与设置项都留着，管理员可随时打开");
        assert!(!settings::get_bool(&d, "export_requires_reauth", true), "出厂不再给含明文口令的导出设二次认证闸门（交付方 2026-10-19）");
        assert!(settings::get_bool(&d, "reveal_requires_reauth", false));
        assert!(!settings::get_bool(&d, "allow_insecure_protocols", true));
        assert!(settings::get_bool(&d, "accounts_allow_copy_password", false));
        assert_eq!(settings::get_i64(&d, "secret_visible_seconds", -1), 10);
        assert_eq!(settings::get_i64(&d, "quick_launcher_result_limit", -1), 20);
        assert!(settings::get_bool(&d, "quick_launcher_enabled", false));
        assert!(settings::get_bool(&d, "quick_launcher_show_recent", false));
        assert!(settings::get_bool(&d, "quick_launcher_rank_recent_favorite", false));
    }

    /// 出厂默认值只有迁移 SQL 一处来源；Rust 侧的声明必须与它逐字一致，
    /// 否则界面显示的策略值与数据库里真正生效的值会各说一套。
    #[test]
    fn factory_defaults_match_migration_sql() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations");
        let sql = format!(
            "{}\n{}\n{}\n{}",
            std::fs::read_to_string(dir.join("0002_seed.sql")).unwrap(),
            std::fs::read_to_string(dir.join("0003_policy_defaults.sql")).unwrap(),
            std::fs::read_to_string(dir.join("0004_extension_id_setting.sql")).unwrap(),
            std::fs::read_to_string(dir.join("0013_lan_update.sql")).unwrap(),
        );
        for (k, v) in DEFAULT_SETTINGS {
            let spaced = format!("('{k}', '{v}'");
            let compact = format!("('{k}','{v}'");
            assert!(sql.contains(&spaced) || sql.contains(&compact), "出厂键 {k}={v} 在迁移 SQL 里找不到（Rust 声明与 SQL 漂移）");
        }
        // 0002 里那个从未被读取的孤儿版本键必须被 0003 清掉（schema 版本以 schema_migrations 为准）
        let d = Db::open_in_memory(&vec![41u8; 32]).unwrap();
        assert!(settings::get(&d, "db_schema_version").unwrap().is_none(), "残留的 db_schema_version 会让人误以为是权威版本号");
        // 反向：SQL 不得种下 Rust 侧没声明、白名单里也没有的 security 键。
        // 先把 `', '` 归一成 `','`：SQL 里带空格的写法曾让这条过滤条件一行都没匹配上，
        // 反向校验实际上从未运行。
        let mut reverse_checked = 0usize;
        for line in sql.lines() {
            let flat = line.trim().replace(", ", ",");
            if !flat.starts_with("('") || !flat.contains(",'security'") {
                continue;
            }
            reverse_checked += 1;
            let rest = &flat[2..];
            let k = &rest[..rest.find('\'').unwrap_or(rest.len())];
            // 0003 已经把这条孤儿键删掉（上面单独断言），0002 的历史 INSERT 不参与校验
            if k == "db_schema_version" {
                continue;
            }
            assert!(DEFAULT_SETTINGS.iter().any(|(key, _)| *key == k) || crate::commands::system::UPDATABLE_SETTINGS.contains(&k),
                "迁移种下了 security 键 {k}，但既不在出厂声明也不在管理员可改白名单里");
        }
        // 这条断言保证反向校验真的在跑：过滤条件一旦失配（比如又多了个空格），它就成了摆设。
        assert!(reverse_checked >= 15, "反向校验只匹配到 {reverse_checked} 行 security INSERT，说明过滤条件已失效");
    }
}
