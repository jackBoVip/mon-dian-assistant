//! 页面库命令：列表、详情、增删改，以及两条预览入口。
//!
//! 审计只记新建/修改/删除，且只记行 id：标题与 HTML 正文都不进台账。
//! 读取与预览不审计——预览每刷新一次就要读一遍正文，写进台账会把它自己淹掉。

use super::{audit, Result};
use crate::html_pages::store::{self, PageRecord, PageSummary};
use crate::preview;
use crate::rbac::{self, perm};
use crate::state::SharedCore;

fn guard(permission: &str) -> Result<(SharedCore, String)> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, permission)?;
    Ok((core, user))
}

#[tauri::command]
pub fn html_page_list() -> Result<Vec<PageSummary>> {
    let (core, _) = guard(perm::HTML_PAGE_READ)?;
    store::list(&core.db)
}

#[tauri::command]
pub fn html_page_get(id: String) -> Result<PageRecord> {
    let (core, _) = guard(perm::HTML_PAGE_READ)?;
    store::get(&core.db, &id)
}

#[tauri::command]
pub fn html_page_create(title: String, html: String) -> Result<PageRecord> {
    let (core, user) = guard(perm::HTML_PAGE_CREATE)?;
    let row = store::create(&core.db, &user, &title, &html)?;
    audit(&core, Some(&user), "html.page.create", Some("html_page"), Some(&row.id), true, None, "app");
    Ok(row)
}

#[tauri::command]
pub fn html_page_update(id: String, title: String, html: String) -> Result<PageRecord> {
    let (core, user) = guard(perm::HTML_PAGE_UPDATE)?;
    let row = store::update(&core.db, &user, &id, &title, &html)?;
    audit(&core, Some(&user), "html.page.update", Some("html_page"), Some(&row.id), true, None, "app");
    Ok(row)
}

#[tauri::command]
pub fn html_page_delete(app: tauri::AppHandle, id: String) -> Result<()> {
    let (core, user) = guard(perm::HTML_PAGE_DELETE)?;
    store::delete(&core.db, &id)?;
    // 窗口里正显示这一页就先关掉：留着它等于挂着一份已经删除的明文。
    preview::close_if_showing(&app, &id);
    audit(&core, Some(&user), "html.page.delete", Some("html_page"), Some(&id), true, None, "app");
    Ok(())
}

/// 右栏嵌入块的地址。它每次加载都会经过回环服务的会话与权限校验，所以这里拿到地址不等于拿到内容。
#[tauri::command]
pub fn html_page_preview_url(id: String) -> Result<String> {
    let (core, _) = guard(perm::HTML_PAGE_READ)?;
    // 先确认页面真的存在，免得给出一个必然 404 的地址
    store::get(&core.db, &id)?;
    preview::url_for(&id)
}

/// 右栏的嵌入块：「同一份内容、就摆在列表右边」。
///
/// 必须是 async：`Window::add_child` 在 Windows 上从同步命令里调用会死锁（Tauri 文档明写）。
/// 位置与尺寸由前端按占位块量出来传进来，原生层不猜布局。
/// `version` 用来区分「同一页的新内容」与「同一页原样重放」：后者只摆位置不导航。
#[tauri::command]
pub async fn html_page_embed_open(
    app: tauri::AppHandle,
    id: String,
    version: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    let (core, _) = guard(perm::HTML_PAGE_READ)?;
    store::get(&core.db, &id)?;
    let url = preview::url_for(&id)?;
    preview::embed::open(
        &app,
        &id,
        &version,
        &url,
        preview::embed::Rect { x, y, width, height },
    )
}

/// 跟随布局：窗口缩放、侧栏变化时只挪位置，不重新导航。
#[tauri::command]
pub fn html_page_embed_sync(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) {
    preview::embed::sync(&app, preview::embed::Rect { x, y, width, height });
}

/// 弹窗打开时收起、关闭时放回：原生层盖在网页上方，弹窗遮不住它。
#[tauri::command]
pub fn html_page_embed_visible(app: tauri::AppHandle, visible: bool) {
    preview::embed::set_visible(&app, visible);
}

#[tauri::command]
pub fn html_page_embed_close(app: tauri::AppHandle) {
    preview::embed::close(&app);
}

/// 「运行脚本」：把同一页开到独立窗口里（同样没有 capability，拿不到本应用任何命令）。
#[tauri::command]
pub fn html_page_preview_open(app: tauri::AppHandle, id: String) -> Result<()> {
    let (core, _) = guard(perm::HTML_PAGE_READ)?;
    let page = store::get(&core.db, &id)?;
    preview::open(&app, &id, &page.title)
}
