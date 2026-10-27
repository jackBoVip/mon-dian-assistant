-- 0014_external_tools.sql —— 外部工具档（浏览器 / 终端 / 按引擎的数据库客户端）。
--
-- 为什么是独立表而不是 app_settings 里的几枚键：数据库档是**可增删的变长清单**，
-- 塞进 KV 就要进 `UPDATABLE_SETTINGS` 白名单，而 `securitySettings.test.ts` 钉死了
-- 「后端白名单键集 == 安全策略页字典键集」、`lib.rs` 又钉死了「每个出厂键都要在白名单里
-- 且真的被读到」。把清单型配置压成 KV 会让这三条守卫同时改脏，不如让它自成一张表。
--
-- `UNIQUE (kind, engine)` 一肩挑两件事：browser/terminal 的 engine 恒为空串，
-- 所以固定两档天然只有一条；database 按引擎去重，不会种出两条 mysql。
--
-- 可重放（IF NOT EXISTS / INSERT OR IGNORE）：`db/migrate.rs` 的升级路径守卫会把最新
-- 这一档真的重跑一遍；0011 那条测试还会把 0014 一起重放。

CREATE TABLE IF NOT EXISTS external_tools (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('browser','terminal','database')),
  engine     TEXT NOT NULL DEFAULT '',
  label      TEXT NOT NULL,
  app_path   TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'database') = (engine <> '')),
  UNIQUE (kind, engine)
);

CREATE INDEX IF NOT EXISTS idx_external_tools_kind ON external_tools(kind, sort_order);

-- 两枚固定档出厂就是「未配置」：app_path 留空 = 交给系统默认，行为与本轮之前完全一致。
INSERT OR IGNORE INTO external_tools
  (id, kind, engine, label, app_path, sort_order, created_at, updated_at)
VALUES
  ('et-browser',  'browser',  '', '浏览器',   '', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('et-terminal', 'terminal', '', '终端工具', '', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 齿轮「设置」组的第五枚入口。engine 为空的数据库档不存在，这里只有这一枚 page 节点。
INSERT OR IGNORE INTO menu_nodes
  (id, node_key, parent_id, label, page_key, kind, builtin, status, sort_order, created_at, updated_at)
VALUES
  ('mn-settings-tools', 'settings.tools', 'mn-gear-settings', '外部工具', 'tools', 'page', 1, 'active', 50,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 每个菜单节点一枚菜单权限（与 0010 同一口径），并回填给每一枚既有角色：
-- 菜单只决定入口是否出现，页面里能不能改由于 system.security.config 说了算。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-node-settings-tools', 'menu.node.settings.tools', '外部工具', 'menu', '二级菜单入口');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'menu.node.settings.tools';
