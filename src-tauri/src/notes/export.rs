//! 笔记的文件出入口：单篇 Markdown、整库 zip 备份与导入。
//!
//! 出站一律走 `secfile::write_private`（0600），路径只来自原生文件对话框；
//! 入站先按配额把字节读进来再落库，zip 炸弹与超大文件在解析前就被挡住。
//!
//! zip 结构（自己写、自己读，不做第三方格式兼容）：
//! ```text
//! notes.json        { version, exportedAt, notes: [{ id, title, contentHtml, createdAt, updatedAt,
//!                     assets: [{ id, mime }] }] }
//! assets/<id>       素材原始字节（png/jpeg/gif/webp，按魔数重认，不采信清单里的 mime）
//! ```

use std::io::{Cursor, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::repo::now;
use crate::db::Db;
use crate::error::{AppError, Result};
use crate::notes::store::{self, ImportNote, ASSET_MAX_BYTES, HTML_MAX_BYTES};
use crate::secfile;

const MAX_ZIP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_NOTES: usize = 2_000;
const MANIFEST: &str = "notes.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipAsset {
    id: String,
    mime: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipNote {
    id: String,
    title: String,
    content_html: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    assets: Vec<ZipAsset>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZipManifest {
    version: u32,
    exported_at: String,
    notes: Vec<ZipNote>,
}

fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(|e| {
        AppError::internal(&format!("读取笔记文件 {}", path.display()), &e)
    })?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput);
    }
    if meta.len() > max {
        return Err(AppError::NoteTooLarge);
    }
    std::fs::read(path).map_err(|e| AppError::internal(&format!("读取笔记文件 {}", path.display()), &e))
}

/// 导出当前使用者的全部笔记。返回（笔记数, 素材数）。
pub fn export_zip(db: &Db, user: &str, path: &Path) -> Result<(usize, usize)> {
    let notes = store::all_for_export(db, user)?;
    let mut manifest = ZipManifest { version: 1, exported_at: now(), notes: Vec::new() };
    let mut total_bytes: u64 = 0;

    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // 图片本身已经压过，再 deflate 一遍只费 CPU。
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));

    for note in &notes {
        manifest.notes.push(ZipNote {
            id: note.record.id.clone(),
            title: note.record.title.clone(),
            content_html: note.record.content_html.clone(),
            created_at: note.record.created_at.clone(),
            updated_at: note.record.updated_at.clone(),
            assets: note
                .assets
                .iter()
                .map(|(id, mime, _)| ZipAsset { id: id.clone(), mime: mime.clone() })
                .collect(),
        });
    }
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    zw.start_file(MANIFEST, deflated).map_err(|e| AppError::internal("笔记导出打包", &e))?;
    zw.write_all(&manifest_bytes)
        .map_err(|e| AppError::internal("笔记导出打包", &e))?;

    let mut asset_count = 0usize;
    for note in &notes {
        for (id, _mime, bytes) in &note.assets {
            total_bytes += bytes.len() as u64;
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(AppError::NoteTooLarge);
            }
            zw.start_file(format!("assets/{id}"), stored)
                .map_err(|e| AppError::internal("笔记导出打包", &e))?;
            zw.write_all(bytes).map_err(|e| AppError::internal("笔记导出打包", &e))?;
            asset_count += 1;
        }
    }

    let cursor = zw.finish().map_err(|e| AppError::internal("笔记导出打包", &e))?;
    secfile::write_private(path, &cursor.into_inner())?;
    Ok((notes.len(), asset_count))
}

fn timestamp_or(raw: &str, fallback: &str) -> String {
    if chrono::DateTime::parse_from_rfc3339(raw.trim()).is_ok() {
        raw.trim().to_string()
    } else {
        fallback.to_string()
    }
}

/// 导入自己导出的 zip。全部笔记与素材换新 id，正文里的素材引用同步改写。
pub fn import_zip(db: &Db, user: &str, path: &Path) -> Result<(usize, usize)> {
    let bytes = read_bounded(path, MAX_ZIP_BYTES)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|_| AppError::FileFormatInvalid)?;
    if archive.len() > MAX_ENTRIES {
        return Err(AppError::FileFormatInvalid);
    }

    let manifest_raw = {
        let mut entry = archive.by_name(MANIFEST).map_err(|_| AppError::FileFormatInvalid)?;
        if entry.size() > MAX_MANIFEST_BYTES {
            return Err(AppError::NoteTooLarge);
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| AppError::internal("笔记导入读取", &e))?;
        buf
    };
    let manifest: ZipManifest =
        serde_json::from_slice(&manifest_raw).map_err(|_| AppError::FileFormatInvalid)?;
    if manifest.notes.len() > MAX_NOTES {
        return Err(AppError::FileFormatInvalid);
    }

    let ts = now();
    let mut imported = Vec::with_capacity(manifest.notes.len());
    let mut total_bytes: u64 = 0;

    for note in manifest.notes {
        let note_id = store::new_id();
        let mut assets = Vec::with_capacity(note.assets.len());
        let mut renames: Vec<(String, String)> = Vec::with_capacity(note.assets.len());
        for asset in &note.assets {
            let mut entry = archive
                .by_name(&format!("assets/{}", asset.id))
                .map_err(|_| AppError::FileFormatInvalid)?;
            if entry.size() > ASSET_MAX_BYTES as u64 {
                return Err(AppError::NoteTooLarge);
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| AppError::internal("笔记导入读取", &e))?;
            total_bytes += data.len() as u64;
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(AppError::NoteTooLarge);
            }
            let mime = store::sniff_image_mime(&data).ok_or(AppError::NoteAssetUnsupported)?;
            let new_asset_id = store::new_id();
            renames.push((asset.id.clone(), new_asset_id.clone()));
            assets.push((new_asset_id, mime.to_string(), data));
        }

        let mut html = store::sanitize_html(&note.content_html);
        for (old, new) in &renames {
            html = html.replace(
                &format!("data-mda-asset=\"{old}\""),
                &format!("data-mda-asset=\"{new}\""),
            );
        }
        if html.len() > HTML_MAX_BYTES {
            return Err(AppError::NoteTooLarge);
        }

        imported.push(ImportNote {
            id: note_id,
            title: store::sanitize_title(&note.title),
            content_html: html,
            created_at: timestamp_or(&note.created_at, &ts),
            updated_at: timestamp_or(&note.updated_at, &ts),
            assets,
        });
    }

    store::insert_imported(db, user, &imported)
}

