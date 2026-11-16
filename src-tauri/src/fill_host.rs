//! Native Messaging 宿主清单（manifest）的生成与安装。
//!
//! 边界说明（如实呈现给使用者）：
//! - 浏览器厂商要求 manifest 中的 `allowed_origins` 精确到扩展 ID。发布出去的扩展在
//!   `extension/manifest.json` 里钉了 `key`（一枚固定的 SPKI 公钥），所以它的 ID 跨机器恒定，
//!   本应用内置那串（`BUILTIN_EXTENSION_ID`）作为默认值：设置项留空即用它，清单照样能生成。
//!   自行改源码加载扩展（没有那枚 key）时 ID 会变，此时把新 ID 填进设置项覆盖默认值。
//! - Windows 上 Chrome/Edge 通过 HKCU 注册表定位 manifest。HKCU 是当前用户自己的配置单元，
//!   普通用户可写，**不需要管理员权限**；应用启动时会静默注册并自愈（清单被删、注册表失配、
//!   安装路径变化），所以使用者安装后无需任何手工导入操作。
//! - 宿主二进制必须与主程序一同分发；找不到二进制时同样返回未就绪。

use std::path::PathBuf;

use crate::error::{AppError, Result};
use crate::settings;
use crate::state::AppCore;

pub const HOST_NAME: &str = "com.mda.fillhost";
pub const PROTOCOL: &str = "mda-fill/1";

/// 发布扩展的固定 ID：`extension/manifest.json` 里 `key` 那枚公钥的
/// SHA-256 前 16 字节按 0→a…15→p 映射而来。改公钥就要改这里，
/// 两侧的一致性由 `scripts/extension-pack.test.mjs` 逐条比对（不靠人记）。
pub const BUILTIN_EXTENSION_ID: &str = "abmoenilfcffmjochdnmifallbkjlmoi";

/// Windows 上浏览器用来定位宿主清单的注册表子键（相对 HKCU）。
/// 键名必须逐字匹配浏览器约定，默认值是该清单文件的绝对路径。
#[cfg(target_os = "windows")]
pub const WINDOWS_REGISTRY_SUBKEYS: &[&str] = &[
    r"Software\Google\Chrome\NativeMessagingHosts\com.mda.fillhost",
    r"Software\Microsoft\Edge\NativeMessagingHosts\com.mda.fillhost",
];

/// 应用自己管理的清单文件（始终生成，供用户核对）。
pub fn manifest_install_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("native-host").join(format!("{HOST_NAME}.json")))
}

fn app_data_dir() -> Option<PathBuf> {
    std::env::var_os("MDA_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(target_os = "macos")]
            {
                std::env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join("Library/Application Support/com.mda.assistant"))
            }
            #[cfg(target_os = "windows")]
            {
                std::env::var_os("APPDATA").map(|h| PathBuf::from(h).join("com.mda.assistant"))
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
                    })
                    .map(|d| d.join("com.mda.assistant"))
            }
        })
}

/// 宿主二进制：优先与主程序同目录（打包后），其次 cargo 目标目录（开发时）。
pub fn host_binary_path() -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "mda_fill_host.exe"
    } else {
        "mda_fill_host"
    };
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join(exe_name),
        exe_dir.join("deps").join(exe_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/release")
            .join(exe_name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/debug")
            .join(exe_name),
    ];
    if let Some(p) = candidates.iter().find(|p| p.is_file()) {
        return Some(p.clone());
    }
    // 打包时宿主作为 sidecar 嵌入，文件名带目标三元组（如 mda_fill_host-aarch64-apple-darwin），
    // 与主程序同目录。三元组不写死在代码里，改为在同目录里按前缀查找。
    let names = std::fs::read_dir(&exe_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .collect::<Vec<_>>();
    names.into_iter().find(|p| {
        let Some(stem) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            return false;
        };
        let suffix = if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        };
        stem.starts_with("mda_fill_host-") && stem.ends_with(suffix) && p.is_file()
    })
}

