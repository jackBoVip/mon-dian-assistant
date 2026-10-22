-- 0002_seed.sql —— 预置权限与最小角色模板
-- 菜单级：accounts.* / system.*；操作级：accounts.<action> 等

INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-accounts',  'menu.accounts',      '账号管理菜单', 'menu',   '左侧第一项：外部系统账号台账'),
  ('p-menu-system',    'menu.system',        '系统管理菜单', 'menu',   '左侧第二项：本软件使用者/角色/安全'),
  ('p-menu-quick',     'menu.quick_launcher','快捷启动器',   'menu',   '全局快捷启动器'),
  ('p-acc-read',       'accounts.read',      '查询账号',     'action', NULL),
  ('p-acc-create',     'accounts.create',    '新建账号',     'action', NULL),
  ('p-acc-update',     'accounts.update',    '编辑账号',     'action', NULL),
  ('p-acc-disable',    'accounts.disable',   '停用账号',     'action', NULL),
  ('p-acc-delete',     'accounts.delete',    '删除/恢复账号','action', NULL),
  ('p-acc-view-secret','accounts.view_secret','查看秘密',    'action', '查看/复制密码等秘密字段'),
  ('p-acc-copy-pwd',   'accounts.copy_password','复制密码',  'action', NULL),
  ('p-acc-fill',       'accounts.autofill',  '打开并安全填充','action', NULL),
  ('p-acc-set-default','accounts.set_default','设置默认账号','action', '按本地使用者+目标保存偏好'),
  ('p-acc-import',     'accounts.import',    '批量导入',     'action', NULL),
  ('p-acc-export',     'accounts.export',    '批量导出',     'action', NULL),
  ('p-sys-user-read',  'system.user.read',   '查看本地使用者','action', NULL),
  ('p-sys-user-mgmt',  'system.user.manage', '管理本地使用者','action', '新增/停用/重置密码'),
  ('p-sys-role-mgmt',  'system.role.manage', '角色权限管理', 'action', NULL),
  ('p-sys-security',   'system.security.config','安全策略配置','action',NULL),
  ('p-sys-audit-read', 'system.audit.read',  '查看审计日志', 'action', NULL),
  ('p-sys-backup',     'system.backup.manage','备份与恢复',  'action', NULL),
  ('p-sys-update-inst','system.update.install','安装更新',   'action', NULL),
  ('p-sys-update-cfg', 'system.update.config','更新源配置',  'action', NULL);

INSERT OR IGNORE INTO roles (id, code, name, description, builtin, created_at, updated_at) VALUES
  ('r-admin',  'system_admin',  '系统管理员', '全部权限，含安全策略、更新与备份', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('r-mgr',    'admin',         '普通管理员', '账号台账全量 + 审计查看，不含更新安装', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('r-user',   'standard_user', '普通用户',   '仅本人可见范围的账号台账读写',   1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- 系统管理员：全部权限
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'r-admin', id FROM permissions;

-- 普通管理员：台账 + 审计查看 + 备份，不含更新安装与角色管理
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'r-mgr', id FROM permissions
   WHERE permission_key IN (
     'menu.accounts','menu.system','menu.quick_launcher',
     'accounts.read','accounts.create','accounts.update','accounts.disable','accounts.delete',
     'accounts.view_secret','accounts.copy_password','accounts.autofill','accounts.set_default',
     'accounts.import','accounts.export','system.user.read','system.audit.read','system.backup.manage'
   );

-- 普通用户：无系统管理菜单，不可导出
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'r-user', id FROM permissions
   WHERE permission_key IN (
     'menu.accounts','menu.quick_launcher',
     'accounts.read','accounts.create','accounts.update','accounts.view_secret',
     'accounts.copy_password','accounts.autofill','accounts.set_default'
   );

INSERT OR IGNORE INTO app_settings (key, value, scope, updated_at) VALUES
  ('theme_style','glass','ui','2026-10-18T00:00:00Z'),
  ('reduce_motion','false','ui','2026-01-01T00:00:00Z'),
  ('quick_launcher_enabled','true','ui','2026-01-01T00:00:00Z'),
  ('quick_launcher_accelerator','','ui','2026-01-01T00:00:00Z'),
  ('quick_launcher_empty_query_show_favorites','true','ui','2026-01-01T00:00:00Z'),
  ('quick_launcher_result_limit','20','ui','2026-01-01T00:00:00Z'),
  ('quick_launcher_enter_action','auto','ui','2026-01-01T00:00:00Z'),
  ('clipboard_clear_after_seconds','30','security','2026-01-01T00:00:00Z'),
  ('copy_password_requires_reauth','true','security','2026-01-01T00:00:00Z'),
  ('allow_insecure_protocols','false','security','2026-01-01T00:00:00Z'),
  ('session_idle_timeout_minutes','10','security','2026-01-01T00:00:00Z'),
  ('max_failed_login_attempts','5','security','2026-01-01T00:00:00Z'),
  ('lockout_seconds','300','security','2026-01-01T00:00:00Z'),
  ('export_requires_reauth','false','security','2026-01-01T00:00:00Z'),
  ('update_channel','stable','security','2026-01-01T00:00:00Z'),
  ('update_source_url','','security','2026-01-01T00:00:00Z'),
  ('db_schema_version','2','security','2026-01-01T00:00:00Z');
