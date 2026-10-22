//! 全局快捷启动器命令。它与主界面共用同一套授权路径（`authorize` + RBAC + ACL），
//! 不存在任何绕过权限的特权 API。

use std::time::Instant;

use super::{action_policy, audit, extension_gate, ActionReply, Result, SearchReply};
use crate::commands::accounts::doc_of;
use crate::db::repo;
use crate::error::AppError;
use crate::quick_launcher::{self, actions as ql, parser, query as qlq, shortcut, QuickAction};
use crate::rbac::perm;
use crate::rbac;
use crate::settings;
use crate::state::AppCore;

const SEARCH_LIMIT: usize = 50;

#[tauri::command]
pub fn quick_search(query: String) -> Result<SearchReply> {
    let core = crate::state::core();
    let started = Instant::now();
    let limit = settings::get_i64(&core.db, "quick_launcher_result_limit", 20).clamp(1, SEARCH_LIMIT as i64) as usize;
    // 每次请求都读：管理员把开关关掉后，空输入的推荐结果必须立刻消失，不能等到重启
    let show_recent = settings::get_bool(&core.db, "quick_launcher_show_recent", true);
    // 需求 line 294 的"最近使用/收藏"这一档同级微调同样由设置决定，同样每次请求都读
    let rank_recent = settings::get_bool(&core.db, "quick_launcher_rank_recent_favorite", true);
    // 未解锁：只回解锁提示，绝不返回任何缓存结果
    if !core.vault.is_unlocked() {
        return Ok(SearchReply { locked: true, results: vec![], syntax_error: None, elapsed_ms: started.elapsed().as_micros(), indexed: 0 });
    }
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::MENU_QUICK_LAUNCHER)?;

    let policy = action_policy(&core);
    let ext = extension_gate(&core);
    let res = core.vault
        .with_index(|idx| qlq::search_unlocked(idx, &query, limit, ext, &policy, show_recent, rank_recent))
        .and_then(|r| r);
    match res {
        Ok(results) => {
            let indexed = core.vault.with_index(|i| i.len()).unwrap_or(0);
            Ok(SearchReply { locked: false, results, syntax_error: None, elapsed_ms: started.elapsed().as_micros(), indexed })
        }
        Err(AppError::QuerySyntax(_)) => Ok(SearchReply {
            locked: false,
            results: vec![],
            // 不回显原文，只说明哪里不合法
            syntax_error: Some("查询串无法解析：请检查引号是否闭合，或字段名前是否拼写正确（例如 系统: 、地址: 、账号别名: ）。".to_string()),
            elapsed_ms: started.elapsed().as_micros(),
            indexed: 0,
        }),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn quick_action(action: QuickAction, item_id: String, target_id: String, credential_id: Option<String>) -> Result<ActionReply> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::MENU_QUICK_LAUNCHER)?;
    match action {
        QuickAction::OpenTarget => open_target( target_id),
        QuickAction::OpenAndFill => open_and_fill( target_id, credential_id),
        QuickAction::CopyUsername => copy_item(item_id, QuickAction::CopyUsername),
        QuickAction::CopyPassword => copy_item(item_id, QuickAction::CopyPassword),
        QuickAction::ViewDetail => {
            // 详情仍由后端做权限校验后返回，不新增特权通道
            let detail = crate::commands::accounts::target_detail( target_id)?;
            let _ = item_id;
            audit(&core, Some(&detail.items.first().map(|_| "").unwrap_or("")), "quick_launcher.view_detail", Some("target"), None, true, None, "launcher");
            Ok(ActionReply::ok("view_detail", "详情已加载"))
        }
        QuickAction::SelectOtherAccount => {
            let doc = doc_of(&core, &item_id).ok_or(AppError::NotFound)?;
            let vk = core.vault.current_vk().ok_or(AppError::Locked)?;
            let list = ql::candidates_for(&core.db, &vk, &user, &doc)?;
            let mut reply = ActionReply::ok("select_other_account", "请选择要使用的账号");
            reply.candidates = Some(list);
            Ok(reply)
        }
        QuickAction::SetDefault => {
            rbac::require(&core.db, &user, perm::ACC_SET_DEFAULT)?;
            repo::set_default_credential(&core.db, &user, &target_id, &item_id)?;
            audit(&core, Some(&user), "accounts.default.set", Some("item"), Some(&item_id), true, None, "launcher");
            core.rebuild_index()?;
            Ok(ActionReply::ok("set_default", "已设为该目标下你的默认账号"))
        }
    }
}

