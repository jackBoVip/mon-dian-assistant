//! 任务中心命令层：会话校验 → RBAC → 记录级 ACL → 业务 + 审计。
//!
//! 这一层是凭据的分界线：环境绑定里只有 `credential_item_id`，口令由适配器在 Rust 内存里
//! 经 `repo::item_payload` 解密取用，**没有任何一条命令把用户名或口令交给前端**。
//! 登录线程只在 `spawn_blocking` 上跑：`Webview::cookies()` 在主线程同步调用会在 Windows 上死锁。

use std::sync::Arc;

use serde::Serialize;

use super::{audit, Result};
use crate::error::AppError;
use crate::rbac::{self, perm};
use crate::state::{AppCore, SharedCore};
use crate::tasks::{adapters::edas, runner, store, task_def, Env};
use crate::tasks::runner::TaskAdapter;

/// 命令入参里的环境串 → 枚举。没有落点的环境一律拒（不给界面留点了没反应的开关）。
fn parse_env(raw: &str) -> Result<Env> {
    Env::parse(raw).ok_or(AppError::InvalidInput)
}

fn require_perm(core: &AppCore, user: &str, key: &str) -> Result<()> {
    rbac::require(&core.db, user, key)
}

/// 执行类动作的门槛按环境分档：生产另需 `task.release.run_prod`。
fn require_run(core: &AppCore, user: &str, env: Env) -> Result<()> {
    require_perm(core, user, if env.is_prod() { perm::TASK_RELEASE_RUN_PROD } else { perm::TASK_RELEASE_RUN })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub task_key: String,
    pub env: String,
    /// 站点形状（域名/region/字段名）本来就是非密的，界面要能看见才能改。
    pub profile_json: String,
    pub configured: bool,
    pub updated_at: Option<String>,
    /// 这份配置即将走明文还是 TLS，界面用它解释为什么按钮不可点。
    pub insecure_http_allowed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub bound: bool,
    pub configured: bool,
    /// 界面能看到的只有"有没有会话、几枚 Cookie、什么时候拿的"，没有值。
    pub active: bool,
    pub cookie_names: Vec<String>,
    pub acquired_seconds_ago: Option<i64>,
    pub ttl_minutes: i64,
    /// 真正会去打开的登录地址，以及它是从哪儿来的：manual / credential / missing。
    pub login_url: Option<String>,
    pub login_url_source: String,
    pub credential_label: Option<String>,
}

#[tauri::command]
pub fn task_definitions() -> Result<Vec<crate::tasks::TaskSummary>> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    Ok(crate::tasks::summaries())
}

#[tauri::command]
pub fn task_profile_get(task_key: String, env: String) -> Result<ProfileView> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    let env_v = parse_env(&env)?;
    task_def(&task_key).ok_or(AppError::InvalidInput)?;
    let row = store::get_profile(&core.db, &task_key, env_v)?;
    let insecure = edas::allow_http_for(&core);
    Ok(match row {
        Some(r) => ProfileView {
            task_key: r.task_key,
            env: r.env,
            profile_json: r.profile_json,
            configured: true,
            updated_at: Some(r.updated_at),
            insecure_http_allowed: insecure,
        },
        None => ProfileView {
            task_key: task_key.clone(),
            env: env_v.as_str().to_string(),
            profile_json: edas::EdasProfile::default().to_json()?,
            configured: false,
            updated_at: None,
            insecure_http_allowed: insecure,
        },
    })
}

/// 存 profile：解析与校验发生在落库之前（`store::put_profile`），运行时不再重复判。
#[tauri::command]
pub fn task_profile_update(task_key: String, env: String, profile_json: String) -> Result<ProfileView> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_CONFIGURE)?;
    let env_v = parse_env(&env)?;
    let env_str = env_v.as_str().to_string();
    let stored = store::put_profile(&core.db, &user, &task_key, env_v, &profile_json)?;
    audit(&core, Some(&user), "task.profile.update", Some("task_profile"), Some(&format!("{task_key}:{env_str}")), true, None, "app");
    let updated_at = store::get_profile(&core.db, &task_key, env_v)?.map(|r| r.updated_at);
    Ok(ProfileView {
        task_key,
        env: env_str,
        profile_json: stored.to_json()?,
        configured: true,
        updated_at,
        insecure_http_allowed: edas::allow_http_for(&core),
    })
}

