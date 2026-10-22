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
    // 读到的值不在枚举内（旧库残留、手工改库）时按默认档处理，绝不让一个 tokens.css
    // 里没有的名字进界面——那等于整套变量取不到值，界面退回浏览器默认色。
    Ok(if THEME_STYLES.contains(&raw.as_str()) {
        raw
    } else {
        "glass".into()
    })
}

/// 主题风格的唯一事实来源：选择器（commands::system::THEME_STYLES）、校验（set_theme）
/// 与前端 tokens.css 的 `[data-theme=…]` 必须完全一致，否则会出现「列出的风格无法被保存」
/// 或「保存了却没有对应 CSS」的静默失效。
///
/// S 轮（2026-10-18）：这套枚举整体换成交付方原型里的四套界面风格，
/// 上一轮的八套（含高对比度无障碍兜底）作废；库里的旧值由迁移 0006 归一到 `glass`。
pub const THEME_STYLES: &[&str] = &["glass", "minimal", "obsidian", "cyber"];

pub fn set_theme(db: &Db, user_id: &str, style: &str) -> Result<()> {
    if !THEME_STYLES.contains(&style) {
        return Err(crate::error::AppError::InvalidInput);
    }
    set_user_pref(db, user_id, "theme_style", style)
}

/// 还没有使用者时的外观写入：落在安装级，`theme_for` 与 `get_theme` 都会读回来。
/// 首启页（保险库尚未创建）与锁定中的界面用它把用户选的主题留住，重启不丢。
pub fn set_theme_install(db: &Db, style: &str) -> Result<()> {
    if !THEME_STYLES.contains(&style) {
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
}
