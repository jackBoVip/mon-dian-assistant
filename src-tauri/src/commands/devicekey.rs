//! 数据库主密钥的"本机 0600 文件密钥"必须经操作者显式同意。
//! 装配之前的界面只能通过这两个命令与本层交互：一个问"要不要同意"，一个提交同意。
//! 两者都不返回、也不记录任何密钥材料；密钥只在 Rust 层生成、写入并立即用于打开 SQLCipher 库。
//!
//! 本包默认就用本机文件密钥（不再把系统安全存储当首选存放位置），所以这里的同意闸门
//! 从"降级确认"变成了"默认存放位置的首次确认"——闸门本身一条没松。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

use crate::crypto::keystore;
use crate::error::{AppError, Result};
use crate::{bootstrap_db_key, device_key_consent, finish_boot, keystore_fallback_used, DeviceKeyConsent, PendingDeviceKey};

/// 并发点击「同意」的闸门：同一进程内只允许一次装配尝试。
static GRANTING: AtomicBool = AtomicBool::new(false);

struct GrantGuard;

impl Drop for GrantGuard {
    fn drop(&mut self) {
        GRANTING.store(false, Ordering::SeqCst);
    }
}

fn consent_from_dir(dir: &PathBuf) -> serde_json::Value {
    let consent = device_key_consent(dir);
    // 是否在用文件密钥只看本机标记，不再跑探针（探针会访问系统安全存储并可能弹授权框）。
    let using_file_key = !matches!(consent, DeviceKeyConsent::None) || keystore_fallback_used(dir);
    serde_json::json!({
        "consent": consent.as_str(),
        "keyFile": if using_file_key { KEY_FILE_NAME } else { "" },
        // 只是旧存放位置的名字，供界面说明"那份旧库的密钥原本放在哪"；纯字符串，不访问钥匙串。
        "legacyBackend": keystore::platform_backend(),
    })
}

/// 本机密钥文件名，与 `lib.rs` 里的 `KEY_FILE` 同一个字符串，界面文案要引用它。
const KEY_FILE_NAME: &str = "vault.device.key";

/// 当前是否需要操作者就"数据库主密钥落到本机文件"给出显式同意。
/// 已装配时读的是保险库数据目录；未装配时读的是启动阶段探测到的待确认状态。
#[tauri::command]
pub fn device_key_consent_status(app: AppHandle) -> serde_json::Value {
    if let Some(core) = crate::state::try_core() {
        let mut v = consent_from_dir(&core.data_dir);
        v["needed"] = serde_json::Value::Bool(false);
        v["reason"] = serde_json::Value::String(PendingDeviceKey::REASON_FRESH.to_string());
        return v;
    }
    match app.try_state::<PendingDeviceKey>() {
        Some(pending) => {
            let mut v = consent_from_dir(&pending.data_dir);
            v["needed"] = serde_json::Value::Bool(true);
            v["reason"] = serde_json::Value::String(pending.reason.to_string());
            v
        }
        // 既没装配也没有待确认状态：按不需要处理，界面会照常走 vault_status 并报出真实错误。
        None => serde_json::json!({
            "needed": false,
            "reason": PendingDeviceKey::REASON_FRESH,
            "consent": DeviceKeyConsent::None.as_str(),
            "keyFile": "",
            "legacyBackend": keystore::platform_backend(),
        }),
    }
}

/// 操作者在界面上明确选择"使用本机 0600 文件密钥"之后调用。
/// 全新安装时在这里生成新密钥并落文件；旧库迁移时在这里把系统安全存储里那把原样搬过来。
#[tauri::command]
pub fn grant_device_key_fallback(app: AppHandle) -> Result<()> {
    if crate::state::try_core().is_some() {
        return Ok(());
    }
    let Some(pending) = app.try_state::<PendingDeviceKey>() else {
        return Err(AppError::Internal);
    };
    let data_dir = pending.data_dir.clone();
    let reason = pending.reason;
    if GRANTING.swap(true, Ordering::SeqCst) {
        // 另一次同意请求正在装配中：直接返回成功，界面随后会重新拉取状态。
        return Ok(());
    }
    let _guard = GrantGuard;
    // consent=true：这条路径的唯一入口就是界面上的显式确认，未确认时启动阶段不会走到这里。
    let db_key = bootstrap_db_key(&data_dir, true)?;
    let core = finish_boot(&app, data_dir.clone(), db_key)?;
    // 同意后必须真的落到文件密钥上；报"unknown"说明标记文件没写上，界面会显示成无同意记录。
    let used_file_key = keystore_fallback_used(&data_dir);
    log::warn!(
        "已按操作者的显式同意完成装配：数据库主密钥来源={}，询问理由={reason}，数据目录已就绪",
        if used_file_key { "本机文件密钥" } else { "未标记（异常）" }
    );
    let _ = crate::audit::record(
        &core.db,
        None,
        "system.device_key.consent",
        Some("device"),
        Some(if used_file_key { "local-file-0600" } else { "unknown" }),
        "success",
        None,
        Some("app"),
    );
    Ok(())
}

/// 不同意时唯一诚实的出口：不写任何密钥文件，直接退出进程。
/// 不夹带任何参数、路径或秘密。
#[tauri::command]
pub fn decline_and_exit(app: AppHandle) {
    log::warn!("操作者不同意把数据库主密钥落到本机文件，未写入任何密钥文件：进程退出");
    app.exit(0);
}