#[tauri::command]
pub fn task_binding_get(task_key: String, env: String) -> Result<Option<store::BindingRow>> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    let env_v = parse_env(&env)?;
    store::get_binding(&core.db, &task_key, env_v)
}

/// 绑定一枚保险库凭据。这里不接收任何口令：只接收 itemId。
#[tauri::command]
pub fn task_binding_update(task_key: String, env: String, login_url: String, credential_item_id: String) -> Result<store::BindingRow> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_CONFIGURE)?;
    let env_v = parse_env(&env)?;
    let row = store::put_binding(&core.db, &user, &task_key, env_v, &login_url, &credential_item_id)?;
    // 审计只记"绑了哪一档、指向哪条记录"，不记别名与地址之外的内容。
    audit(&core, Some(&user), "task.env_binding.update", Some("task_env_binding"), Some(&format!("{task_key}:{}", row.env)), true, None, "app");
    drop_key_on_rebind(&task_key, env_v);
    Ok(row)
}

#[tauri::command]
pub fn task_binding_delete(task_key: String, env: String) -> Result<()> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_CONFIGURE)?;
    let env_v = parse_env(&env)?;
    store::delete_binding(&core.db, &task_key, env_v)?;
    audit(&core, Some(&user), "task.env_binding.delete", Some("task_env_binding"), Some(&format!("{task_key}:{}", env_v.as_str())), true, None, "app");
    drop_key_on_rebind(&task_key, env_v);
    Ok(())
}

/// 换绑/解绑之后旧会话就不该再用：立刻丢掉。
fn drop_key_on_rebind(task_key: &str, env: Env) {
    edas::session::drop_key(&edas::session_cache_key(task_key, env));
}

#[tauri::command]
pub fn task_session_status(task_key: String, env: String) -> Result<SessionStatus> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    read_session_status(&core, &task_key, parse_env(&env)?)
}

fn read_session_status(core: &AppCore, task_key: &str, env: Env) -> Result<SessionStatus> {
    let profile = store::profile_or_default(&core.db, task_key, env)?;
    let binding = store::get_binding(&core.db, task_key, env)?;
    let cached = edas::session::cached(&edas::session_cache_key(task_key, env));
    // 地址的来源与"能不能用"一起判：手动覆盖的直接用；跟着凭据的那一路要解密才知道，
    // 解不出来（凭据没填、目标没地址、协议被红线拒了）就如实标 missing，让界面给下一步。
    let (login_url, login_url_source) = match binding.as_ref() {
        Some(row) if !row.login_url.trim().is_empty() => (Some(row.login_url.clone()), "manual".to_string()),
        Some(row) => match edas::resolve_login_url(core, row) {
            Ok(url) => (Some(url), "credential".to_string()),
            Err(_) => (None, "missing".to_string()),
        },
        None => (None, "missing".to_string()),
    };
    Ok(SessionStatus {
        bound: binding.is_some(),
        configured: store::is_configured(&core.db, task_key, env)?,
        active: cached.is_some(),
        cookie_names: cached.as_ref().map(|s| s.names().to_vec()).unwrap_or_default(),
        acquired_seconds_ago: cached.as_ref().map(|s| s.acquired_secs_ago() as i64),
        ttl_minutes: profile.session.ttl_minutes.max(1),
        login_url,
        login_url_source,
        credential_label: binding.as_ref().and_then(|b| b.credential_label.clone()),
    })
}

/// 静默登录（用户零操作）。`force=true` 用于"会话已被判失效，重来一次"。
#[tauri::command]
pub async fn task_session_login(task_key: String, env: String, force: bool) -> Result<SessionStatus> {
    let core = crate::state::core();
    let user = core.check_session()?;
    let env_v = parse_env(&env)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    require_run(&core, &user, env_v)?;
    let profile = store::profile_or_default(&core.db, &task_key, env_v)?;
    let action = if force { "task.session.relogin" } else { "task.session.login" };

    let worker_core = core.clone();
    let worker_user = user.clone();
    let worker_key = task_key.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        if force {
            edas::refresh_session(&worker_core, &worker_user, &worker_key, env_v, &profile)
        } else {
            edas::session_for(&worker_core, &worker_user, &worker_key, env_v, &profile)
        }
    })
    .await
    .map_err(|e| AppError::internal("任务登录线程", &e))?;

    match outcome {
        Ok(session) => {
            audit(&core, Some(&user), action, Some("task_session"), Some(&format!("{task_key}:{}", env_v.as_str())), true, None, "app");
            let mut status = read_session_status(&core, &task_key, env_v)?;
            status.active = true;
            status.cookie_names = session.names().to_vec();
            status.acquired_seconds_ago = Some(session.acquired_secs_ago() as i64);
            Ok(status)
        }
        Err(e) => {
            // 只记错误码：登录线索里可能有页面回传的文本，不进审计。
            audit(&core, Some(&user), action, Some("task_session"), Some(&format!("{task_key}:{}", env_v.as_str())), false, Some(e.code()), "app");
            Err(e)
        }
    }
}

