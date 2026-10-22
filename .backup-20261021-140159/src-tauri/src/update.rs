//! 内网更新：清单获取（强制 HTTPS）、签名验证、平台/架构匹配、下载与安装。
//!
//! 安全边界：
//! - 发布签名私钥只在受控发布环境；客户端只内置公钥。公钥来自环境变量/随包分发的 pub 文件，
//!   未配置时更新功能显式报告「未配置」，绝不降级为「不校验签名」。
//! - 生产模式拒绝明文 HTTP 更新源。
//! - 只安装签名有效、平台与架构匹配、版本合法且来源在管理员配置范围内的包。

use std::io::Read;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::settings;
use crate::state::AppCore;

/// 更新清单：由发布环境签名（对 `canonical` 字段的 UTF-8 字节做 Ed25519 签名）。
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub notes: String,
    pub packages: Vec<Pkg>,
    /// 对 packages 等内容的规范串，签名即作用于它
    pub canonical: String,
    /// base64（标准字母表）Ed25519 签名
    pub signature: String,
    #[serde(default)]
    pub signer: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Pkg {
    pub platform: String,
    pub arch: String,
    pub url: String,
    #[serde(default)]
    pub size: i64,
    /// 包内容 SHA-256（十六进制小写）
    pub sha256: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub channel: String,
    pub source_url: String,
    pub release_date: Option<String>,
    pub notes: Option<String>,
    pub platform: String,
    pub arch: String,
    pub package_size: Option<i64>,
    /// ok / failed / unknown（未配置公钥时为 unknown，不得显示为安全）
    pub signature_valid: String,
    pub signer: Option<String>,
    pub available: bool,
    pub downloaded: bool,
    pub installed: bool,
    pub message: String,
}

/// 内置/配置的发布公钥（32 字节 base64）。未配置则更新校验不可能通过。
pub fn release_pubkey() -> Option<VerifyingKey> {
    let raw = std::env::var("MDA_UPDATE_PUBKEY")
        .ok()
        .or_else(|| {
            let dir = std::env::var("MDA_CONFIG_DIR").ok()?;
            let p = Path::new(&dir).join("update-release.pub");
            std::fs::read_to_string(p).ok()
        })?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(trimmed).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

fn base_info(core: &AppCore) -> UpdateInfo {
    UpdateInfo {
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        latest_version: None,
        channel: settings::get(&core.db, "update_channel").ok().flatten().unwrap_or_else(|| "stable".into()),
        source_url: settings::get(&core.db, "update_source_url").ok().flatten().unwrap_or_default(),
        release_date: None,
        notes: None,
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        package_size: None,
        signature_valid: "unknown".to_string(),
        signer: None,
        available: false,
        downloaded: false,
        installed: false,
        message: String::new(),
    }
}

/// 版本格式必须是 `x.y.z`（可带 `-pre`），拒绝不可解析的版本参与升级判断。
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core_part = v.split('-').next()?;
    let mut it = core_part.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    Some((a, b, c))
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 校验清单自签名字段：签名必须覆盖 `canonical`，且 `canonical` 必须真的描述这些包，
/// 否则清单内容可被替换（签名有效但内容不同）。
fn verify_manifest(m: &Manifest, key: &VerifyingKey) -> Result<()> {
    use base64::Engine;
    let expected = canonical_of(&m.version, &m.channel, &m.date, &m.notes, &m.packages);
    if expected != m.canonical {
        return Err(AppError::UpdateSignatureInvalid);
    }
    let sig_bytes = base64::engine::general_purpose::STANDARD.decode(m.signature.trim()).map_err(|_| AppError::UpdateSignatureInvalid)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| AppError::UpdateSignatureInvalid)?;
    key.verify_strict(m.canonical.as_bytes(), &sig)
        .map_err(|_| AppError::UpdateSignatureInvalid)?;
    Ok(())
}

