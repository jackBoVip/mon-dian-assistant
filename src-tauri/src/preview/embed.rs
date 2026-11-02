//! 右栏里那块直接可用的预览：把一块独立 webview 嵌进主窗。
//!
//! 安全边界与「运行脚本」那扇窗相同，而且更硬：内容来自 `http://127.0.0.1`，对 Tauri 来说
//! **不是** local origin（`is_local_url` 只认 app 协议与 devUrl），所以 `Webview::on_message`
//! 对远程来源的自定义命令一律拒绝，除非某条 capability 显式写了 `remote`（本应用一条都没有）。
//! 也就是说：这块区域能跑脚本、能联网，但页面里任何 `__TAURI_INTERNALS__.invoke` 都只会被拒。
//!
//! 原生 webview 会盖在网页上方，所以弹窗、切页、锁库、收托盘时都要明确收起或关闭它；
//! 位置由前端按占位块的 `getBoundingClientRect()`（CSS 像素 = 逻辑像素）逐个事件同步。
//! 收托盘把这块也关了，主窗回来时前端会重放 `open`：同 id 同版本只摆位置、不重新导航，
//! 页面里已经点出来的状态（计算器输入等）不会因为一次重放被清掉。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

use crate::error::{AppError, Result};

pub const LABEL: &str = "page-pane";

/// 子 webview 挂在主窗上；主窗 label 与 `tauri.conf.json` 的 `app.windows[0].label` 同源。
const MAIN_WINDOW: &str = "main";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// 前端量出来的是 CSS 像素。NaN/无穷/负宽高会让建窗或定位当场失败，
    /// 所以脏输入在这里就丢掉：宁可保持上一帧，也不把错误值交给 Tauri。
    pub fn sanitized(self) -> Option<Self> {
        let finite = [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite());
        if !finite || self.width < 1.0 || self.height < 1.0 {
            return None;
        }
        Some(Self {
            x: self.x.max(0.0),
            y: self.y.max(0.0),
            width: self.width,
            height: self.height,
        })
    }
}

/// 这块区域里现在载的是哪一页的哪一版。同 id 同版本再进来只摆位置、不重新导航：
/// 窗口重新获得焦点会重放 `open`，重导航会把页面里已点出来的状态（计算器输入等）清掉。
#[derive(Debug, Clone, PartialEq)]
struct Shown {
    id: String,
    version: String,
}

static SHOWN: OnceLock<Mutex<Option<Shown>>> = OnceLock::new();
/// 建窗、导航、关闭串行化：建窗要等主线程回话，并发进来只会撞同一个 label。
static GATE: OnceLock<Mutex<()>> = OnceLock::new();
/// 最近一次"该不该露出来"。建窗是异步的，弹窗可能在建窗途中打开，
/// 所以创建完成后按这枚标记收尾，而不是无脑 show。
static VISIBLE: AtomicBool = AtomicBool::new(true);

fn shown() -> &'static Mutex<Option<Shown>> {
    SHOWN.get_or_init(|| Mutex::new(None))
}

fn gate() -> &'static Mutex<()> {
    GATE.get_or_init(|| Mutex::new(()))
}

pub fn open(app: &AppHandle, id: &str, version: &str, url: &str, rect: Rect) -> Result<()> {
    let Some(rect) = rect.sanitized() else {
        return Ok(());
    };
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| AppError::internal("预览地址解析", &e))?;
    let wanted = Shown {
        id: id.to_string(),
        version: version.to_string(),
    };

    let _gate = gate().lock();
    if let Some(webview) = app.get_webview(LABEL) {
        webview
            .set_position(LogicalPosition::new(rect.x, rect.y))
            .map_err(|e| AppError::internal("预览位置", &e))?;
        webview
            .set_size(LogicalSize::new(rect.width, rect.height))
            .map_err(|e| AppError::internal("预览尺寸", &e))?;
        let same = shown().lock().as_ref() == Some(&wanted);
        if !same {
            webview
                .navigate(parsed)
                .map_err(|e| AppError::internal("预览跳转", &e))?;
            *shown().lock() = Some(wanted);
        }
        apply_visibility(&webview);
        return Ok(());
    }

    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or_else(|| AppError::internal("预览嵌入", &"找不到主窗口"))?;
    let webview = window
        .add_child(
            WebviewBuilder::new(LABEL, WebviewUrl::External(parsed)),
            LogicalPosition::new(rect.x, rect.y),
            LogicalSize::new(rect.width, rect.height),
        )
        .map_err(|e| AppError::internal("预览嵌入", &e))?;
    apply_visibility(&webview);
    *shown().lock() = Some(wanted);
    Ok(())
}

fn apply_visibility(webview: &tauri::Webview) {
    let _ = if VISIBLE.load(Ordering::Acquire) {
        webview.show()
    } else {
        webview.hide()
    };
}

/// 只摆位置与尺寸，不碰导航：窗口缩放、侧栏宽度变化都走这条。
pub fn sync(app: &AppHandle, rect: Rect) {
    let Some(rect) = rect.sanitized() else {
        return;
    };
    let _gate = gate().lock();
    if let Some(webview) = app.get_webview(LABEL) {
        let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
        let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));
    }
}

/// 弹窗会盖在网页上方但盖不住原生 webview，所以在弹窗打开期间把它收起来。
pub fn set_visible(app: &AppHandle, visible: bool) {
    VISIBLE.store(visible, Ordering::Release);
    let _gate = gate().lock();
    if let Some(webview) = app.get_webview(LABEL) {
        let _ = if visible { webview.show() } else { webview.hide() };
    }
}

pub fn close(app: &AppHandle) {
    let _gate = gate().lock();
    *shown().lock() = None;
    if let Some(webview) = app.get_webview(LABEL) {
        let _ = webview.close();
    }
}

/// 只在"嵌的正是这一页"时关闭：删完一页不该顺手关掉别页。
pub fn close_if_showing(app: &AppHandle, id: &str) {
    let current = shown().lock().as_ref().map(|s| s.id.clone());
    if current.as_deref() == Some(id) {
        close(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dirty_geometry_instead_of_handing_it_to_tauri() {
        let ok = Rect {
            x: 320.0,
            y: 96.0,
            width: 640.0,
            height: 480.0,
        };
        assert_eq!(ok.sanitized(), Some(ok));

        for bad in [
            Rect { x: f64::NAN, y: 0.0, width: 10.0, height: 10.0 },
            Rect { x: 0.0, y: f64::INFINITY, width: 10.0, height: 10.0 },
            Rect { x: 0.0, y: 0.0, width: 0.0, height: 10.0 },
            Rect { x: 0.0, y: 0.0, width: 10.0, height: -3.0 },
        ] {
            assert_eq!(bad.sanitized(), None, "{bad:?} 应该被挡下");
        }
    }

    #[test]
    fn negative_offsets_clamp_to_the_client_area() {
        let rect = Rect {
            x: -12.0,
            y: -4.0,
            width: 100.0,
            height: 50.0,
        }
        .sanitized()
        .expect("宽高有效就该留下");
        assert_eq!(rect.x, 0.0);
        assert_eq!(rect.y, 0.0);
        assert_eq!(rect.width, 100.0);
        assert_eq!(rect.height, 50.0);
    }
}
