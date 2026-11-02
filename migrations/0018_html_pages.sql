-- 0018_html_pages.sql —— 工具 / 页面库：粘贴 HTML、命名标题、左列表右预览
-- 两条硬边界：
--   1. 页面正文一律进保险库（SQLCipher），解锁后才能读；不落任何明文缓存文件；
--   2. 预览能跑脚本、能加载 CDN，所以内容只经 preview 模块的回环服务供出；右栏嵌入块与
--      「运行脚本」窗口都从那里取，每次请求重新校验会话与 html.page.read。两者对 Tauri
--      都是 remote origin，没有 remote capability 时拿不到本应用任何命令。
-- 可重放：migrate.rs 的升级路径守卫会把最新一档真的重跑一遍，所以全部 IF NOT EXISTS / INSERT OR IGNORE。

CREATE TABLE IF NOT EXISTS html_pages (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (length(trim(title)) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_html_pages_updated ON html_pages(updated_at DESC);

-- ---------------------------------------------------------------- 导航
-- 一级「工具」：parent_id 为 NULL 的 page 节点（与 top.quiz / top.notes 同形）。
-- sort_order=25：胶囊顺序是 账号中心(10) → 题库(15) → 笔记(16) → 任务中心(17)
-- → 系统管理(20) → 工具(25)，排在最后；它不是一个分组，所以不进 menu::BINDINGS。
-- node_key 用 top.tools，别与齿轮里的 gear.tools（外部工具页）混为一谈。
INSERT OR IGNORE INTO menu_nodes
  (id, node_key, parent_id, label, page_key, kind, builtin, status, sort_order, created_at, updated_at)
VALUES
  ('mn-top-tools', 'top.tools', NULL, '工具', 'html', 'page', 1, 'active', 25,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 菜单权限：与 0010 / 0015 / 0016 / 0017 同一口径，节点键 = menu.node.<node_key>，回填给每一枚既有角色。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-node-top-tools', 'menu.node.top.tools', '工具', 'menu', '一级菜单入口（工具）');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'menu.node.top.tools';

-- 操作权限：读给三档内置角色，写（新建/修改/删除）只给两档管理员。
-- 自定义角色不在这里种，之后由权限页显式勾选。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-html-page-read',   'html.page.read',   '查看页面', 'action', '读取页面列表与正文'),
  ('p-html-page-create', 'html.page.create', '新建页面', 'action', '保存一份新的 HTML 页面'),
  ('p-html-page-update', 'html.page.update', '修改页面', 'action', '改标题或替换 HTML 正文'),
  ('p-html-page-delete', 'html.page.delete', '删除页面', 'action', '删除已保存的页面');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key = 'html.page.read'
  WHERE r.id IN ('r-admin', 'r-mgr', 'r-user');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key IN ('html.page.create', 'html.page.update', 'html.page.delete')
  WHERE r.id IN ('r-admin', 'r-mgr');