/// 非 Windows 平台：各浏览器的 NativeMessagingHosts 目录（Windows 返回空，走注册表）。
pub fn browser_manifest_dirs() -> Vec<(&'static str, PathBuf)> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        out.push((
            "Chrome",
            home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"),
        ));
        out.push((
            "Edge",
            home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
        ));
        out.push((
            "Chromium",
            home.join("Library/Application Support/Chromium/NativeMessagingHosts"),
        ));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        for (label, dir) in [
            ("Chrome", "google-chrome"),
            ("Edge", "microsoft-edge"),
            ("Chromium", "chromium"),
        ] {
            out.push((label, base.join(dir).join("NativeMessagingHosts")));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        // Windows 用 HKCU 注册表，见 write_registry / auto_register。
    }
    out
}

/// 供系统管理页展示的注册表键（Windows）。
pub fn registry_hint() -> Option<&'static str> {
    cfg!(target_os = "windows")
        .then(|| "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.mda.fillhost")
}

pub fn manifest_json(extension_id: &str, host_path: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "name": HOST_NAME,
        "description": "蒙电信产助手 一次性凭据填充宿主",
        "path": host_path.display().to_string(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")],
    })
}

/// 解析扩展 ID 与宿主路径，写入应用自管清单。返回 (路径, 原因)。
/// 扩展 ID 取设置项 `extension_id`，留空回退到发布扩展的内置 ID。
pub fn prepare(core: &AppCore) -> std::result::Result<serde_json::Value, (String, String)> {
    let configured = settings::get(&core.db, "extension_id")
        .map_err(|_| ("INTERNAL".to_string(), "设置读取失败".to_string()))?
        .unwrap_or_default();
    let configured = configured.trim().to_string();
    let (extension_id, id_source) = if configured.is_empty() {
        (BUILTIN_EXTENSION_ID.to_string(), "builtin")
    } else {
        if !is_valid_extension_id(&configured) {
            return Err((
                "EXTENSION_ID_INVALID".into(),
                "扩展 ID 格式不正确：应为 32 位小写字母；留空则使用内置 ID".into(),
            ));
        }
        (configured, "configured")
    };
    let host = host_binary_path().ok_or_else(|| {
        (
            "HOST_BINARY_MISSING".into(),
            "未找到宿主二进制 mda_fill_host：请与主程序一同构建/分发后再试".into(),
        )
    })?;
    let path = manifest_install_path()
        .ok_or_else(|| ("INTERNAL".into(), "无法确定应用数据目录".into()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| ("INTERNAL".into(), "无法创建清单目录".into()))?;
    }
    let body = manifest_json(&extension_id, &host).to_string();
    // 这个函数的错误形状是 (code, message) 元组，不共用 AppError：把 secfile 的原因如实转过去。
    crate::secfile::write_private(&path, body.as_bytes())
        .map_err(|e| (e.code().to_string(), e.to_string()))?;
    Ok(serde_json::json!({
        "manifestPath": path.display().to_string(),
        "hostPath": host.display().to_string(),
        "extensionId": extension_id,
        "extensionIdSource": id_source,
        "protocol": PROTOCOL,
        "browserDirs": browser_manifest_dirs().iter().map(|(l, d)| serde_json::json!({ "browser": l, "path": d.display().to_string() })).collect::<Vec<_>>(),
        "registryHint": registry_hint(),
    }))
}

/// Windows：把清单路径写入 HKCU 下 Chrome/Edge 的 NativeMessagingHosts 键。
/// HKCU 是当前用户自己的 hive，普通用户可写，不需要提权。
#[cfg(target_os = "windows")]
fn write_registry(manifest: &std::path::Path) -> std::result::Result<Vec<String>, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let value = manifest.to_string_lossy().into_owned();
    let mut written = Vec::new();
    for sub in WINDOWS_REGISTRY_SUBKEYS {
        let (key, _disposition) = hkcu.create_subkey(sub).map_err(|e| format!("{sub}: {e}"))?;
        key.set_value("", &value)
            .map_err(|e| format!("{sub}: {e}"))?;
        written.push((*sub).to_string());
    }
    Ok(written)
}

