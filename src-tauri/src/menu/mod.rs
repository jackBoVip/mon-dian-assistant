//! 菜单节点：导航入口的结构与启停。
//! 这里只决定入口是否出现，不授予任何页面或操作权限——真正的拒绝仍在命令层。

use crate::db::{repo, Db};
use crate::error::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const LABEL_MAX_CHARS: usize = 40;

/// 可绑定页面 → 父分组。账号中心是一级页，没有可挂的父组，故不在此表。
const BINDINGS: &[(&str, &str)] = &[
    ("users", "top.system"),
    ("roles", "top.system"),
    ("menus", "top.system"),
    ("permissions", "top.system"),
    ("audit", "top.system"),
    ("security", "gear.settings"),
    ("appearance", "gear.settings"),
    ("backup", "gear.settings"),
    ("update", "gear.settings"),
    ("tools", "gear.settings"),
    ("launcher", "gear.tools"),
];

/// 这两个分组名在界面上没有独立显示位，改名无法被兑现，直接拒绝。
const FIXED_GROUP_KEYS: &[&str] = &["gear.settings", "gear.tools"];

/// 这一页自己所在的落点。停用它的任何一条路径 = 操作者再也回不到本页。
const SELF_PAGE: &str = "menus";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuNode {
    pub id: String,
    pub node_key: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub page_key: Option<String>,
    pub kind: String,
    pub builtin: bool,
    pub status: String,
    pub sort_order: i64,
    /// 决定这个入口出不出现的菜单权限键。三枚旧键沿用，其余为 `menu.node.<node_key>`。
    pub perm_key: String,
}

/// 菜单节点的权限键：三枚历史键保持不动（后端命令与自锁守卫都在用），其余按节点派生。
pub fn perm_key_for(node_key: &str) -> String {
    match node_key {
        "top.accounts" => "menu.accounts".to_string(),
        "top.system" => "menu.system".to_string(),
        "tools.launcher" => "menu.quick_launcher".to_string(),
        _ => format!("menu.node.{node_key}"),
    }
}

pub fn parent_key_for(page_key: &str) -> Option<&'static str> {
    BINDINGS.iter().find(|(page, _)| *page == page_key).map(|(_, parent)| *parent)
}

pub fn bindable_pages() -> Vec<&'static str> {
    BINDINGS.iter().map(|(page, _)| *page).collect()
}

fn clean_label(label: &str) -> Result<String> {
    let v = label.trim();
    if v.is_empty() || v.chars().count() > LABEL_MAX_CHARS {
        return Err(AppError::MenuLabelInvalid);
    }
    Ok(v.to_string())
}

fn map_node(r: &rusqlite::Row<'_>) -> rusqlite::Result<MenuNode> {
    let node_key: String = r.get(1)?;
    let perm_key = perm_key_for(&node_key);
    Ok(MenuNode {
        id: r.get(0)?,
        node_key,
        parent_id: r.get(2)?,
        label: r.get(3)?,
        page_key: r.get(4)?,
        kind: r.get(5)?,
        builtin: r.get::<_, i64>(6)? != 0,
        status: r.get(7)?,
        sort_order: r.get(8)?,
        perm_key,
    })
}

const SELECT_NODE: &str =
    "SELECT id,node_key,parent_id,label,page_key,kind,builtin,status,sort_order FROM menu_nodes";

pub fn list(db: &Db) -> Result<Vec<MenuNode>> {
    let conn = db.lock_conn();
    list_conn(&conn)
}

fn list_conn(conn: &Connection) -> Result<Vec<MenuNode>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT_NODE} ORDER BY (parent_id IS NOT NULL), COALESCE(parent_id,''), sort_order, node_key"
    ))?;
    let rows = stmt
        .query_map([], map_node)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn node_conn(conn: &Connection, id: &str) -> Result<MenuNode> {
    conn.query_row(&format!("{SELECT_NODE} WHERE id=?1"), params![id], map_node)
        .optional()?
        .ok_or(AppError::NotFound)
}