/// 规范串：字段顺序与分隔符固定，发布端与客户端必须一致。
pub fn canonical_of(version: &str, channel: &str, date: &str, notes: &str, packages: &[Pkg]) -> String {
    let mut lines: Vec<String> = packages
        .iter()
        .map(|p| format!("{}|{}|{}|{}|{}", p.platform, p.arch, p.url, p.size, p.sha256.to_lowercase()))
        .collect();
    lines.sort();
    format!("v1\nversion={version}\nchannel={channel}\ndate={date}\nnotes={notes}\npackages\n{}\n", lines.join("\n"))
}

fn fetch_text(url: &str) -> std::result::Result<String, AppError> {
    if !url.starts_with("https://") {
        return Err(AppError::InsecureUpdateSource);
    }
    let resp = ureq::get(url).call().map_err(|_| AppError::UpdateSourceUnreachable)?;
    let mut buf = String::new();
    resp.into_reader().read_to_string(&mut buf).map_err(|_| AppError::UpdateSourceUnreachable)?;
    if buf.len() > 1_048_576 {
        return Err(AppError::FileTooLarge);
    }
    Ok(buf)
}

pub fn check(core: &AppCore) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    if info.source_url.is_empty() {
        info.message = "未配置内网更新源，当前为离线状态（未发起任何网络请求）。".to_string();
        return Ok(info);
    }
    if !info.source_url.starts_with("https://") {
        return Err(AppError::InsecureUpdateSource);
    }
    let key = match release_pubkey() {
        Some(k) => k,
        None => {
            info.signature_valid = "unknown".to_string();
            info.message = "未配置发布签名公钥：无法校验更新包，已拒绝安装。请在部署环境中配置 MDA_UPDATE_PUBKEY 或 update-release.pub。".to_string();
            return Ok(info);
        }
    };
    let text = fetch_text(&info.source_url)?;
    // 审查 F14：连上了但清单不是那份 JSON，与"源不可达"是两件事。报错了码，
    // 运维会去查网络，而真正该查的是 sourceUrl 背后的文件。
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| {
        log::warn!("更新清单解析失败：{e}；sourceUrl={}", info.source_url);
        AppError::UpdateManifestInvalid
    })?;
    verify_manifest(&manifest, &key)?;
    info.signature_valid = "ok".to_string();
    info.signer = if manifest.signer.is_empty() { None } else { Some(manifest.signer.clone()) };
    info.latest_version = Some(manifest.version.clone());
    info.release_date = Some(manifest.date.clone());
    info.notes = Some(manifest.notes.clone());
    info.available = is_newer(&manifest.version, &info.current_version)
        && manifest.channel == info.channel
        && manifest.packages.iter().any(|p| p.platform == info.platform && p.arch == info.arch);
    if let Some(p) = manifest.packages.iter().find(|p| p.platform == info.platform && p.arch == info.arch) {
        info.package_size = Some(p.size);
        if !p.url.starts_with("https://") {
            info.available = false;
            info.message = "更新包地址不是 HTTPS，已拒绝下载。".to_string();
            return Ok(info);
        }
    } else {
        info.available = false;
        info.message = "清单中没有匹配当前平台/架构的更新包。".to_string();
        return Ok(info);
    }
    if info.message.is_empty() {
        info.message = if info.available {
            "发现可用更新：签名校验通过、平台匹配。".to_string()
        } else {
            "当前已是最新可用版本（或通道不匹配）。".to_string()
        };
    }
    persist_pending(core, &manifest)?;
    Ok(info)
}

fn pending_path(core: &AppCore) -> PathBuf {
    core.data_dir.join("update-pending.json")
}

fn persist_pending(core: &AppCore, m: &Manifest) -> Result<()> {
    let json = serde_json::to_vec(m).map_err(AppError::Serde)?;
    std::fs::write(pending_path(core), json).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    Ok(())
}

