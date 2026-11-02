//! 系统托盘：关闭主窗口 = 隐藏驻留，退出只走托盘菜单。
//!
//! 三端的托盘能力并不一样：Windows 有左键点击事件、macOS 左键就是展开菜单（还要用模板图才不糊成方块）、
//! Linux 的 appindicator 只给菜单不给点击。所以这里只统一三件共同的事——建一枚托盘、恢复主窗口、
//! 走 `app.exit(0)` 退出；点击语义按平台分开，见 `click_opens_main`。
//!
//! 关窗发生在事件循环线程上，必须是 O(1) 且不碰数据库：提示标记由 `hydrate` 在装配完成后读一次，
//! 之后只改内存位。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, CloseRequestApi, Manager, Window};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::settings;
use crate::state::SharedCore;

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "tray.main";
const MENU_SHOW: &str = "tray.show";
const MENU_QUIT: &str = "tray.quit";
const MENU_SHOW_LABEL: &str = "显示主窗口";
const MENU_QUIT_LABEL: &str = "退出";
/// 运行时写入的安装级键，不进 `DEFAULT_SETTINGS`（先例：`last_backup_at`）。
const HINT_KEY: &str = "tray_hint_shown";

// macOS 菜单栏只取 alpha 做模板图，彩色底板会变成一块实心方块；
// 44px 是 Retina 下的 22pt，22px 那张留给非 Retina。
#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray/tray-template@2x.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray/tray.png");

/// 托盘真的建起来了才算数。Linux 缺 appindicator 时这里是 false。
static TRAY_OK: AtomicBool = AtomicBool::new(false);
/// 退出已发起：此后任何关闭请求都不再拦。
static QUITTING: AtomicBool = AtomicBool::new(false);
/// 一次性说明框已经确认过。
static HINT_SHOWN: AtomicBool = AtomicBool::new(false);
/// 说明框正在显示：连点关闭不能叠出第二个框。
static ASKING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// 不拦：退出已经在路上，或者这不是主窗口。
    Allow,
    /// 托盘不可用：关窗就是退出，否则会留下一个既无界面也无托盘的进程。
    Quit,
    /// 隐藏到托盘。
    Hide,
    /// 隐藏前先弹一次说明。
    Ask,
}

/// 关窗决策。单独抽出来是为了能在没有托盘、没有窗口的测试环境里把真值表走满。
pub fn decide_close(label: &str, tray_ok: bool, quitting: bool, hint_shown: bool) -> CloseAction {
    if label != MAIN_WINDOW {
        // 启动器与答题浮层的"关闭"本来就是 hide()，不能被改成退出。
        return CloseAction::Allow;
    }
    if quitting {
        return CloseAction::Allow;
    }
    if !tray_ok {
        return CloseAction::Quit;
    }
    if hint_shown {
        CloseAction::Hide
    } else {
        CloseAction::Ask
    }
}

/// Linux 的 appindicator 是运行期 dlopen 进来的（`libappindicator-sys` 里那个 `Lazy<Library>`），
/// 库不在时它在第一次解引用时直接 panic；而 release 是 `panic = "abort"`，panic 会带走整个进程。
/// 所以建托盘前自己探一次：探不到就当托盘不可用，让关闭退化为"退出"，而不是启动即崩。
#[cfg(target_os = "linux")]
fn appindicator_loadable() -> bool {
    ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        .iter()
        .any(|name| unsafe { libloading::Library::new(name) }.is_ok())
}

