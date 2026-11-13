//! 窗口形态：macOS 走配置里的 `titleBarStyle: Overlay` + 原生红绿灯；
//! Windows / Linux 在启动时去框，窗口按钮由界面自绘。
//!
//! 为什么必须在运行时做：`titleBarStyle` 与 `hiddenTitle` 是 **macOS 专属**配置
//! （`tauri-runtime-wry-2.12.1/src/lib.rs:799` 那段把 `config.title_bar_style` 交给窗口构造器，
//! 外面套的是 `#[cfg(target_os = "macos")]`；`tauri-utils` 里该字段的注释也写着
//! "The style of the macOS title bar"）。所以在 Windows/Linux 上，那两行配置**一个字都没生效**，
//! 主窗拿到的是系统标题栏 —— 与自绘的 `.top-navbar` 叠成两条栏。`tauri.conf.json` 没法按平台
//! 分开写 `decorations`，故在这里按 `cfg!` 分支处理。

use tauri::{AppHandle, Manager};

/// 界面是否要自己画最小化/最大化/关闭三颗钮。
///
/// macOS 有原生红绿灯，去框反而丢掉窗口按钮；其余平台去框后系统不再提供任何按钮，
/// 所以这一枚常量同时决定"去不去框"与"界面画不画按钮"——两处必须是同一个答案。
pub const CUSTOM_CONTROLS: bool = !cfg!(target_os = "macos");

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chrome {
    pub custom_controls: bool,
    /// `std::env::consts::OS`：界面只用它区分 mac/windows/linux 三档外观。
    pub platform: &'static str,
}

/// 界面要问的那一嘴：画不画窗口按钮、当前是哪一档平台。
pub fn chrome() -> Chrome {
    Chrome { custom_controls: CUSTOM_CONTROLS, platform: std::env::consts::OS }
}

/// setup 早期调用。失败**只记日志**：这里返回 Err 会变成 Tauri 的 panic，
/// 而本项目 release 是 `panic = "abort"`（见 lib.rs setup 那段说明）。
pub fn apply(handle: &AppHandle) {
    let Some(window) = handle.get_webview_window("main") else {
        log::warn!("主窗不存在：跳过窗口形态处理");
        return;
    };
    if CUSTOM_CONTROLS {
        if let Err(e) = window.set_decorations(false) {
            // 去框失败就维持系统标题栏：界面那三颗钮仍然画（前端只认 customControls），
            // 顶多出现"两条栏"的原状，绝不能因为形态问题让应用起不来。
            log::warn!("去框失败（{e}）：保留系统标题栏，窗口按钮改由界面自绘");
        }
    }
    #[cfg(windows)]
    {
        match window.hwnd() {
            Ok(hwnd) => {
                // Win11 走 DWM 原生圆角；属性不存在（Win10）时退回窗口区域裁剪。
                if !dwm_round_corners(hwnd.0) {
                    region_corners::install(hwnd.0, &window);
                }
            }
            Err(e) => log::warn!("取不到主窗 HWND：跳过圆角设置（{e}）"),
        }
    }
}

/// Windows 11 的 DWM 只给**有系统边框**的窗口自动圆角；去框后必须显式要求圆角。
/// `DWMWA_WINDOW_CORNER_PREFERENCE` 是 Win11 (build 22000+) 才有的属性，Win10 的
/// dwmapi 不认识它，调用返回失败码 —— 用这个失败作为分支信号，比读版本号可靠
/// （`GetVersionExW` 在没有 supportedOS 清单的进程里会被骗成 6.2）。
#[cfg(windows)]
fn dwm_round_corners(hwnd: *mut core::ffi::c_void) -> bool {
    // 直接声明而不是引 `windows` crate：它已在依赖图里（tauri 用 0.62.2），
    // 但为一个函数把它提成本包的直接依赖不值得，且会多一处版本要对齐。
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: *mut core::ffi::c_void, attribute: u32, data: *const u32, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if hr != 0 {
        log::warn!("DWM 圆角未生效（hr={hr:#010x}）：判定为 Windows 10，改用窗口区域圆角");
    }
    hr == 0
}