pub fn create(db: &Db, label: &str, page_key: &str) -> Result<String> {
    let label = clean_label(label)?;
    let parent_key = parent_key_for(page_key).ok_or(AppError::MenuPageUnknown)?;

    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let parent_id: String = tx
        .query_row("SELECT id FROM menu_nodes WHERE node_key=?1", params![parent_key], |r| r.get(0))
        .optional()?
        .ok_or(AppError::NotFound)?;
    let max_order: Option<i64> =
        tx.query_row("SELECT MAX(sort_order) FROM menu_nodes WHERE parent_id=?1", params![parent_id], |r| r.get(0))?;
    let id = format!("custom.{}", uuid::Uuid::now_v7());
    let now = repo::now();
    tx.execute(
        "INSERT INTO menu_nodes
           (id,node_key,parent_id,label,page_key,kind,builtin,status,sort_order,created_at,updated_at)
         VALUES (?1,?1,?2,?3,?4,'page',0,'active',?5,?6,?6)",
        params![id, parent_id, label, page_key, max_order.unwrap_or(0) + 10, now],
    )?;
    // 新入口立刻成为一枚可分配的菜单权限；默认授权给所有角色，保持"建完就能看见"。
    let perm_key = perm_key_for(&id);
    tx.execute(
        "INSERT OR IGNORE INTO permissions (id,permission_key,name,type,description)
         VALUES (?1,?2,?3,'menu','自定义菜单入口')",
        params![format!("p-{id}"), perm_key, label],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key=?1",
        params![perm_key],
    )?;
    tx.commit()?;
    Ok(id)
}