/// 建托盘。失败只降级并返回 false，**绝不**让 `setup` 拿到 Err
/// （release 是 `panic = "abort"`，见 `lib.rs` 里 setup 那段说明）。
pub fn install(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    if !appindicator_loadable() {
        log::warn!("系统托盘不可用（缺少 libayatana-appindicator3.so.1）：关闭主窗口将直接退出");
        return false;
    }
    match build(app) {
        Ok(()) => {
            TRAY_OK.store(true, Ordering::SeqCst);
            true
        }
        Err(e) => {
            // GNOME 没装 AppIndicator 扩展就走这里：此时关窗必须是"退出"，
            // 不能把窗口藏进一个用户找不回来的地方。
            log::warn!("系统托盘不可用（{e}）：关闭主窗口将直接退出");
            false
        }
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, MENU_SHOW_LABEL, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, MENU_QUIT_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    #[allow(unused_mut)]
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_ICON)?)
        .tooltip("蒙电信产助手")
        .menu(&menu)
        // Windows 左键留给"显示主窗口"，菜单走右键；macOS 左键本来就是展开菜单。
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_SHOW => show_main(app),
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if click_shows_window(&event) {
                show_main(tray.app_handle());
            }
        });

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    builder.build(app)?;
    Ok(())
}

/// 把主窗口拉回前台。托盘菜单、托盘点击、Dock 点击（Reopen）、二次启动共用这一份。
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        // 先 unminimize 再 show：否则 Windows 上会先亮出一条仍处于最小化状态的标题栏。
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 唯一的退出入口。必须走 `app.exit(0)`：`RunEvent::Exit` 里的 LAN 停止、OCR 释放、
/// 连接加锁、IPC 通道文件摘除都挂在这条路径上，换成 `process::exit` 就是泄漏。
pub fn request_quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    app.exit(0);
}

/// 装配完成后读一次"说明已看过"，之后关闭路径只读内存。
pub fn hydrate(app: &AppHandle) {
    if let Some(core) = app.try_state::<SharedCore>() {
        HINT_SHOWN.store(settings::get_bool(&core.db, HINT_KEY, false), Ordering::SeqCst);
    }
}

