-- 0007：把「含明文口令的导出要先过主密码二次认证」这道闸门出厂关掉。
--
-- 交付方 2026-10-19 一句「导出取消二次确认，直接导出」。闸门本身留在代码里
-- （commands/data.rs::gate_export_reauth 仍然真读这个键），改的只是出厂值：
-- 关掉后点「确认导出」直接落盘，系统管理页那行「敏感导出二次认证」会显示"不需要"，
-- 管理员想恢复就把键改回 true —— 届时的拦截仍然在后端，不依赖前端记得先要口令。
--
-- 三条 SQL 各自管一种库：
--   UPDATE 管已有库（0002/0003 早就种成 true，INSERT OR IGNORE 改不动它）；
--   第二句管"这一行压根不存在"的库（例如手工清过 app_settings 的排查现场）。
-- 这一档只有安装级一处：读取侧走的是 settings::get_bool(app_settings)，偏好表里没有这一键，
-- 所以不必（也不应）去 user_preferences 上做对应的清理。
-- 键名与 scope 与 0002/0003 完全一致，值写成 'false' 而不是 '0'：get_bool 只认真写的 "true"。

UPDATE app_settings SET value = 'false' WHERE key = 'export_requires_reauth';

INSERT OR IGNORE INTO app_settings (key, value, scope, updated_at)
  VALUES ('export_requires_reauth', 'false', 'security', '2026-01-01T00:00:00Z');