/// Windows：删除本应用写过的 NativeMessagingHosts 键（卸载/用户主动取消）。
#[cfg(target_os = "windows")]
fn remove_registry() -> Vec<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mut removed = Vec::new();
    for sub in WINDOWS_REGISTRY_SUBKEYS {
        if hkcu.delete_subkey_all(sub).is_ok() {
            removed.push((*sub).to_string());
        }
    }
    removed
}

/// 宿主注册是否健康：清单存在且（Windows 上）注册表键值指向它。供界面只读回显。
pub fn windows_registry_healthy(manifest: &std::path::Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        registry_matches(manifest)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = manifest;
        true
    }
}

/// Windows：注册表键值是否与当前清单路径一致（用于判断是否需要自愈）。
#[cfg(target_os = "windows")]
fn registry_matches(manifest: &std::path::Path) -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let expected = manifest.to_string_lossy().into_owned();
    WINDOWS_REGISTRY_SUBKEYS.iter().all(|sub| {
        hkcu.open_subkey(sub)
            .and_then(|k| k.get_value::<String, _>(""))
            .map(|v| v == expected)
            .unwrap_or(false)
    })
}

/// 真正完成"浏览器能发现宿主"的注册：清单 + 注册表（Windows）/ 浏览器目录（其它平台）。
/// `prepare` 只生成清单供核对，本函数才产生让浏览器生效的副作用。
pub fn register(core: &AppCore) -> Result<serde_json::Value> {
    let prepared = prepare(core).map_err(|(code, _)| match code.as_str() {
        "EXTENSION_ID_INVALID" => AppError::InvalidInput,
        _ => AppError::Internal,
    })?;
    let manifest = PathBuf::from(
        prepared
            .get("manifestPath")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let mut registry_written: Vec<String> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        match write_registry(&manifest) {
            Ok(keys) => registry_written = keys,
            Err(reason) => {
                failed.push(serde_json::json!({ "browser": "Windows 注册表", "reason": reason }))
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let body = std::fs::read_to_string(&manifest)
            .map_err(|e| AppError::internal("填充宿主进程", &e))?;
        for (browser, dir) in browser_manifest_dirs() {
            let target = dir.join(format!("{HOST_NAME}.json"));
            let r = (|| -> std::result::Result<(), String> {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                std::fs::write(&target, &body).map_err(|e| e.to_string())?;
                Ok(())
            })();
            match r {
                Ok(_) => registry_written.push(format!("{browser}: {}", target.display())),
                Err(reason) => {
                    failed.push(serde_json::json!({ "browser": browser, "reason": reason }))
                }
            }
        }
    }

    Ok(serde_json::json!({
        "manifestPath": manifest.display().to_string(),
        "hostPath": prepared.get("hostPath").cloned().unwrap_or(serde_json::Value::Null),
        "extensionId": prepared.get("extensionId").cloned().unwrap_or(serde_json::Value::Null),
        "extensionIdSource": prepared.get("extensionIdSource").cloned().unwrap_or(serde_json::Value::Null),
        "written": registry_written,
        "failed": failed,
        "registryHint": registry_hint(),
    }))
}

/// 启动时静默自愈：清单被删、注册表失配或安装路径变化都会重写。
/// 任何失败只记日志，**绝不影响启动**——填充功能降级，但主程序照常可用。
pub fn auto_register(core: &AppCore) {
    auto_register_inner(core, false);
}

/// 强制重写（扩展 ID 变更时用）：路径没变但清单内容要换新 ID，不能走健康检查跳过。
pub fn auto_register_force(core: &AppCore) {
    auto_register_inner(core, true);
}

fn auto_register_inner(core: &AppCore, force: bool) {
    // 先做一次便宜的判定：清单存在且（Windows 上）注册表键值匹配就跳过写盘。
    // 强制模式跳过它——扩展 ID 变了，路径没变但内容必须重写。
    let healthy = !force
        && manifest_install_path()
            .map(|p| p.is_file() && windows_registry_healthy(&p))
            .unwrap_or(false);

    if healthy {
        return;
    }
    match register(core) {
        Ok(v) => {
            let n = v
                .get("written")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let f = v
                .get("failed")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if f > 0 {
                log::warn!("浏览器宿主注册部分失败（{n} 项成功，{f} 项失败）：{v}");
            } else {
                log::info!("浏览器宿主已自动注册（{n} 处），安装后无需手动导入注册表");
            }
        }
        Err(e) => log::warn!("浏览器宿主自动注册失败（不影响启动）：{} — {}", e.code(), e),
    }
}

/// 系统管理页的显式"安装宿主清单"：真正写入注册表/浏览器目录，并留审计。
pub fn install(core: &AppCore) -> Result<serde_json::Value> {
    let result = register(core)?;
    let _ = crate::audit::record(
        &core.db,
        core.vault.active_user().as_deref(),
        "extension.host_manifest.install",
        Some("channel"),
        None,
        "success",
        None,
        Some("system"),
    );
    Ok(result)
}

pub fn uninstall(core: &AppCore) -> Result<serde_json::Value> {
    let mut removed: Vec<String> = Vec::new();
    if let Some(p) = manifest_install_path() {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| AppError::internal("填充宿主进程", &e))?;
            removed.push(p.display().to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        // 只删本应用写过的键，不碰浏览器其它配置。
        removed.extend(remove_registry().into_iter().map(|k| format!("HKCU\\{k}")));
    }
    #[cfg(not(target_os = "windows"))]
    for (_, dir) in browser_manifest_dirs() {
        let target = dir.join(format!("{HOST_NAME}.json"));
        if target.exists() && std::fs::remove_file(&target).is_ok() {
            removed.push(target.display().to_string());
        }
    }
    let _ = crate::audit::record(
        &core.db,
        core.vault.active_user().as_deref(),
        "extension.host_manifest.uninstall",
        Some("channel"),
        None,
        "success",
        None,
        Some("system"),
    );
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
        let v = manifest_json(
            "abcdefghijklmnopabcdefghijklmnop",
            std::path::Path::new("/usr/local/bin/mda_fill_host"),
        );
        assert_eq!(v["name"], HOST_NAME);
        assert_eq!(v["type"], "stdio");
        assert_eq!(
            v["allowed_origins"][0],
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        );
        assert_eq!(v["path"], "/usr/local/bin/mda_fill_host");
    }

    #[test]
    fn builtin_extension_id_is_a_valid_id() {
        // 这串值是从发布扩展的公钥推导来的；形状错了等于清单里 allowed_origins 废掉，
        // 公钥与它的真实对应关系由 scripts/extension-pack.test.mjs 校验（Rust 侧不做 sha256）。
        assert!(is_valid_extension_id(BUILTIN_EXTENSION_ID));
        let v = manifest_json(BUILTIN_EXTENSION_ID, std::path::Path::new("/x"));
        assert_eq!(
            v["allowed_origins"][0],
            format!("chrome-extension://{BUILTIN_EXTENSION_ID}/")
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_registry_keys_are_browser_specific() {
        // 少一个键 = 那个浏览器永远找不到宿主；写成 HKLM = 普通用户装不上。
        assert!(WINDOWS_REGISTRY_SUBKEYS
            .iter()
            .any(|k| k.contains("Google\\Chrome")));
        assert!(WINDOWS_REGISTRY_SUBKEYS
            .iter()
            .any(|k| k.contains("Microsoft\\Edge")));
        assert!(WINDOWS_REGISTRY_SUBKEYS
            .iter()
            .all(|k| k.starts_with(r"Software\")));
    }
}