pub fn handle_close(window: &Window, api: &CloseRequestApi) {
    let action = decide_close(
        window.label(),
        TRAY_OK.load(Ordering::SeqCst),
        QUITTING.load(Ordering::SeqCst),
        HINT_SHOWN.load(Ordering::SeqCst),
    );
    match action {
        CloseAction::Allow => {}
        CloseAction::Quit => {
            // 托盘建不起来时也要拦：启动时就有一个隐藏的 launcher 窗口活着，
            // 放任默认关闭只会留下一个无界面、无托盘、快捷键还在吃按键的进程。
            api.prevent_close();
            request_quit(window.app_handle());
        }
        CloseAction::Hide => {
            api.prevent_close();
            hide_main(window.app_handle());
        }
        CloseAction::Ask => {
            api.prevent_close();
            ask_once(window.app_handle());
        }
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    // 主窗收进托盘时预览窗不能还浮在桌面上：那里面是刚解密出来的页面正文。
    crate::preview::close(app);
}

fn ask_once(app: &AppHandle) {
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(
            "蒙电信产助手会继续在系统托盘运行，全局快捷键保持可用。\n\n\
             再次打开：点击托盘图标 →「显示主窗口」。\n\
             彻底退出：托盘菜单 →「退出」。",
        )
        .title("关闭窗口后仍在后台运行")
        .kind(MessageDialogKind::Info)
        // 只给一颗「知道了」。双按钮时 Esc 会落到取消上，若取消写着「直接退出」就是误杀。
        .buttons(MessageDialogButtons::OkCustom("知道了".into()))
        .show(move |_| {
            ASKING.store(false, Ordering::SeqCst);
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            HINT_SHOWN.store(true, Ordering::SeqCst);
            // 启动失败页没有 SharedCore：只记内存位，下次启动可能再弹一次，可以接受。
            if let Some(core) = handle.try_state::<SharedCore>() {
                if let Err(e) = settings::set(&core.db, HINT_KEY, "true", "ui") {
                    log::warn!("记录托盘提示已展示失败（{}）", e.code());
                }
            }
            hide_main(&handle);
        });
}

fn click_shows_window(event: &TrayIconEvent) -> bool {
    match event {
        TrayIconEvent::Click { button, button_state, .. } => click_opens_main(
            cfg!(target_os = "macos"),
            *button == MouseButton::Left,
            // `Up` 是"松开"，与 Windows 的 WM_LBUTTONUP 对应（tray-icon 的枚举文档把这两档写反了）。
            *button_state == MouseButtonState::Up,
        ),
        TrayIconEvent::DoubleClick { button, .. } => {
            click_opens_main(cfg!(target_os = "macos"), *button == MouseButton::Left, true)
        }
        _ => false,
    }
}

/// macOS 左键已经是"展开菜单"，那边再恢复窗口就成了一个动作两件事。
fn click_opens_main(macos: bool, left: bool, released: bool) -> bool {
    !macos && left && released
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn only_main_window_close_is_intercepted() {
        assert_eq!(decide_close("launcher", true, false, true), CloseAction::Allow);
        assert_eq!(decide_close("quiztip", true, false, true), CloseAction::Allow);
        assert_eq!(decide_close(MAIN_WINDOW, true, false, true), CloseAction::Hide);
    }

    #[test]
    fn quitting_never_blocks_exit() {
        assert_eq!(decide_close(MAIN_WINDOW, true, true, false), CloseAction::Allow);
        assert_eq!(decide_close(MAIN_WINDOW, true, true, true), CloseAction::Allow);
    }

    /// 托盘建不起来时必须显式退出而不是隐藏：隐藏会留下一个无界面、无托盘的进程。
    #[test]
    fn missing_tray_quits_instead_of_hiding() {
        assert_eq!(decide_close(MAIN_WINDOW, false, false, true), CloseAction::Quit);
        assert_eq!(decide_close(MAIN_WINDOW, false, false, false), CloseAction::Quit);
    }

    #[test]
    fn first_close_asks_then_only_hides() {
        assert_eq!(decide_close(MAIN_WINDOW, true, false, false), CloseAction::Ask);
        assert_eq!(decide_close(MAIN_WINDOW, true, false, true), CloseAction::Hide);
    }

    /// macOS 的左键是展开菜单，Windows/Linux 才是恢复窗口；右键在两端都不该恢复。
    #[test]
    fn click_rule_follows_platform_menu_convention() {
        assert!(!click_opens_main(true, true, true));
        assert!(click_opens_main(false, true, true));
        assert!(!click_opens_main(false, false, true));
        assert!(!click_opens_main(false, true, false));
    }

    #[test]
    fn hint_flag_round_trips_and_is_not_a_factory_default() {
        let db = Db::open_in_memory(&vec![51u8; 32]).unwrap();
        assert!(!settings::get_bool(&db, HINT_KEY, false));
        settings::set(&db, HINT_KEY, "true", "ui").unwrap();
        assert!(settings::get_bool(&db, HINT_KEY, false));
        // 进了 DEFAULT_SETTINGS 就会被 factory_defaults_match_migration_sql 要求同步进迁移 SQL，
        // 而这枚键是运行时才写的，本来就不该有出厂值。
        assert!(!crate::DEFAULT_SETTINGS.iter().any(|(key, _)| *key == HINT_KEY));
    }

    /// 图标是被 include_bytes! 编进来的字节，编错/替换成带底板的旧图只有这里能发现。
    #[test]
    fn tray_icon_assets_are_the_expected_pngs() {
        const PNG_SIGNATURE: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        const CASES: [(&[u8], u32); 3] = [
            (include_bytes!("../icons/tray/tray-template.png"), 22),
            (include_bytes!("../icons/tray/tray-template@2x.png"), 44),
            (include_bytes!("../icons/tray/tray.png"), 32),
        ];
        for (bytes, size) in CASES {
            assert_eq!(&bytes[..8], PNG_SIGNATURE);
            let image = Image::from_bytes(bytes).expect("托盘图标必须是可解码的 PNG");
            assert_eq!((image.width(), image.height()), (size, size));
        }

        // 模板图必须是纯黑 + alpha：带上任何彩色底板，macOS 菜单栏都会变成一块实心方块。
        let template = Image::from_bytes(include_bytes!("../icons/tray/tray-template@2x.png")).unwrap();
        for pixel in template.rgba().chunks(4) {
            if pixel[3] > 0 {
                assert_eq!(&pixel[..3], &[0, 0, 0]);
            }
        }
    }
}
