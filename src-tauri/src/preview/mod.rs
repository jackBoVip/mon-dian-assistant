//! 页面库的预览通道：一条回环供页服务 + 两个消费端。
//!
//! 内容只有一个来源：`server` 绑在 127.0.0.1 的随机端口上，每次请求都重新过会话与权限。
//! 消费端有两处，安全边界相同——内容对 Tauri 都是 remote origin，没有 `remote` capability
//! 就拿不到本应用任何命令：
//! - 右栏的嵌入块（`embed`）：子 webview 直接摆在列表右边，能点、能跑脚本、能联网；
//! - 「运行脚本」的独立窗口（本文件）：`page-preview` 不在 capability 的 windows 名单里。
//!
//! 锁库、删页、主窗收进托盘三个时机两个消费端都要收掉：明文不能留在屏幕上，旧内容也不该挂在已删页面后面。

use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, Result};
use crate::state::SharedCore;

pub mod embed;
pub mod server;

pub const WINDOW_LABEL: &str = "page-preview";

struct Bound {
    port: u16,
    token: String,
}

static BOUND: OnceLock<Bound> = OnceLock::new();
/// 当前窗口里显示的是哪一页；删页时要据此决定关不关窗。
static SHOWING: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn showing() -> &'static Mutex<Option<String>> {
    SHOWING.get_or_init(|| Mutex::new(None))
}

pub fn server_started() -> bool {
    BOUND.get().is_some()
}

/// 由 `server::start` 在绑定成功后登记；重复登记（理论上只有一次）返回 false。
pub fn remember(port: u16, token: String) -> bool {
    BOUND.set(Bound { port, token }).is_ok()
}

pub fn start(core: SharedCore) -> Result<()> {
    server::start(core)
}

/// 预览地址。令牌是持有型的：同机进程拿到地址就能读，与 `ipc.rs` 的通道令牌同一信任模型。
pub fn url_for(id: &str) -> Result<String> {
    let bound = BOUND.get().ok_or(AppError::PreviewUnavailable)?;
    Ok(format!("http://127.0.0.1:{}/s/{}/{}", bound.port, bound.token, id))
}

pub fn open(app: &AppHandle, id: &str, title: &str) -> Result<()> {
    let url = url_for(id)?;
    *showing().lock() = Some(id.to_string());
    let title = format!("预览 · {title}");

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        // 同一扇窗复用：地址与标题都换掉，再带到前台。导航本身就会重新请求，不必先清什么。
        let parsed = url.parse().map_err(|e| AppError::internal("预览地址解析", &e))?;
        window
            .navigate(parsed)
            .map_err(|e| AppError::internal("预览窗口跳转", &e))?;
        let _ = window.set_title(&title);
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let parsed = url.parse().map_err(|e| AppError::internal("预览地址解析", &e))?;
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(1024.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .build()
        .map_err(|e| AppError::internal("页面预览窗口", &e))?;
    Ok(())
}

/// 关掉两个消费端（不存在就忽略）。锁库、收托盘都走这条。
pub fn close(app: &AppHandle) {
    embed::close(app);
    *showing().lock() = None;
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.close();
    }
}

/// 只在"某处正显示的正是这一页"时关闭：删完一页不该顺手关掉别页的预览。
pub fn close_if_showing(app: &AppHandle, id: &str) {
    embed::close_if_showing(app, id);
    let current = showing().lock().clone();
    if current.as_deref() == Some(id) {
        *showing().lock() = None;
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.close();
        }
    }
}
