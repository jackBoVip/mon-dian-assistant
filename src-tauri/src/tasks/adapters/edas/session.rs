//! 会话：隐藏 WebView 换来的 Cookie 只在 Rust 内存里活着一小会儿。
//!
//! 三条边界：
//! - Cookie 值与口令都不落库、不进日志、不回前端；`CookieSession` 装在 `Zeroizing` 里，Drop 即清零。
//! - 有 TTL（默认 30 分钟）。过期不是错误，是"再来一次静默登录"的信号。
//! - 保险库一锁定就整柜丢掉（`clear_all`），运行侧由 `tasks::runner::cancel_all` 停下。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use zeroize::Zeroizing;

pub const DEFAULT_TTL_MINUTES: i64 = 30;

/// WebView 交回来的一枚 Cookie 的最小视图。`login` 负责从 `tauri` 的 Cookie 类型映射到这里，
/// 这样挑选与拼接的规则就能离线测（不需要真的开一个窗口）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
}

/// 一次登录换来的会话。
pub struct CookieSession {
    header: Zeroizing<String>,
    names: Vec<String>,
    acquired: Instant,
    ttl: Duration,
}

impl CookieSession {
    /// 直接进 `Cookie` 请求头的那一串。调用方用完即弃，不要复制进日志。
    pub fn header(&self) -> &str {
        self.header.as_str()
    }

    /// 只含 Cookie 名字，给探测命令与界面显示"拿到了哪几枚"用。
    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn acquired_secs_ago(&self) -> u64 {
        self.acquired.elapsed().as_secs()
    }

    pub fn fresh(&self) -> bool {
        self.acquired.elapsed() < self.ttl
    }

    /// 取某枚 Cookie 的值（CSRF 头要用）。这是本模块唯一会把值交出去的地方。
    pub fn cookie_value(&self, name: &str) -> Option<String> {
        self.header
            .split(';')
            .find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                (k.trim() == name && !v.trim().is_empty()).then(|| v.trim().to_string())
            })
    }
}

/// 手工 Debug：会话是装秘密的容器，调试输出里只能出现名字与时长，不能出现值。
impl std::fmt::Debug for CookieSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CookieSession")
            .field("names", &self.names)
            .field("acquired_secs_ago", &self.acquired_secs_ago())
            .field("fresh", &self.fresh())
            .finish_non_exhaustive()
    }
}

/// 从 WebView 交回的 Cookie 里拼会话。
///
/// 判定顺序：先按域后缀筛（不给别的站点当跳板），再按名字去重（同名取第一枚，
/// 原实现是全量拼接，同名两枚会让控制台按后一枚解题），最后要求"必需的那几枚"都在。
pub fn harvest(
    raw: &[RawCookie],
    host_suffixes: &[String],
    required: &[String],
    ttl: Duration,
) -> Option<CookieSession> {
    let mut names: Vec<String> = Vec::new();
    let mut pairs: Vec<String> = Vec::new();
    for cookie in raw {
        let name = cookie.name.trim();
        if name.is_empty() || cookie.value.trim().is_empty() {
            continue;
        }
        let domain = cookie.domain.trim().trim_start_matches('.').to_ascii_lowercase();
        let owned = host_suffixes.iter().any(|suffix| {
            let suffix = suffix.trim_start_matches('.').to_ascii_lowercase();
            !suffix.is_empty() && (domain == suffix || domain.ends_with(&format!(".{suffix}")))
        });
        if !owned {
            continue;
        }
        if names.iter().any(|n| n == name) {
            continue;
        }
        names.push(name.to_string());
        pairs.push(format!("{name}={}", cookie.value.trim()));
    }
    if !required.iter().all(|need| names.iter().any(|n| n == need)) {
        return None;
    }
    if pairs.is_empty() {
        return None;
    }
    Some(CookieSession {
        header: Zeroizing::new(pairs.join(";")),
        names,
        acquired: Instant::now(),
        ttl,
    })
}

pub fn ttl_from_minutes(minutes: i64) -> Duration {
    let minutes = minutes.max(1) as u64;
    Duration::from_secs(minutes * 60)
}

static CACHE: OnceLock<Mutex<HashMap<String, Arc<CookieSession>>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Arc<CookieSession>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 会话缓存键。按"任务 + 环境"分柜：测试与生产是两套站点，绝不能互相顶用。
pub fn cache_key(task_key: &str, env: &str) -> String {
    format!("{task_key}|{env}")
}

pub fn cached(key: &str) -> Option<Arc<CookieSession>> {
    let found = cache().lock().get(key).cloned();
    match found {
        Some(session) if session.fresh() => Some(session),
        Some(_) => {
            // 过期的一枚也别留在柜里：它已经不顶用，还占着内存里的 Cookie 字节。
            cache().lock().remove(key);
            None
        }
        None => None,
    }
}

pub fn store(key: &str, session: CookieSession) -> Arc<CookieSession> {
    let arc = Arc::new(session);
    cache().lock().insert(key.to_string(), arc.clone());
    arc
}

pub fn drop_key(key: &str) {
    cache().lock().remove(key);
}

/// 保险库锁定/退出时调用：所有环境的会话一起丢。
pub fn clear_all() {
    cache().lock().clear();
}

/// 柜里还有几枚会话（给安全状态页与测试用，不回任何内容）。
pub fn cached_count() -> usize {
    cache().lock().len()
}

