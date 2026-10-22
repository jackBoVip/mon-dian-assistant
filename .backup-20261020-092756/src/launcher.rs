//! 快速启动器的窗口与系统级快捷键管理。
//!
//! 这里的职责只有两件事：把启动器窗口拉起到最前/收起，以及维护全局快捷键注册。
//! 所有数据读取和动作执行仍走 `commands::launcher` 的鉴权路径，本模块不接触任何凭据。
//! 快捷键注册失败（与其它应用冲突）时必须恢复旧键并如实报错，绝不静默失效。

use std::sync::Arc;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt};

use crate::error::{AppError, Result};
use crate::quick_launcher::shortcut;
use crate::settings;
use crate::state::{AppCore, SharedCore};

pub const LAUNCHER_LABEL: &str = "launcher";
/// 尺寸与"透明"是同一件事的两半，来源是交付方 2026-10-18 19:5x 对着真机截图的一句
/// 「这个弹窗有问题,外面有个大片空白」。
///
/// 上一档是 760×620 的实心窗：原型那枚弹窗的遮罩 `position:fixed; inset:0` 在浏览器里压的是整屏桌面，
/// 看不出边界；搬进一扇独立置顶窗之后，窗体矩形是看得见的，本体（上限 600px）四周就多出左右各 80px、
/// 顶部 93px（15vh×620）、底部 22px 一片染色死灰。处置照 S 轮二批撤壳层留白那条口径——真机体验优先于
/// 原型字面：遮罩染色整块撤掉（`--overlay-veil` / `--blur-overlay` 在主窗的 Drawer/Modal 还在用，令牌本身不动），
/// 窗口改透明并关掉系统阴影，尺寸收到本体加一圈阴影留白。留着系统阴影会在透明窗上画出一圈矩形投影，
/// 正好又变成一条"空白边"。
///
/// 本体最坏一档实测（一次性探针按 648×580 视口逐块量的计算值，内容区放满 9 条逼出 320 clamp）：
/// 输入行 61 + 命中摘要 39 + 内容区 320 + 两行页脚 84.2 + 本体上下描边 2 = 506.2。页脚之所以是两行：
/// 原型只有三组导航提示，我们多一组「Tab 切换操作」和一串全局快捷键回显，本体 600px 净宽放不下五个分组，
/// 靠 .search-footer 的 wrap 换到第二行。
/// 高 580 = 上留白 24 + 本体 506.2 + 下留白 28 = 558.2，余 21.8px 给键盘芯片那一行的字体渲染浮动
/// （620 那一档的 527px 空间里有 93px 是遮罩让位，撤掉让位之后 580 就够）；
/// 宽 648 = 本体 600 + 左右各 24 阴影留白——透明、看不见，但仍是一小块点击热区，所以不再多给。
const LAUNCHER_WIDTH: f64 = 648.0;
const LAUNCHER_HEIGHT: f64 = 580.0;

/// 创建（或取回）启动器窗口。默认隐藏，置顶、无边框、不进任务栏。
/// `content_protected` 让截屏/录屏在部分平台上无法捕获窗口内容，避免结果里的账号信息被留档。
/// `transparent` 与 `shadow(false)` 配套：这扇窗的可见内容只有本体那一枚圆角卡片，卡片外那一圈
/// 24/28px 是透明的（样式侧 `.launcher-body` 已改 `background:transparent`，见 global.css 快捷启动器那一段）。
/// 系统阴影是按窗口矩形画的，透明窗上留着它就等于又贴了一圈矩形投影。
pub fn ensure_window(app: &tauri::AppHandle) -> Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LAUNCHER_LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, LAUNCHER_LABEL, WebviewUrl::App("launcher.html".into()))
        .title("快速查找账号")
        .inner_size(LAUNCHER_WIDTH, LAUNCHER_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .center()
        .content_protected(true)
        .build()
        .map_err(|_| AppError::Internal)?;
    Ok(w)
}

/// 前端调用：显示或隐藏启动器。显示后通知 webview 清空上一次查询并聚焦输入框。
pub fn show_or_hide(app: &tauri::AppHandle, visible: bool) -> Result<()> {
    let w = ensure_window(app)?;
    if visible {
        let _ = w.center();
        w.show().map_err(|_| AppError::Internal)?;
        w.set_always_on_top(true).map_err(|_| AppError::Internal)?;
        let _ = w.set_focus();
        let _ = w.emit("launcher://shown", serde_json::json!({ "at": chrono::Utc::now().timestamp_millis() }));
    } else {
        w.hide().map_err(|_| AppError::Internal)?;
    }
    Ok(())
}

