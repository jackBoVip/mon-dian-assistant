//! 光标附近的截屏。
//!
//! 取景是一条横带：以光标为中心，往上 48、往下 132、宽 760 逻辑像素。
//! 答题时鼠标一般停在自己正在读的那一行，题干就在这一行上下几行之内；
//! 整屏截图既慢（5K 屏 ~59MB/次）又会把无关窗口一起送进 OCR。
//!
//! 坐标系（对着 xcap 0.9.8 与 tao 0.35 的源码核过）：
//! - `AppHandle::cursor_position()` 是「物理像素」：macOS/Linux 上等于逻辑坐标乘主屏缩放，
//!   Windows 上就是屏幕物理像素。
//! - xcap 的 Monitor 坐标在 macOS/Linux 是逻辑点、Windows 是物理像素。
//! 所以换算只在非 Windows 上除以主屏缩放一次；`capture_region` 的 x/y 相对该显示器，
//! 返回图是物理像素（macOS 由 CGWindowListCreateImage 按屏缩放输出）。
//!
//! 权限：macOS 需要「屏幕录制」授权。拒绝时系统截图会得到一张全黑图，
//! 这里用亮度启发式把它判成「没权限」，而不是报成「没识别到题目」——
//! 那会把使用者引向完全错误的排障方向。
//!
//! 取景几何（[`Band`]）与像素（[`capture_band`]）分开：悬停线程 700ms 内复用上一次 OCR
//! 结果时仍然需要**当前**的取景带位置来摆放浮层，不能为了算坐标再去截一次屏。

use image::{DynamicImage, RgbaImage};
use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, Result};

/// 取景带宽度（逻辑像素）。
pub const BAND_WIDTH: f64 = 760.0;
/// 光标上方取多少（逻辑像素）。
pub const BAND_ABOVE: f64 = 48.0;
/// 光标下方取多少（逻辑像素）。
pub const BAND_BELOW: f64 = 132.0;
/// 取景带左边相对光标的偏移：题干通常从光标左侧一点开始。
pub const BAND_LEFT: f64 = 160.0;

