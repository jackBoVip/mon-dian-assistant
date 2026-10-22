-- 0004：把浏览器扩展 ID 变成管理员真正能配的一项。
--
-- fill_host::prepare() 一直从 app_settings 读 'extension_id'，但这个键既没有出厂行、
-- 也不在 update_setting 的白名单里，而设置页只渲染后端返回的键——三者叠加后
-- 「扩展 ID」在界面没有任何入口，Native Messaging 清单永远返回 EXTENSION_ID_REQUIRED。
-- 这里补一行出厂空值（不硬编码任何扩展 ID），让设置页出现可编辑的输入框。
--
-- 出厂值必须是空串：allowed_origins 要求精确到扩展 ID，猜一个默认值等于给未知扩展放行填充通道。
INSERT OR IGNORE INTO app_settings (key, value, scope, updated_at) VALUES
  ('extension_id', '', 'security', '2026-01-01T00:00:00Z');
