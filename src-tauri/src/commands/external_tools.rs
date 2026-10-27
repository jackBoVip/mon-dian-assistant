//! 外部工具档命令：浏览器/终端两枚固定档改路径，数据库档按引擎可增删。
//!
//! 全部走 `system.security.config`（与快捷启动器开关、安全策略同档）：改的是**本机所有使用者**
//! 共用的拉起目标，爆炸半径不比那些小。审计只记行 id 与动作，绝不记整条本机路径。

use super::{audit, Result};
use crate::error::AppError;
use crate::external_tools::{self, Kind, ToolView};
use crate::rbac::{self, perm};

#[tauri::command]
pub fn list_external_tools() -> Result<Vec<ToolView>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    external_tools::list(&core.db)
}

/// 改浏览器/终端那两枚固定档。`appPath` 传空串即清除 = 交回系统默认。
#[tauri::command]
pub fn set_external_tool(kind: String, app_path: String) -> Result<ToolView> {
    let slot = Kind::from_key(&kind).ok_or(AppError::InvalidInput)?;
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    let row = external_tools::set_fixed_path(&core.db, slot, &app_path)?;
    audit(&core, Some(&user), "system.tool.upsert", Some("external_tool"), Some(&row.id), true, None, "app");
    Ok(row.into())
}

/// 新增（`id` 为空）或修改一条数据库工具档。
#[tauri::command]
pub fn upsert_database_tool(id: Option<String>, engine: String, label: String, app_path: String) -> Result<ToolView> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    let row = external_tools::upsert_database(&core.db, id.as_deref(), &engine, &label, &app_path)?;
    audit(&core, Some(&user), "system.tool.upsert", Some("external_tool"), Some(&row.id), true, None, "app");
    Ok(row.into())
}

#[tauri::command]
pub fn delete_external_tool(id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    external_tools::delete_database(&core.db, &id)?;
    audit(&core, Some(&user), "system.tool.delete", Some("external_tool"), Some(&id), true, None, "app");
    Ok(())
}
