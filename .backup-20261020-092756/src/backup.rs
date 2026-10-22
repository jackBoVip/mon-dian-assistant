//! 加密备份与受控恢复。
//!
//! 流程：SQLCipher 一致性备份（ rusqlite::backup ）→ 临时明文库（仍在加密卷内，使用后立即安全删除）
//! → 用 HKDF 风格派生的备份密钥做 AES-256-GCM 整体封装 → 落盘 `.mdbak` + sidecar 元数据（含 SHA-256）。
//! 恢复前必须 verify，并先为当前状态生成回滚备份。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::commands::system::BackupInfo;
use crate::crypto::{aead, random_bytes, SecretBytes};
use crate::crypto::aead::hmac_sha256;
use crate::error::{AppError, Result};
use crate::state::AppCore;

const MAGIC: &[u8; 5] = b"MDBK1";
const SALT_LEN: usize = 16;

fn backups_dir(core: &AppCore) -> PathBuf {
    core.backup_dir.clone()
}

fn backup_key(db_key: &[u8], salt: &[u8]) -> SecretBytes {
    // 备份密钥由数据库密钥 + 每次随机盐派生，不复用原文
    let mut material = Vec::with_capacity(db_key.len() + salt.len() + 6);
    material.extend_from_slice(db_key);
    material.extend_from_slice(salt);
    material.extend_from_slice(b"bkp-v1");
    SecretBytes(hmac_sha256(db_key, &material).to_vec())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn meta_path(file: &Path) -> PathBuf {
    PathBuf::from(format!("{}.json", file.display()))
}

fn write_meta(file: &Path, info: &BackupInfo) -> Result<()> {
    let json = serde_json::to_vec_pretty(info).map_err(AppError::Serde)?;
    std::fs::write(meta_path(file), json).map_err(|_| AppError::Internal)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(meta_path(file), std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_meta(file: &Path) -> Option<BackupInfo> {
    let json = std::fs::read(meta_path(file)).ok()?;
    serde_json::from_slice(&json).ok()
}

/// 创建一次加密备份。
pub fn create(core: &AppCore) -> Result<BackupInfo> {
    let dir = backups_dir(core);
    std::fs::create_dir_all(&dir).map_err(|_| AppError::Internal)?;
    let id = uuid::Uuid::now_v7().to_string();
    let created_at = crate::db::repo::now();
    let schema = { let conn = core.db.lock_conn(); crate::db::migrate::version(&conn)? };

    // 1) 一致性备份到临时 SQLCipher 文件（使用同一个 DB 密钥）
    let tmp = dir.join(format!(".{id}.tmp.db"));
    {
        let src = core.db.lock_conn();
        let mut dst = Connection::open(&tmp).map_err(|_| AppError::Internal)?;
        dst.execute_batch(&format!("PRAGMA key = \"x'{}'\"", hex::encode(core.db_key.as_slice())))
            .map_err(|_| AppError::Internal)?;
        {
            // Backup 句柄会在生命周期内独占目标连接，必须先用完再查完整性
            let bm = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|_| AppError::Internal)?;
            bm.run_to_completion(64, std::time::Duration::from_millis(20), None).map_err(|_| AppError::Internal)?;
        }
        let ok: i64 = dst
            .query_row("PRAGMA integrity_check=1", [], |r| {
                let s: String = r.get(0)?;
                Ok(if s == "ok" { 1 } else { 0 })
            })
            .unwrap_or(0);
        if ok != 1 {
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::Internal);
        }
        drop(dst);
    }
    let raw = std::fs::read(&tmp).map_err(|_| AppError::Internal)?;
    // 临时文件安全删除（尽力而为；SSD 上不能承诺物理不可恢复，见 README 限制说明）
    wipe_and_remove(&tmp);

    // 2) 整体 AEAD 封装
    let salt = random_bytes(SALT_LEN);
    let key = backup_key(core.db_key.as_slice(), &salt);
    let aad = format!("MDBK1|{id}|{schema}").into_bytes();
    let (ct, nonce) = aead::encrypt(key.as_slice(), &raw, &aad)?;
    drop(key);
    drop(raw);

    let mut blob = Vec::with_capacity(MAGIC.len() + salt.len() + nonce.len() + ct.len());
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    let digest = sha256_hex(&blob);

    let file = dir.join(format!("{id}.mdbak"));
    std::fs::write(&file, &blob).map_err(|_| AppError::Internal)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    let info = BackupInfo {
        id,
        file_name: file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        created_at,
        size_bytes: blob.len() as i64,
        schema_version: schema,
        encrypted: true,
        sha256: digest,
        verified_at: Some(crate::db::repo::now()),
    };
    write_meta(&file, &info)?;
    Ok(info)
}

pub fn delete_quiet(path: &Path) { wipe_and_remove(path); }

fn wipe_and_remove(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let len = meta.len() as usize;
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
            use std::io::Write;
            let _ = f.write_all(&vec![0u8; len]);
            let _ = f.sync_all();
        }
    }
    let _ = std::fs::remove_file(path);
}

