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
    round_corners(&window);
}

/// Windows 11 的 DWM 只给**有系统边框**的窗口自动圆角；去框后必须显式要求圆角。
/// Windows 10 根本没有这个属性，调用返回失败码 —— 那一代无任何圆角 API，直角属预期。
#[cfg(windows)]
fn round_corners(window: &tauri::WebviewWindow) {
    // 直接声明而不是引 `windows` crate：它已在依赖图里（tauri 用 0.62.2），
    // 但为一个函数把它提成本包的直接依赖不值得，且会多一处版本要对齐。
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: *mut core::ffi::c_void, attribute: u32, data: *const u32, size: u32) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    let Ok(hwnd) = window.hwnd() else {
        log::warn!("取不到主窗 HWND：跳过圆角设置");
        return;
    };
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if hr != 0 {
        log::warn!("DWM 圆角未生效（hr={hr:#010x}）：Windows 10 无此属性，直角属预期");
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
