//! 非秘密设置（app_settings，安装级）与本地使用者偏好（user_preferences，按 app_user_id 区分）。
//! 秘密一律不在此处；主题、快捷键、超时、剪贴板清理延时等可安全明文保存。
//!
//! 需求 §516 提到的 `quick_launcher_preferences` 是**可选**独立表，本项目未建该表：
//! 快捷启动器的开关全部走 app_settings（安装级，改动需要系统安全权限），
//! 只有主题这类真正因人而异的项走 user_preferences。多使用者机器上"关掉快捷启动器的推荐"
//! 就是对所有本地使用者关掉——这是有意选择的口径，验收时按此理解。

use crate::db::repo::now;
use crate::db::Db;
use crate::error::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

pub fn get(db: &Db, key: &str) -> Result<Option<String>> {
    let conn = db.lock_conn();
    Ok(conn.query_row("SELECT value FROM app_settings WHERE key=?1", params![key], |r| r.get(0)).optional()?)
}

pub fn set(db: &Db, key: &str, value: &str, scope: &str) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO app_settings (key,value,scope,updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, scope=excluded.scope, updated_at=excluded.updated_at",
        params![key, value, scope, now()],
    )?;
    Ok(())
}

pub fn get_i64(db: &Db, key: &str, default: i64) -> i64 {
    get(db, key).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn get_bool(db: &Db, key: &str, default: bool) -> bool {
    get(db, key).ok().flatten().map(|v| v == "true" || v == "1").unwrap_or(default)
}

pub fn all(db: &Db) -> Result<Vec<(String, String, String)>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare("SELECT key, value, scope FROM app_settings ORDER BY key")?;
    let v = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn get_user_pref(db: &Db, user_id: &str, key: &str) -> Result<Option<String>> {
    let conn = db.lock_conn();
    Ok(conn
        .query_row("SELECT value FROM user_preferences WHERE app_user_id=?1 AND key=?2", params![user_id, key], |r| r.get(0))
        .optional()?)
}

pub fn set_user_pref(db: &Db, user_id: &str, key: &str, value: &str) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO user_preferences (app_user_id,key,value,updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(app_user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        params![user_id, key, value, now()],
    )?;
    Ok(())
}

/// 主题风格按使用者区分；明暗身份由风格本身携带，不再有独立的模式轴（S 轮）。
pub fn theme_for(db: &Db, user_id: &str) -> Result<String> {
    let raw = get_user_pref(db, user_id, "theme_style")?
        .or(get(db, "theme_style")?)
        .unwrap_or_else(|| "glass".into());
    // 读到的值不在枚举内、也不是表里存在的自定义档（旧库残留、手工改库、主题被删）时按默认档处理，
    // 绝不让一个 tokens.css 里没有的名字进界面——那等于整套变量取不到值，界面退回浏览器默认色。
    if theme_style_is_known(db, &raw)? {
        Ok(raw)
    } else {
        Ok("glass".into())
    }
}

/// 主题风格的唯一事实来源：选择器（commands::system::THEME_STYLES）、校验（set_theme）
/// 与前端 tokens.css 的 `[data-theme=…]` 必须完全一致，否则会出现「列出的风格无法被保存」
/// 或「保存了却没有对应 CSS」的静默失效。
///
/// S 轮（2026-10-18）：这套枚举整体换成交付方原型里的四套界面风格，
/// 上一轮的八套（含高对比度无障碍兜底）作废；库里的旧值由迁移 0006 归一到 `glass`。
///
/// 0012 起还有一类**自定义档**：`custom-<id>`，id 必须在 custom_themes 表里存在。
/// 它们不在这个枚举里（枚举配的是 tokens.css 里编译期就写死的那四套），
/// 校验走 `theme_style_is_known`。
pub const THEME_STYLES: &[&str] = &["glass", "minimal", "obsidian", "cyber"];

/// 自定义主题允许出现的令牌名。必须与 tokens.css 的 `[data-theme="glass"]` 块、
/// 以及前端 `src/lib/themeTokens.ts` 的 THEME_TOKEN_NAMES 三方一致（配对关系由
/// ipcContract.test.ts 那条守卫核，缺一名或多一名都红）。
pub const THEME_TOKEN_NAMES: &[&str] = &[
    "--t-primary",
    "--t-primary-hover",
    "--t-primary-glow",
    "--t-text",
    "--t-text-body",
    "--t-text-muted",
    "--t-text-inverse",
    "--t-on-primary-muted",
    "--t-danger",
    "--t-success",
    "--t-success-soft",
    "--t-warning",
    "--t-star",
    "--t-accent",
    "--t-surface",
    "--t-surface-elevated",
    "--t-surface-sunken",
    "--t-border",
    "--t-border-subtle",
    "--t-border-strong",
    "--t-divider",
    "--row-hover",
    "--t-bg",
    "--blob-1",
    "--blob-2",
    "--blob-3",
    "--blur",
    "--blur-overlay",
    "--shadow-dropdown",
    "--shadow-btn",
    "--shadow-sm",
    "--glow-inset",
];

/// 自定义主题的 id 形状：它会拼进 `[data-theme="custom-…"]` 选择器，所以只收小写字母、
/// 数字与连字符，且必须以字母或数字开头。
pub fn custom_theme_id_is_valid(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=32).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// 令牌值的注入闸门。语法级的严格校验在前端做（它会逐枚报行号与原因），这一层守的是
/// "就算前端被绕过、请求直接打进来，落库的值也拼不出 `}` / `<` / `url(` / `@import` 这些形状"。
/// 允许的字符恰好覆盖四套主题里出现过的全部字面量：#hex、rgb()/rgba()、var()、blur()、
/// 阴影的数值与单位、transparent 这类关键字。
fn token_value_is_safe(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 160
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '#' | '%' | '(' | ')' | ',' | '.' | ' ' | '-'))
}