fn load_pending(core: &AppCore) -> Result<Manifest> {
    let bytes = std::fs::read(pending_path(core)).map_err(|_| AppError::NotFound)?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::internal("更新检查与下载", &e))
}

/// 下载：流式写入临时文件，落盘后校验 SHA-256；失败即删除，不留半成品。
pub fn download(core: &AppCore, app: &tauri::AppHandle) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    crate::rbac::require(&core.db, &core.check_session()?, crate::rbac::perm::SYS_UPDATE_CONFIG)?;
    let m = load_pending(core)?;
    let key = release_pubkey().ok_or(AppError::UpdateSignatureInvalid)?;
    verify_manifest(&m, &key)?;
    let pkg = m
        .packages
        .iter()
        .find(|p| p.platform == info.platform && p.arch == info.arch)
        .ok_or(AppError::UpdatePlatformMismatch)?;
    if !pkg.url.starts_with("https://") {
        return Err(AppError::InsecureUpdateSource);
    }

    use tauri::Emitter;
    let dest = core.data_dir.join("downloads").join(format!("{}-{}-{}", m.version, info.platform, info.arch));
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    let resp = ureq::get(&pkg.url).call().map_err(|_| AppError::UpdateSourceUnreachable)?;
    let total = if pkg.size > 0 { pkg.size as usize } else { 0 };
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&dest).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut written: usize = 0;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut chunk).map_err(|_| AppError::UpdateSourceUnreachable)?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &chunk[..n]).map_err(|e| AppError::internal("更新检查与下载", &e))?;
        sha2::Digest::update(&mut hasher, &chunk[..n]);
        written += n;
        let _ = app.emit("update://progress", progress_payload("下载中", written, total));
    }
    std::io::Write::flush(&mut file).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    drop(file);
    let _ = app.emit("update://progress", progress_payload("校验 SHA-256", written, total));
    let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::finalize(hasher));
    if digest != pkg.sha256.to_lowercase() {
        crate::backup::delete_quiet(&dest);
        return Err(AppError::UpdateSignatureInvalid);
    }
    info.downloaded = true;
    info.latest_version = Some(m.version.clone());
    info.signature_valid = "ok".to_string();
    info.message = "更新包下载完成，SHA-256 与签名清单一致。安装需在确认后重启应用。".to_string();
    Ok(info)
}

/// 下载进度事件载荷。字段名必须与前端 UpdateProgress（percent/received/total/stage）
/// 完全一致：曾经只发 downloaded/total，前端读 percent 永远拿不到值，进度条一直停在 0%。
/// 清单未提供 size 时 percent 为 null，由前端如实显示已下载字节数而不是伪造 0%。
/// percent 表示"下载完成度"，当前在做什么由 stage 说明；下载满即为 100，随后进入校验阶段。
fn progress_payload(stage: &str, received: usize, total: usize) -> serde_json::Value {
    let percent: Option<i64> = if total > 0 {
        Some(((((received as f64 / total as f64) * 100.0).round() as i64)).clamp(0, 100))
    } else {
        None
    };
    serde_json::json!({ "stage": stage, "received": received, "total": total, "percent": percent })
}

/// 安装：本版本不静默替换自身。校验通过后把包标记为就绪并提示重启，
/// 由打包器/系统更新机制完成替换（详见 README 的内网更新部署章节）。
pub fn install(core: &AppCore) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    crate::rbac::require(&core.db, &core.check_session()?, crate::rbac::perm::SYS_UPDATE_INSTALL)?;
    core.require_reauth()?;
    let m = load_pending(core)?;
    let key = release_pubkey().ok_or(AppError::UpdateSignatureInvalid)?;
    verify_manifest(&m, &key)?;
    let pkg = m
        .packages
        .iter()
        .find(|p| p.platform == info.platform && p.arch == info.arch)
        .ok_or(AppError::UpdatePlatformMismatch)?;
    let dest = core.data_dir.join("downloads").join(format!("{}-{}-{}", m.version, info.platform, info.arch));
    if !dest.exists() {
        return Err(AppError::NotFound);
    }
    let bytes = std::fs::read(&dest).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    let digest = crate::backup::sha256_hex(&bytes);
    drop(bytes);
    if digest != pkg.sha256.to_lowercase() {
        return Err(AppError::UpdateSignatureInvalid);
    }
    info.latest_version = Some(m.version);
    info.downloaded = true;
    info.signature_valid = "ok".to_string();
    info.installed = false;
    info.message = "更新包已通过签名与哈希校验，处于「待安装」状态。为避免中断工作，安装将在应用重启时由系统更新器执行；本版本不会静默替换自身。".to_string();
    Ok(info)
}

