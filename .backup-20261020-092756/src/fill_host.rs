//! Native Messaging 宿主清单（manifest）的生成与安装。
//!
//! 边界说明（必须如实呈现给使用者）：
//! - 浏览器厂商要求 manifest 中的 `allowed_origins` 精确到扩展 ID。本应用不内置任何默认扩展 ID，
//!   也绝不伪造一个"看起来能用"的 ID：未配置时清单不会被写入浏览器目录，状态返回未安装。
//! - Windows 上 Chrome/Edge 通过注册表定位 manifest。本应用只写用户目录下的清单文件，
//!   并在状态里给出需要由使用者自行导入的注册表键值；未经确认不改动注册表。
//! - 宿主二进制必须与主程序一同分发；找不到二进制时同样返回未就绪。

use std::path::PathBuf;

use crate::error::{AppError, Result};
use crate::settings;
use crate::state::AppCore;

pub const HOST_NAME: &str = "com.mda.fillhost";
pub const PROTOCOL: &str = "mda-fill/1";

/// 应用自己管理的清单文件（始终生成，供用户核对或手动引用）。
pub fn manifest_install_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("native-host").join(format!("{HOST_NAME}.json")))
}

fn app_data_dir() -> Option<PathBuf> {
    std::env::var_os("MDA_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(target_os = "macos")]
            {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/com.mda.assistant"))
            }
            #[cfg(target_os = "windows")]
            {
                std::env::var_os("APPDATA").map(|h| PathBuf::from(h).join("com.mda.assistant"))
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
                    .map(|d| d.join("com.mda.assistant"))
            }
        })
}

/// 宿主二进制：优先与主程序同目录（打包后），其次 cargo 目标目录（开发时）。
pub fn host_binary_path() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") { "mda_fill_host.exe" } else { "mda_fill_host" };
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join(exe_name),
        exe_dir.join("deps").join(exe_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/release").join(exe_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug").join(exe_name),
    ];
    if let Some(p) = candidates.iter().find(|p| p.is_file()) {
        return Some(p.clone());
    }
    // 打包时宿主作为 sidecar 嵌入，文件名带目标三元组（如 mda_fill_host-aarch64-apple-darwin），
    // 与主程序同目录。三元组不写死在代码里，改为在同目录里按前缀查找。
    let names = std::fs::read_dir(&exe_dir).ok()?.flatten().map(|e| e.path()).collect::<Vec<_>>();
    names.into_iter().find(|p| {
        let Some(stem) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else { return false };
        let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
        stem.starts_with("mda_fill_host-") && stem.ends_with(suffix) && p.is_file()
    })
}

/// 各浏览器在当前的 NativeMessagingHosts 目录（Windows 返回 None，走注册表）。
pub fn browser_manifest_dirs() -> Vec<(&'static str, PathBuf)> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        out.push(("Chrome", home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")));
        out.push(("Edge", home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts")));
        out.push(("Chromium", home.join("Library/Application Support/Chromium/NativeMessagingHosts")));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
        for (label, dir) in [("Chrome", "google-chrome"), ("Edge", "microsoft-edge"), ("Chromium", "chromium")] {
            out.push((label, base.join(dir).join("NativeMessagingHosts")));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        // 见 manifest_status()：Windows 需要注册表键指向清单文件，本应用不自动写注册表。
    }
    out
}

pub fn registry_hint() -> Option<&'static str> {
    cfg!(target_os = "windows").then(|| "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mda.fillhost")
}

/// 供系统管理页展示的就绪状态。所有 false 都带原因，不粉饰。
pub fn manifest_json(extension_id: &str, host_path: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "name": HOST_NAME,
        "description": "蒙电信产助手 一次性凭据填充宿主",
        "path": host_path.display().to_string(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")],
    })
}