/// Windows 10 的兜底圆角：`SetWindowRgn` + `CreateRoundRectRgn` 把窗口裁成圆角矩形。
///
/// 诚实说明代价（不是 DWM 圆角的等价替代）：
/// - HRGN 是**硬裁剪，边缘没有抗锯齿**，高 DPI 下四角会有可见锯齿；
/// - 顶层窗口的 region 会连带裁掉 DWM 阴影，窗口看起来比 Win11 更"贴"桌面；
/// - 最大化时必须撤掉 region，否则四角会露出桌面；
/// - size / DPI 变化后 region 不会自动跟随，必须重设（下面注册了窗口事件）。
/// 全部失败都只记日志、保持直角，绝不影响应用启动。
#[cfg(windows)]
mod region_corners {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    /// 100% 缩放下与 Win11 DWM 圆角接近的半径（物理像素）。
    const RADIUS_100: f64 = 12.0;

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRoundRectRgn(x1: i32, y1: i32, x2: i32, y2: i32, w: i32, h: i32) -> *mut core::ffi::c_void;
        fn DeleteObject(obj: *mut core::ffi::c_void) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: *mut core::ffi::c_void, rgn: *mut core::ffi::c_void, redraw: i32) -> i32;
        fn GetWindowRect(hwnd: *mut core::ffi::c_void, rect: *mut Rect) -> i32;
        fn IsZoomed(hwnd: *mut core::ffi::c_void) -> i32;
    }

    /// 返回 false 表示这一步没做成，调用方保持直角即可。
    fn set_region(hwnd_raw: isize, scale: f64) -> bool {
        let hwnd = hwnd_raw as *mut core::ffi::c_void;
        unsafe {
            // 最大化时窗口本就该贴满屏幕，撤掉 region 恢复矩形。
            if IsZoomed(hwnd) != 0 {
                return SetWindowRgn(hwnd, std::ptr::null_mut(), 1) != 0;
            }
            let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(hwnd, &mut r) == 0 {
                return false;
            }
            let w = r.right - r.left;
            let h = r.bottom - r.top;
            if w <= 0 || h <= 0 {
                return false;
            }
            // clamp 的上下界必须保持 min<=max，否则 f64::clamp 会 panic。
            let max_radius = ((w.min(h) / 4).max(4)) as f64;
            let radius = (RADIUS_100 * scale).round().clamp(4.0, max_radius) as i32;
            // 后两参是圆角**椭圆的直径**，不是半径；右下 +1 是 GDI 半开区间的惯例。
            let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2);
            if rgn.is_null() {
                return false;
            }
            if SetWindowRgn(hwnd, rgn, 1) == 0 {
                DeleteObject(rgn); // 失败时 HRGN 仍归我们，成功则由系统接管，不能删。
                return false;
            }
        }
        true
    }

    pub(super) fn install(hwnd: *mut core::ffi::c_void, window: &tauri::WebviewWindow) {
        let raw = hwnd as isize;
        let scale_x100 = Arc::new(AtomicU32::new(
            (window.scale_factor().unwrap_or(1.0).max(1.0) * 100.0).round() as u32,
        ));
        let scale = scale_x100.load(Ordering::Relaxed) as f64 / 100.0;
        if set_region(raw, scale) {
            log::info!("已启用 Windows 10 窗口区域圆角（{RADIUS_100:.0}px @100%，硬裁剪）");
        } else {
            log::warn!("窗口区域圆角设置失败：保持直角");
        }

        let shared = scale_x100.clone();
        window.on_window_event(move |event| {
            match event {
                tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                    shared.store((*scale_factor * 100.0).round() as u32, Ordering::Relaxed);
                }
                tauri::WindowEvent::Resized(_) => {}
                _ => return,
            }
            let s = shared.load(Ordering::Relaxed) as f64 / 100.0;
            let _ = set_region(raw, s);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这一枚常量是"后端去框"与"前端画按钮"的唯一共同答案：它一旦和平台判定脱钩，
    /// 就会出现"框没了但也没有任何窗口按钮"或"两条栏 + 三颗多余按钮"这两种现场。
    #[test]
    fn custom_controls_tracks_exactly_the_non_mac_platforms() {
        assert_eq!(CUSTOM_CONTROLS, !cfg!(target_os = "macos"));
        let chrome = chrome();
        assert_eq!(chrome.custom_controls, CUSTOM_CONTROLS);
        assert_eq!(chrome.platform, std::env::consts::OS);
    }
}