fn copy_item(item_id: String, action: QuickAction) -> Result<ActionReply> {
    if action == QuickAction::CopyUsername {
        super::accounts::copy_username( item_id).map(|mut r| {
            r.action = "copy_username".into();
            r
        })
    } else {
        super::accounts::copy_password( item_id).map(|mut r| {
            r.action = "copy_password".into();
            r
        })
    }
}

/// 打开目标：只打开台账中保存的地址，且校验协议；绝不把凭据拼进 URL 或命令行。
#[tauri::command]
pub fn open_target(target_id: String) -> Result<ActionReply> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    let (url, target_type, protocol) = core.vault.with_vk(|vk| {
        let m = repo::target_meta(vk, &core.db, &target_id)?;
        let t = repo::get_target_row(&core.db, &target_id)?;
        let url = if m.url.is_empty() { format!("{}://{}", m.protocol, m.host) } else { m.url.clone() };
        Ok::<_, AppError>((url, t.target_type, m.protocol))
    })?;
    if url.is_empty() {
        return Err(AppError::InvalidInput);
    }
    if repo::is_insecure_protocol(&target_type, &protocol) && !settings::get_bool(&core.db, "allow_insecure_protocols", false) {
        return Err(AppError::InsecureProtocolDisabled);
    }
    let scheme = url.split(':').next().unwrap_or("").to_lowercase();
    if !matches!(scheme.as_str(), "https" | "http" | "ssh" | "sftp" | "rdp" | "vnc") {
        return Err(AppError::InvalidInput);
    }
    if scheme == "http" && !settings::get_bool(&core.db, "allow_insecure_protocols", false) {
        return Err(AppError::InsecureProtocolDisabled);
    }
    open_in_browser(&url)?;
    audit(&core, Some(&user), "accounts.open_target", Some("target"), Some(&target_id), true, None, "launcher");
    Ok(ActionReply { opened: Some(super::super::quick_launcher::query::address_summary(&url)), ..ActionReply::ok("open_target", "已在系统浏览器中打开") })
}

fn open_in_browser(url: &str) -> std::result::Result<(), AppError> {
    open::that(url).map_err(|_| AppError::Internal)
}

/// 打开并安全填充：
/// 1) 校验会话/权限；2) 解析本次使用的凭据（默认账号，或用户显式选择的其它账号）；
/// 3) 打开精确地址；4) 签发一次性短时票据（只在 Rust 内存与 Native Messaging 通道中流转）。
/// 扩展未就绪时明确降级，不假装已填充。
#[tauri::command]
pub fn open_and_fill(target_id: String, credential_id: Option<String>) -> Result<ActionReply> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_AUTOFILL)?;
    let item_id = match ql::resolve_fill_credential(&core.db, &user, &target_id, credential_id.as_deref()) {
        Ok(id) => id,
        // 没有有效默认账号时先展示选择器，绝不随机挑选或填充错误账号
        Err(AppError::NoDefaultCredential) => {
            let vk = core.vault.current_vk().ok_or(AppError::Locked)?;
            let mut reply = ActionReply::fail("open_and_fill", &AppError::NoDefaultCredential);
            reply.candidates = Some(ql::candidates_for_target(&core.db, &vk, &user, &target_id)?);
            return Ok(reply);
        }
        Err(e) => return Err(e),
    };

    ql::authorize(&core.db, &core.vault, &user, QuickAction::OpenAndFill, &item_id)?;
    let url = core.vault.with_vk(|vk| {
        let m = repo::target_meta(vk, &core.db, &target_id)?;
        let p = repo::item_payload(vk, &core.db, &item_id)?;
        Ok::<_, AppError>(if p.login_url_override.is_empty() { m.url } else { p.login_url_override })
    })?;
    if url.is_empty() {
        return Err(AppError::InvalidInput);
    }

    if !extension_gate(&core) {
        // 明确降级：只打开网站，并提供单独的用户名/密码复制动作
        open_in_browser(&url)?;
        audit(&core, Some(&user), "accounts.fill.unavailable", Some("item"), Some(&item_id), false, Some("EXTENSION_UNAVAILABLE"), "launcher");
        return Ok(ActionReply {
            opened: Some(parser_origin_for_log(&url)),
            message: "浏览器扩展未就绪：已打开网站。请手动输入，或使用「复制用户名」「复制密码」两个单独动作。".to_string(),
            ..ActionReply::fail("open_and_fill", &AppError::ExtensionUnavailable)
        });
    }

    let (ticket, binding) = ql::issue_fill_ticket(&core.db, &core.tickets, &core.vault, &user, &item_id)?;
    open_in_browser(&url)?;
    repo::touch_last_accessed(&core.db, &item_id)?;
    audit(&core, Some(&user), "accounts.fill.request", Some("item"), Some(&item_id), true, None, "launcher");
    let expires_in = (ticket.expires_at - chrono::Utc::now().timestamp()).max(0);
    Ok(ActionReply {
        fill: Some(super::FillGrant { status: "awaiting".into(), origin: parser_origin(&binding.origin), expires_in_seconds: expires_in }),
        opened: Some(parser_origin(&binding.origin)),
        ..ActionReply::ok("open_and_fill", "已打开网站，等待浏览器扩展凭票据填充")
    })
}