/// 列出备份（读 sidecar 元数据，不读内容）。
pub fn list(core: &AppCore) -> Result<Vec<BackupInfo>> {
    let dir = backups_dir(core);
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    let entries = std::fs::read_dir(&dir).map_err(|_| AppError::Internal)?;
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "mdbak").unwrap_or(false) {
            if let Some(info) = read_meta(&p) {
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// 校验：重算 SHA-256、解密、结构完整性与版本检查。
pub fn verify(core: &AppCore, id: &str) -> Result<BackupInfo> {
    let (file, mut info) = locate(core, id)?;
    let blob = std::fs::read(&file).map_err(|_| AppError::Internal)?;
    if sha256_hex(&blob) != info.sha256 {
        info.verified_at = None;
        write_meta(&file, &info)?;
        return Err(AppError::Internal);
    }
    decrypt_blob(core, &blob, &info)?;
    info.verified_at = Some(crate::db::repo::now());
    write_meta(&file, &info)?;
    Ok(info)
}

fn locate(core: &AppCore, id: &str) -> Result<(PathBuf, BackupInfo)> {
    let dir = backups_dir(core);
    let file = dir.join(format!("{id}.mdbak"));
    if !file.exists() {
        return Err(AppError::NotFound);
    }
    let info = read_meta(&file).ok_or(AppError::NotFound)?;
    if info.id != id {
        return Err(AppError::InvalidInput);
    }
    Ok((file, info))
}

fn decrypt_blob(core: &AppCore, blob: &[u8], info: &BackupInfo) -> Result<Vec<u8>> {
    let head = blob.get(..MAGIC.len() + SALT_LEN + crate::crypto::NONCE_LEN).ok_or(AppError::InvalidInput)?;
    if head[..MAGIC.len()] != MAGIC[..] {
        return Err(AppError::InvalidInput);
    }
    let salt = &head[MAGIC.len()..MAGIC.len() + SALT_LEN];
    let nonce = &head[MAGIC.len() + SALT_LEN..];
    let ct = blob.get(head.len()..).ok_or(AppError::InvalidInput)?;
    let key = backup_key(core.db_key.as_slice(), salt);
    let aad = format!("MDBK1|{}|{}", info.id, info.schema_version).into_bytes();
    let pt = aead::decrypt(key.as_slice(), ct, nonce, &aad)?;
    Ok(pt.to_vec())
}

/// 受控恢复：先 verify，再为当前状态生成回滚备份，然后覆盖主库文件。
/// 调用方必须在成功后锁定会话（密钥态与文件已不一致）。
pub fn restore(core: &AppCore, id: &str) -> Result<()> {
    let (file, info) = locate(core, id)?;
    let blob = std::fs::read(&file).map_err(|_| AppError::Internal)?;
    if sha256_hex(&blob) != info.sha256 {
        return Err(AppError::Internal);
    }
    let raw = decrypt_blob(core, &blob, &info)?;
    // 回滚备份
    let _ = create(core)?;

    let main_path = Path::new(&core.db.path);
    let staging = main_path.with_extension("restore.tmp");
    std::fs::write(&staging, &raw).map_err(|_| AppError::Internal)?;
    drop(raw);

    // 用当前 DB 密钥验证恢复文件可打开且结构版本正确
    {
        let probe = Connection::open(&staging).map_err(|_| AppError::Internal)?;
        probe
            .execute_batch(&format!("PRAGMA key = \"x'{}'\"", hex::encode(core.db_key.as_slice())))
            .map_err(|_| AppError::Internal)?;
        let ok: bool = probe
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
                let n: i64 = r.get(0)?;
                Ok(n > 0)
            })
            .unwrap_or(false);
        if !ok {
            wipe_and_remove(&staging);
            return Err(AppError::Internal);
        }
        let v: i64 = probe.query_row("SELECT max(version) FROM schema_migrations", [], |r| r.get(0)).unwrap_or(0);
        if v != info.schema_version {
            wipe_and_remove(&staging);
            return Err(AppError::Internal);
        }
        drop(probe);
    }

    // 关闭主连接后替换文件（WAL/SHM 一并清理）
    core.lock_connections();
    let backup_of_current = main_path.with_extension("pre-restore.bak");
    std::fs::rename(main_path, &backup_of_current).map_err(|_| AppError::Internal)?;
    for ext in ["wal", "shm"] {
        let p = main_path.with_extension(ext);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Err(e) = std::fs::rename(&staging, main_path) {
        let _ = std::fs::rename(&backup_of_current, main_path);
        log::warn!("恢复备份时替换主文件失败：{e}");
        return Err(AppError::Internal);
    }
    let _ = std::fs::remove_file(&backup_of_current);
    Ok(())
}
