//! 隐藏 WebView 静默登录：在应用内换回会话，界面不出现浏览器，用户零操作。
//!
//! 流程（与原实现同形，只是换了宿主与判据）：
//! 1. `visible(false)` 打开登录地址；
//! 2. 周期性注入"填表 + 提交"脚本——SSO 页面是异步渲染的，一次注入够不着就等下一轮；
//! 3. 在 **Rust 侧**轮询 `Webview::cookies()`（不靠页面 JS 计时器：隐藏窗口会被节流）；
//! 4. 登录成功后按 profile 去授权页点一下跳转按钮，再收一次 Cookie；
//! 5. 无论成功失败，窗口必须销毁（`LoginWindow` 的 Drop）。
//!
//! 凭据边界：用户名与口令只进这一段 JS 字符串，只在内存里；不写日志、不落库、不回前端。
//! 对外只允许出现 [`LoginTrace`] 里的状态串（`filled` / `noframe` / `clicked` / `error:`）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::{WebviewWindow, WebviewWindowBuilder};
use tauri::{Url, WebviewUrl};

use crate::error::{AppError, Result};

use super::profile::EdasProfile;
use super::session::{harvest, js_string_literal, ttl_from_minutes, CookieSession, RawCookie};

/// 注入脚本的返回状态最多留这么长（异常文本可能整页 HTML）。
const STATUS_MAX_CHARS: usize = 80;
static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

/// 一次登录的可观测痕迹：只有状态串与主机名，没有任何凭据或 Cookie 值。
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTrace {
    pub statuses: Vec<String>,
    pub final_host: String,
    pub cookie_names: Vec<String>,
    pub saw_form: bool,
    /// 授权页有没有走到过——现场排障最想知道的一项。
    pub authorize_visited: bool,
}

/// Drop 即销毁窗口：超时、报错、提前成功都不许把隐藏窗口留在机器上。
struct LoginWindow {
    window: WebviewWindow,
}

impl Drop for LoginWindow {
    fn drop(&mut self) {
        let _ = self.window.destroy();
    }
}

/// 「填表并提交」脚本。三个要点：
/// - 值用**原生 setter** 灌进去再派发 input/change——SSO 是 React 受控输入，直接赋 `.value` 它不认；
/// - 任何异常都变成状态串返回：Windows 上 eval 抛异常会被吞掉，现场只能看到"永远找不到表单"；
/// - 用户名/口令走 [`js_string_literal`]，含引号或 U+2028 的口令不会把脚本写坏。
pub fn fill_script(profile: &EdasProfile, username: &str, password: &str) -> String {
    let account = js_string_literal(&profile.login.account_selector);
    let pwd_sel = js_string_literal(&profile.login.password_selector);
    let user = js_string_literal(username);
    let pass = js_string_literal(password);
    let submit = match profile.login.submit.as_str() {
        "click" => format!(
            "var btn = document.querySelector({}); if (!btn) {{ return 'nosubmit'; }} btn.click();",
            js_string_literal(&profile.login.submit_selector)
        ),
        "form" => "if (pwd.form && pwd.form.requestSubmit) { pwd.form.requestSubmit(); } else if (pwd.form) { pwd.form.submit(); } else { return 'noform'; }".to_string(),
        _ => r#"var fire = function (t, code) {
                    var e = new Event(t, { bubbles: true, cancelable: true });
                    e.key = 'Enter'; e.code = 'Enter'; e.keyCode = code; e.which = code;
                    pwd.dispatchEvent(e);
                };
                fire('keydown', 13); fire('keypress', 13); fire('keyup', 13);"#
            .to_string(),
    };
    format!(
        r#"(function () {{
  try {{
    var ACC = {user};
    var PWD = {pass};
    var acc = document.querySelector({account});
    var pwd = document.querySelector({pwd_sel});
    if (!acc || !pwd) {{ return 'noframe'; }}
    var put = function (el, v) {{
      var proto = (el && el.constructor && el.constructor.prototype) || window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) {{ d.set.call(el, v); }} else {{ el.value = v; }}
      el.dispatchEvent(new Event('input', {{ bubbles: true }}));
      el.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }};
    if (acc.value !== ACC) {{ put(acc, ACC); }}
    if (pwd.value !== PWD) {{ put(pwd, PWD); }}
    {submit}
    return 'filled';
  }} catch (e) {{
    return 'error:' + String((e && e.message) ? e.message : e).slice(0, 60);
  }}
}})()"#
    )
}