fn parser_origin(url: &str) -> String {
    quick_launcher::query::address_summary(url)
}

fn parser_origin_for_log(url: &str) -> String {
    quick_launcher::query::address_summary(url)
}

/// 终端/数据库类目标的一键连接入口。
/// 绝不把口令或私钥口令放进命令行参数、Shell 历史或日志。
#[tauri::command]
pub fn connect_terminal(item_id: String) -> Result<ActionReply> {
    let core = crate::state::core();
    let user = core.check_session()?;
    ql::authorize(&core.db, &core.vault, &user, QuickAction::OpenTarget, &item_id)?;
    let row = repo::get_item_row(&core.db, &user, &item_id)?;
    let (host, port, protocol, username) = core.vault.with_vk(|vk| {
        let m = repo::target_meta(vk, &core.db, &row.target_id)?;
        let p = repo::item_payload(vk, &core.db, &item_id)?;
        Ok::<_, AppError>((m.host, m.port, m.protocol, p.username))
    })?;
    if host.is_empty() {
        return Err(AppError::InvalidInput);
    }
    let allow_weak = settings::get_bool(&core.db, "allow_insecure_protocols", false);
    if repo::is_insecure_protocol(&row.item_type, &protocol) && !allow_weak {
        return Err(AppError::InsecureProtocolDisabled);
    }
    match row.item_type.as_str() {
        "terminal" => {
            let p = if protocol.is_empty() { "ssh".to_string() } else { protocol.clone() };
            if p == "ssh" {
                let host_label = if port.is_empty() { host.clone() } else { format!("{host}:{port}") };
                let url = format!("ssh://{username}@{host_label}");
                match open::that(&url) {
                    Ok(_) => {
                        audit(&core, Some(&user), "accounts.connect", Some("item"), Some(&item_id), true, None, "launcher");
                        Ok(ActionReply { opened: Some(format!("ssh://{host}")), ..ActionReply::ok("open_target", "已通过系统终端打开 SSH 连接入口；密码需在终端中由你本人输入，应用不会写入命令行") })
                    }
                    Err(_) => {
                        let info = format!("{p}://{}@{}{}", username, host, if port.is_empty() { String::new() } else { format!(":{port}") });
                        super::accounts::write_clipboard(&info)?;
                        Ok(ActionReply { opened: None, ..ActionReply::ok("open_target", "系统未能直接打开终端：已复制非秘密连接信息（不含密码），请在终端中粘贴并手动完成认证") })
                    }
                }
            } else {
                let info = format!("{p}://{host}{}", if port.is_empty() { String::new() } else { format!(":{port}") });
                super::accounts::write_clipboard(&info)?;
                Ok(ActionReply::ok("open_target", &format!("{p} 需由系统客户端完成：已复制主机信息（不含密码）")))
            }
        }
        other => {
            let info = format!("{}@{}{}", username, host, if port.is_empty() { String::new() } else { format!(":{port}") });
            super::accounts::write_clipboard(&info)?;
            Ok(ActionReply::ok("open_target", &format!("{other}：已复制非秘密连接信息（不含密码），请使用本机已安装的客户端连接")))
        }
    }
}

