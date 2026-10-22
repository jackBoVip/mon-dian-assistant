//! 数据搬运与更新类命令：导入/导出/模板/更新/浏览器宿主清单。
//! 与主界面共用同一套鉴权：权限一律由 rbac::require 校验，敏感动作要求近期二次认证。

use std::collections::HashMap;
use std::path::Path;

use super::{audit, user};
use crate::error::{AppError, Result};
use crate::importexport::{self, TargetLookup};
use crate::rbac::{self, perm};
use crate::state::AppCore;

fn lk_of(core: &AppCore) -> Result<TargetLookup> {
    core.vault
        .with_index(|i| TargetLookup::new(i.target_hints()))
        .map(|lk| lk)
}

/// 含秘密导出的二次认证门，由 export_requires_reauth 策略决定（交付方 2026-10-19 起出厂为 false，
/// 即点「确认导出」直接落盘；键改回 true 这道门就重新生效，且拦的是后端而不是"前端记得问一句"）。
/// 必须真的读这个键：否则管理员在界面上看到"已禁用"，后端却依旧拦人，
/// 设置项就成了只显示用处的孤儿键（reveal/copy 两项走的是同一套判定）。
fn gate_export_reauth(core: &AppCore, include_secrets: bool) -> Result<()> {
    if include_secrets && crate::settings::get_bool(&core.db, "export_requires_reauth", false) {
        // 后端自己校验，不依赖前端"记得"先做一次 reauthenticate。
        core.require_reauth()?;
    }
    Ok(())
}

#[tauri::command]
pub fn import_template() -> Result<serde_json::Value> {
    Ok(serde_json::json!({
        "csv": importexport::template_csv(),
        "columns": importexport::IMPORT_COLUMNS,
        "note": "模板不含任何真实凭据。含秘密的迁移请使用『导出为加密容器』后再由接收方导入。",
    }))
}

#[tauri::command]
pub fn import_preview(path: String) -> Result<importexport::ImportPreview> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::ACC_IMPORT)?;
    let p = Path::new(&path);
    // 容器那一侧形状完全不同，走错入口要等一次 Argon2id 派生才失败，所以只在门口挡掉它。
    // 其余一律交给内容识别：CSV 与 xlsx 由文件头的字节形状判定，比后缀名可信
    // （交付方要求"导入自动识别格式"）。
    if is_container_path(p) {
        return Err(AppError::FileFormatInvalid);
    }
    let lk = lk_of(&core)?;
    let preview = importexport::import_preview(&core.db, &actor, p, &lk)?;
    audit(&core, Some(&actor), "accounts.import.preview", Some("file"), Some(&preview.filename), true, None, "app");
    Ok(preview)
}

#[tauri::command]
pub fn import_commit(
    job_id: String,
    conflict_policy: String,
    defaults: Option<HashMap<String, String>>,
) -> Result<importexport::ImportCommitResult> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::ACC_IMPORT)?;
    let policy = conflict_policy.as_str();
    if !matches!(policy, "skip" | "update" | "abort") {
        return Err(AppError::InvalidInput);
    }
    let default_type = defaults.as_ref().and_then(|d| d.get("targetType")).cloned();
    let lk = lk_of(&core)?;
    let res = core.vault.with_vk(|vk| {
        importexport::import_commit(&core.db, vk, &actor, &job_id, None, policy, default_type.as_deref(), &lk)
    })?;
    core.rebuild_index()?;
    audit(
        &core,
        Some(&actor),
        "accounts.import.commit",
        Some("import_job"),
        Some(&job_id),
        true,
        None,
        "app",
    );
    Ok(res)
}

/// 只认 `.mdaexport`。容器与 CSV 的形状完全不同，走错入口要等一次 Argon2id 派生才失败，
/// 白让界面卡住几百毫秒，所以扩展名在门口就挡掉。
fn is_container_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("mdaexport")) == Some(true)
}

/// 容器预览：口令只用于本机派生密钥，绝不入库、不进审计、不回显。
/// 预览产物里只有行数、冲突行号与文件摘要，没有任何秘密字段。
#[tauri::command]
pub fn container_preview(path: String, passphrase: String) -> Result<importexport::ContainerPreview> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::ACC_IMPORT)?;
    let p = Path::new(&path);
    if !is_container_path(p) {
        return Err(AppError::InvalidInput);
    }
    let lk = lk_of(&core)?;
    let pw = zeroize::Zeroizing::new(passphrase);
    let preview = importexport::container_preview(&core.db, p, pw.as_str(), &lk)?;
    audit(&core, Some(&actor), "container.import.preview", Some("file"), Some(preview.filename.as_str()), true, None, "app");
    Ok(preview)
}