/// 平均亮度低于这个值就当成「被系统拦成黑图」。
const BLACK_FRAME_LUMA: f64 = 3.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenPermission {
    Granted,
    Denied,
    /// 当前会话拿不到可靠的权限信息（Wayland 等）。
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPermissionStatus {
    pub supported: bool,
    pub permission: ScreenPermission,
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

impl MonitorRect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// 取景带（不含像素）。浮层摆放与 OCR 共用同一份几何。
///
/// 坐标与尺寸的单位是**截图单位**：macOS/Linux 上是逻辑点（截图时乘 `scale` 出物理像素），
/// Windows 上就是物理像素（`scale` 只用来把带子画大）。两种平台下
/// `origin/width/height/cursor` 与 `monitor` 始终同一套单位，可以直接一起做加法。
#[derive(Clone, Copy, Debug)]
pub struct Band {
    /// 左上角的屏幕坐标（截图单位）。
    pub origin_x: f64,
    pub origin_y: f64,
    /// 尺寸（截图单位）。
    pub width: f64,
    pub height: f64,
    /// 光标在带内的偏移（截图单位）。
    pub cursor_x: f64,
    pub cursor_y: f64,
    /// 截图像素 / 截图单位。
    pub scale: f64,
    pub monitor: MonitorRect,
}

impl Band {
    pub fn rect(&self) -> (f64, f64, f64, f64) {
        (self.origin_x, self.origin_y, self.width, self.height)
    }

    /// 光标在**截图像素**里的位置。
    ///
    /// 截图一律是物理像素，但带子的坐标只有 macOS/Linux 是逻辑点（要乘缩放）；
    /// Windows 上光标与显示器边界本来就是物理像素，再乘一次缩放（150% 即 1.5 倍）
    /// 会把「光标压在哪一行」算到带子外面去，选错题干行。
    pub fn cursor_px(&self) -> (f64, f64) {
        if cfg!(target_os = "windows") {
            (self.cursor_x, self.cursor_y)
        } else {
            (self.cursor_x * self.scale, self.cursor_y * self.scale)
        }
    }
}

/// 一逻辑点等于多少截图单位。
///
/// macOS/Linux 的显示器边界是逻辑点、截图按缩放输出物理像素，所以带子按逻辑点画，
/// 只有光标位置换算到像素时乘缩放；Windows 的边界与截图都是物理像素，
/// 整条带子都要先折成物理像素，否则 150% 缩放下的取景带只有三分之二的覆盖面。
fn band_unit(scale: f64) -> f64 {
    if cfg!(target_os = "windows") {
        scale
    } else {
        1.0
    }
}

/// 一张取景截图。
pub struct Captured {
    pub band: Band,
    pub image: DynamicImage,
}

/// Wayland 下没有全局截屏能力（xcap 只能在 X11 上抓 root 窗口）。
pub fn is_wayland() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    if session.eq_ignore_ascii_case("wayland") {
        return true;
    }
    // 只设了 WAYLAND_DISPLAY、没有 XDG_SESSION_TYPE 的会话也是 Wayland。
    std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none()
}

/// macOS 之外没有屏幕录制授权这一层（Windows 需要 UAC 提升的进程才能抓管理员窗口，
/// 普通窗口不需要授权）。
pub fn permission() -> ScreenPermission {
    #[cfg(target_os = "macos")]
    {
        // 返回 C `bool`；按字节读，避免和 ObjC 的 BOOL 宽度差异扯上关系。
        if unsafe { CGPreflightScreenCaptureAccess() } != 0 {
            ScreenPermission::Granted
        } else {
            ScreenPermission::Denied
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ScreenPermission::Granted
    }
}

pub fn permission_status() -> ScreenPermissionStatus {
    if is_wayland() {
        return ScreenPermissionStatus {
            supported: false,
            permission: ScreenPermission::Unknown,
            detail: Some("当前是 Wayland 桌面会话，系统不允许全局截屏；请改用 X11 会话后再启用答题助手。".to_string()),
        };
    }
    ScreenPermissionStatus { supported: true, permission: permission(), detail: None }
}

/// 只在用户点了「申请权限」时调用：macOS 会弹系统授权框。
pub fn request_permission() -> ScreenPermissionStatus {
    #[cfg(target_os = "macos")]
    {
        if !is_wayland() {
            unsafe {
                CGRequestScreenCaptureAccess();
            }
        }
    }
    permission_status()
}

/// 算光标附近的取景带位置（不截图）。
pub fn band_at_cursor(app: &AppHandle) -> Result<Band> {
    if is_wayland() {
        return Err(AppError::QuizUnsupportedPlatform);
    }
    if permission() == ScreenPermission::Denied {
        return Err(AppError::QuizScreenPermissionDenied);
    }

    let (cx, cy) = cursor_logical(app)?;
    let monitors = xcap::Monitor::all().map_err(|e| AppError::QuizCaptureFailed(format!("枚举显示器失败：{e}")))?;
    if monitors.is_empty() {
        return Err(AppError::QuizCaptureFailed("没有可用显示器".to_string()));
    }

    let monitor = pick_monitor(&monitors, cx, cy);
    let (mx, my, mw, mh) = monitor_bounds(monitor)?;
    let scale = monitor.scale_factor().unwrap_or(1.0) as f64;

    Ok(geometry(MonitorRect { x: mx, y: my, width: mw, height: mh, scale }, cx, cy, band_unit(scale)))
}

/// 纯几何：光标 + 显示器 → 取景带。`unit` 见 [`band_unit`]。
fn geometry(monitor: MonitorRect, cx: f64, cy: f64, unit: f64) -> Band {
    let width = (BAND_WIDTH * unit).min(monitor.width);
    let height = ((BAND_ABOVE + BAND_BELOW) * unit).min(monitor.height);
    let x0 = clamp_band(cx - BAND_LEFT * unit, monitor.x, monitor.width, width);
    let y0 = clamp_band(cy - BAND_ABOVE * unit, monitor.y, monitor.height, height);
    Band {
        origin_x: x0,
        origin_y: y0,
        width,
        height,
        cursor_x: cx - x0,
        cursor_y: cy - y0,
        scale: monitor.scale,
        monitor,
    }
}

/// 按取景带截图。全黑图判为「被系统拦掉了」。
pub fn capture_band(band: &Band) -> Result<DynamicImage> {
    let monitors = xcap::Monitor::all().map_err(|e| AppError::QuizCaptureFailed(format!("枚举显示器失败：{e}")))?;
    if monitors.is_empty() {
        return Err(AppError::QuizCaptureFailed("没有可用显示器".to_string()));
    }
    // 按取景带的中心找显示器：这一步与 `band_at_cursor` 用的是同一个判定。
    let cx = band.origin_x + band.width / 2.0;
    let cy = band.origin_y + band.height / 2.0;
    let monitor = pick_monitor(&monitors, cx, cy);
    let (mx, my, mw, mh) = monitor_bounds(monitor)?;

    let rx = (band.origin_x - mx).round().max(0.0) as u32;
    let ry = (band.origin_y - my).round().max(0.0) as u32;
    let rw = (band.width.round() as u32).min(mw.round().max(1.0) as u32);
    let rh = (band.height.round() as u32).min(mh.round().max(1.0) as u32);
    if rw == 0 || rh == 0 {
        return Err(AppError::QuizCaptureFailed("取景区域为空".to_string()));
    }
    let frame = monitor
        .capture_region(rx, ry, rw, rh)
        .map_err(|e| AppError::QuizCaptureFailed(format!("截屏失败：{e}")))?;

    if is_black_frame(&frame) && permission() == ScreenPermission::Granted {
        return Err(AppError::QuizScreenPermissionDenied);
    }
    Ok(DynamicImage::ImageRgba8(frame))
}

/// 一次完整的「定位 + 截图」。手动试一次走这条；悬停线程需要缓存 OCR 时分开调用。
pub fn capture_at_cursor(app: &AppHandle) -> Result<Captured> {
    let band = band_at_cursor(app)?;
    let image = capture_band(&band)?;
    Ok(Captured { band, image })
}

/// 光标的屏幕逻辑坐标。取景与浮层定位共用这一处换算。
pub fn cursor_logical(app: &AppHandle) -> Result<(f64, f64)> {
    let cursor = app
        .cursor_position()
        .map_err(|e| AppError::QuizCaptureFailed(format!("读取光标位置失败：{e}")))?;
    #[cfg(target_os = "windows")]
    {
        Ok((cursor.x, cursor.y))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let scale = primary_scale();
        Ok((cursor.x / scale, cursor.y / scale))
    }
}

/// 把逻辑坐标换成窗口定位用的物理像素。
pub fn logical_to_physical(x: f64, y: f64, scale: f64) -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        let _ = scale;
        (x.round() as i32, y.round() as i32)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let s = if scale > 0.0 { scale } else { 1.0 };
        ((x * s).round() as i32, (y * s).round() as i32)
    }
}