/// 现场取证用：把登录走到哪一步、拿到哪几枚 Cookie、接口分类结果如实说出来（没有值）。
#[tauri::command]
pub async fn task_probe_login(task_key: String, env: String, probe_service: Option<String>) -> Result<edas::ProbeReport> {
    let core = crate::state::core();
    let user = core.check_session()?;
    let env_v = parse_env(&env)?;
    require_perm(&core, &user, perm::TASK_RELEASE_CONFIGURE)?;
    let profile = store::profile_or_default(&core.db, &task_key, env_v)?;
    let worker_core = core.clone();
    let worker_user = user.clone();
    let worker_key = task_key.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let service = probe_service.as_deref();
        edas::probe(&worker_core, &worker_user, &worker_key, env_v, &profile, service)
    })
    .await
    .map_err(|e| AppError::internal("任务探测线程", &e))??;
    audit(&core, Some(&user), "task.session.probe", Some("task_session"), Some(&format!("{task_key}:{}", env_v.as_str())), report.logged_in, None, "app");
    Ok(report)
}

// ---------------------------------------------------------------- 运行

/// 一份发布说明的最大字节数：与题库导入同一档，超了就是拿错了整包文档。
const NOTES_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// 读发布说明（.docx）。这一步只是把表格变成待发行，不改任何线上东西。
#[tauri::command]
pub fn task_release_parse(path: String) -> Result<edas::release_notes::ParsedNotes> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    let trimmed = path.trim();
    // 只吃 .docx：老的 .doc 二进制格式本仓库不再另起一条解析链（要用 Word/WPS 先另存）。
    if !trimmed.to_ascii_lowercase().ends_with(".docx") {
        return Err(AppError::FileFormatInvalid);
    }
    let meta = std::fs::metadata(trimmed).map_err(|_| AppError::TaskFileUnreadable)?;
    if meta.len() > NOTES_MAX_BYTES {
        return Err(AppError::FileTooLarge);
    }
    let bytes = std::fs::read(trimmed).map_err(|_| AppError::TaskFileUnreadable)?;
    edas::release_notes::parse_bytes(&bytes)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewReleaseItem {
    pub item_key: String,
    pub display_name: Option<String>,
    pub desired_tag: Option<String>,
}

/// 执行类命令的统一门槛：先把运行读出来（顺带验 runId 存在），再按它自己的环境判权限。
///
/// 权限按**运行所属环境**判，而不是按前端传来的环境串判——否则改一下请求里的 env
/// 就能用测试环境的权限发生产。
fn gate_run(core: &AppCore, user: &str, run_id: &str) -> Result<runner::RunRow> {
    let run = runner::load_run(core, run_id)?;
    let env = run.env_value().ok_or(AppError::InvalidInput)?;
    require_run(core, user, env)?;
    Ok(run)
}

#[tauri::command]
pub fn task_run_create(task_key: String, env: String, items: Vec<NewReleaseItem>) -> Result<runner::RunRow> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    let env_v = parse_env(&env)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    require_run(&core, &user, env_v)?;
    if items.is_empty() {
        return Err(AppError::InvalidInput);
    }
    let new: Vec<runner::NewRunItem> = items
        .into_iter()
        .map(|i| runner::NewRunItem { item_key: i.item_key, display_name: i.display_name, desired_tag: i.desired_tag })
        .collect();
    // 输入摘要只记"这一批有几项、来自哪次导入"：文件路径与凭据都不进 params_json。
    let params = serde_json::json!({ "itemCount": new.len() }).to_string();
    let run_id = runner::create_run(&core, &task_key, env_v, &params, &new, &user)?;
    audit(&core, Some(&user), "task.release.create", Some("task_run"), Some(&run_id), true, None, "app");
    runner::load_run(&core, &run_id)
}

