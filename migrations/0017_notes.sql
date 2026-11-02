-- 0017_notes.sql —— 笔记：页面正文与内联图片素材
-- 两条硬边界：
--   1. 笔记按 created_by 隔离，列表/详情/更新/删除一律带当前使用者过滤；
--   2. 图片字节存本表，前端经 IPC 取 data URL——CSP 只有 img-src 'self' data:，
--      不引远程图、不开 assetProtocol。
-- 可重放：migrate.rs 的升级路径守卫会把最新一档真的重跑一遍。

-- 正文是 TipTap 的 HTML（含 data-mda-asset 引用的图片），标题只是列表上的名字。
CREATE TABLE IF NOT EXISTS note_pages (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (length(trim(title)) BETWEEN 1 AND 120)
);

-- 素材按笔记归属；删笔记时级联清掉，不留孤儿字节。
CREATE TABLE IF NOT EXISTS note_assets (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES note_pages(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp')),
  byte_len   INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_owner_updated ON note_pages(created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_assets_note ON note_assets(note_id);

-- ---------------------------------------------------------------- 导航
-- 一级「笔记」：parent_id 为 NULL 的 page 节点（与 top.quiz 同形）。
-- sort_order=16：紧跟「题库」(15)，排在「任务中心」(17) 之前。
INSERT OR IGNORE INTO menu_nodes
  (id, node_key, parent_id, label, page_key, kind, builtin, status, sort_order, created_at, updated_at)
VALUES
  ('mn-top-notes', 'top.notes', NULL, '笔记', 'notes', 'page', 1, 'active', 16,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 菜单权限：与 0010 / 0015 / 0016 同一口径，节点键 = menu.node.<node_key>，回填给每一枚既有角色。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-menu-node-top-notes', 'menu.node.top.notes', '笔记', 'menu', '一级菜单入口（笔记）');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'menu.node.top.notes';

-- 操作权限：个人笔记不做管理员门槛，读写两枚都回填三档内置角色。
-- 自定义角色不在这里种，之后由权限页显式勾选。
INSERT OR IGNORE INTO permissions (id, permission_key, name, type, description) VALUES
  ('p-notes-read',  'notes.read',  '查看笔记', 'action', '读取自己的笔记列表与正文'),
  ('p-notes-write', 'notes.write', '编辑笔记', 'action', '新建、修改、删除与导入导出笔记');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r
   JOIN permissions p ON p.permission_key IN ('notes.read', 'notes.write')
  WHERE r.id IN ('r-admin', 'r-mgr', 'r-user');