/// 把字符串变成**安全的 JS 字面量**。
///
/// JSON 是 JS 的子集，但有两个例外：行分隔符 U+2028 与段分隔符 U+2029 在 JSON 字符串里合法、
/// 在 JS 字符串字面量里是语法错误。口令正好带这两个字符时，注入脚本会整段失效，
/// 现场表现是"永远找不到登录表单"——所以显式转义它们。
pub fn js_string_literal(raw: &str) -> String {
    let json = serde_json::to_string(raw).unwrap_or_else(|_| "\"\"".to_string());
    json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rc(name: &str, value: &str, domain: &str) -> RawCookie {
        RawCookie { name: name.to_string(), value: value.to_string(), domain: domain.to_string() }
    }

    const TTL: Duration = Duration::from_secs(60);

    /// 会话柜是进程级静态：测它的两条用例必须串行，否则会互相清掉对方的条目。
    static CACHE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn cache_turn() -> std::sync::MutexGuard<'static, ()> {
        CACHE_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn harvest_keeps_only_cookies_of_the_configured_hosts() {
        let raw = vec![
            rc("c_csrf", "tok1", "edas.console.example.com"),
            rc("login_ticket", "abc", ".console.example.com"),
            rc("junk", "x", "evil.other.com"),
        ];
        let suffixes = vec!["edas.console.example.com".to_string(), "console.example.com".to_string()];
        let s = harvest(&raw, &suffixes, &["c_csrf".to_string()], TTL).expect("必需 Cookie 都在");
        assert_eq!(s.names(), ["c_csrf", "login_ticket"]);
        assert_eq!(s.header(), "c_csrf=tok1;login_ticket=abc");
    }

    #[test]
    fn harvest_requires_every_required_cookie() {
        let raw = vec![rc("other", "1", "edas.example.com")];
        let suffixes = vec!["edas.example.com".to_string()];
        assert!(harvest(&raw, &suffixes, &["c_csrf".to_string()], TTL).is_none());
        // 没有必需项时只要有任一本域 Cookie 就算成功
        assert!(harvest(&raw, &suffixes, &[], TTL).is_some());
        // 空值不算拿到
        let raw = vec![rc("c_csrf", "  ", "edas.example.com")];
        assert!(harvest(&raw, &suffixes, &[], TTL).is_none());
    }

    #[test]
    fn harvest_dedupes_by_name_keeping_the_first() {
        let raw = vec![
            rc("c_csrf", "first", "edas.example.com"),
            rc("c_csrf", "second", "sub.edas.example.com"),
        ];
        let s = harvest(&raw, &["edas.example.com".to_string()], &["c_csrf".to_string()], TTL).unwrap();
        assert_eq!(s.header(), "c_csrf=first");
        assert_eq!(s.cookie_value("c_csrf").as_deref(), Some("first"));
        assert_eq!(s.cookie_value("nope"), None);
    }

    #[test]
    fn cache_round_trip_expiry_and_clear() {
        let _turn = cache_turn();
        let key = cache_key("release", "test");
        clear_all();
        assert_eq!(cached_count(), 0);
        assert!(cached(&key).is_none());

        let session = harvest(&[rc("c_csrf", "v", "edas.example.com")], &["edas.example.com".to_string()], &[], TTL).unwrap();
        store(&key, session);
        assert_eq!(cached_count(), 1);
        assert!(cached(&key).is_some());

        // 过期即淘汰：柜子里不留不顶用的会话字节
        let stale = harvest(
            &[rc("c_csrf", "v", "edas.example.com")],
            &["edas.example.com".to_string()],
            &[],
            Duration::ZERO,
        )
        .unwrap();
        store(&cache_key("release", "prod"), stale);
        assert!(cached(&cache_key("release", "prod")).is_none());
        assert_eq!(cached_count(), 1, "过期的那枚要被清掉");

        drop_key(&key);
        assert_eq!(cached_count(), 0);
    }

    #[test]
    fn production_env_never_shares_the_test_session() {
        let _turn = cache_turn();
        clear_all();
        let test_key = cache_key("release", "test");
        let prod_key = cache_key("release", "prod");
        assert_ne!(test_key, prod_key);
        let session = harvest(&[rc("a", "1", "x.com")], &["x.com".to_string()], &[], TTL).unwrap();
        store(&test_key, session);
        assert!(cached(&prod_key).is_none(), "测试环境的会话不能顶到生产环境");
        clear_all();
    }

    #[test]
    fn js_literals_escape_the_two_characters_json_allows_and_js_does_not() {
        assert_eq!(js_string_literal("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(js_string_literal("line\nbreak\ttab"), r#""line\nbreak\ttab""#);
        assert_eq!(js_string_literal("p\u{2028}q"), r#""p\u2028q""#);
        assert_eq!(js_string_literal("p\u{2029}q"), r#""p\u2029q""#);
        // 中文与常见符号原样保留
        assert_eq!(js_string_literal("蒙电#Pass1"), "\"蒙电#Pass1\"");
    }

    #[test]
    fn ttl_falls_back_to_a_minute_when_misconfigured() {
        assert_eq!(ttl_from_minutes(30), Duration::from_secs(1800));
        assert_eq!(ttl_from_minutes(0), Duration::from_secs(60));
        assert_eq!(ttl_from_minutes(-5), Duration::from_secs(60));
    }
}
