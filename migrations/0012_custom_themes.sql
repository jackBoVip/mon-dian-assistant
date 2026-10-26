-- 0012_custom_themes.sql —— 自定义主题表。
-- 「界面外观」允许把一整套设计令牌粘进来新增一档界面风格。存的是**已按白名单逐值校验过**的
-- 令牌表（JSON 对象），不存用户原文：原文里可以有 `}`、`url()` 这类会破坏 CSS 形状的东西，
-- 落库就等于把注入面持久化了。
--
-- id 是短小写标识（[a-z0-9-]），前端把它拼成 `custom-<id>` 写进 data-theme，
-- 所以这一列的形状在 settings.rs 里也校一遍（两侧都校，谁被绕过都不给注入留口子）。
-- 主题选择本身仍存在 theme_style 这条偏好里（user_preferences / app_settings），
-- 这里只放"有哪些自定义档、每档的令牌是什么"。
CREATE TABLE IF NOT EXISTS custom_themes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tokens     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
