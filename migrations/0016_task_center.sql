-- 0016_task_center.sql —— 任务中心：运行记录、环境绑定与「微服务发布」
-- 两条硬边界：
--   1. 任务配置只存凭据**引用**（vault_items.id），密码永远不复制到任务侧；
--   2. 运行日志落库前必须脱敏，表里不该出现 Cookie / 口令。
-- 可重放：migrate.rs 的升级路径守卫会把最新一档真的重跑一遍。

-- ---------------------------------------------------------------- 配置
-- 非密配置：端点模板、环境参数、JSON 字段路径、并发与超时。
-- 站点差异全部收在这张表的 JSON 里，换环境不需要改代码发版。
CREATE TABLE IF NOT EXISTS task_profiles (
  task_key     TEXT NOT NULL,
  env          TEXT NOT NULL CHECK (env IN ('test','prod')),
  profile_json TEXT NOT NULL,
  updated_by   TEXT REFERENCES app_users(id),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (task_key, env)
);

-- 每个环境：登录地址 + 一枚保险库凭据。这里**只有引用**，没有用户名/密码列。
CREATE TABLE IF NOT EXISTS task_env_bindings (
  task_key           TEXT NOT NULL,
  env                TEXT NOT NULL CHECK (env IN ('test','prod')),
  login_url          TEXT NOT NULL,
  credential_item_id TEXT NOT NULL REFERENCES vault_items(id),
  updated_by         TEXT REFERENCES app_users(id),
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (task_key, env)
);

-- ---------------------------------------------------------------- 运行
CREATE TABLE IF NOT EXISTS task_runs (
  id               TEXT PRIMARY KEY,
  task_key         TEXT NOT NULL,
  env              TEXT NOT NULL CHECK (env IN ('test','prod')),
  status           TEXT NOT NULL CHECK (status IN
                     ('preparing','ready','running','cancelling','succeeded','partial','failed','cancelled')),
  -- 输入摘要（服务清单/文件来源）：不含任何凭据
  params_json      TEXT NOT NULL,
  summary_json     TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  created_by       TEXT NOT NULL REFERENCES app_users(id),
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_created ON task_runs(task_key, created_at DESC);

-- 每一项是一次"服务 → 目标镜像"的发布，快照式：重试/重跑都不会改写别的运行。
CREATE TABLE IF NOT EXISTS task_run_items (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  item_key          TEXT NOT NULL,
  display_name      TEXT,
  desired_tag       TEXT,
  image_ref         TEXT,
  app_id            TEXT,
  service_update_at TEXT,
  tag_update_at     TEXT,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending','resolving','ready','publishing','waiting','succeeded','failed','skipped')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  message           TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (run_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_task_run_items_run ON task_run_items(run_id, ordinal);

-- 逐条日志。写入前由 tasks::redact 统一脱敏；这里没有列能放 Cookie 的原文。
CREATE TABLE IF NOT EXISTS task_run_logs (
  run_id   TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  ts       TEXT NOT NULL,
  level    TEXT NOT NULL,
  item_key TEXT,
  message  TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- ---------------------------------------------------------------- 导航
-- 一级「任务中心」是 group（无 page_key），二级第一项「微服务发布」绑 release 页。
-- sort_order=17：排在「题库」(15) 之后、「系统管理」(20) 之前。
INSERT OR IGNORE INTO menu_nodes
  (id, node_key, parent_id, label, page_key, kind, builtin, status, sort_order, created_at, updated_at)
VALUES
  ('mn-top-tasks', 'top.tasks', NULL, '任务中心', NULL, 'group', 1, 'active', 17,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('mn-task-release', 'task.release', 'mn-top-tasks', '微服务发布', 'release', 'page', 1, 'active', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 菜单权限：与 0010 / 0015 同一口径，回填给每一枚既有角色。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-node-top-tasks',   'menu.node.top.tasks',   '任务中心',   'menu', '一级菜单入口（任务中心）'),
  ('p-menu-node-task-release','menu.node.task.release','微服务发布', 'menu', '二级菜单入口');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key IN ('menu.node.top.tasks', 'menu.node.task.release');

-- 操作权限：查看/配置/测试环境发布给两档管理员；生产发布单独一枚，默认只给系统管理员。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-task-release-view',      'task.release.view',      '查看发布任务', 'action', '读取发布信息、查看运行历史与日志'),
  ('p-task-release-configure', 'task.release.configure', '配置发布任务', 'action', '维护环境绑定与适配器配置'),
  ('p-task-release-run',       'task.release.run',       '执行测试环境发布', 'action', '准备并发布到测试环境'),
  ('p-task-release-run-prod',  'task.release.run_prod',  '执行生产环境发布', 'action', '生产环境发布另需此权限');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key IN
     ('task.release.view', 'task.release.configure', 'task.release.run')
  WHERE r.id IN ('r-admin', 'r-mgr');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'r-admin', p.id FROM permissions p WHERE p.permission_key = 'task.release.run_prod';
