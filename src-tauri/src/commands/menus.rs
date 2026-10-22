//! 菜单管理命令。
//! 读导航对所有已解锁使用者开放（没有它连入口都画不出来）；写菜单仍需系统角色管理权限。

use super::audit;
use crate::error::Result;
use crate::menu::{self, MenuNode};
use crate::rbac::{self, perm};

#[tauri::command]
pub fn list_menu_nodes() -> Result<Vec<MenuNode>> {
    let core = crate::state::core();
    core.check_session()?;
    menu::list(&core.db)
}

#[tauri::command]
pub fn create_menu_node(label: String, page_key: String) -> Result<String> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    let id = menu::create(&core.db, &label, &page_key)?;
    audit(&core, Some(&admin), "system.menu.create", Some("menu_node"), Some(&id), true, None, "app");
    Ok(id)
}

#[tauri::command]
pub fn rename_menu_node(id: String, label: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    menu::rename(&core.db, &id, &label)?;
    audit(&core, Some(&admin), "system.menu.rename", Some("menu_node"), Some(&id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn move_menu_node(id: String, direction: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    menu::move_node(&core.db, &id, &direction)?;
    audit(&core, Some(&admin), "system.menu.move", Some("menu_node"), Some(&id), true, None, "app");
    Ok(())
}

/// 启停开关：交付方点名"无需验证"，所以这一条**不要求二次认证**——它只隐藏入口，
/// 不删数据、不改权限，且随时可以拨回来（回不来的那几枚由领域层挡住）。
/// 权限校验与审计照旧：能改菜单结构本身就要求 `system.role.manage`。
#[tauri::command]
pub fn set_menu_node_status(id: String, status: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    menu::set_status(&core.db, &id, &status)?;
    audit(&core, Some(&admin), "system.menu.status", Some("menu_node"), Some(&id), true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn delete_menu_node(id: String) -> Result<()> {
    let core = crate::state::core();
    let admin = core.check_session()?;
    rbac::require(&core.db, &admin, perm::SYS_ROLE_MANAGE)?;
    core.require_reauth()?;
    menu::delete(&core.db, &id)?;
    audit(&core, Some(&admin), "system.menu.delete", Some("menu_node"), Some(&id), true, None, "app");
    Ok(())
}
