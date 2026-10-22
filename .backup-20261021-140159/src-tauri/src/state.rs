//! 进程内共享状态。数据库句柄、保险库密钥态、会话表、一次性票据表都只活在这一层。
//! 前端拿不到 DEK、拿不到数据库密钥、拿不到未授权的记录，权限一律在此之后由 Rust 再校验。

use crate::auth::session::{SessionStore, VaultState};
use crate::crypto::tokens::TicketStore;
use crate::db::Db;
use crate::error::{AppError, Result};
use crate::quick_launcher::query::ActionPolicy;
use crate::quick_launcher::search::SearchIndex;
use crate::db::repo;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct AppCore {
    pub db: Db,
    pub vault: Arc<VaultState>,
    pub sessions: Arc<SessionStore>,
    pub tickets: Arc<TicketStore>,
    /// 浏览器扩展/Native Messaging 通道是否就绪；未就绪时前端不得显示“打开并安全填充”
    pub extension_ready: Arc<AtomicBool>,
    /// 当前生效的全局快捷键（注册失败时保留旧值）
    pub shortcut: Arc<Mutex<String>>,
    /// 数据库主密钥（SQLCipher），只在 Rust 层持有，Drop 时清零
    pub db_key: Arc<crate::crypto::SecretBytes>,
    pub backup_dir: std::path::PathBuf,
    pub data_dir: std::path::PathBuf,
    /// 装配完成后注入；用于在锁定发生时主动通知窗口，而不是等前端下一次调用命令才发现。
    app_handle: std::sync::OnceLock<tauri::AppHandle>,
    /// 内存搜索索引是否需要重建。审查 F9：原先每条写命令都同步 `rebuild_index()`，
    /// 那是"全库遍历 + 逐条解密"，改一条凭据要为整个库付钱。
    /// 现在写命令只置这个标记，读索引前才重建（见 `ensure_index_fresh`）：
    /// 读侧拿到的内容仍然永远是最新的，代价从"每一次写"挪到"写之后的第一次读"。
    index_dirty: Arc<std::sync::atomic::AtomicBool>,
}

impl AppCore {
    pub fn new(db: Db, db_key: crate::crypto::SecretBytes, data_dir: std::path::PathBuf) -> Self {
        let backup_dir = data_dir.join("backups");
        Self {
            db_key: Arc::new(db_key),
            backup_dir,
            data_dir,
            db,
            vault: Arc::new(VaultState::default()),
            sessions: Arc::new(SessionStore::default()),
            tickets: Arc::new(TicketStore::default()),
            extension_ready: Arc::new(AtomicBool::new(false)),
            shortcut: Arc::new(Mutex::new(shortcut_default())),
            app_handle: std::sync::OnceLock::new(),
            index_dirty: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        let _ = self.app_handle.set(handle);
    }

    pub fn extension_ready(&self) -> bool {
        self.extension_ready.load(Ordering::Relaxed)
    }

    pub fn set_extension_ready(&self, v: bool) {
        self.extension_ready.store(v, Ordering::Relaxed);
    }

    pub fn idle_timeout_seconds(&self) -> i64 {
        crate::settings::get_i64(&self.db, "session_idle_timeout_minutes", 10) * 60
    }

    /// 会话过期检查：空闲超时即锁定，清空明文索引与密钥。
    pub fn check_session(&self) -> Result<String> {
        let user = self.vault.active_user().ok_or(AppError::Locked)?;
        let timeout = self.idle_timeout_seconds();
        let now = chrono::Utc::now().timestamp();
        let expired = self
            .vault
            .session_expired(timeout, now)
            .unwrap_or(true);
        if expired {
            self.lock_down();
            return Err(AppError::Locked);
        }
        self.vault.touch(now);
        Ok(user)
    }

    pub fn lock_down(&self) {
        if let Some(sid) = self.vault.session_id() {
            self.tickets.revoke_session(&sid);
        }
        self.vault.lock();
        // 明文已清零：立刻通知所有窗口，界面不能继续显示上一次解密出来的内容。
        // 事件不含任何数据，只表示「已进入锁定态」。
        use tauri::Emitter;
        if let Some(app) = self.app_handle.get() {
            let _ = app.emit("vault://locked", serde_json::json!({ "at": chrono::Utc::now().timestamp_millis() }));
        }
    }

    pub fn action_policy(&self) -> ActionPolicy {
        // 审查 F2：用户名明文与"查看秘密"共用一条权限，动作列表也必须按它裁剪，
        // 免得界面摆出一颗点了必然被 authorize 拒绝的动作。
        let can_copy_username = self
            .vault
            .active_user()
            .map(|u| crate::rbac::has_permission(&self.db, &u, crate::rbac::perm::ACC_VIEW_SECRET).unwrap_or(false))
            .unwrap_or(false);
        ActionPolicy {
            allow_copy_password: crate::settings::get_bool(&self.db, "accounts_allow_copy_password", true),
            // 兜底值必须与出厂种子同值（lib.rs 的 DEFAULT_SETTINGS + 0002/0008 迁移），
            // 否则"这一行不存在"的库与全新装的库会对同一个动作给出两种答案。
            require_reauth_for_password: crate::settings::get_bool(&self.db, "copy_password_requires_reauth", false),
            can_copy_username,
        }
    }

    pub fn require_reauth(&self) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        let window = crate::settings::get_i64(&self.db, "reauth_window_seconds", 120);
        if self.vault.reauth_fresh(window, now).unwrap_or(false) {
            Ok(())
        } else {
            Err(AppError::ReauthRequired)
        }
    }