/// 写入应用自管清单；返回 (路径, 原因)。未配置扩展 ID 或找不到二进制时不写。
pub fn prepare(core: &AppCore) -> std::result::Result<serde_json::Value, (String, String)> {
    let extension_id = settings::get(&core.db, "extension_id")
        .map_err(|_| ("INTERNAL".to_string(), "设置读取失败".to_string()))?
        .unwrap_or_default();
    if extension_id.trim().is_empty() {
        return Err(("EXTENSION_ID_REQUIRED".into(), "尚未配置浏览器扩展 ID：清单无法生成，因为 allowed_origins 必须精确到扩展 ID".into()));
    }
    if !is_valid_extension_id(extension_id.trim()) {
        return Err(("EXTENSION_ID_INVALID".into(), "扩展 ID 格式不正确：应为 32 位小写字母".into()));
    }
    let host = host_binary_path().ok_or_else(|| {
        ("HOST_BINARY_MISSING".into(), "未找到宿主二进制 mda_fill_host：请与主程序一同构建/分发后再试".into())
    })?;
    let path = manifest_install_path().ok_or_else(|| ("INTERNAL".into(), "无法确定应用数据目录".into()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| ("INTERNAL".into(), "无法创建清单目录".into()))?;
    }
    let body = manifest_json(extension_id.trim(), &host).to_string();
    std::fs::write(&path, body).map_err(|_| ("INTERNAL".into(), "清单写入失败".into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(serde_json::json!({
        "manifestPath": path.display().to_string(),
        "hostPath": host.display().to_string(),
        "extensionId": extension_id.trim(),
        "protocol": PROTOCOL,
        "browserDirs": browser_manifest_dirs().iter().map(|(l, d)| serde_json::json!({ "browser": l, "path": d.display().to_string() })).collect::<Vec<_>>(),
        "registryHint": registry_hint(),
    }))
}

/// 安装到浏览器目录：逐个目录尝试，返回每个目录的结果，失败原因如实返回。
pub fn install(core: &AppCore) -> Result<serde_json::Value> {
    let prepared = prepare(core).map_err(|(code, _)| match code.as_str() {
        "EXTENSION_ID_REQUIRED" | "EXTENSION_ID_INVALID" => AppError::InvalidInput,
        _ => AppError::Internal,
    })?;
    let src = std::path::PathBuf::from(prepared.get("manifestPath").and_then(|v| v.as_str()).unwrap_or(""));
    let body = std::fs::read_to_string(&src).map_err(|_| AppError::Internal)?;
    let mut installed: Vec<serde_json::Value> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();
    for (browser, dir) in browser_manifest_dirs() {
        let target = dir.join(format!("{HOST_NAME}.json"));
        let r = (|| -> std::result::Result<(), String> {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&target, &body).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match r {
            Ok(_) => installed.push(serde_json::json!({ "browser": browser, "path": target.display().to_string() })),
            Err(msg) => failed.push(serde_json::json!({ "browser": browser, "reason": msg })),
        }
    }
    let _ = crate::audit::record(&core.db, core.vault.active_user().as_deref(), "extension.host_manifest.install", Some("channel"), None, "success", None, Some("system"));
    Ok(serde_json::json!({
        "installed": installed,
        "failed": failed,
        "registryHint": prepared.get("registryHint").cloned().unwrap_or(serde_json::Value::Null),
        "hostPath": prepared.get("hostPath").cloned().unwrap_or(serde_json::Value::Null),
        "note": if cfg!(target_os = "windows") {
            "Windows 需自行把注册表键指向清单文件路径；本应用不自动修改注册表。"
        } else {
            "清单写入后需重启浏览器，扩展才能发现宿主。"
        },
    }))
}

pub fn uninstall(core: &AppCore) -> Result<serde_json::Value> {
    let mut removed: Vec<String> = Vec::new();
    if let Some(p) = manifest_install_path() {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|_| AppError::Internal)?;
            removed.push(p.display().to_string());
        }
    }
    for (_, dir) in browser_manifest_dirs() {
        let target = dir.join(format!("{HOST_NAME}.json"));
        if target.exists() && std::fs::remove_file(&target).is_ok() {
            removed.push(target.display().to_string());
        }
    }
    let _ = crate::audit::record(&core.db, core.vault.active_user().as_deref(), "extension.host_manifest.uninstall", Some("channel"), None, "success", None, Some("system"));
    Ok(serde_json::json!({ "removed": removed }))
}

pub(crate) fn is_valid_extension_id(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_id_must_be_32_lowercase() {
        assert!(is_valid_extension_id(&"a".repeat(32)));
        assert!(!is_valid_extension_id("ABC"));
        assert!(!is_valid_extension_id(&"a".repeat(31)));
        assert!(!is_valid_extension_id(&"1".repeat(32)));
    }

    #[test]
    fn manifest_shape_matches_spec() {
        let v = manifest_json("abcdefghijklmnopabcdefghijklmnop", std::path::Path::new("/usr/local/bin/mda_fill_host"));
        assert_eq!(v["name"], HOST_NAME);
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["allowed_origins"][0], "chrome-extension://abcdefghijklmnopabcdefghijklmnop/");
        assert_eq!(v["path"], "/usr/local/bin/mda_fill_host");
    }

    #[test]
    fn windows_uses_registry_hint_only() {
        // 非 Windows 平台必须给出至少一个可写目录；Windows 给出注册表提示
        if cfg!(target_os = "windows") {
            assert!(registry_hint().is_some());
            assert!(browser_manifest_dirs().is_empty());
        } else {
            assert!(!browser_manifest_dirs().is_empty());
            assert!(registry_hint().is_none());
        }
    }
}