/// 授权页那一点击。`xpath=` 前缀走 `document.evaluate`（结果类型 9 = FIRST_ORDERED_NODE_TYPE），
/// 否则按 CSS 选择器。
pub fn authorize_script(profile: &EdasProfile) -> String {
    let sel = js_string_literal(&profile.login.authorize_selector);
    format!(
        r#"(function () {{
  try {{
    var sel = {sel};
    var el = null;
    if (sel.indexOf('xpath=') === 0) {{
      var r = document.evaluate(sel.slice(6), document, null, 9, null);
      el = r.singleNodeValue;
    }} else {{
      el = document.querySelector(sel);
    }}
    if (!el) {{ return 'noframe'; }}
    el.click();
    return 'clicked';
  }} catch (e) {{
    return 'error:' + String((e && e.message) ? e.message : e).slice(0, 60);
  }}
}})()"#
    )
}

/// 登录地址的 scheme 闸门，单独抽出来测：不建窗口就能验到它。
///
/// https 永远放行；http 只在 `allow_http` 为真时放行——那个bool 由调用方按"测试环境 且
/// 管理员开了 `allow_insecure_protocols`"算出来（见 `super::allow_http_for`），
/// **不是** profile 里的一个字段：站点配置不该有权力关掉本应用的协议红线。
pub fn scheme_error(login_url: &str, allow_http: bool) -> Result<Url> {
    let url = Url::parse(login_url.trim()).map_err(|_| AppError::TaskProfileInvalid("登录地址无法解析".to_string()))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if allow_http => Ok(url),
        other => Err(AppError::TaskProfileInvalid(format!(
            "登录地址无法使用（收到 {other}）：明文 http 需要管理员在安全策略里开启「允许不安全协议」"
        ))),
    }
}

/// `eval_with_callback` 交回的是"已 JSON 序列化的结果"，可能带引号；这里统一还原成状态串。
/// 只承认那几个已知状态，其余记为 `unknown`：页面回传的东西一律不进日志。
pub fn eval_status(raw: &str) -> String {
    let trimmed = raw.trim();
    let decoded: String = serde_json::from_str(trimmed).unwrap_or_else(|_| trimmed.trim_matches('"').to_string());
    let cleaned: String = decoded.chars().filter(|c| !c.is_control()).collect();
    let clipped: String = cleaned.chars().take(STATUS_MAX_CHARS).collect();
    let guarded = crate::tasks::redact(&clipped);
    for known in ["noframe", "nosubmit", "noform", "clicked", "filled", "error:"] {
        if guarded.starts_with(known) {
            return known.to_string();
        }
    }
    "unknown".to_string()
}

fn domain_matches(domain: &str, suffix: &str) -> bool {
    let d = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    let s = suffix.trim().trim_start_matches('.').to_ascii_lowercase();
    !s.is_empty() && (d == s || d.ends_with(&format!(".{s}")))
}

/// 当前页面主机名（只到主机名：路径与查询串可能带一次性令牌）。
fn current_host(window: &WebviewWindow) -> String {
    window
        .url()
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .unwrap_or_default()
}

fn raw_cookies(window: &WebviewWindow) -> Vec<RawCookie> {
    let fallback = current_host(window);
    window
        .cookies()
        .unwrap_or_default()
        .into_iter()
        .map(|c| RawCookie {
            name: c.name().to_string(),
            value: c.value().to_string(),
            domain: c.domain().unwrap_or(&fallback).to_string(),
        })
        .collect()
}

/// 名字列表：本域下拿到了哪几枚 Cookie（值不外带）。
pub fn cookie_names(window: &WebviewWindow, suffixes: &[String]) -> Vec<String> {
    raw_cookies(window)
        .iter()
        .filter(|c| suffixes.iter().any(|s| domain_matches(&c.domain, s)))
        .map(|c| c.name.clone())
        .collect()
}

/// 一次静默登录的结果：**总是**带线索回来，会话可能为 None。
///
/// 为什么失败也要带线索：现场排障时"注入过表单但页面没跳走"和"根本没找到表单"是两种病，
/// 而这两种病在界面上长得一模一样。线索里只有状态串与主机名。
#[derive(Debug, Default)]
pub struct LoginOutcome {
    pub trace: LoginTrace,
    pub session: Option<CookieSession>,
}

