-- 0010_menu_node_permissions.sql —— 每个菜单节点一枚菜单权限键
-- 一级与二级入口都单独授权；三枚既有键继续复用：
--   top.accounts → menu.accounts、top.system → menu.system、tools.launcher → menu.quick_launcher
-- 其余节点统一为 menu.node.<node_key>，自定义节点在创建时由后端补行。
--
-- 可重放：migrate.rs 的升级路径守卫会把最新一档真的重跑一遍。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-node-gear-settings',  'menu.node.gear.settings',       '设置',     'menu', '一级菜单入口（设置）'),
  ('p-menu-node-gear-tools',     'menu.node.gear.tools',          '快捷入口', 'menu', '一级菜单入口（快捷入口）'),
  ('p-menu-node-system-users',   'menu.node.system.users',        '用户管理', 'menu', '二级菜单入口'),
  ('p-menu-node-system-roles',   'menu.node.system.roles',        '角色管理', 'menu', '二级菜单入口'),
  ('p-menu-node-system-menus',   'menu.node.system.menus',        '菜单管理', 'menu', '二级菜单入口'),
  ('p-menu-node-system-permissions', 'menu.node.system.permissions', '权限管理', 'menu', '二级菜单入口'),
  ('p-menu-node-system-audit',   'menu.node.system.audit',        '审计日志', 'menu', '二级菜单入口'),
  ('p-menu-node-settings-security', 'menu.node.settings.security', '安全策略', 'menu', '二级菜单入口'),
  ('p-menu-node-settings-appearance', 'menu.node.settings.appearance', '界面外观', 'menu', '二级菜单入口'),
  ('p-menu-node-settings-backup', 'menu.node.settings.backup',    '备份与恢复', 'menu', '二级菜单入口'),
  ('p-menu-node-settings-update', 'menu.node.settings.update',    '系统更新', 'menu', '二级菜单入口'),
  ('p-menu-node-tools-data',     'menu.node.tools.data',          '导入/导出', 'menu', '二级菜单入口');

-- 已有角色保持当前可见性：菜单入口全部授予，页面本身仍按操作权限裁剪。
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key LIKE 'menu.node.%';