/// 令牌 JSON 必须是 { 白名单名: 安全字面量 } 的扁平对象，至少一枚、至多整套。
/// 通过时返回规范化后的 (名, 值) 列表。
fn normalize_theme_tokens(tokens_json: &str) -> Option<Vec<(String, String)>> {
    let parsed: serde_json::Map<String, serde_json::Value> = serde_json::from_str(tokens_json).ok()?;
    // 整套齐全是硬条件：`:root` 里没有这些令牌的默认值，缺一枚就意味着那一档下某个 var() 取不到值。
    // 前端已经按行号报过一遍，这里再守一次——请求直接打进来时不能靠前端把关。
    if parsed.len() != THEME_TOKEN_NAMES.len() || !THEME_TOKEN_NAMES.iter().all(|n| parsed.contains_key(*n)) {
        return None;
    }
    let mut out = Vec::with_capacity(parsed.len());
    for (k, v) in parsed {
        if !THEME_TOKEN_NAMES.contains(&k.as_str()) {
            return None;
        }
        let Some(s) = v.as_str() else { return None };
        if !token_value_is_safe(s) {
            return None;
        }
        out.push((k, s.to_string()));
    }
    Some(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    /// 规范化之后的 JSON 对象串（键已核过白名单、值已核过字面形状）。
    pub tokens: String,
}

pub fn list_custom_themes(db: &Db) -> Result<Vec<CustomTheme>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare("SELECT id, name, tokens FROM custom_themes ORDER BY created_at, id")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CustomTheme {
                id: r.get(0)?,
                name: r.get(1)?,
                tokens: r.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn custom_theme_exists(db: &Db, id: &str) -> Result<bool> {
    let conn = db.lock_conn();
    Ok(conn
        .query_row("SELECT 1 FROM custom_themes WHERE id=?1", params![id], |_| Ok(true))
        .optional()?
        .is_some())
}

/// 新增一档自定义主题。`tokens_json` 不合规直接拒（InvalidInput），库里从不存用户原文。
pub fn add_custom_theme(db: &Db, id: &str, name: &str, tokens_json: &str) -> Result<()> {
    if !custom_theme_id_is_valid(id) {
        return Err(crate::error::AppError::InvalidInput);
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 24 {
        return Err(crate::error::AppError::InvalidInput);
    }
    let Some(tokens) = normalize_theme_tokens(tokens_json) else {
        return Err(crate::error::AppError::InvalidInput);
    };
    // 重新序列化一遍：落库的是规范化后的那份，不是收到的那串
    let canonical = serde_json::to_string(&tokens.into_iter().collect::<std::collections::BTreeMap<_, _>>())
        .map_err(|_| crate::error::AppError::Internal)?;
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO custom_themes (id,name,tokens,created_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, tokens=excluded.tokens, created_at=excluded.created_at",
        params![id, name, canonical, now()],
    )?;
    Ok(())
}

/// 删一档自定义主题。若当前正选用它，调用方负责先切回内置档——这里把它一并归一到 glass，
/// 免得留下一个"存着却查不到 CSS"的主题值（那等于整套 var() 取不到值）。
pub fn delete_custom_theme(db: &Db, id: &str) -> Result<()> {
    if !custom_theme_id_is_valid(id) {
        return Err(crate::error::AppError::InvalidInput);
    }
    let style = format!("custom-{id}");
    let conn = db.lock_conn();
    conn.execute("DELETE FROM custom_themes WHERE id=?1", params![id])?;
    conn.execute("UPDATE app_settings SET value='glass' WHERE key='theme_style' AND value=?1", params![style])?;
    conn.execute("UPDATE user_preferences SET value='glass' WHERE key='theme_style' AND value=?1", params![style])?;
    Ok(())
}

/// 主题值是否可用：内置四套，或表里真的存在的 `custom-<id>`。
pub fn theme_style_is_known(db: &Db, style: &str) -> Result<bool> {
    if THEME_STYLES.contains(&style) {
        return Ok(true);
    }
    match style.strip_prefix("custom-") {
        Some(id) => Ok(custom_theme_id_is_valid(id) && custom_theme_exists(db, id)?),
        None => Ok(false),
    }
}

pub fn set_theme(db: &Db, user_id: &str, style: &str) -> Result<()> {
    if !theme_style_is_known(db, style)? {
        return Err(crate::error::AppError::InvalidInput);
    }
    set_user_pref(db, user_id, "theme_style", style)
}

/// 还没有使用者时的外观写入：落在安装级，`theme_for` 与 `get_theme` 都会读回来。
/// 首启页（保险库尚未创建）与锁定中的界面用它把用户选的主题留住，重启不丢。
pub fn set_theme_install(db: &Db, style: &str) -> Result<()> {
    if !theme_style_is_known(db, style)? {
        return Err(crate::error::AppError::InvalidInput);
    }
    set(db, "theme_style", style, "ui")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory(&vec![51u8; 32]).unwrap()
    }

    /// user_preferences 对外键 app_users(id)：偏好必须挂在真实存在的使用者上，
    /// 否则外键约束会拒绝写入（这正是约束要防的脏数据）。
    fn seed_users(db: &Db, ids: &[&str]) {
        let c = db.lock_conn();
        for id in ids {
            c.execute(
                "INSERT INTO app_users
                 (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,
                  pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
                 VALUES (?1,?2,'测试使用者','argon2id',?3,?4,1,1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                params![id, format!("MDA-{id}"), b"salt".as_slice(), b"hash".as_slice()],
            )
            .unwrap();
        }
    }

    #[test]
    fn seeded_defaults_are_readable() {
        let d = db();
        assert_eq!(get_i64(&d, "session_idle_timeout_minutes", 0), 10);
        // 0008 起这枚出厂值是 false（复制密码不再要求再验主密码，交付方 2026-10-20）；
        // 兜底参数刻意写 true：读不到键时必须报"不要求"，这里才能把"键真的在"这件事证出来。
        assert!(!get_bool(&d, "copy_password_requires_reauth", true));
        assert!(!get_bool(&d, "allow_insecure_protocols", true));
        assert_eq!(get(&d, "theme_style").unwrap().as_deref(), Some("glass"));
    }

    #[test]
    fn user_theme_preference_overrides_install_default() {
        let d = db();
        seed_users(&d, &["u1", "u2"]);
        set_user_pref(&d, "u1", "theme_style", "cyber").unwrap();
        assert_eq!(theme_for(&d, "u1").unwrap(), "cyber");
        // 另一位使用者仍取安装默认，互不覆盖
        assert_eq!(theme_for(&d, "u2").unwrap(), "glass");
    }

    /// 库里留着上一轮那八套名字时（迁移 0006 之后仍可能被手工改库写回），读取侧按默认档处理：
    /// 一个 tokens.css 里没有的名字进界面，等于整套变量取不到值、界面退回浏览器默认色。
    #[test]
    fn stale_theme_name_from_an_older_round_falls_back_to_default() {
        let d = db();
        seed_users(&d, &["u1"]);
        set_user_pref(&d, "u1", "theme_style", "enterprise-blue").unwrap();
        assert_eq!(theme_for(&d, "u1").unwrap(), "glass");
    }

    #[test]
    fn rejects_unknown_theme_style() {
        let d = db();
        seed_users(&d, &["u1"]);
        assert!(set_theme(&d, "u1", "hot-pink").is_err());
        // 上一轮的八套名字如今全部不合法（含那枚高对比度无障碍兜底）
        assert!(set_theme(&d, "u1", "high-contrast").is_err());
        assert!(set_theme(&d, "u1", "liquid-glass").is_err());
        set_theme(&d, "u1", "obsidian").unwrap();
    }

    /// 首启页还没有使用者，主题必须能落到安装级并被读回来——否则切换器只能活在内存里，
    /// 重启就退回默认档，用户会觉得那次选择没被听见。
    #[test]
    fn install_scope_theme_round_trips_without_a_user() {
        let d = db();
        assert_eq!(get(&d, "theme_style").unwrap().as_deref(), Some("glass"));
        set_theme_install(&d, "obsidian").unwrap();
        assert_eq!(get(&d, "theme_style").unwrap().as_deref(), Some("obsidian"));
        // 没有使用者偏好时，theme_for 走的就是这一枚安装级值
        seed_users(&d, &["u9"]);
        assert_eq!(theme_for(&d, "u9").unwrap(), "obsidian");
        assert!(set_theme_install(&d, "hot-pink").is_err());
    }

    /// 列表漂移曾经让「简洁浅色」在选择器里叫 clean-light、在写入校验里叫 light-clean，
    /// 用户选了它只会得到 InvalidInput。四套风格必须逐个既能存又能被 CSS 消费。
    #[test]
    fn every_listed_theme_style_persists_and_has_css_tokens() {
        let d = db();
        seed_users(&d, &["u1"]);
        let css = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/styles/tokens.css"))
            .expect("需要能读到前端 tokens.css，否则主题契约无法校验");
        assert_eq!(THEME_STYLES.len(), 4, "S 轮起主题集合固定为交付方原型的那四套界面风格");
        for style in THEME_STYLES {
            set_theme(&d, "u1", style).unwrap_or_else(|e| panic!("{style} 应可保存，实际失败：{e:?}"));
            assert_eq!(theme_for(&d, "u1").unwrap(), *style);
            assert!(
                css.contains(&format!("[data-theme=\"{style}\"]")),
                "{style} 在 tokens.css 中没有 [data-theme] 变量块，切换后界面不会有任何视觉变化"
            );
        }
    }

    /// 自定义主题的令牌白名单必须与 tokens.css 的 glass 块成对：缺失 0 且陈旧 0。
    /// 只写"我们列了 32 枚"不算——名单会漂，漂了就有令牌存得进来却没有对应 CSS，
    /// 或者 CSS 里有、用户却永远填不了。
    #[test]
    fn theme_token_whitelist_matches_tokens_css_both_directions() {
        let css = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/styles/tokens.css"))
            .expect("需要能读到前端 tokens.css");
        let block = css
            .split("[data-theme=\"glass\"]")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("tokens.css 里得有 [data-theme=\"glass\"] 块");
        let real: Vec<String> = block
            .lines()
            .filter_map(|l| Some(l.trim().strip_prefix("--")?))
            .filter_map(|l| l.split(':').next().map(|n| format!("--{n}")))
            .map(|s| s.trim().to_string())
            .collect();
        let missing: Vec<&String> = real.iter().filter(|n| !THEME_TOKEN_NAMES.contains(&n.as_str())).collect();
        let stale: Vec<String> = THEME_TOKEN_NAMES
            .iter()
            .filter(|n| !real.iter().any(|r| r == *n))
            .map(|n| n.to_string())
            .collect();
        assert!(missing.is_empty(), "tokens.css 里有、白名单里没有（缺失）：{missing:?}");
        assert!(stale.is_empty(), "白名单里有、tokens.css 里没有（陈旧）：{stale:?}");
        assert!(real.len() >= 30, "glass 块只解析出 {} 枚，解析本身大概是坏的", real.len());
    }

    /// 自定义档：存进去之后 set_theme 才认，删掉之后 theme_for 必须回退到 glass，
    /// 绝不能留着一个"查不到 CSS"的 data-theme 值。
    /// 一整套合法令牌（值取自 THEME_TOKEN_NAMES 的顺序，覆盖项按需替换）。
    /// 与前端那份夹具一样不手抄 tokens.css 的色值——这里要证的不是颜色对不对，是形状过不过关。
    fn full_tokens_json(overrides: &[(&str, &str)]) -> String {
        let mut map = std::collections::BTreeMap::new();
        for name in THEME_TOKEN_NAMES {
            let value = overrides
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| *v)
                .unwrap_or("red");
            map.insert(*name, value);
        }
        serde_json::to_string(&map).unwrap()
    }

    #[test]
    fn custom_theme_roundtrip_gates_set_theme_and_falls_back_on_delete() {
        let d = db();
        seed_users(&d, &["u1"]);
        // 值里带 # 的 JSON 要用 r##"…"##：r#"…"# 会在 `"#` 处被提前截断
        let tokens = full_tokens_json(&[("--t-primary", "#0e6ba8"), ("--t-bg", "#eef4f8")]);
        add_custom_theme(&d, "sea", "海盐蓝", &tokens).unwrap();

        assert!(theme_style_is_known(&d, "custom-sea").unwrap());
        set_theme(&d, "u1", "custom-sea").unwrap();
        assert_eq!(theme_for(&d, "u1").unwrap(), "custom-sea");
        // 列表里读回来的是规范化后的那份，键序稳定
        let listed = list_custom_themes(&d).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "海盐蓝");
        assert_eq!(listed[0].tokens, full_tokens_json(&[("--t-primary", "#0e6ba8"), ("--t-bg", "#eef4f8")]));

        delete_custom_theme(&d, "sea").unwrap();
        assert!(!theme_style_is_known(&d, "custom-sea").unwrap());
        assert_eq!(theme_for(&d, "u1").unwrap(), "glass", "删掉正在用的自定义档后必须回退，不能留空引用");
    }

    /// 写入侧的注入闸门：id 形状、令牌名白名单、值的字面形状，三样各拒一次。
    /// 前端已经报过行号了，这一层守的是"请求直接打进来"这条路。
    #[test]
    fn custom_theme_write_rejects_bad_id_unknown_token_and_injection_shaped_value() {
        let d = db();
        assert!(add_custom_theme(&d, "../x", "坏 id", r##"{"--t-primary":"#fff"}"##).is_err());
        assert!(add_custom_theme(&d, "ok1", "不在白名单", r##"{"--t-nonsense":"#fff"}"##).is_err());
        assert!(add_custom_theme(&d, "ok2", "非字符串值", r#"{"--t-primary":123}"#).is_err());
        assert!(add_custom_theme(&d, "ok3", "空对象", "{}").is_err());
        // 只给一枚（哪怕值都合法）也不收：半套规则进界面比不进去更糟
        assert!(add_custom_theme(&d, "ok3b", "半套", r#"{"--t-primary":"red"}"#).is_err());
        // 值里带 } 与 < 是 CSS 注入的两条主路，必须挡在落库之前
        assert!(add_custom_theme(&d, "ok4", "闭合大括号", r#"{"--t-primary":"red}body{display:none"}"#).is_err());
        assert!(add_custom_theme(&d, "ok5", "尖括号", r##"{"--t-primary":"#fff<img src=x>"}"##).is_err());
        assert!(add_custom_theme(&d, "ok6", "url 函数", r#"{"--t-bg":"url(http://a/b)"}"#).is_err());
        assert!(list_custom_themes(&d).unwrap().is_empty(), "被拒的都不该留在表里");
    }
}