/// 走一遍静默登录换会话。`login` 本身不返回 `Result`：失败是"线索 + 没有会话"，
/// 由调用方决定报哪种错（命令层报 `TASK_SESSION_EXPIRED`，探测命令直接把线索给界面）。
pub fn login(
    app: &tauri::AppHandle,
    profile: &EdasProfile,
    login_url: &str,
    username: &str,
    password: &str,
    allow_http: bool,
) -> LoginOutcome {
    let url = match scheme_error(login_url, allow_http) {
        Ok(url) => url,
        Err(e) => {
            log::warn!("静默登录未启动：{e}");
            return LoginOutcome {
                trace: LoginTrace {
                    statuses: vec!["config-rejected".to_string()],
                    ..Default::default()
                },
                session: None,
            };
        }
    };
    let suffixes = profile.cookie_host_suffixes();
    let required = profile.session.required_cookie_names.clone();
    let ttl = ttl_from_minutes(profile.session.ttl_minutes);
    let timeout = Duration::from_millis(profile.login.timeout_ms.max(5_000));
    let step = Duration::from_millis(profile.login.inject_retry_ms.max(100));
    let settle = Duration::from_millis(profile.login.authorize_settle_ms);
    let authorize_url = profile.login.authorize_url.trim().to_string();
    let deadline = Instant::now() + timeout;

    let label = format!("mda-silent-login-{}", WINDOW_SEQ.fetch_add(1, Ordering::SeqCst));
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .visible(false)
        .decorations(false)
        .resizable(false)
        .focusable(false)
        .skip_taskbar(true)
        .title("任务中心静默登录")
        .inner_size(profile.login_viewport[0] as f64, profile.login_viewport[1] as f64)
        .devtools(false)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            log::warn!("隐藏登录窗口起不来：{}", short_reason(&e));
            return LoginOutcome {
                trace: LoginTrace {
                    statuses: vec!["nowindow".to_string()],
                    ..Default::default()
                },
                session: None,
            };
        }
    };
    let _guard = LoginWindow { window: window.clone() };

    let last: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut trace = LoginTrace::default();
    let mut saw_form = false;
    // 没配授权页时，登录页自己就是终点。
    let mut need_authorize = !authorize_url.is_empty();
    let mut next_click_at: Option<Instant> = None;

    let eval = |script: String| {
        let sink = last.clone();
        let _ = window.eval_with_callback(script, move |raw| {
            if let Ok(mut slot) = sink.lock() {
                *slot = Some(raw);
            }
        });
    };

    while Instant::now() < deadline {
        // 1. 先看现成的 Cookie。授权页还没走过时不算数——控制台的会话正是那一跳发下来的。
        if !need_authorize {
            let cookies = raw_cookies(&window);
            if let Some(session) = harvest(&cookies, &suffixes, &required, ttl) {
                trace.cookie_names = session.names().to_vec();
                trace.final_host = current_host(&window);
                return LoginOutcome { trace, session: Some(session) };
            }
        }

        // 2. 还没去过授权页就反复注入填表脚本（SSO 异步渲染，一次够不着就得等下一轮）；
        //    去过之后按 settle 间隔补点授权按钮。
        if !trace.authorize_visited {
            eval(fill_script(profile, username, password));
        } else if let Some(at) = next_click_at {
            if Instant::now() >= at {
                eval(authorize_script(profile));
                next_click_at = Some(Instant::now() + settle);
            }
        }

        std::thread::sleep(step);
        let status = last
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .map(|r| eval_status(&r))
            .unwrap_or_default();
        if !status.is_empty() && trace.statuses.last().map(String::as_str) != Some(status.as_str()) {
            trace.statuses.push(status.clone());
            if profile.trace_login {
                log::debug!("静默登录状态：{status}");
            }
        }
        if status == "filled" {
            saw_form = true;
        }

        // 3. 登录态推进：注入过表单、现在找不到它 = 页面已经跳走了。
        if need_authorize && (status == "noframe" && saw_form || status == "clicked") {
            if let Ok(target) = Url::parse(&authorize_url) {
                let _ = window.navigate(target);
                trace.authorize_visited = true;
                need_authorize = false;
                next_click_at = Some(Instant::now() + settle);
            }
        }
    }

    trace.final_host = current_host(&window);
    trace.cookie_names = cookie_names(&window, &suffixes);
    log::warn!(
        "静默登录未在 {} 毫秒内拿到会话 Cookie（见过的状态：{:?}，最终主机 {}）",
        timeout.as_millis(),
        trace.statuses,
        trace.final_host
    );
    LoginOutcome { trace, session: None }
}