pub fn rename(db: &Db, id: &str, label: &str) -> Result<()> {
    let label = clean_label(label)?;
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let node = node_conn(&tx, id)?;
    if FIXED_GROUP_KEYS.contains(&node.node_key.as_str()) {
        return Err(AppError::MenuProtected("分组名称由版本固定，不能修改".to_string()));
    }
    tx.execute(
        "UPDATE menu_nodes SET label=?1, updated_at=?2 WHERE id=?3",
        params![label, repo::now(), id],
    )?;
    // 权限目录里的名字跟着入口走，改完菜单不该留一个旧名。
    tx.execute(
        "UPDATE permissions SET name=?1 WHERE permission_key=?2",
        params![label, perm_key_for(&node.node_key)],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn move_node(db: &Db, id: &str, direction: &str) -> Result<()> {
    let step: i64 = match direction {
        "up" => -1,
        "down" => 1,
        _ => return Err(AppError::InvalidInput),
    };
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let node = node_conn(&tx, id)?;
    let parent_id = node
        .parent_id
        .clone()
        .ok_or_else(|| AppError::MenuProtected("一级菜单的顺序由版本固定".to_string()))?;

    let mut stmt =
        tx.prepare("SELECT id FROM menu_nodes WHERE parent_id=?1 ORDER BY sort_order, node_key")?;
    let siblings = stmt
        .query_map(params![parent_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let index = siblings.iter().position(|s| s == id).ok_or(AppError::NotFound)? as i64;
    let target = index + step;
    if target < 0 {
        return Err(AppError::MenuProtected("已经是最前一项".to_string()));
    }
    if target as usize >= siblings.len() {
        return Err(AppError::MenuProtected("已经是最后一项".to_string()));
    }

    let mut ordered = siblings;
    ordered.swap(index as usize, target as usize);
    let now = repo::now();
    for (i, node_id) in ordered.iter().enumerate() {
        tx.execute(
            "UPDATE menu_nodes SET sort_order=?1, updated_at=?2 WHERE id=?3",
            params![((i as i64) + 1) * 10, now, node_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 停用 `disabling_id` 之后，是否**还剩一条能进菜单管理页的路径**。
///
/// 路径可用 = 该节点绑定 `menus` 页、自己启用、且一路到根的每个祖先都启用。
/// 守卫刻意不写死节点键（原先是 `["top.system","system.menus"]` 两枚）：这棵树现在能被
/// 改名、加别名入口、换父级，写死的名单会随结构漂移——漂移之后守卫还在跑，但已经不守任何东西。
/// 断链（父指不到）按不可达处理：宁可少放行，也不给"停用了回不来"开门。
fn menus_page_still_reachable(nodes: &[MenuNode], disabling_id: &str) -> bool {
    let by_id = nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<std::collections::HashMap<_, _>>();

    nodes.iter().any(|node| {
        if node.page_key.as_deref() != Some(SELF_PAGE)
            || node.id == disabling_id
            || node.status != "active"
        {
            return false;
        }
        let mut parent = node.parent_id.as_deref();
        loop {
            match parent {
                None => return true,
                Some(pid) => match by_id.get(pid) {
                    Some(ancestor) if ancestor.id != disabling_id && ancestor.status == "active" => {
                        parent = ancestor.parent_id.as_deref();
                    }
                    _ => return false,
                },
            }
        }
    })
}

pub fn set_status(db: &Db, id: &str, status: &str) -> Result<()> {
    if status != "active" && status != "disabled" {
        return Err(AppError::InvalidInput);
    }
    let conn = db.lock_conn();
    let node = node_conn(&conn, id)?;
    if status == "disabled" && !menus_page_still_reachable(&list_conn(&conn)?, &node.id) {
        return Err(AppError::MenuProtected(
            "停用后就没有入口能回到菜单管理页，这一项不能停用".to_string(),
        ));
    }
    conn.execute(
        "UPDATE menu_nodes SET status=?1, updated_at=?2 WHERE id=?3",
        params![status, repo::now(), id],
    )?;
    Ok(())
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction()?;
    let node = node_conn(&tx, id)?;
    if node.builtin {
        return Err(AppError::MenuProtected("内置菜单不能删除".to_string()));
    }
    // 与停用同一把尺：删掉的若是回到本页的最后一条路，删完就再也进不来。
    if node.page_key.as_deref() == Some(SELF_PAGE)
        && !menus_page_still_reachable(&list_conn(&tx)?, &node.id)
    {
        return Err(AppError::MenuProtected(
            "删除后就没有入口能回到菜单管理页，这一项不能删除".to_string(),
        ));
    }
    // 自定义入口的权限键随节点一起退场，否则权限页会留下一枚点不到的孤儿项。
    let perm_key = perm_key_for(&node.node_key);
    tx.execute(
        "DELETE FROM role_permissions WHERE permission_id IN
           (SELECT id FROM permissions WHERE permission_key=?1)",
        params![perm_key],
    )?;
    tx.execute("DELETE FROM permissions WHERE permission_key=?1", params![perm_key])?;
    tx.execute("DELETE FROM menu_nodes WHERE id=?1", params![id])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory(&vec![31u8; 32]).unwrap()
    }

    fn by_key<'a>(nodes: &'a [MenuNode], key: &str) -> &'a MenuNode {
        nodes.iter().find(|n| n.node_key == key).unwrap()
    }

    #[test]
    fn seed_has_four_roots_and_eleven_leaves() {
        let nodes = list(&db()).unwrap();
        assert_eq!(nodes.len(), 15);
        assert_eq!(nodes.iter().filter(|n| n.parent_id.is_none()).count(), 4);
        assert_eq!(nodes.iter().filter(|n| n.parent_id.is_some()).count(), 11);
        for (page, parent) in BINDINGS {
            let node = nodes
                .iter()
                .find(|n| n.page_key.as_deref() == Some(*page) && n.parent_id.is_some())
                .unwrap();
            assert_eq!(by_key(&nodes, parent).id, node.parent_id.clone().unwrap(), "{page} 的父组不对");
        }
        assert!(nodes.iter().filter(|n| n.parent_id.is_some()).all(|n| n.builtin));
        assert_eq!(parent_key_for("accounts"), None);
        assert_eq!(bindable_pages().len(), 11);
    }

    #[test]
    fn seed_nodes_carry_their_permission_key() {
        let d = db();
        let nodes = list(&d).unwrap();
        assert_eq!(by_key(&nodes, "top.accounts").perm_key, "menu.accounts");
        assert_eq!(by_key(&nodes, "top.system").perm_key, "menu.system");
        assert_eq!(by_key(&nodes, "tools.launcher").perm_key, "menu.quick_launcher");
        assert_eq!(by_key(&nodes, "gear.settings").perm_key, "menu.node.gear.settings");
        assert_eq!(
            by_key(&nodes, "system.permissions").perm_key,
            "menu.node.system.permissions"
        );
    }

    #[test]
    fn create_derives_parent_and_appends_to_the_end() {
        let d = db();
        let id = create(&d, "  备用成员  ", "users").unwrap();
        let nodes = list(&d).unwrap();
        let node = nodes.iter().find(|n| n.id == id).unwrap();
        assert_eq!(node.label, "备用成员");
        assert_eq!(node.node_key, id);
        assert!(node.node_key.starts_with("custom."));
        assert_eq!(node.kind, "page");
        assert!(!node.builtin);
        assert_eq!(node.page_key.as_deref(), Some("users"));
        assert_eq!(node.parent_id.as_deref(), Some(by_key(&nodes, "top.system").id.as_str()));
        assert_eq!(node.sort_order, 60, "系统管理下已有 5 项（末项 50），新项应排 60");
        assert_eq!(node.perm_key, format!("menu.node.{id}"));

        // 新入口立刻有可分配的菜单权限，且默认授权给每一枚角色。
        let conn = d.lock_conn();
        let (name, kind): (String, String) = conn
            .query_row(
                "SELECT name, type FROM permissions WHERE permission_key=?1",
                params![node.perm_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((name.as_str(), kind.as_str()), ("备用成员", "menu"));
        let roles: i64 = conn.query_row("SELECT count(*) FROM roles", [], |r| r.get(0)).unwrap();
        let granted: i64 = conn
            .query_row(
                "SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                 WHERE p.permission_key=?1",
                params![node.perm_key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(granted, roles);
    }

    #[test]
    fn create_rejects_invalid_label_and_page() {
        let d = db();
        assert!(matches!(create(&d, "   ", "users"), Err(AppError::MenuLabelInvalid)));
        let long = "名".repeat(LABEL_MAX_CHARS + 1);
        assert!(matches!(create(&d, &long, "users"), Err(AppError::MenuLabelInvalid)));
        assert!(matches!(create(&d, "别名", "accounts"), Err(AppError::MenuPageUnknown)));
        assert!(matches!(create(&d, "别名", "nope"), Err(AppError::MenuPageUnknown)));
    }

    #[test]
    fn same_page_can_be_bound_twice() {
        let d = db();
        let a = create(&d, "审计（别名一）", "audit").unwrap();
        let b = create(&d, "审计（别名二）", "audit").unwrap();
        assert_ne!(a, b);
        let nodes = list(&d).unwrap();
        assert_eq!(nodes.iter().filter(|n| n.page_key.as_deref() == Some("audit")).count(), 3);
    }

    #[test]
    fn rename_works_for_page_nodes_but_not_gear_groups() {
        let d = db();
        let users = by_key(&list(&d).unwrap(), "system.users").id.clone();
        rename(&d, &users, " 成员 ").unwrap();
        assert_eq!(by_key(&list(&d).unwrap(), "system.users").label, "成员");
        let perm_name: String = d
            .lock_conn()
            .query_row(
                "SELECT name FROM permissions WHERE permission_key='menu.node.system.users'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(perm_name, "成员", "权限目录的名字必须跟着入口改名");

        let gear = by_key(&list(&d).unwrap(), "gear.settings").id.clone();
        assert!(matches!(rename(&d, &gear, "偏好"), Err(AppError::MenuProtected(_))));
        assert!(matches!(rename(&d, "missing", "x"), Err(AppError::NotFound)));
    }

    #[test]
    fn move_swaps_siblings_and_renumbers() {
        let d = db();
        let alias = create(&d, "启动（别名）", "launcher").unwrap();
        move_node(&d, &alias, "up").unwrap();
        let nodes = list(&d).unwrap();
        let tools: Vec<&MenuNode> = nodes
            .iter()
            .filter(|n| n.parent_id.as_deref() == Some(by_key(&nodes, "gear.tools").id.as_str()))
            .collect();
        assert_eq!(
            tools.iter().map(|n| n.node_key.as_str()).collect::<Vec<_>>(),
            vec![alias.as_str(), "tools.launcher"]
        );
        assert_eq!(tools.iter().map(|n| n.sort_order).collect::<Vec<_>>(), vec![10, 20]);

        assert!(matches!(move_node(&d, &alias, "up"), Err(AppError::MenuProtected(_))));

        let root = by_key(&nodes, "top.accounts").id.clone();
        assert!(matches!(move_node(&d, &root, "down"), Err(AppError::MenuProtected(_))));
    }

    #[test]
    fn status_guard_blocks_the_two_ways_back_in() {
        let d = db();
        let menus = by_key(&list(&d).unwrap(), "system.menus").id.clone();
        assert!(matches!(set_status(&d, &menus, "disabled"), Err(AppError::MenuProtected(_))));
        let system = by_key(&list(&d).unwrap(), "top.system").id.clone();
        assert!(matches!(set_status(&d, &system, "disabled"), Err(AppError::MenuProtected(_))));

        let launcher = by_key(&list(&d).unwrap(), "tools.launcher").id.clone();
        set_status(&d, &launcher, "disabled").unwrap();
        assert_eq!(by_key(&list(&d).unwrap(), "tools.launcher").status, "disabled");
        set_status(&d, &launcher, "active").unwrap();
        assert_eq!(by_key(&list(&d).unwrap(), "tools.launcher").status, "active");
        assert!(matches!(set_status(&d, &launcher, "paused"), Err(AppError::InvalidInput)));
    }

    /// 守卫是**从树推出来的**，不是两枚写死的键：多一条能进菜单管理页的路径，
    /// 原来那条就允许停用；但两条路径共同的祖先仍然不能停，否则一起消失。
    #[test]
    fn status_guard_follows_the_tree_not_a_hardcoded_key_list() {
        let d = db();
        let menus = by_key(&list(&d).unwrap(), "system.menus").id.clone();
        let alias = create(&d, "菜单备份", "menus").unwrap();

        set_status(&d, &menus, "disabled").unwrap();
        assert_eq!(by_key(&list(&d).unwrap(), "system.menus").status, "disabled");
        assert_eq!(by_key(&list(&d).unwrap(), &alias).status, "active");

        // 内置那条已停用，别名成了唯一路径：停掉它就是自锁，必须挡住。
        assert!(matches!(set_status(&d, &alias, "disabled"), Err(AppError::MenuProtected(_))));
        let system = by_key(&list(&d).unwrap(), "top.system").id.clone();
        assert!(matches!(set_status(&d, &system, "disabled"), Err(AppError::MenuProtected(_))));
    }

    #[test]
    fn delete_guard_uses_the_same_reachability_rule() {
        let d = db();
        let menus = by_key(&list(&d).unwrap(), "system.menus").id.clone();
        let alias = create(&d, "菜单备份", "menus").unwrap();
        // 内置那条还启用着，别名只是多出来的一条：可以删。
        delete(&d, &alias).unwrap();

        let alias = create(&d, "菜单备份", "menus").unwrap();
        set_status(&d, &menus, "disabled").unwrap();
        // 此时别名是唯一入口，删掉它等于自锁。
        assert!(matches!(delete(&d, &alias), Err(AppError::MenuProtected(_))));
        assert_eq!(by_key(&list(&d).unwrap(), &alias).status, "active");
    }

    #[test]
    fn delete_only_custom_nodes() {
        let d = db();
        let builtin = by_key(&list(&d).unwrap(), "system.users").id.clone();
        assert!(matches!(delete(&d, &builtin), Err(AppError::MenuProtected(_))));
        assert_eq!(list(&d).unwrap().len(), 15);

        let custom = create(&d, "别名", "users").unwrap();
        let perm_key = format!("menu.node.{custom}");
        let count_perms = |conn: &rusqlite::Connection| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM permissions WHERE permission_key=?1",
                params![perm_key],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count_perms(&d.lock_conn()), 1);
        delete(&d, &custom).unwrap();
        assert_eq!(list(&d).unwrap().len(), 15);
        let conn = d.lock_conn();
        assert_eq!(count_perms(&conn), 0, "删入口必须同时删掉它的菜单权限");
        let grants: i64 = conn
            .query_row(
                "SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                 WHERE p.permission_key=?1",
                params![perm_key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(grants, 0, "角色授权行也必须清干净");
        drop(conn);
        assert!(matches!(delete(&d, "missing"), Err(AppError::NotFound)));
    }
}