/// 单篇 Markdown 落盘。路径来自保存对话框，写入与权限一并由 secfile 收口。
pub fn write_markdown(path: &Path, markdown: &str) -> Result<()> {
    if markdown.len() > HTML_MAX_BYTES {
        return Err(AppError::NoteTooLarge);
    }
    secfile::write_private(path, markdown.as_bytes())
}

/// 从对话框选中的路径读一张图片；大小先按元数据卡住，不把超大文件读进内存。
pub fn read_asset_file(path: &Path) -> Result<Vec<u8>> {
    let bytes = read_bounded(path, ASSET_MAX_BYTES as u64)?;
    if bytes.is_empty() {
        return Err(AppError::FileFormatInvalid);
    }
    Ok(bytes)
}

/// 导入用：读取 .md / .txt 文本。UTF-8 解不开时按 GB18030 兜底，
/// 中文 Windows 导出的小本子多半是这一档。
pub fn read_text_file(path: &Path) -> Result<String> {    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt") {
        return Err(AppError::FileFormatInvalid);
    }
    let bytes = read_bounded(path, HTML_MAX_BYTES as u64)?;
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        return Ok(text.trim_start_matches('\u{feff}').to_string());
    }
    let (text, _, _) = encoding_rs::GB18030.decode(&bytes);
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory(&vec![11u8; 32]).unwrap()
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    #[test]
    fn zip_round_trip_preserves_notes_and_rewrites_asset_ids() {
        let source = db();
        let note = store::create(&source, "u1").unwrap();
        let asset = store::add_asset(&source, "u1", &note.note.id, PNG).unwrap();
        let html = format!("<h1>标题</h1><p>正文</p><img data-mda-asset=\"{}\">", asset.id);
        store::update(&source, "u1", &note.note.id, "巡检记录", &html).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("notes.zip");
        assert_eq!(export_zip(&source, "u1", &zip_path).unwrap(), (1, 1));

        let target = db();
        assert_eq!(import_zip(&target, "u2", &zip_path).unwrap(), (1, 1));

        let list = store::list(&target, "u2", None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "巡检记录");

        let detail = store::get(&target, "u2", &list[0].id).unwrap();
        assert_eq!(detail.assets.len(), 1, "素材必须跟着笔记一起进来");
        let new_asset_id = &detail.assets[0].id;
        assert_ne!(new_asset_id, &asset.id, "导入要换新 id，避免撞上本机已有素材");
        assert!(detail.note.content_html.contains(&format!("data-mda-asset=\"{new_asset_id}\"")));
        assert!(!detail.note.content_html.contains(&asset.id));
        assert!(detail.assets[0].data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn zip_export_is_scoped_to_one_user() {
        let db = db();
        store::create(&db, "u1").unwrap();
        store::create(&db, "u2").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("notes.zip");
        assert_eq!(export_zip(&db, "u1", &zip_path).unwrap().0, 1);
    }

    #[test]
    fn importing_a_non_zip_is_rejected_without_touching_the_db() {
        let db = db();
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("notes.zip");
        std::fs::write(&bogus, b"definitely not a zip").unwrap();
        assert!(matches!(import_zip(&db, "u1", &bogus), Err(AppError::FileFormatInvalid)));
        assert!(store::list(&db, "u1", None).unwrap().is_empty());
    }

    #[test]
    fn text_file_import_accepts_md_and_txt_only() {
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("a.md");
        std::fs::write(&md, "\u{feff}# 标题\n正文").unwrap();
        assert_eq!(read_text_file(&md).unwrap(), "# 标题\n正文");

        let gbk = dir.path().join("b.txt");
        std::fs::write(&gbk, encoding_rs::GB18030.encode("中文字符").0.as_ref()).unwrap();
        assert_eq!(read_text_file(&gbk).unwrap(), "中文字符");

        let exe = dir.path().join("c.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert!(matches!(read_text_file(&exe), Err(AppError::FileFormatInvalid)));
    }

    #[test]
    fn markdown_export_writes_the_file_at_the_chosen_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write_markdown(&path, "# 标题\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# 标题\n");
    }
}