/// 主屏缩放因子缓存 10 秒：悬停线程每 120ms 取一次光标，
/// 每次都去枚举显示器会把省下来的 CPU 又花回去。
fn primary_scale() -> f64 {
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, f64)>> = std::sync::Mutex::new(None);
    const TTL: std::time::Duration = std::time::Duration::from_secs(10);
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, scale)) = *guard {
        if at.elapsed() < TTL {
            return scale;
        }
    }
    let scale = xcap::Monitor::all()
        .ok()
        .and_then(|ms| {
            ms.iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or_else(|| ms.first())
                .and_then(|m| m.scale_factor().ok())
        })
        .filter(|s| *s > 0.0)
        .unwrap_or(1.0) as f64;
    *guard = Some((std::time::Instant::now(), scale));
    scale
}

fn pick_monitor<'a>(monitors: &'a [xcap::Monitor], x: f64, y: f64) -> &'a xcap::Monitor {
    for m in monitors {
        if let Ok((mx, my, mw, mh)) = monitor_bounds(m) {
            if x >= mx && y >= my && x < mx + mw && y < my + mh {
                return m;
            }
        }
    }
    monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(&monitors[0])
}

fn monitor_bounds(m: &xcap::Monitor) -> Result<(f64, f64, f64, f64)> {
    let x = m.x().map_err(|e| AppError::QuizCaptureFailed(format!("读取显示器坐标失败：{e}")))?;
    let y = m.y().map_err(|e| AppError::QuizCaptureFailed(format!("读取显示器坐标失败：{e}")))?;
    let w = m.width().map_err(|e| AppError::QuizCaptureFailed(format!("读取显示器尺寸失败：{e}")))?;
    let h = m.height().map_err(|e| AppError::QuizCaptureFailed(format!("读取显示器尺寸失败：{e}")))?;
    Ok((x as f64, y as f64, w as f64, h as f64))
}

fn clamp_band(start: f64, monitor_start: f64, monitor_len: f64, band_len: f64) -> f64 {
    let max = (monitor_start + monitor_len - band_len).max(monitor_start);
    start.clamp(monitor_start, max)
}

