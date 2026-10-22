-- 0003：安全策略出厂默认值补齐。
--
-- 0002 已经种下大部分 security 键，但代码里读取的另外几个策略键没有出厂值，
-- 于是「界面显示的数字」其实来自 Rust 的 unwrap 兜底常量，管理员看不到也改不到真实来源。
-- 出厂默认值只允许有这一处（迁移 SQL）；Rust 侧 lib.rs::DEFAULT_SETTINGS 只是对它的
-- 契约声明，由测试双向校验，杜绝两处各写一份而漂移（clipboard_clear_after_seconds 曾经
-- 在 SQL 里是 30、在 Rust 里是 20）。
--
-- 键的 scope 必须是 install/security/ui（app_settings 上有 CHECK 约束）。
INSERT OR IGNORE INTO app_settings (key, value, scope, updated_at) VALUES
  -- 主密码最小长度：可上调，但 Rust 侧会夹紧到内置下限之上（auth/policy.rs::MIN_LENGTH）
  ('master_password_min_length', '12', 'security', '2026-01-01T00:00:00Z'),
  -- 检测到系统休眠/进程挂起即锁定保险库（lib.rs::spawn_idle_lock）
  ('lock_on_system_sleep', 'true', 'security', '2026-01-01T00:00:00Z'),
  -- 「查看秘密」与「复制密码」一样要求二次认证
  ('reveal_requires_reauth', 'true', 'security', '2026-01-01T00:00:00Z'),
  -- 明文在界面上停留的秒数，超时自动隐藏
  ('secret_visible_seconds', '10', 'security', '2026-01-01T00:00:00Z'),
  -- 是否允许「复制密码」这一动作本身（关闭后高风险动作一律不可用）
  ('accounts_allow_copy_password', 'true', 'security', '2026-01-01T00:00:00Z'),
  -- 敏感导出是否要求刚通过二次认证。交付方 2026-10-19 定为出厂关闭（点「确认导出」直接落盘）；
  -- 已有库由 0007 迁移改值，这一行只管新建的库。
  ('export_requires_reauth', 'false', 'security', '2026-01-01T00:00:00Z'),
  -- 二次认证的有效窗口（秒）
  ('reauth_window_seconds', '120', 'security', '2026-01-01T00:00:00Z'),
  -- 快捷启动器：是否显示最近条目、是否允许「打开并安全填充」
  ('quick_launcher_show_recent', 'true', 'ui', '2026-01-01T00:00:00Z'),
  -- 排序档（需求 line 294）：true 时同一匹配等级内按 收藏 > 默认账号 > 最近使用 微调；
  -- 关掉后只按 完全 > 前缀 > 包含 排，同级保持索引原序。匹配等级与 AND 过滤永远不受它影响。
  ('quick_launcher_rank_recent_favorite', 'true', 'ui', '2026-01-01T00:00:00Z'),
  ('quick_launcher_fill_enabled', 'true', 'ui', '2026-01-01T00:00:00Z');

-- 从未被读取的孤儿键：schema 版本以 schema_migrations 为准（db::migrate::version），
-- 这一行写在 0002 里却没有任何代码读它，留着只会让人以为它是权威版本号。
DELETE FROM app_settings WHERE key = 'db_schema_version';
