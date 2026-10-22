//! 秘密文件的写入收口。
//!
//! 审查 F12 的原因：原先六处（通道令牌、设备密钥、备份文件与元数据、报告文件、宿主清单）
//! 都是同一个形状——
//!
//! ```text
//! std::fs::write(path, bytes)?;                       // 权限取决于 umask，常见就是 0644
//! let _ = std::fs::set_permissions(path, 0o600);      // 收紧失败被静默吞掉
//! ```
//!
//! 这里有两个问题：
//! 1. **写入与收紧之间有一个窗口**：同机其他进程（或另一个用户，取决于目录权限）在这段
//!    时间里读到的设备密钥文件可能是全局可读的。
//! 2. **收紧失败没人知道**：`let _ =` 让"密钥文件全局可读"这件事不留任何痕迹，
//!    而界面上照样显示"已封装在 0600 文件中"。
//!
//! 现在的做法：`open2` 的 mode 参数就带 0600（`mode` 会被 umask 相与，只会更少不会更多，
//! 所以创建那一刻起就不可能比 0600 更宽），写完再显式 chmod 一次并**回读校验**。
//! 校验只在"确实多出了组/其他位"时失败——比 0600 更严（比如 0400）不算问题，
//! 免得在某些文件系统上把首次运行误伤成不可用。
//!
//! 非 Unix 平台没有 POSIX 权限位：如实记一行日志，保护依赖 NTFS ACL / 卷权限，
//! 不假装这里做了它做不到的事。

use crate::error::{AppError, Result};
use std::io::Write;
use std::path::Path;

/// 写一个必须是私有权限的秘密文件。失败返回错误，绝不静默。
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| AppError::internal(&format!("秘密文件创建 {}", path.display()), &e))?;
            f.write_all(bytes)
                .map_err(|e| AppError::internal(&format!("秘密文件写入 {}", path.display()), &e))?;
            f.flush()
                .map_err(|e| AppError::internal(&format!("秘密文件落盘 {}", path.display()), &e))?;
        }
        // 再 chmod 一次：覆盖"文件本来已存在且权限更宽"的情况（open 的 mode 只在创建时生效）。
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| AppError::internal(&format!("秘密文件权限收紧 {}", path.display()), &e))?;
        let mode = std::fs::metadata(path)
            .map_err(|e| AppError::internal(&format!("秘密文件权限回读 {}", path.display()), &e))?
            .permissions()
            .mode()
            & 0o777;
        if mode & 0o077 != 0 {
            // 只有"多出组/其他位"才失败：比 0600 更严（0400 等）放过，别在某些挂载选项下误伤首启。
            log::error!("秘密文件 {} 的权限是 {mode:#o}，组或其他用户可读", path.display());
            return Err(AppError::internal(
                &format!("秘密文件 {} 权限未收紧到 0600（实际 {mode:#o}）", path.display()),
                &"permissive mode bits",
            ));
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).map_err(|e| AppError::internal(&format!("秘密文件写入 {}", path.display()), &e))?;
        log::debug!(
            "非 Unix 平台不设置 POSIX 权限位：{} 的保护依赖 NTFS ACL / 卷权限",
            path.display()
        );
    }
    Ok(())
}

/// 非秘密但**状态有意义**的小文件（存放标记、同意记录）：失败不阻断流程，但必须留痕。
/// 原先这些点是 `let _ = std::fs::write(...)`，写失败时界面仍然按"成功"那一侧显示。
pub fn write_state_flag(dir: &Path, name: &str, bytes: &[u8]) {
    let path = dir.join(name);
    match std::fs::write(&path, bytes) {
        Ok(()) => {}
        Err(e) => log::warn!("状态标记 {name} 写入失败（{}）：{e}", path.display()),
    }
}
