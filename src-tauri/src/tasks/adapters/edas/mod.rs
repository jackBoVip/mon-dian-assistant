//! EDAS 控制台适配器（第一个适配器）。
//!
//! 与原「蒙电运维」实现的对应关系：
//! - 四个控制台读接口 + 一个改镜像接口 → [`profile::EdasProfile`] 里的端点声明；
//! - Chrome + rod 登录 → [`login`]：应用内隐藏 WebView 静默登录，界面不出现浏览器；
//! - `InsecureSkipVerify: true` → [`client`]：验证书，企业内网证书走 `caPemPath` 显式注入；
//! - `for {}` 无界轮询 → [`profile::PollRule`]：间隔与次数都有上限，且每一步都听取消信号。
//!
//! 原实现里写死在 `taskParms.go` 的域名 / namespace / region / 仓库 ID，这里全部是数据；
//! 换环境改 `task_profiles.profile_json`，不改代码、不发版。

pub mod adapter;
pub mod client;
pub mod image_ref;
pub mod login;
pub mod prepare;
pub mod profile;
pub mod publish;
pub mod release_notes;
pub mod session;

pub use client::EdasClient;
pub use login::LoginOutcome;
pub use profile::EdasProfile;
pub use session::CookieSession;

use std::sync::Arc;

use crate::db::repo;
use crate::error::{AppError, Result};
use crate::settings;
use crate::state::{AppCore, SharedCore};
use crate::tasks::{store, Env};

/// 明文 http 的唯一放行口径：管理员在安全策略里显式开了「允许不安全协议」。
///
/// 两件事刻意不做：一、不按环境写死——内蒙电的生产控制台本身就是 http，把生产钉成 https
/// 等于这一页在真实环境里用不了（交付方 2026-10-31 点名）；二、不写进 profile——站点配置
/// 没有权力关掉本应用的协议红线，否则一份配置就能悄悄放行明文。开关默认关。
pub fn allow_http_for(core: &SharedCore) -> bool {
    settings::get_bool(&core.db, "allow_insecure_protocols", false)
}

/// 会话缓存键（任务 + 环境）。
pub fn session_cache_key(task_key: &str, env: Env) -> String {
    session::cache_key(task_key, env.as_str())
}

/// 取（或换）一次会话。
///
/// **阻塞实现**：`Webview::cookies()` 在主线程同步调用会在 Windows 上死锁，
/// 所以调用方必须已经在工作线程上（命令层走 `spawn_blocking`，运行引擎本来就在线程池里）。
pub fn session_for(core: &SharedCore, actor: &str, task_key: &str, env: Env, profile: &EdasProfile) -> Result<Arc<CookieSession>> {
    let key = session_cache_key(task_key, env);
    if let Some(existing) = session::cached(&key) {
        return Ok(existing);
    }
    refresh_session(core, actor, task_key, env, profile)
}

/// 强制重新登录一次（会话被判失效、或用户点了"重新登录"）。
pub fn refresh_session(core: &SharedCore, actor: &str, task_key: &str, env: Env, profile: &EdasProfile) -> Result<Arc<CookieSession>> {
    let key = session_cache_key(task_key, env);
    session::drop_key(&key);
    let outcome = run_login(core, actor, task_key, env, profile);
    match outcome {
        Ok(LoginOutcome { session: Some(session), .. }) => Ok(session::store(&key, session)),
        Ok(_) => Err(AppError::TaskSessionExpired),
        // 绑定缺失/凭据不可见这类"配置问题"如实回，不要伪装成登录失败。
        Err(e) if e.code() != "TASK_SESSION_EXPIRED" => Err(e),
        Err(_) => Err(AppError::TaskSessionExpired),
    }
}