/// 供 `lib.rs` 安装的全局快捷键处理器：按下时切换启动器显隐。
pub fn toggle(app: &tauri::AppHandle, core: &SharedCore) {
    if !settings::get_bool(&core.db, "quick_launcher_enabled", true) {
        return;
    }
    let visible = app
        .get_webview_window(LAUNCHER_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let _ = show_or_hide(app, !visible);
}

/// 占用状态判断：已注册即视为可用；未注册则返回失败原因。
fn register_one(app: &tauri::AppHandle, accel: &str) -> Result<()> {
    app.global_shortcut()
        .register(accel)
        .map_err(|_| AppError::ShortcutConflict)
}

fn unregister_one(app: &tauri::AppHandle, accel: &str) {
    let _ = app.global_shortcut().unregister(accel);
}

fn is_registered(app: &tauri::AppHandle, accel: &str) -> bool {
    app.global_shortcut().is_registered(accel)
}

/// 换键：先摘旧键，再注册新键；新键失败必须回滚旧键并报错。
pub fn rebind(app: &tauri::AppHandle, core: &Arc<AppCore>, accel: &str, old: &str) -> Result<serde_json::Value> {
    let want = accel.trim().to_string();
    if shortcut::equivalent(&want, old) && is_registered(app, old) {
        persist(core, &want, true)?;
        return Ok(status_json(&want, true));
    }
    unregister_one(app, old);
    if let Err(e) = register_one(app, &want) {
        // 回滚：旧快捷键必须恢复，否则用户会失去唯一的唤起入口
        let _ = register_one(app, old);
        return Err(e);
    }
    persist(core, &want, true)?;
    Ok(status_json(&want, true))
}

/// 启用/停用系统级唤起。停用不影响主窗口内的搜索入口。
pub fn apply_enabled(app: &tauri::AppHandle, core: &Arc<AppCore>, enabled: bool) -> Result<serde_json::Value> {
    let current = core.shortcut.lock().clone();
    if enabled {
        if !is_registered(app, &current) {
            register_one(app, &current)?;
        }
    } else {
        unregister_one(app, &current);
    }
    settings::set(&core.db, "quick_launcher_enabled", if enabled { "true" } else { "false" }, "install")?;
    Ok(status_json(&current, enabled && is_registered(app, &current)))
}

/// 启动时按设置注册快捷键；失败只记录，不阻塞主界面。
pub fn bootstrap(app: &tauri::AppHandle, core: &Arc<AppCore>) -> Option<String> {
    let saved = settings::get(&core.db, "quick_launcher_shortcut").ok().flatten();
    let accel = saved
        .filter(|s| shortcut::validate_accelerator(s).is_ok())
        .unwrap_or_else(|| shortcut::default_accelerator().to_string());
    *core.shortcut.lock() = accel.clone();
    if !settings::get_bool(&core.db, "quick_launcher_enabled", true) {
        return None;
    }
    match register_one(app, &accel) {
        Ok(_) => Some(accel),
        Err(_) => {
            let fallback = shortcut::default_accelerator();
            if shortcut::equivalent(&accel, fallback) {
                None
            } else {
                match register_one(app, fallback) {
                    Ok(_) => {
                        let fb = fallback.to_string();
                        *core.shortcut.lock() = fb.clone();
                        Some(fb)
                    }
                    Err(_) => None,
                }
            }
        }
    }
}

fn persist(core: &Arc<AppCore>, accel: &str, ok: bool) -> Result<()> {
    *core.shortcut.lock() = accel.to_string();
    settings::set(&core.db, "quick_launcher_shortcut", accel, "install")?;
    let _ = crate::audit::record(
        &core.db,
        core.vault.active_user().as_deref(),
        "quick_launcher.shortcut.set",
        Some("setting"),
        None,
        if ok { "success" } else { "failure" },
        None,
        Some("system"),
    );
    Ok(())
}

fn status_json(shortcut: &str, registered: bool) -> serde_json::Value {
    serde_json::json!({
        "shortcut": shortcut,
        "registered": registered,
        "default": shortcut::default_accelerator(),
        "hint": if registered { "快捷键已生效" } else { "快捷键未能注册：与系统或其他应用冲突，请在系统设置中释放后重试" },
    })
}
