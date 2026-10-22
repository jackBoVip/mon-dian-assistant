-- 0008：把「复制密码要先再验一次主密码」这道闸门出厂关掉。
--
-- 交付方 2026-10-20 一句「复制密码提示该操作需要再次验证主密码，这是不对的，应该直接复制成功，无需验证」。
-- 闸门本身留在代码里（commands/accounts.rs::copy_password 仍然真读这个键，
-- quick_launcher 与台账页两条路都走它），改的只是出厂值：
-- 关掉后点「复制密码」直接进剪贴板（30 秒后自动清空的机制不变），
-- 系统管理页那行「复制密码需二次认证」会显示"不需要"，管理员想恢复就把键改回 true ——
-- 届时的拦截仍在后端，不依赖前端记得先要口令。与 0007 同一条口径。
--
-- 安全后果按同一份账写清楚，不淡化：使用者只要解锁过本软件、且对那条凭据有查看权限，
-- 就能把明文口令放进剪贴板，中间不再有一次"确认这是本人"的握手。
-- 剩下的兜底是：会话空闲超时会自动锁库（session_idle_timeout_minutes，出厂 10 分钟）、
-- 剪贴板 30 秒后清空、以及这条动作仍要求 accounts.view_secret 权限、仍进审计日志。
-- 台账页里「查看明文」那一道（reveal_requires_reauth）没动，仍是出厂要二次认证。
--
-- 两条 SQL 各管一种库（同 0007）：UPDATE 管已有库（0002 早就种成 true，INSERT OR IGNORE 改不动它）；
-- 第二句管"这一行压根不存在"的库。键名与 scope 与 0002 完全一致，值写 'false' 而不是 '0'：
-- settings::get_bool 只认真写的 "true"。

UPDATE app_settings SET value = 'false' WHERE key = 'copy_password_requires_reauth';

INSERT OR IGNORE INTO app_settings (key, value, scope, updated_at)
  VALUES ('copy_password_requires_reauth', 'false', 'security', '2026-01-01T00:00:00Z');