/// 探测：把登录线索与（可选的）一发真实接口调用原样交回界面。
///
/// 现场排障需要的是"注入过表单但页面没跳走"这种事实，而不是又一句"登录失败"。
/// 返回的只有状态名、主机名与 Cookie 名。
pub fn probe(core: &SharedCore, actor: &str, task_key: &str, env: Env, profile: &EdasProfile, probe_service: Option<&str>) -> Result<ProbeReport> {
    let outcome = run_login(core, actor, task_key, env, profile)?;
    let mut report = ProbeReport {
        statuses: outcome.trace.statuses,
        final_host: outcome.trace.final_host,
        cookie_names: outcome.trace.cookie_names,
        saw_form: outcome.trace.saw_form,
        authorize_visited: outcome.trace.authorize_visited,
        logged_in: outcome.session.is_some(),
        api_service: String::new(),
        api_class: String::new(),
        repo_id_found: false,
    };
    if let (Some(service), Some(session)) = (probe_service, outcome.session.as_ref()) {
        let client = EdasClient::new(profile.clone(), allow_http_for(core))?;
        let url = repository_url(profile, service)?;
        let (class, repo_id_found) = match client.get_json(&url, session) {
            Ok(value) => {
                let repo_id = profile::pick(&value, &profile.paths.repo_id).and_then(|v| v.as_str()).unwrap_or_default();
                ("ok".to_string(), !repo_id.is_empty())
            }
            Err(e) => (e.code().to_string(), false),
        };
        report.api_service = service.to_string();
        report.api_class = class;
        report.repo_id_found = repo_id_found;
    }
    Ok(report)
}

/// 探测报告。字段全部是给界面看的判定结果，没有值型秘密。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub statuses: Vec<String>,
    pub final_host: String,
    pub cookie_names: Vec<String>,
    pub saw_form: bool,
    pub authorize_visited: bool,
    pub logged_in: bool,
    pub api_service: String,
    pub api_class: String,
    pub repo_id_found: bool,
}

/// 仓库信息接口地址（探测与准备共用同一份拼装，避免两处各写一遍）。
pub fn repository_url(profile: &EdasProfile, service_name: &str) -> Result<String> {
    let repo_name = profile.repo_name_for(service_name);
    let stamp = chrono::Utc::now().timestamp_millis().to_string();
    profile.build_url(
        &profile.endpoints.repository,
        &[
            (&profile.dynamic_params.timestamp, &stamp),
            (&profile.dynamic_params.repo_name, &repo_name),
        ],
    )
}

