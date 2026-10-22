-- 菜单节点：决定导航入口是否出现，不授予任何权限。
-- 权限键仍由版本定义（permissions 表），新增菜单只能绑定既有 page_key。
--
-- 这一档一律写成可重放（IF NOT EXISTS / INSERT OR IGNORE）：`migrate.rs` 里那条
-- 「库停在倒数第二版时 run() 只补最新一条」的升级路径守卫，会把最新这一档真的重跑一遍。
CREATE TABLE IF NOT EXISTS menu_nodes (
  id         TEXT PRIMARY KEY,
  node_key   TEXT NOT NULL UNIQUE,
  parent_id  TEXT REFERENCES menu_nodes(id),
  label      TEXT NOT NULL,
  page_key   TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('group','page')),
  builtin    INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_menu_nodes_parent ON menu_nodes(parent_id, sort_order);

INSERT OR IGNORE INTO menu_nodes
  (id, node_key, parent_id, label, page_key, kind, builtin, status, sort_order, created_at, updated_at)
VALUES
  ('mn-top-accounts', 'top.accounts', NULL, '账号中心', 'accounts', 'page', 1, 'active', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-top-system', 'top.system', NULL, '系统管理', NULL, 'group', 1, 'active', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-gear-settings', 'gear.settings', NULL, '设置', NULL, 'group', 1, 'active', 30,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-gear-tools', 'gear.tools', NULL, '快捷入口', NULL, 'group', 1, 'active', 40,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('mn-system-users', 'system.users', 'mn-top-system', '用户管理', 'users', 'page', 1, 'active', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-system-roles', 'system.roles', 'mn-top-system', '角色管理', 'roles', 'page', 1, 'active', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-system-menus', 'system.menus', 'mn-top-system', '菜单管理', 'menus', 'page', 1, 'active', 30,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-system-permissions', 'system.permissions', 'mn-top-system', '权限管理', 'permissions', 'page', 1, 'active', 40,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-system-audit', 'system.audit', 'mn-top-system', '审计日志', 'audit', 'page', 1, 'active', 50,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('mn-settings-security', 'settings.security', 'mn-gear-settings', '安全策略', 'security', 'page', 1, 'active', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-settings-appearance', 'settings.appearance', 'mn-gear-settings', '界面外观', 'appearance', 'page', 1, 'active', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-settings-backup', 'settings.backup', 'mn-gear-settings', '备份与恢复', 'backup', 'page', 1, 'active', 30,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-settings-update', 'settings.update', 'mn-gear-settings', '系统更新', 'update', 'page', 1, 'active', 40,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('mn-tools-launcher', 'tools.launcher', 'mn-gear-tools', '快速启动器', 'launcher', 'page', 1, 'active', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-tools-data', 'tools.data', 'mn-gear-tools', '导入/导出', 'data', 'page', 1, 'active', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