    /// 写命令用这个代替全量重建：O(1)，不碰数据库，不解密任何东西。
    pub fn mark_index_dirty(&self) {
        self.index_dirty.store(true, Ordering::Relaxed);
    }

    /// 读索引之前调一次。脏才重建，干净就是几个原子的读。
    /// 注意调用位置：**必须在 `vault.with_index(..)` 回调之外**调，
    /// 回调里回碰 vault 状态或数据库锁会同线程死锁（见 auth/session.rs 的说明）。
    pub fn ensure_index_fresh(&self) -> Result<()> {
        if self.index_dirty.load(Ordering::Relaxed) {
            self.rebuild_index()?;
            self.index_dirty.store(false, Ordering::Relaxed);
        }
        Ok(())
    }

    /// 依据当前授权范围重建内存搜索索引（明文只存在于内存，锁定即清零）。
    pub fn rebuild_index(&self) -> Result<()> {
        let user = self.vault.active_user().ok_or(AppError::Locked)?;
        self.vault.with_vk(|vk| {
            let docs = repo::build_search_index(&self.db, vk, &user)?;
            self.vault.replace_index(SearchIndex::new(docs));
            self.index_dirty.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    /// 替换正在使用的数据库文件前，必须先关闭全部连接。
    pub fn lock_connections(&self) {
        self.db.dispose_connections();
    }
}

fn shortcut_default() -> String {
    crate::quick_launcher::shortcut::default_accelerator().to_string()
}

pub type SharedCore = Arc<AppCore>;

/// 进程内唯一的共享状态句柄。
///
/// Tauri 的命令参数只接受 `State<'_, T>` 等少数内置类型；本项目所有命令都要以
/// `Arc<AppCore>` 的语义把核心句柄传给内部函数（`&core` 既可是 `&Arc<AppCore>`
/// 也可是 `&AppCore`），因此命令层统一从这里取句柄，而不是让宏去反序列化 `Arc`。
/// 句柄在 `setup` 阶段写入且只写一次。绝大多数命令只有在装配完成后才可被调用；
/// 装配前也必须能应答的那几条（状态查询、外观）走 `core_or_await_consent`，见该函数说明。
static CORE: std::sync::OnceLock<SharedCore> = std::sync::OnceLock::new();

pub fn set_global_core(core: SharedCore) -> bool {
    CORE.set(core).is_ok()
}

/// 取共享状态；尚未装配时 panic。
/// release 下 panic 即 abort（进程直接没了），所以**只给"装配前绝不会被调到"的命令用**，
/// 界面在装配前就可能调用的那几条请用 `core_or_await_consent`。
pub fn core() -> SharedCore {
    CORE.get().cloned().expect("共享状态尚未初始化")
}

/// 装配前后可安全探测：未装配返回 None。
/// 只允许给"数据库密钥同意闸门"这类在装配之前就必须工作的命令使用。
pub fn try_core() -> Option<SharedCore> {
    CORE.get().cloned()
}

/// 装配之前也可能被界面调到、且必须给出**错误**而不是让进程挂掉的那类命令用这个。
///
/// `core()` 的 `expect` 在 release 下是 `panic → abort`：整个进程带着没关的连接一起没了。
/// 首次运行走到"本机文件密钥需显式同意"时数据库根本还没装配，而主窗口的挂载代码就在这
/// 个阶段读外观，于是一调用就自杀（实测 rc = -6 / SIGABRT），同意界面永远显示不出来。
/// 外观不属于秘密数据，未装配时如实回一个错误码即可，界面会用自己的默认值继续渲染。
pub fn core_or_await_consent() -> Result<SharedCore> {
    CORE.get().cloned().ok_or(AppError::DeviceKeyConsentRequired)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 装配前调 `core_or_await_consent` 必须回错误码。这条是 D4 的回归：
    /// `[profile.release] panic = "abort"` 下，`core()` 的 expect 等于让进程自杀，
    /// 全新数据目录 + 系统安全存储不可用时，主窗口挂载读外观就触发了它（实测 rc = -6），
    /// 结果"本机文件密钥需显式同意"的界面永远显示不出来。
    /// 依赖前提：测试进程里 `set_global_core` 永不被调用（它只在 `finish_boot` 里出现）。
    #[test]
    fn pre_assembly_handle_access_yields_error_code_not_a_panic() {
        assert!(try_core().is_none(), "测试进程不应装配全局状态");
        let err = match core_or_await_consent() {
            Err(e) => e,
            Ok(_) => panic!("未装配时必须回错误，而不是给出句柄"),
        };
        assert_eq!(err.code(), "DEVICE_KEY_CONSENT_REQUIRED");
    }

    /// 装配前界面真的会调的那两条命令，改走错误返回后不得 panic。
    /// `core()` 本身仍按设计 panic（这里用 `AssertUnwindSafe` + `catch_unwind` 把两种行为都钉住；
    /// dev profile 是 unwind，所以这条断言在测试里成立，release 下的真实后果由上面那条注释说明）。
    #[test]
    fn commands_callable_before_assembly_return_errors_while_core_still_asserts() {
        assert!(matches!(
            crate::commands::system::get_theme(),
            Err(AppError::DeviceKeyConsentRequired)
        ));
        assert!(matches!(
            crate::commands::vault::vault_status(),
            Err(AppError::DeviceKeyConsentRequired)
        ));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(core)).is_err();
        assert!(panicked, "core() 在未装配时按设计 panic，界面在装配前不该调它");
    }
}
