//! 局域网更新源命令层。
//!
//! 两条权限分开：查看发现结果要「更新源配置」，开放入站端口要「局域网更新源」。
//! 后者是运维暴露面，不该跟着前者顺带获得。

use crate::commands::audit;
use crate::error::{AppError, Result};
use crate::lan;
use crate::rbac::{self, perm};
use crate::settings;

#[tauri::command]
pub fn lan_status() -> Result<lan::LanStatus> {
    let core = crate::state::core();
    let actor = crate::commands::user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_UPDATE_CONFIG)?;
    Ok(lan::status(&core))
}

/// 开关「本机作为更新源」。开启前先跑一次托管目录自检，
/// 让「清单验不过」在这里就失败，而不是扩散到所有客户端。
#[tauri::command]
pub fn lan_set_serve(enabled: bool, dir: Option<String>) -> Result<lan::LanStatus> {
    let core = crate::state::core();
    let actor = crate::commands::user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_UPDATE_SERVE)?;

    if enabled {
        let d = dir.as_deref().map(str::trim).unwrap_or("");
        if d.is_empty() {
            return Err(AppError::InvalidInput);
        }
        lan::store::load(std::path::Path::new(d))?;
        settings::set(&core.db, "lan_serve_dir", d, "install")?;
    }
    settings::set(&core.db, "lan_serve_enabled", if enabled { "true" } else { "false" }, "install")?;
    lan::sync_serve(&core);

    audit(
        &core,
        Some(&actor),
        if enabled { "lan.serve.enable" } else { "lan.serve.disable" },
        Some("update"),
        None,
        true,
        None,
        "app",
    );
    Ok(lan::status(&core))
}

/// 从指定源（实例号或手填 IP:端口）或最优发现源拉清单并验签。
///
/// 与 `check_update` 同级权限：能看更新源的人就能检查更新。
#[tauri::command]
pub fn lan_check(source: Option<String>) -> Result<crate::update::UpdateInfo> {
    let core = crate::state::core();
    let actor = crate::commands::user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_UPDATE_CONFIG)?;
    let info = crate::update::check_lan(&core, source.as_deref())?;
    audit(
        &core,
        Some(&actor),
        "lan.update.check",
        Some("update"),
        info.lan_source.as_deref(),
        true,
        None,
        "app",
    );
    Ok(info)
}

/// 从局域网源下载更新包。与 HTTPS 下载同一套闸门：安装权限 + 二次认证。
#[tauri::command]
pub fn lan_download(app: tauri::AppHandle) -> Result<crate::update::UpdateInfo> {
    let core = crate::state::core();
    let actor = crate::commands::user(&core)?;
    rbac::require(&core.db, &actor, perm::SYS_UPDATE_INSTALL)?;
    core.require_reauth()?;
    crate::update::download(&core, &app)
}
