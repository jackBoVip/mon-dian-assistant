//! 笔记命令：列表、详情、增删改、图片素材、导入导出。
//!
//! 自动保存每 700 ms 就可能发一次 `notes_update`，所以它**不写审计**——
//! 否则 audit_events 会被自己的保存动作淹掉。审计只记新建/删除/导入/导出，
//! 且只记笔记 id，正文一律不进。

use std::path::PathBuf;

use base64::Engine as _;

use super::{audit, Result};
use crate::error::AppError;
use crate::notes::export;
use crate::notes::store::{self, NoteAssetDto, NoteDetail, NoteRecord, NoteSummary};
use crate::rbac::{self, perm};
use crate::state::SharedCore;

fn guard(permission: &str) -> Result<(SharedCore, String)> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, permission)?;
    Ok((core, user))
}

#[tauri::command]
pub fn notes_list(q: Option<String>) -> Result<Vec<NoteSummary>> {
    let (core, user) = guard(perm::NOTES_READ)?;
    store::list(&core.db, &user, q.as_deref())
}

#[tauri::command]
pub fn notes_get(id: String) -> Result<NoteDetail> {
    let (core, user) = guard(perm::NOTES_READ)?;
    store::get(&core.db, &user, &id)
}

#[tauri::command]
pub fn notes_create() -> Result<NoteDetail> {
    let (core, user) = guard(perm::NOTES_WRITE)?;
    let detail = store::create(&core.db, &user)?;
    audit(&core, Some(&user), "notes.create", Some("note"), Some(&detail.note.id), true, None, "app");
    Ok(detail)
}

#[tauri::command]
pub fn notes_update(id: String, title: String, html: String) -> Result<NoteRecord> {
    let (core, user) = guard(perm::NOTES_WRITE)?;
    store::update(&core.db, &user, &id, &title, &html)
}

#[tauri::command]
pub fn notes_delete(id: String) -> Result<()> {
    let (core, user) = guard(perm::NOTES_WRITE)?;
    store::delete(&core.db, &user, &id)?;
    audit(&core, Some(&user), "notes.delete", Some("note"), Some(&id), true, None, "app");
    Ok(())
}

/// 插入图片（文件对话框）：类型按魔数认，调用方传的扩展名不作数。
#[tauri::command]
pub fn note_upload_asset_from_path(note_id: String, path: String) -> Result<NoteAssetDto> {
    let (core, user) = guard(perm::NOTES_WRITE)?;
    let bytes = export::read_asset_file(&PathBuf::from(&path))?;
    store::add_asset(&core.db, &user, &note_id, &bytes)
}

/// 粘贴图片：剪贴板给的是 base64，可能是裸串也可能是 data URL，两种都收。
#[tauri::command]
pub fn note_upload_asset_bytes(note_id: String, data_b64: String) -> Result<NoteAssetDto> {
    let (core, user) = guard(perm::NOTES_WRITE)?;
    let payload = match data_b64.split_once("base64,") {
        Some((_, rest)) => rest,
        None => data_b64.as_str(),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|_| AppError::FileFormatInvalid)?;
    store::add_asset(&core.db, &user, &note_id, &bytes)
}

/// 导入 .md / .txt 的文本通道。解析与插入图片在界面的无头编辑器里做，
/// 这里只负责读文件——路径来自原生对话框，不是前端随手拼的字符串。
#[tauri::command]
pub fn notes_read_text_file(path: String) -> Result<String> {
    let (_core, _user) = guard(perm::NOTES_WRITE)?;
    export::read_text_file(&PathBuf::from(&path))
}

#[tauri::command]
pub fn notes_export_markdown(path: String, markdown: String) -> Result<()> {
    let (core, user) = guard(perm::NOTES_READ)?;
    export::write_markdown(&PathBuf::from(&path), &markdown)?;
    audit(&core, Some(&user), "notes.export", Some("note"), None, true, None, "app");
    Ok(())
}

/// 全部笔记打包成 zip。只导当前使用者自己的：换账号看不到别人的笔记，
/// 导出也不该破这条隔离。
#[tauri::command]
pub fn notes_export_zip(path: String) -> Result<()> {
    let (core, user) = guard(perm::NOTES_READ)?;
    export::export_zip(&core.db, &user, &PathBuf::from(&path))?;
    audit(&core, Some(&user), "notes.export.zip", Some("note"), None, true, None, "app");
    Ok(())
}

#[tauri::command]
pub fn notes_import_zip(path: String) -> Result<NoteImportSummary> {
    let (core, user) = guard(perm::NOTES_WRITE)?;
    let (notes, assets) = export::import_zip(&core.db, &user, &PathBuf::from(&path))?;
    audit(&core, Some(&user), "notes.import.zip", Some("note"), None, true, None, "app");
    Ok(NoteImportSummary { notes, assets })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteImportSummary {
    pub notes: usize,
    pub assets: usize,
}