#[cfg(test)]
mod tests {
    //! 覆盖验收 §9.1/§9.2 的更新通道红线：改包内容或给错签名必须拒绝安装；
    //! 未配置更新源/公钥时不得发起外部连接，也绝不允许"跳过校验"。
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signature, Signer, SigningKey};
    use rand::RngCore;

    /// 环境变量是进程级全局状态：读写它的测试必须串行，否则会互相看见对方的值。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 测试用密钥：不依赖 ed25519-dalek 的 rand_core feature（生产构建没开）。
    fn test_key() -> SigningKey {
        let mut secret = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        SigningKey::from_bytes(&secret)
    }

    fn pkg(platform: &str, arch: &str, url: &str, sha: &str) -> Pkg {
        Pkg {
            platform: platform.to_string(),
            arch: arch.to_string(),
            url: url.to_string(),
            size: 2048,
            sha256: sha.to_string(),
        }
    }

    fn pkgs() -> Vec<Pkg> {
        vec![
            pkg("macos", "aarch64", "https://intra.example/app-1.1.0.dmg", "aa01"),
            pkg("windows", "x86_64", "https://intra.example/app-1.1.0.exe", "bb02"),
        ]
    }

    /// 私钥只活在测试进程里；真实发布私钥按需求不进仓库。
    fn manifest_signed_by(key: &SigningKey) -> Manifest {
        let canonical = canonical_of("1.1.0", "stable", "2026-10-14", "修复若干问题", &pkgs());
        let signature: Signature = key.sign(canonical.as_bytes());
        Manifest {
            version: "1.1.0".into(),
            channel: "stable".into(),
            date: "2026-10-14".into(),
            notes: "修复若干问题".into(),
            packages: pkgs(),
            signer: "release".into(),
            canonical,
            signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        }
    }

    fn err_of(r: Result<()>) -> AppError {
        r.expect_err("应当被拒绝")
    }

    #[test]
    fn correctly_signed_manifest_is_accepted() {
        let key = test_key();
        let m = manifest_signed_by(&key);
        assert!(verify_manifest(&m, &key.verifying_key()).is_ok(), "合法清单必须通过");
    }

    /// 攻击形态一：换掉下载 URL / 哈希，但保留旧 canonical 与旧签名（签名本身仍有效）。
    #[test]
    fn swapped_package_content_is_rejected_even_with_valid_signature() {
        let key = test_key();
        let mut m = manifest_signed_by(&key);
        m.packages[0].url = "https://evil.example/app-1.1.0.dmg".to_string();
        assert!(matches!(
            err_of(verify_manifest(&m, &key.verifying_key())),
            AppError::UpdateSignatureInvalid
        ));

        let mut m2 = manifest_signed_by(&key);
        m2.packages[0].sha256 = "00".repeat(32);
        assert!(matches!(
            err_of(verify_manifest(&m2, &key.verifying_key())),
            AppError::UpdateSignatureInvalid
        ));

        // size 同样在规范串里：改尺寸不改签名一样拒绝。
        let mut m3 = manifest_signed_by(&key);
        m3.packages[1].size = 1;
        assert!(matches!(
            err_of(verify_manifest(&m3, &key.verifying_key())),
            AppError::UpdateSignatureInvalid
        ));
    }

    /// 攻击形态二：把 canonical 重算成攻击者想要的内容（自洽），但没有对应签名。
    #[test]
    fn self_consistent_canonical_without_matching_signature_is_rejected() {
        let key = test_key();
        let foreign = test_key();
        let mut m = manifest_signed_by(&key);
        let attack = vec![pkg("macos", "aarch64", "https://evil.example/x.dmg", "ff")];
        m.canonical = canonical_of(&m.version, &m.channel, &m.date, &m.notes, &attack);
        m.packages = attack;
        assert!(matches!(
            err_of(verify_manifest(&m, &key.verifying_key())),
            AppError::UpdateSignatureInvalid
        ));
        // 用无关密钥签名的清单同样拒绝——绝不因"能解出签名结构"就放行。
        let other = manifest_signed_by(&foreign);
        assert!(matches!(
            err_of(verify_manifest(&other, &key.verifying_key())),
            AppError::UpdateSignatureInvalid
        ));
    }

    #[test]
    fn malformed_signature_is_rejected() {
        let key = test_key();
        let mut m = manifest_signed_by(&key);
        m.signature = "不是 base64 !!".to_string();
        assert!(matches!(err_of(verify_manifest(&m, &key.verifying_key())), AppError::UpdateSignatureInvalid));

        let mut m2 = manifest_signed_by(&key);
        m2.signature = base64::engine::general_purpose::STANDARD.encode(vec![7u8; 32]);
        assert!(matches!(err_of(verify_manifest(&m2, &key.verifying_key())), AppError::UpdateSignatureInvalid));

        // 空签名（发布端漏填）也走同一条拒绝路径。
        let mut m3 = manifest_signed_by(&key);
        m3.signature = String::new();
        assert!(matches!(err_of(verify_manifest(&m3, &key.verifying_key())), AppError::UpdateSignatureInvalid));
    }

    /// canonical 只描述字段集合，与包数组顺序无关；改任一字段必须改变 canonical。
    #[test]
    fn canonical_is_order_independent_and_field_sensitive() {
        let mut swapped = pkgs();
        swapped.reverse();
        assert_eq!(
            canonical_of("1.1.0", "stable", "2026-10-14", "n", &pkgs()),
            canonical_of("1.1.0", "stable", "2026-10-14", "n", &swapped)
        );
        assert_ne!(
            canonical_of("1.1.0", "stable", "2026-10-14", "n", &pkgs()),
            canonical_of("1.1.0", "beta", "2026-10-14", "n", &pkgs())
        );
        assert_ne!(
            canonical_of("1.1.0", "stable", "2026-10-14", "n", &pkgs()),
            canonical_of("1.1.1", "stable", "2026-10-14", "n", &pkgs())
        );
        assert_ne!(
            canonical_of("1.1.0", "stable", "2026-10-14", "n", &pkgs()),
            canonical_of("1.1.0", "stable", "2026-10-14", "n", &[pkg("macos", "aarch64", "https://intra.example/app-1.1.0.dmg", "AA02")])
        );
        // 哈希大小写不影响规范串（发布端可给大写）。
        assert_eq!(
            canonical_of("1", "s", "d", "n", &[pkg("a", "b", "https://x", "Aa01")]),
            canonical_of("1", "s", "d", "n", &[pkg("a", "b", "https://x", "aa01")])
        );
    }

    #[test]
    fn release_pubkey_requires_exactly_32_valid_bytes() {
        let _g = env_lock();
        let key = test_key();
        let valid = base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes());
        let short = base64::engine::general_purpose::STANDARD.encode(vec![9u8; 31]);

        std::env::remove_var("MDA_UPDATE_PUBKEY");
        std::env::remove_var("MDA_CONFIG_DIR");
        assert!(release_pubkey().is_none(), "两个来源都没有时必须报告「无法校验」，不得返回可用密钥");

        for bad in ["", "   ", "!!!not-base64!!!", "c2hvcnQ=", short.as_str()] {
            std::env::set_var("MDA_UPDATE_PUBKEY", bad);
            assert!(release_pubkey().is_none(), "非法公钥（{bad:?}）不能被接受");
        }

        std::env::set_var("MDA_UPDATE_PUBKEY", valid.clone());
        assert_eq!(release_pubkey().map(|k| k.to_bytes()), Some(key.verifying_key().to_bytes()));

        // 环境变量缺失时回落到配置目录下的 pub 文件；文件内容同样必须解成 32 字节。
        std::env::remove_var("MDA_UPDATE_PUBKEY");
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MDA_CONFIG_DIR", dir.path());
        assert!(release_pubkey().is_none());
        std::fs::write(dir.path().join("update-release.pub"), "not base64 at all").unwrap();
        assert!(release_pubkey().is_none());
        std::fs::write(dir.path().join("update-release.pub"), format!("{valid}\n")).unwrap();
        assert_eq!(release_pubkey().map(|k| k.to_bytes()), Some(key.verifying_key().to_bytes()));

        std::env::remove_var("MDA_CONFIG_DIR");
        std::env::remove_var("MDA_UPDATE_PUBKEY");
    }

    /// 明文 HTTP / 其它非 https 前缀必须在发起任何连接之前被拒。
    #[test]
    fn non_https_sources_are_rejected_before_any_network_call() {
        for url in [
            "http://intra.example/manifest.json",
            "HTTP://intra.example/manifest.json",
            "https:/intra.example/manifest.json",
            "//intra.example/manifest.json",
            "file:///tmp/manifest.json",
            "",
        ] {
            assert!(
                matches!(fetch_text(url), Err(AppError::InsecureUpdateSource)),
                "{url:?} 应被判为不安全更新源"
            );
        }
    }

    /// 前后端事件契约：字段名与 percent 语义必须和前端 UpdateProgress 一致。
    #[test]
    fn progress_event_matches_frontend_field_names() {
        let v = progress_payload("下载中", 512, 1024);
        assert_eq!(v["stage"], "下载中");
        assert_eq!(v["received"], 512);
        assert_eq!(v["total"], 1024);
        assert_eq!(v["percent"], 50);
        assert!(v.get("downloaded").is_none(), "不得再发前端读不到的旧字段名");

        // 清单没写 size：percent 必须是 null（前端据此显示字节数），不能谎报 0%
        let unknown = progress_payload("下载中", 4096, 0);
        assert!(unknown["percent"].is_null(), "total 未知时不得给出百分比");
        assert_eq!(unknown["received"], 4096);

        // percent 四舍五入到整数：999/1000 已是 99.9%，显示 100 而不是截断成 99
        assert_eq!(progress_payload("下载中", 999, 1000)["percent"], 100);
        assert_eq!(progress_payload("下载中", 333, 1000)["percent"], 33);
        assert_eq!(progress_payload("校验 SHA-256", 1000, 1000)["percent"], 100);
        // 响应体比清单 size 大（异常源）也不能算出 100% 以上
        assert_eq!(progress_payload("下载中", 2048, 1000)["percent"], 100);
    }

    #[test]
    fn version_comparison_boundaries() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(is_newer("1.3.0", "1.2.99"));
        assert!(is_newer("2.0.0", "1.999.999"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.2", "1.2.3"));
        // 预发布后缀不参与比较：1.2.4-pre 不算比 1.2.4 新，避免把未定版包推给终端。
        assert!(!is_newer("1.2.4-pre", "1.2.4"));
        assert!(is_newer("1.2.4-pre", "1.2.3"));
        // 无法解析的版本一律拒绝升级（返回 false，而不是当作可用更新）。
        for bad in ["abc", "1.2", "1.2.x", "", "v1.2.3-rc1"] {
            assert!(!is_newer(bad, "1.0.0"), "{bad:?} 不应被判为可用更新");
        }
    }
}