/// 登录地址的取值顺序（纯函数，单独测）：任务侧手动覆盖 > 凭据自己的登录地址 > 目标地址。
///
/// 之所以默认跟着凭据走：账号中心里那条凭据本来就记着"去哪儿登录"，任务侧再抄一遍
/// 就是第二个事实来源，改一处漏一处。
pub fn pick_login_url(manual: &str, credential_override: &str, target_url: &str) -> Option<String> {
    [manual, credential_override, target_url]
        .into_iter()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

/// 解析这一档真正要打开的登录地址，并按本应用的协议红线校验一遍。
///
/// 手动覆盖也要重新校验：管理员把"允许不安全协议"关掉之后，之前存下的明文地址
/// 不该继续被使用。
pub fn resolve_login_url(core: &AppCore, binding: &store::BindingRow) -> Result<String> {
    let candidate = if !binding.login_url.trim().is_empty() {
        binding.login_url.trim().to_string()
    } else {
        let (override_url, target_url) = core.vault.with_vk(|vk| {
            let payload = repo::item_payload(vk, &core.db, &binding.credential_item_id)?;
            let meta = repo::target_meta(vk, &core.db, &binding.credential_target_id)?;
            let fallback = if meta.allowed_origin.trim().is_empty() { meta.url } else { meta.allowed_origin };
            Ok::<_, AppError>((payload.login_url_override, fallback))
        })?;
        pick_login_url("", &override_url, &target_url).ok_or_else(|| {
            AppError::TaskProfileInvalid("这条凭据没有登录地址：请到账号中心补填，或在环境配置里改用别的地址".to_string())
        })?
    };
    store::validate_login_url(&candidate, &core.db)
}

/// 走一遍静默登录。失败与成功都带回线索；配置类问题（没绑定、凭据不可见）回 `Err`。
fn run_login(core: &SharedCore, actor: &str, task_key: &str, env: Env, profile: &EdasProfile) -> Result<LoginOutcome> {
    let binding = store::get_binding(&core.db, task_key, env)?.ok_or_else(|| {
        log::warn!("任务 {task_key} 的 {} 环境还没有环境绑定", env.as_str());
        AppError::NotFound
    })?;
    let visible = {
        let conn = core.db.lock_conn();
        repo::can_access_item(&conn, actor, &binding.credential_item_id)?
    };
    if !visible {
        // 绑定过又失去可见性（被删除/收回授权）：按不存在回，与台账侧口径一致。
        return Err(AppError::NotFound);
    }
    let (username, password) = core.vault.with_vk(|vk| {
        let payload = repo::item_payload(vk, &core.db, &binding.credential_item_id)?;
        Ok((payload.username, payload.password))
    })?;
    if username.trim().is_empty() || password.is_empty() {
        return Err(AppError::TaskProfileInvalid("绑定的凭据里没有用户名或口令，请回环境配置重绑".to_string()));
    }
    let app = core.app_handle().ok_or(AppError::Internal)?;
    let login_url = resolve_login_url(core, &binding)?;
    Ok(login::login(
        &app,
        profile,
        &login_url,
        username.trim(),
        password.expose(),
        allow_http_for(core),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn repository_url_matches_the_console_shape() {
        let mut p = EdasProfile::default();
        p.base_url = "https://edas.console.example.com".into();
        p.params.insert("namespace".into(), "nmdlyxcs".into());
        let url = repository_url(&p, "biz-order-service").unwrap();
        assert!(url.starts_with("https://edas.console.example.com/json/v5/oam/cr/repository.json?"), "{url}");
        assert!(url.contains("repoName=biz_order_service"), "{url}");
        assert!(url.contains("_t="), "{url}");
        assert!(url.contains("namespace=nmdlyxcs"), "{url}");
    }

    #[test]
    fn allow_http_is_the_admin_switch_alone() {
        let db = Db::open_in_memory(&[21u8; 32]).unwrap();
        let core = Arc::new(crate::state::AppCore::new(db, crate::crypto::random_key(), std::env::temp_dir()));
        settings::set(&core.db, "allow_insecure_protocols", "true", "security").unwrap();
        assert!(allow_http_for(&core));
        settings::set(&core.db, "allow_insecure_protocols", "false", "security").unwrap();
        assert!(!allow_http_for(&core), "开关关掉后，之前存下的明文地址不该继续被使用");
    }

    #[test]
    fn login_url_follows_the_credential_unless_overridden() {
        // 手动覆盖优先；其次凭据自己的登录地址；再退到目标地址
        assert_eq!(pick_login_url(" https://sso.a ", "https://sso.b", "https://c").as_deref(), Some("https://sso.a"));
        assert_eq!(pick_login_url("", "https://sso.b", "https://c").as_deref(), Some("https://sso.b"));
        assert_eq!(pick_login_url("  ", "", "https://c").as_deref(), Some("https://c"));
        // 三处都没有 → None，由调用方给出"去账号中心补填"这句可执行的下一步
        assert_eq!(pick_login_url("", "  ", ""), None);
    }

    #[test]
    fn missing_binding_is_reported_as_missing_not_as_login_failure() {
        let db = Db::open_in_memory(&[22u8; 32]).unwrap();
        let core = Arc::new(crate::state::AppCore::new(db, crate::crypto::random_key(), std::env::temp_dir()));
        let err = run_login(&core, "u1", "release", Env::Test, &EdasProfile::default()).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        // 会话刷新要把这条如实传下去，不能统一压成"登录失效"
        let err = refresh_session(&core, "u1", "release", Env::Test, &EdasProfile::default()).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }
}