fn short_reason(error: &tauri::Error) -> String {
    let text = error.to_string();
    let mut out: String = text.chars().take(120).collect();
    if out.is_empty() {
        out.push_str("未知原因");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_script_carries_selectors_and_both_values_as_literals() {
        let p = EdasProfile::default();
        let js = fill_script(&p, r#"user"x"#, "p\\a\"ss\nnewline");
        assert!(js.contains(r#""user\"x""#), "{js}");
        assert!(js.contains(r#""p\\a\"ss\nnewline""#), "{js}");
        assert!(js.contains("#account"));
        assert!(js.contains("#password"));
        // 默认回车提交：不该顺带把表单 submit 掉
        assert!(js.contains("keydown"), "{js}");
        assert!(!js.contains("requestSubmit"), "回车模式不该提交表单");
    }

    #[test]
    fn submit_modes_match_the_profile() {
        let mut p = EdasProfile::default();
        p.login.submit = "form".into();
        assert!(fill_script(&p, "u", "p").contains("requestSubmit"));
        p.login.submit = "click".into();
        p.login.submit_selector = "#loginBtn".into();
        let js = fill_script(&p, "u", "p");
        assert!(js.contains("#loginBtn"), "{js}");
        assert!(js.contains("nosubmit"), "{js}");
    }

    #[test]
    fn authorize_script_supports_xpath_and_css() {
        let p = EdasProfile::default();
        let js = authorize_script(&p);
        assert!(js.contains("document.evaluate"), "{js}");
        assert!(js.contains("icestarkNode"), "{js}");
        let mut q = p.clone();
        q.login.authorize_selector = "#jump > button".into();
        assert!(authorize_script(&q).contains("#jump > button"));
    }

    #[test]
    fn eval_status_normalises_the_wire_format() {
        assert_eq!(eval_status("\"filled\""), "filled");
        assert_eq!(eval_status("noframe"), "noframe");
        assert_eq!(eval_status("\"error:Cannot read properties of null\""), "error:");
        // 页面把别的东西回传回来了：不认，也不原样进日志
        let leaked = eval_status("\"Cookie: SESSION=abc123\"");
        assert_eq!(leaked, "unknown");
        assert!(!leaked.contains("abc123"));
        assert_eq!(eval_status(&format!("\"filled{}\"", "x".repeat(500))), "filled");
        assert_eq!(eval_status(""), "unknown");
    }

    #[test]
    fn domain_suffix_matching_is_dot_insensitive() {
        assert!(domain_matches(".console.example.com", "console.example.com"));
        assert!(domain_matches("edas.console.example.com", "console.example.com"));
        assert!(!domain_matches("example.com", "console.example.com"));
        assert!(domain_matches("EDAS.Example.com", "edas.example.com"));
        assert!(!domain_matches("x", ""));
    }

    #[test]
    fn scheme_gate_runs_before_any_window_is_created() {
        assert!(scheme_error("https://login.example.com/sso", false).is_ok());
        // 明文：没被放行 → 拒
        assert_eq!(scheme_error("http://login.example.com/sso", false).unwrap_err().code(), "TASK_PROFILE_INVALID");
        assert!(scheme_error("http://login.example.com/sso", true).is_ok(), "管理员放行后明文可用（生产控制台就是 http）");
        // 其它协议 / 不合法地址
        assert_eq!(scheme_error("ftp://x", true).unwrap_err().code(), "TASK_PROFILE_INVALID");
        assert_eq!(scheme_error("不是地址", true).unwrap_err().code(), "TASK_PROFILE_INVALID");
    }

    #[test]
    fn trace_serialises_camel_case_and_carries_no_values() {
        let trace = LoginTrace {
            statuses: vec!["filled".into(), "noframe".into(), "clicked".into()],
            final_host: "edas.console.example.com".into(),
            cookie_names: vec!["c_csrf".into()],
            saw_form: true,
            authorize_visited: true,
        };
        let json = serde_json::to_string(&trace).unwrap();
        assert!(json.contains("\"authorizeVisited\":true"), "{json}");
        assert!(json.contains("\"finalHost\""), "{json}");
        assert!(!json.contains('='), "线索里不该出现任何 k=v 形态的凭据：{json}");
    }
}
