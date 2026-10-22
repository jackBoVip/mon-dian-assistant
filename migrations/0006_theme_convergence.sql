-- 0006：主题轴收敛——把 0002 里已经作废的三枚外观键清掉，并把旧主题名归到新的一枚默认值。
--
-- 这一轮把主题体系整体换成原型的四套（glass / minimal / obsidian / cyber），
-- 连带删掉了三条独立于主题风格的轴：明暗模式（appearance_mode）、玻璃开关（glass_enabled）、
-- 玻璃强度（glass_intensity）。Rust 侧 `settings::THEME_STYLES` 与前端 `lib/theme.ts` 已改成四枚，
-- 于是库里留下的这些键变成两种东西：
--   1) 谁都不再读的死键（三条 mode/glass）；
--   2) 一个读得到、但已经不在合法集里的值（旧主题名，例如 enterprise-blue）。
-- 死键若不清，`get_settings` 会把它们原样列给系统管理页，界面上就会出现"有一行设置改了没反应"；
-- 旧主题名若不清，虽然 `theme_for()` 现在会把它兜底成 glass，但那是靠代码兜而不是数据干净——
-- 备份文件、审计报告、以及任何直接读库的排查都会继续看到一个已经不存在的风格名。
-- 所以两条都在这里做掉，让升级后的库与全新安装的库（0002 出厂值已是 glass）形状一致。
--
-- 归一化写成 NOT IN(...) 而不是逐名替换：旧安装里到底存过哪些名字取决于装过哪几个版本，
-- 逐名列举必然漏，而"不在合法集里"这个判据与代码里的兜底逻辑是同一句话。
-- user_preferences 里每个使用者各自存过 theme_style，也要一起归一，否则个人偏好仍然压着安装级默认值。

DELETE FROM app_settings WHERE key IN ('appearance_mode', 'glass_enabled', 'glass_intensity');
DELETE FROM user_preferences WHERE key IN ('appearance_mode', 'glass_enabled', 'glass_intensity');

UPDATE app_settings
   SET value = 'glass'
 WHERE key = 'theme_style'
   AND value NOT IN ('glass', 'minimal', 'obsidian', 'cyber');

UPDATE user_preferences
   SET value = 'glass'
 WHERE key = 'theme_style'
   AND value NOT IN ('glass', 'minimal', 'obsidian', 'cyber');