/// 抽样判黑：每 8 像素取一点，够快也不至于被一根竖线骗过。
fn is_black_frame(frame: &RgbaImage) -> bool {
    let step = 8u32;
    let mut sum = 0u64;
    let mut count = 0u64;
    for y in (0..frame.height()).step_by(step as usize) {
        for x in (0..frame.width()).step_by(step as usize) {
            let px = frame.get_pixel(x, y);
            sum += px[0] as u64 + px[1] as u64 + px[2] as u64;
            count += 3;
        }
    }
    if count == 0 {
        return true;
    }
    (sum as f64 / count as f64) < BLACK_FRAME_LUMA
}

#[cfg(target_os = "macos")]
extern "C" {
    /// ApplicationServices：`bool CGPreflightScreenCaptureAccess(void)`（10.15+）。
    fn CGPreflightScreenCaptureAccess() -> u8;
    /// ApplicationServices：`bool CGRequestScreenCaptureAccess(void)`（10.15+）。
    fn CGRequestScreenCaptureAccess() -> u8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn band_is_clamped_inside_the_monitor() {
        // 光标在屏幕最左上角：取景带不能探出边界。
        assert_eq!(clamp_band(-160.0, 0.0, 1920.0, 760.0), 0.0);
        // 光标在右下角：右边界卡住。
        assert_eq!(clamp_band(1900.0, 0.0, 1920.0, 760.0), 1160.0);
        // 屏幕比取景带还窄：起点只能是显示器原点。
        assert_eq!(clamp_band(10.0, 0.0, 400.0, 760.0), 0.0);
        // 副屏负坐标。
        assert_eq!(clamp_band(-2000.0, -1920.0, 1920.0, 760.0), -1920.0);
    }

    #[test]
    fn black_frames_are_told_apart_from_normal_ones() {
        let black = RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 255]));
        assert!(is_black_frame(&black));

        // 一面深色底上写着白字：平均亮度低但远高于阈值，不能判成全黑。
        let mut dark = RgbaImage::from_pixel(64, 64, Rgba([18, 18, 18, 255]));
        for x in 0..32 {
            dark.put_pixel(x, 4, Rgba([240, 240, 240, 255]));
        }
        assert!(!is_black_frame(&dark));

        let light = RgbaImage::from_pixel(64, 64, Rgba([250, 250, 250, 255]));
        assert!(!is_black_frame(&light));
    }

    #[test]
    fn monitor_containment_uses_half_open_ranges() {
        let m = MonitorRect { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 };
        assert!(m.contains(-1920.0, 0.0));
        assert!(m.contains(-1.0, 1079.0));
        assert!(!m.contains(0.0, 0.0), "主屏左上角不属于副屏");
        assert!(!m.contains(-1.0, 1080.0));
    }

    /// 截图像素是浮层定位与「光标压在哪一行」共用的单位：
    /// 非 Windows 要乘缩放，Windows 的带子坐标本身已经是物理像素、不能再乘。
    #[test]
    fn cursor_pixel_position_matches_the_capture_units() {
        let band = Band {
            origin_x: 0.0,
            origin_y: 0.0,
            width: BAND_WIDTH,
            height: BAND_ABOVE + BAND_BELOW,
            cursor_x: 100.0,
            cursor_y: 40.0,
            scale: 2.0,
            monitor: MonitorRect { x: 0.0, y: 0.0, width: 2880.0, height: 1800.0, scale: 2.0 },
        };
        let expected = if cfg!(target_os = "windows") { (100.0, 40.0) } else { (200.0, 80.0) };
        assert_eq!(band.cursor_px(), expected);
    }

    /// 带子按逻辑尺寸定义：150% 缩放的 Windows 上也要折成物理像素，
    /// 否则截图只有 760 物理像素宽、覆盖面只剩三分之二。
    #[test]
    fn band_keeps_the_same_logical_coverage_on_every_scale() {
        let monitor = MonitorRect { x: 0.0, y: 0.0, width: 2880.0, height: 1800.0, scale: 1.5 };
        let band = geometry(monitor, 1440.0, 900.0, 1.5);
        assert_eq!(band.width, BAND_WIDTH * 1.5);
        assert_eq!(band.height, (BAND_ABOVE + BAND_BELOW) * 1.5);
        assert_eq!(band.cursor_x, BAND_LEFT * 1.5);
        assert_eq!(band.cursor_y, BAND_ABOVE * 1.5);
        // 1x 档（macOS/Linux 的逻辑点）保持原尺寸。
        let plain = geometry(monitor, 1440.0, 900.0, 1.0);
        assert_eq!(plain.width, BAND_WIDTH);
        assert_eq!(plain.cursor_y, BAND_ABOVE);
    }
}