/// 快捷键：查看 / 修改 / 恢复默认。注册失败时保留旧值并明确提示。
#[tauri::command]
pub fn launcher_preferences() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let current = core.shortcut.lock().clone();
    Ok(serde_json::json!({
        "shortcut": current,
        "default": shortcut::default_accelerator(),
        "enabled": settings::get_bool(&core.db, "quick_launcher_enabled", true),
        "showRecentWhenEmpty": settings::get_bool(&core.db, "quick_launcher_show_recent", true),
        "rankRecentFavorite": settings::get_bool(&core.db, "quick_launcher_rank_recent_favorite", true),
        "resultLimit": settings::get_i64(&core.db, "quick_launcher_result_limit", 20),
        "syntax": parser::syntax_help(),
    }))
}

#[tauri::command]
pub fn set_launcher_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<serde_json::Value> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    let old = core.shortcut.lock().clone();
    shortcut::validate_accelerator(&accelerator).map_err(|_| AppError::InvalidInput)?;
    crate::launcher::rebind(&app, &core, &accelerator, &old)
}

#[tauri::command]
pub fn set_launcher_enabled(app: tauri::AppHandle, enabled: bool) -> Result<serde_json::Value> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::SYS_SECURITY)?;
    settings::set(&core.db, "quick_launcher_enabled", if enabled { "true" } else { "false" }, "install")?;
    crate::launcher::apply_enabled(&app, &core, enabled)
}

#[tauri::command]
pub fn launcher_visibility(app: tauri::AppHandle, visible: bool) -> Result<()> {
    let core = crate::state::core();
    if visible && core.vault.is_unlocked() {
        // 只有解锁后才可以显示结果；锁定时窗口内只呈现解锁面板
        core.rebuild_index()?;
    }
    crate::launcher::show_or_hide(&app, visible)
}

/// —— 以下两个函数只由本机 IPC（Native Messaging 宿主进程）调用，不注册为 webview 命令 ——

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantChallenge {
    pub ticket_id: String,
    pub ticket_secret: String,
    pub target_id: String,
    pub credential_id: String,
    pub origin: String,
    pub expires_at: i64,
    /// 需要用户在桌面端确认（该凭据配置了「每次填充前确认」）
    pub confirm_required: bool,
}

/// 第一步：扩展报告当前页面 Origin，宿主向桌面端索取一次性挑战。
/// 只有存在与 Origin + 当前会话严格绑定的未过期票据时才返回。
pub fn challenge_for_origin(core: &AppCore, origin: &str) -> Option<GrantChallenge> {
    let session_id = core.vault.session_id()?;
    let (id, secret, binding) = core.tickets.grant_for_origin(origin, &session_id)?;
    let confirm_required = core
        .vault
        .with_vk(|vk| repo::item_payload(vk, &core.db, &binding.credential_id).map(|p| p.confirm_before_fill))
        .unwrap_or(true);
    let expires_at = core.tickets.expires_at(&id)?;
    Some(GrantChallenge {
        ticket_id: id,
        ticket_secret: secret.to_string(),
        target_id: binding.target_id,
        credential_id: binding.credential_id,
        origin: binding.origin,
        expires_at,
        confirm_required,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FillRequest {
    pub ticket_id: String,
    pub ticket_secret: String,
    pub target_id: String,
    pub credential_id: String,
    pub origin: String,
}

/// 第二步：宿主出示票据，桌面端一次性消费并返回凭据。
/// 任何绑定不符/过期/重放都会失败；成功后凭据只经 stdout 长度前缀帧交给宿主。
pub fn complete_fill(core: &AppCore, req: &FillRequest) -> Option<(String, String)> {
    let session_id = core.vault.session_id()?;
    let binding = crate::crypto::tokens::TicketBinding {
        target_id: req.target_id.clone(),
        credential_id: req.credential_id.clone(),
        origin: req.origin.clone(),
        app_user_id: core.vault.active_user()?,
        session_id,
    };
    core.tickets.redeem(&req.ticket_id, &req.ticket_secret, &binding).ok()?;
    let (username, password) = core
        .vault
        .with_vk(|vk| {
            let p = repo::item_payload(vk, &core.db, &req.credential_id)?;
            Ok::<_, AppError>((p.username.clone(), p.password.expose().to_string()))
        })
        .ok()?;
    let _ = repo::touch_last_accessed(&core.db, &req.credential_id);
    let _ = crate::audit::record(
        &core.db,
        core.vault.active_user().as_deref(),
        "accounts.fill.success",
        Some("item"),
        Some(&req.credential_id),
        "success",
        None,
        Some("extension"),
    );
    Some((username, password))
}