#[tauri::command]
pub fn task_run_prepare(run_id: String) -> Result<runner::RunRow> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    let run = gate_run(&core, &user, &run_id)?;
    let env = run.env_value().ok_or(AppError::InvalidInput)?;
    let adapter = build_adapter(&core, &user, &run, env)?;
    let started = runner::start_prepare(&core, &run_id, adapter);
    audit(&core, Some(&user), "task.release.prepare", Some("task_run"), Some(&run_id), started.is_ok(), started.as_ref().err().map(|e| e.code()), "app");
    started?;
    runner::load_run(&core, &run_id)
}

/// 开始发布。生产环境的第二道闸是界面的逐条镜像确认，这道闸是权限——两道都得过。
#[tauri::command]
pub fn task_run_publish(run_id: String) -> Result<runner::RunRow> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    let run = gate_run(&core, &user, &run_id)?;
    let env = run.env_value().ok_or(AppError::InvalidInput)?;
    let adapter = build_adapter(&core, &user, &run, env)?;
    let started = runner::start_publish(&core, &run_id, adapter);
    audit(&core, Some(&user), "task.release.run", Some("task_run"), Some(&run_id), started.is_ok(), started.as_ref().err().map(|e| e.code()), "app");
    started?;
    runner::load_run(&core, &run_id)
}

#[tauri::command]
pub fn task_run_cancel(run_id: String) -> Result<runner::RunRow> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    let run = gate_run(&core, &user, &run_id)?;
    if run.created_by != user && !rbac::has_permission(&core.db, &user, perm::TASK_RELEASE_CONFIGURE).unwrap_or(false) {
        // 别人按下的取消不该由你来点：正在跑的那一轮是他的手在动的。
        return Err(AppError::Forbidden);
    }
    runner::request_cancel(&core, &run_id)?;
    audit(&core, Some(&user), "task.release.cancel", Some("task_run"), Some(&run_id), true, None, "app");
    runner::load_run(&core, &run_id)
}

/// 重试失败项：把失败行放回待读取、运行回到准备态，然后重走一次读取。
/// 发布仍然是人的那一下——不把"读取"和"发布"合并成一颗按钮。
#[tauri::command]
pub fn task_run_retry(run_id: String) -> Result<runner::RunRow> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    let run = gate_run(&core, &user, &run_id)?;
    let env = run.env_value().ok_or(AppError::InvalidInput)?;
    let reset = runner::reset_failed(&core, &run_id)?;
    let adapter = build_adapter(&core, &user, &run, env)?;
    runner::start_prepare(&core, &run_id, adapter)?;
    audit(&core, Some(&user), "task.release.retry", Some("task_run"), Some(&run_id), true, None, "app");
    let _ = reset;
    runner::load_run(&core, &run_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: runner::RunRow,
    pub items: Vec<runner::RunItem>,
}

#[tauri::command]
pub fn task_run_get(run_id: String) -> Result<RunDetail> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    let run = runner::load_run(&core, &run_id)?;
    Ok(RunDetail { run, items: runner::load_items(&core, &run_id)? })
}

#[tauri::command]
pub fn task_run_list(task_key: String, env: String, limit: Option<i64>) -> Result<Vec<store::RunListItem>> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    store::list_runs(&core.db, &task_key, parse_env(&env)?, limit.unwrap_or(20))
}

#[tauri::command]
pub fn task_run_logs(run_id: String, after_seq: Option<i64>, limit: Option<i64>) -> Result<Vec<store::LogRow>> {
    let core = crate::state::core();
    let user = super::user(&core)?;
    require_perm(&core, &user, perm::TASK_RELEASE_VIEW)?;
    let run = runner::load_run(&core, &run_id)?;
    store::logs_after(&core.db, &run.id, after_seq.unwrap_or(0), limit.unwrap_or(200))
}

/// 适配器要落库、要发请求，但它只在引擎给的那两个方法里动。
fn build_adapter(core: &SharedCore, user: &str, run: &runner::RunRow, env: Env) -> Result<Arc<dyn TaskAdapter>> {
    task_def(&run.task_key).ok_or(AppError::InvalidInput)?;
    let profile = store::profile_or_default(&core.db, &run.task_key, env)?;
    Ok(Arc::new(edas::adapter::EdasAdapter::new(core.clone(), user, &run.task_key, env, profile)?))
}
