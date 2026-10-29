//! 答题浮层：悬停识别命中后贴在光标旁边的一枚置顶小窗。
//!
//! 它与启动器共用「透明、无边框、置顶、不抢焦点」的窗口形态，但多两条硬约束：
//! - **点击穿透**：浮层压在别的应用上，鼠标必须能穿过去继续选字/滚动；
//! - **完全避开取景带**：悬停线程每 700ms 会再截一次屏，浮层若压在取景带里，
//!   下一轮就会把答案本身 OCR 进题干。放不下（屏幕太小）时宁可不显示。

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::{AppError, Result};
use crate::quiz::capture::{logical_to_physical, Band};
use crate::quiz::matcher::MatchHit;
use crate::quiz::EVENT_TIP;

pub const TIP_LABEL: &str = "quiztip";
/// 逻辑尺寸。内容超出由 CSS 截断（最多三行题干），窗口本身不再随内容跳动——
/// 每次改尺寸都会让置顶窗闪一下，而悬停每 700ms 就可能换一次内容。
pub const TIP_WIDTH: f64 = 440.0;
pub const TIP_HEIGHT: f64 = 210.0;
/// 与取景带保持的空隙：贴边会让两次坐标换算的取整误差把一行字压进带子里。
const TIP_GAP: f64 = 12.0;
/// 离屏幕边缘至少留这么多。
const SCREEN_MARGIN: f64 = 8.0;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipPayload {
    pub visible: bool,
    pub hit: Option<MatchHit>,
    pub show_options: bool,
    pub at: i64,
}

pub fn ensure_window(app: &AppHandle) -> Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(TIP_LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, TIP_LABEL, WebviewUrl::App("quiztip.html".into()))
        .title("题库答案")
        .inner_size(TIP_WIDTH, TIP_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .content_protected(true)
        .build()
        .map_err(|e| AppError::internal("答题浮层窗口", &e))?;
    // 不接收鼠标：浮层只是给人看一眼，点到的是它下面的应用。
    let _ = w.set_ignore_cursor_events(true);
    Ok(w)
}

/// 显示浮层并把它放到取景带之外。返回是否真的显示（放不下时为 false）。
pub fn show(app: &AppHandle, band: &Band, hit: MatchHit, show_options: bool) -> Result<bool> {
    let Some((x, y)) = place_tip(
        band.rect(),
        (band.monitor.x, band.monitor.y, band.monitor.width, band.monitor.height),
        (TIP_WIDTH, TIP_HEIGHT),
    ) else {
        hide(app)?;
        return Ok(false);
    };

    let w = ensure_window(app)?;
    let (px, py) = logical_to_physical(x, y, band.monitor.scale);
    w.set_position(tauri::PhysicalPosition::new(px, py))
        .map_err(|e| AppError::internal("答题浮层窗口", &e))?;
    let payload = TipPayload { visible: true, hit: Some(hit), show_options, at: now_ms() };
    w.emit(EVENT_TIP, payload).map_err(|e| AppError::internal("答题浮层窗口", &e))?;
    w.show().map_err(|e| AppError::internal("答题浮层窗口", &e))?;
    // 置顶窗在部分桌面环境里 `show()` 之后会被别的应用压下去，每次都再抬一次。
    let _ = w.set_always_on_top(true);
    Ok(true)
}

/// 通知浮层收起内容并隐藏窗口。窗口已经不在时也算成功。
pub fn hide(app: &AppHandle) -> Result<()> {
    let Some(w) = app.get_webview_window(TIP_LABEL) else { return Ok(()) };
    let _ = w.emit(
        EVENT_TIP,
        TipPayload { visible: false, hit: None, show_options: false, at: now_ms() },
    );
    w.hide().map_err(|e| AppError::internal("答题浮层窗口", &e))
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(TIP_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 浮层左上角（屏幕逻辑坐标）。**必须**整块落在取景带之外：
/// 先试带子下方，放不下再试上方；两边都放不下就返回 None（宁可不显示）。
///
/// `band` = (x, y, w, h)，`monitor` = (x, y, w, h)，`tip` = (w, h)。
pub fn place_tip(
    band: (f64, f64, f64, f64),
    monitor: (f64, f64, f64, f64),
    tip: (f64, f64),
) -> Option<(f64, f64)> {
    let (bx, by, _bw, bh) = band;
    let (mx, my, mw, mh) = monitor;
    let (tw, th) = tip;
    if tw > mw || th > mh {
        return None;
    }
    let min_x = mx + SCREEN_MARGIN;
    let max_x = mx + mw - tw - SCREEN_MARGIN;
    let x = (bx - 40.0).clamp(min_x, max_x.max(min_x));

    let below = by + bh + TIP_GAP;
    if below + th <= my + mh - SCREEN_MARGIN {
        return Some((x, below));
    }
    let above = by - TIP_GAP - th;
    if above >= my + SCREEN_MARGIN {
        return Some((x, above));
    }
    None
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tip_goes_below_the_band_when_there_is_room() {
        let band = (100.0, 300.0, 760.0, 180.0);
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        let (x, y) = place_tip(band, monitor, (440.0, 210.0)).unwrap();
        assert_eq!(y, 300.0 + 180.0 + TIP_GAP);
        assert!(x >= 8.0 && x + 440.0 <= 1912.0);
    }

    #[test]
    fn tip_flips_above_the_band_near_the_bottom_edge() {
        // 光标贴近屏幕底部：下方放不下 210px，必须翻到取景带上方。
        let band = (100.0, 880.0, 760.0, 180.0);
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        let (_, y) = place_tip(band, monitor, (440.0, 210.0)).unwrap();
        assert_eq!(y, 880.0 - TIP_GAP - 210.0);
        assert!(y + 210.0 <= 880.0, "浮层不能压进取景带");
    }

    #[test]
    fn tip_is_clamped_to_the_monitor_horizontally() {
        let band = (1500.0, 100.0, 760.0, 180.0);
        let monitor = (0.0, 0.0, 1920.0, 1080.0);
        let (x, _) = place_tip(band, monitor, (440.0, 210.0)).unwrap();
        assert!(x + 440.0 <= 1920.0 - SCREEN_MARGIN);
    }

    #[test]
    fn tiny_screen_means_no_tip_instead_of_overlapping_band() {
        // 上下都放不下：宁可不出浮层，也不能让它落进取景带。
        let band = (0.0, 40.0, 400.0, 180.0);
        let monitor = (0.0, 0.0, 400.0, 260.0);
        assert!(place_tip(band, monitor, (440.0, 210.0)).is_none());
        // 窗口比屏幕还宽同样拒绝。
        assert!(place_tip((0.0, 0.0, 100.0, 50.0), (0.0, 0.0, 300.0, 600.0), (440.0, 210.0)).is_none());
    }
}