/// 容器提交：写 secrets 进保险库，所以和"含秘密导出"一样要近期二次认证。
/// 口令参数用完即 Zeroizing 清零；审计只记文件名与文件摘要。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCommitOpts {
    pub path: String,
    pub passphrase: String,
    pub fingerprint: String,
    pub conflict_policy: String,
}

#[tauri::command]
pub fn container_commit(opts: ContainerCommitOpts) -> Result<importexport::ImportCommitResult> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::ACC_IMPORT)?;
    core.require_reauth()?;
    let p = Path::new(&opts.path);
    if !is_container_path(p) {
        return Err(AppError::InvalidInput);
    }
    let lk = lk_of(&core)?;
    let pw = zeroize::Zeroizing::new(opts.passphrase);
    let res = core.vault.with_vk(|vk| {
        importexport::container_commit(&core.db, vk, &actor, p, pw.as_str(), &opts.fingerprint, &opts.conflict_policy, &lk)
    })?;
    core.rebuild_index()?;
    audit(&core, Some(&actor), "container.import.commit", Some("import_container"), Some(opts.fingerprint.as_str()), true, None, "app");
    Ok(res)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOpts {
    pub include_secrets: bool,
    #[serde(default)]
    pub target_ids: Option<Vec<String>>,
    /// csv | xlsx | container；缺省沿用旧语义（含秘密→容器、不含→CSV），
    /// 所以未传这一项的调用方产物不变。
    #[serde(default)]
    pub format: Option<String>,
    /// ledger | browser（Chrome/Edge 那五列）。缺省 ledger。
    #[serde(default)]
    pub shape: Option<String>,
}

#[tauri::command]
pub fn export_preview(opts: ExportOpts) -> Result<importexport::ExportPreview> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::ACC_EXPORT)?;
    gate_export_reauth(&core, opts.include_secrets)?;
    let ids = opts.target_ids.as_deref();
    core.vault.with_vk(|vk| {
        importexport::export_preview(
            &core.db,
            vk,
            &actor,
            opts.include_secrets,
            ids,
            opts.format.as_deref(),
            opts.shape.as_deref(),
        )
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCommitOpts {
    pub path: String,
    pub include_secrets: bool,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub target_ids: Option<Vec<String>>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub shape: Option<String>,
}

#[tauri::command]
pub fn export_commit(opts: ExportCommitOpts) -> Result<importexport::ExportResult> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::ACC_EXPORT)?;
    gate_export_reauth(&core, opts.include_secrets)?;
    let path = Path::new(&opts.path);
    let res = core.vault.with_vk(|vk| {
        importexport::export_commit(
            &core.db,
            vk,
            &actor,
            path,
            opts.include_secrets,
            opts.passphrase.as_deref(),
            opts.target_ids.as_deref(),
            opts.format.as_deref(),
            opts.shape.as_deref(),
        )
    })?;
    // 审计只记文件名与是否加密，绝不记口令，也绝不记文件内容
    let fname = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    audit(&core, Some(&actor), "accounts.export.commit", Some("file"), Some(fname.as_str()), true, None, "app");
    if opts.include_secrets {
        let _ = crate::audit::record(
            &core.db,
            Some(&actor),
            "accounts.export.with_secrets",
            Some("file"),
            None,
            "success",
            None,
            Some("app"),
        );
        // 交付方 2026-10-18 指定导出对齐 Chrome/Edge，于是多了"可读文件里带明文口令"这条出口。
        // 容器那条（format=mdaexport）没有这个后果，所以单独记一笔：审计要能区分
        // "留了一份加密产物"和"留了一份谁都能打开的产物"。
        if res.format != "mdaexport" {
            let _ = crate::audit::record(
                &core.db,
                Some(&actor),
                "accounts.export.plaintext_secrets",
                Some("file"),
                Some(fname.as_str()),
                "success",
                None,
                Some("app"),
            );
        }
    }
    Ok(res)
}

// —— 更新 ——

#[tauri::command]
pub fn check_update() -> Result<crate::update::UpdateInfo> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_UPDATE_CONFIG)?;
    crate::update::check(&core)
}

#[tauri::command]
pub fn download_update(app: tauri::AppHandle) -> Result<crate::update::UpdateInfo> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_UPDATE_INSTALL)?;
    core.require_reauth()?;
    crate::update::download(&core, &app)
}

#[tauri::command]
pub fn install_update() -> Result<crate::update::UpdateInfo> {
    let core = crate::state::core();
    crate::update::install(&core)
}

// —— 浏览器扩展宿主清单 ——

#[tauri::command]
pub fn extension_host_status() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_SECURITY)?;
    let prepared = crate::fill_host::prepare(&core);
    Ok(match prepared {
        Ok(v) => serde_json::json!({ "ready": true, "prepared": v, "channel": crate::commands::system::channel_state(&core) }),
        Err((code, reason)) => serde_json::json!({ "ready": false, "code": code, "reason": reason, "channel": crate::commands::system::channel_state(&core) }),
    })
}

#[tauri::command]
pub fn extension_host_install() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_SECURITY)?;
    core.require_reauth()?;
    crate::fill_host::install(&core)
}

#[tauri::command]
pub fn extension_host_uninstall() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let actor = user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_SECURITY)?;
    crate::fill_host::uninstall(&core)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::session::Session;
    use crate::crypto::SecretBytes;
    use crate::crypto::vault_key;
    use crate::db::Db;
    use crate::quick_launcher::search::SearchIndex;
    use std::sync::Arc;

    /// 已解锁、但未做二次认证的 core。窗口长度由设置项决定，测试里显式写死便于断言边界。
    fn unlocked_core(window_seconds: i64) -> AppCore {
        let db = Db::open_in_memory(&vec![41u8; 32]).unwrap();
        crate::settings::set(&db, "reauth_window_seconds", &window_seconds.to_string(), "security").unwrap();
        let core = AppCore::new(db, SecretBytes::new(vec![7u8; 32]), std::env::temp_dir());
        let now = chrono::Utc::now().timestamp();
        let vk = vault_key::initialize("Master#2026x", "u1", 1, &Default::default()).unwrap().0;
        core.vault.unlock(
            Session { id: "s-test".into(), user_id: "u1".into(), started_at: now, last_activity: now, reauth_at: None },
            Arc::new(vk),
            SearchIndex::new(vec![]),
        );
        core
    }

    #[test]
    fn export_gate_follows_the_policy_setting() {
        let core = unlocked_core(120);
        assert!(gate_export_reauth(&core, false).is_ok(), "不含秘密的导出不该要求二次认证");
        // 出厂为关（交付方 2026-10-19：导出去掉二次确认，直接导出）：没做过认证也放行
        assert!(gate_export_reauth(&core, true).is_ok(), "出厂策略下含秘密导出必须能直接导出");

        // 管理员显式打开：这道门必须真的拦人，否则界面显示"需要"而后端放行（反向孤儿键）
        crate::settings::set(&core.db, "export_requires_reauth", "true", "security").unwrap();
        assert!(matches!(gate_export_reauth(&core, true), Err(AppError::ReauthRequired)));
        core.vault.grant_reauth(chrono::Utc::now().timestamp());
        assert!(gate_export_reauth(&core, true).is_ok(), "刚通过二次认证应当放行");

        crate::settings::set(&core.db, "export_requires_reauth", "false", "security").unwrap();
        assert!(gate_export_reauth(&core, true).is_ok());
    }

    /// 曾经 grant_reauth 存"now+窗口"、判定又加一次窗口 ⇒ 实际有效期是配置值的两倍。
    #[test]
    fn reauth_window_is_exactly_the_configured_length() {
        let core = unlocked_core(120);
        crate::settings::set(&core.db, "export_requires_reauth", "true", "security").unwrap();
        let now = chrono::Utc::now().timestamp();
        core.vault.grant_reauth(now - 119);
        assert!(gate_export_reauth(&core, true).is_ok());
        core.vault.grant_reauth(now - 121);
        assert!(matches!(gate_export_reauth(&core, true), Err(AppError::ReauthRequired)), "超过配置的 120 秒窗口必须失效");
    }
}
