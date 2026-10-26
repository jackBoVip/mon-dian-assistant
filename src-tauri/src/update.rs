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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// 从局域网源拉取时填「主机名（http://ip:port）」；HTTPS 通道为 null
    pub lan_source: Option<String>,
    /// 是否已把安装包交给系统打开（本版本不静默替换自身）
    pub opened: bool,
    pub message: String,
}

/// 下载通道。决定「包从哪取」，也决定源地址按哪套规则校验。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Transport {
    Https,
    Lan,
}

impl Transport {
    fn key(self) -> &'static str {
        match self {
            Transport::Https => "https",
            Transport::Lan => "lan",
        }
    }
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
        lan_source: None,
        opened: false,
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
pub(crate) fn verify_manifest(m: &Manifest, key: &VerifyingKey) -> Result<()> {
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

/// 更新源放行规则。
///
/// - `https://`：任意主机，现有内网发布通道不变
/// - `http://`：**仅当主机是私网 IP 字面量**，服务局域网镜像通道
///
/// 域名一律不放行明文：DNS 解析结果无法提前确认落在私网，用了就等于把边界交给解析器。
pub fn is_allowed_update_url(u: &str) -> bool {
    let Ok(parsed) = url::Url::parse(u) else {
        return false;
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    match parsed.scheme() {
        "https" => u.starts_with("https://") && parsed.host().is_some(),
        "http" => {
            u.starts_with("http://")
                && match parsed.host() {
                    Some(url::Host::Ipv4(ip)) => crate::lan::net::is_private_or_local(std::net::IpAddr::V4(ip)),
                    Some(url::Host::Ipv6(ip)) => crate::lan::net::is_private_or_local(std::net::IpAddr::V6(ip)),
                    _ => false,
                }
        }
        _ => false,
    }
}

/// 手工填写的局域网源允许写成 `10.0.0.5:8765`，入库前补成完整 URL。
pub fn normalize_lan_source(input: &str) -> Option<String> {
    let v = input.trim();
    if v.is_empty() {
        return None;
    }
    let candidate = if v.contains("://") { v.to_string() } else { format!("http://{v}") };
    let candidate = candidate.trim_end_matches('/').to_string();
    is_allowed_update_url(&candidate).then_some(candidate)
}

/// 包文件扩展名：以签名清单里的 `url` 为准（它也在 canonical 内，被签名覆盖）。
///
/// 落盘时必须带扩展名，否则 `open` 认不出 dmg；局域网镜像也不能靠 url 取包，
/// 所以扩展名只能从清单读，不能从实际下载地址猜。
pub fn package_extension(p: &Pkg) -> &'static str {
    let path = p.url.split(['?', '#']).next().unwrap_or("");
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "dmg" => "dmg",
        "pkg" => "pkg",
        "exe" => "exe",
        "msi" => "msi",
        "deb" => "deb",
        "rpm" => "rpm",
        "appimage" => "AppImage",
        _ => match p.platform.as_str() {
            "macos" => "dmg",
            "windows" => "exe",
            _ => "bin",
        },
    }
}

fn fetch_text_with(url: &str, allow_lan_http: bool) -> std::result::Result<String, AppError> {
    // 不开局域网通道时保留原来的严格前缀判断：`https:/x`（单斜杠）这类写法
    // 会被 `url` crate 规范化成合法地址，用它做判断等于放宽了既有红线。
    let allowed = if allow_lan_http { is_allowed_update_url(url) } else { url.starts_with("https://") };
    if !allowed {
        return Err(AppError::InsecureUpdateSource);
    }
    let resp = if allow_lan_http {
        // 私网源不得 302 到别处：一次跳转就能把请求带出局域网。
        ureq::AgentBuilder::new().redirects(0).build().get(url).call()
    } else {
        ureq::get(url).call()
    }
    .map_err(|_| AppError::UpdateSourceUnreachable)?;
    let mut buf = String::new();
    resp.into_reader().read_to_string(&mut buf).map_err(|_| AppError::UpdateSourceUnreachable)?;
    if buf.len() > 1_048_576 {
        return Err(AppError::FileTooLarge);
    }
    Ok(buf)
}

fn fetch_text(url: &str) -> std::result::Result<String, AppError> {
    fetch_text_with(url, false)
}

/// HTTPS 通道：管理员在设置里填的更新源。
pub fn check(core: &AppCore) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    if info.source_url.is_empty() {
        info.message = "未配置内网更新源，当前为离线状态（未发起任何网络请求）。".to_string();
        return Ok(info);
    }
    if !is_allowed_update_url(&info.source_url) {
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
    let manifest = parse_manifest(&text, &info.source_url)?;
    verify_manifest(&manifest, &key)?;
    let source = info.source_url.clone();
    evaluate_manifest(core, &manifest, Transport::Https, &mut info)?;
    persist_pending(core, Transport::Https, &source, &manifest)?;
    Ok(info)
}

/// 局域网通道：从指定源（实例号或手填 IP:端口）或最优发现源拉清单。
///
/// 验签规则与 HTTPS 通道完全一致——走明文信道不代表可以减少校验。
pub fn check_lan(core: &AppCore, hint: Option<&str>) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    let src = crate::lan::resolve_source(core, hint)?;
    info.lan_source = Some(format!("{}（{}）", src.host, src.base));
    info.source_url = format!("{}/manifest", src.base.trim_end_matches('/'));
    if !is_allowed_update_url(&info.source_url) {
        return Err(AppError::InsecureUpdateSource);
    }
    let Some(key) = release_pubkey() else {
        info.message = "未配置发布签名公钥：局域网源能被发现，但清单无法校验，已拒绝更新。".to_string();
        return Ok(info);
    };
    let text = fetch_text_with(&info.source_url, true)?;
    let manifest = parse_manifest(&text, &info.source_url)?;
    verify_manifest(&manifest, &key)?;
    evaluate_manifest(core, &manifest, Transport::Lan, &mut info)?;
    persist_pending(core, Transport::Lan, &src.base, &manifest)?;
    Ok(info)
}

/// 审查 F14：连上了但清单不是那份 JSON，与"源不可达"是两件事。报了错码，
/// 运维会去查网络，而真正该查的是源地址背后的文件。
fn parse_manifest(text: &str, source: &str) -> Result<Manifest> {
    serde_json::from_str(text).map_err(|e| {
        log::warn!("更新清单解析失败：{e}；source={source}");
        AppError::UpdateManifestInvalid
    })
}

/// 两份通道共用的清单评估：版本/通道/平台匹配、包地址规则、已落盘判定。
fn evaluate_manifest(core: &AppCore, m: &Manifest, transport: Transport, info: &mut UpdateInfo) -> Result<()> {
    info.signature_valid = "ok".to_string();
    info.signer = (!m.signer.is_empty()).then(|| m.signer.clone());
    info.latest_version = Some(m.version.clone());
    info.release_date = Some(m.date.clone());
    info.notes = Some(m.notes.clone());

    let Some(pkg) = matching_pkg(m, &info.platform, &info.arch) else {
        info.available = false;
        info.message = "清单中没有匹配当前平台/架构的更新包。".to_string();
        return Ok(());
    };
    info.package_size = Some(pkg.size);
    // HTTPS 通道的包地址必须仍是 https；局域网通道按 sha256 内容寻址取包，
    // 清单里的 url 只用来推断扩展名，不参与连接。
    if transport == Transport::Https && !pkg.url.starts_with("https://") {
        info.available = false;
        info.message = "更新包地址不是 HTTPS，已拒绝下载。".to_string();
        return Ok(());
    }
    info.available = is_newer(&m.version, &info.current_version) && m.channel == info.channel;
    // 已经完整落过盘的包必须被认出来：否则重新检查后「打开安装包」按钮会永远灰着。
    let dest = package_path(core, &m.version, &info.platform, &info.arch, pkg);
    info.downloaded = std::fs::metadata(&dest)
        .map(|meta| meta.is_file() && (pkg.size <= 0 || meta.len() == pkg.size as u64))
        .unwrap_or(false);
    info.message = if info.available {
        "发现可用更新：签名校验通过、平台匹配。".to_string()
    } else {
        "当前已是最新可用版本（或通道不匹配）。".to_string()
    };
    Ok(())
}

fn matching_pkg<'a>(m: &'a Manifest, platform: &str, arch: &str) -> Option<&'a Pkg> {
    m.packages.iter().find(|p| p.platform == platform && p.arch == arch)
}

fn package_path(core: &AppCore, version: &str, platform: &str, arch: &str, pkg: &Pkg) -> PathBuf {
    core.data_dir
        .join("downloads")
        .join(format!("{version}-{platform}-{arch}.{}", package_extension(pkg)))
}

fn pending_path(core: &AppCore) -> PathBuf {
    core.data_dir.join("update-pending.json")
}

/// 待下载清单：除清单本身外还记住「从哪条通道、哪个源」拉的，
/// 否则下载时会不知道该按 HTTPS 直连还是去局域网镜像取包。
#[derive(serde::Serialize, serde::Deserialize)]
struct PendingUpdate {
    transport: String,
    source: String,
    manifest: Manifest,
}

impl PendingUpdate {
    fn transport_kind(&self) -> Result<Transport> {
        match self.transport.as_str() {
            "https" => Ok(Transport::Https),
            "lan" => Ok(Transport::Lan),
            _ => Err(AppError::UpdateManifestInvalid),
        }
    }
}

fn persist_pending(core: &AppCore, transport: Transport, source: &str, m: &Manifest) -> Result<()> {
    let payload = PendingUpdate {
        transport: transport.key().to_string(),
        source: source.to_string(),
        manifest: m.clone(),
    };
    let json = serde_json::to_vec(&payload).map_err(AppError::Serde)?;
    std::fs::write(pending_path(core), json).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    Ok(())
}

fn load_pending(core: &AppCore) -> Result<PendingUpdate> {
    let bytes = std::fs::read(pending_path(core)).map_err(|_| AppError::NotFound)?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::internal("更新检查与下载", &e))
}

/// 下载：流式写入临时文件，落盘后校验 SHA-256；失败即删除，不留半成品。
///
/// 通道由 `update-pending.json` 决定：HTTPS 源直连清单里的包地址，
/// 局域网源按 sha256 去镜像取包（清单里的 url 可能是任何写法，不予采信）。
pub fn download(core: &AppCore, app: &tauri::AppHandle) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    crate::rbac::require(&core.db, &core.check_session()?, crate::rbac::perm::SYS_UPDATE_CONFIG)?;
    let pending = load_pending(core)?;
    let transport = pending.transport_kind()?;
    let m = &pending.manifest;
    let key = release_pubkey().ok_or(AppError::UpdateSignatureInvalid)?;
    verify_manifest(m, &key)?;
    let pkg = matching_pkg(m, &info.platform, &info.arch).ok_or(AppError::UpdatePlatformMismatch)?;
    let url = package_source_url(&pending, pkg, transport)?;
    let dest = package_path(core, &m.version, &info.platform, &info.arch, pkg);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::internal("更新检查与下载", &e))?;
    }
    let reader = open_reader(&url, transport)?;
    let (written, digest) = stream_to_file(reader, &dest, pkg, app)?;
    if digest != pkg.sha256.to_lowercase() {
        crate::backup::delete_quiet(&dest);
        return Err(AppError::UpdateSignatureInvalid);
    }
    info.downloaded = true;
    info.latest_version = Some(m.version.clone());
    info.signature_valid = "ok".to_string();
    info.lan_source = (transport == Transport::Lan).then(|| pending.source.clone());
    info.message = format!(
        "更新包下载完成（{} 字节），SHA-256 与签名清单一致。下一步需手动打开安装包。",
        written
    );
    Ok(info)
}

/// 取包地址。两条通道的规则必须分开写：HTTPS 只认清单里的 https 地址，
/// 局域网只认内容寻址（sha256），绝不因为「清单里有 url」就直连任意主机。
fn package_source_url(pending: &PendingUpdate, pkg: &Pkg, transport: Transport) -> Result<String> {
    match transport {
        Transport::Https => {
            if !pkg.url.starts_with("https://") {
                return Err(AppError::InsecureUpdateSource);
            }
            Ok(pkg.url.clone())
        }
        Transport::Lan => {
            // 清单在 check 时已验签，这里再判一次地址：pending 文件是本机可写文件，
            // 不能让它把请求带到公网 http 地址上。
            if !is_allowed_update_url(&format!("{}/manifest", pending.source.trim_end_matches('/'))) {
                return Err(AppError::InsecureUpdateSource);
            }
            crate::lan::package_url(&pending.source, &pkg.sha256)
        }
    }
}

fn open_reader(url: &str, transport: Transport) -> Result<Box<dyn Read>> {
    let resp = match transport {
        Transport::Https => ureq::get(url).call(),
        // 私网源不得 302 到别处：一次跳转就能把请求带出局域网。
        Transport::Lan => ureq::AgentBuilder::new().redirects(0).build().get(url).call(),
    }
    .map_err(|_| AppError::UpdateSourceUnreachable)?;
    Ok(resp.into_reader())
}

/// 流式落盘并顺带算 SHA-256，返回 (写入字节数, 摘要)。进度事件沿用 `update://progress`。
fn stream_to_file(mut reader: Box<dyn Read>, dest: &Path, pkg: &Pkg, app: &tauri::AppHandle) -> Result<(usize, String)> {
    use tauri::Emitter;
    let total = if pkg.size > 0 { pkg.size as usize } else { 0 };
    let mut file = std::fs::File::create(dest).map_err(|e| AppError::internal("更新检查与下载", &e))?;
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
    Ok((written, hex::encode(<sha2::Sha256 as sha2::Digest>::finalize(hasher))))
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

/// 打开安装包：本版本不静默替换自身。
///
/// 打开前重算一次完整 SHA-256——落盘到点击之间的时间里文件可能被替换过，
/// 只信任「下载时算过一次」等于信任一个可以被改写的产物。
pub fn open_package(core: &AppCore) -> Result<UpdateInfo> {
    let mut info = base_info(core);
    crate::rbac::require(&core.db, &core.check_session()?, crate::rbac::perm::SYS_UPDATE_INSTALL)?;
    core.require_reauth()?;
    let pending = load_pending(core)?;
    let m = &pending.manifest;
    let key = release_pubkey().ok_or(AppError::UpdateSignatureInvalid)?;
    verify_manifest(m, &key)?;
    let pkg = matching_pkg(m, &info.platform, &info.arch).ok_or(AppError::UpdatePlatformMismatch)?;
    let dest = package_path(core, &m.version, &info.platform, &info.arch, pkg);
    if !dest.is_file() {
        return Err(AppError::NotFound);
    }
    let digest = sha256_of_file(&dest)?;
    if digest != pkg.sha256.to_lowercase() {
        // 被换过的包留着只会让下一次点击继续失败：删掉，让用户重新下载。
        crate::backup::delete_quiet(&dest);
        return Err(AppError::UpdateSignatureInvalid);
    }
    open::that(&dest).map_err(|e| AppError::internal("打开安装包", &e))?;
    info.latest_version = Some(m.version.clone());
    info.downloaded = true;
    info.signature_valid = "ok".to_string();
    info.lan_source = (pending.transport == Transport::Lan.key()).then(|| pending.source.clone());
    info.installed = false;
    info.opened = true;
    info.message = "已打开安装包，请拖入「应用程序」后手动重启应用。".to_string();
    Ok(info)
}

fn sha256_of_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|e| AppError::internal("打开安装包", &e))?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| AppError::internal("打开安装包", &e))?;
        if n == 0 {
            break;
        }
        sha2::Digest::update(&mut hasher, &buf[..n]);
    }
    Ok(hex::encode(<sha2::Sha256 as sha2::Digest>::finalize(hasher)))
}

#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    //! 覆盖验收 §9.1/§9.2 的更新通道红线：改包内容或给错签名必须拒绝安装；
    //! 未配置更新源/公钥时不得发起外部连接，也绝不允许"跳过校验"。
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signature, Signer, SigningKey};
    use rand::RngCore;

    /// 环境变量是进程级全局状态：读写它的测试必须串行，否则会互相看见对方的值。
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

    /// 与当前平台/架构匹配的清单。签名不参与 `evaluate_manifest`，这里留空。
    fn manifest_for(version: &str, url: &str, size: i64, sha: &str) -> Manifest {
        let packages = vec![Pkg {
            platform: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            url: url.into(),
            size,
            sha256: sha.into(),
        }];
        let canonical = canonical_of(version, "stable", "", "", &packages);
        Manifest {
            version: version.into(),
            channel: "stable".into(),
            date: String::new(),
            notes: String::new(),
            packages,
            canonical,
            signature: String::new(),
            signer: String::new(),
        }
    }

    fn test_core(dir: &std::path::Path) -> AppCore {
        let db = crate::db::Db::open_in_memory(&vec![41u8; 32]).unwrap();
        AppCore::new(db, crate::crypto::SecretBytes::new(vec![7u8; 32]), dir.to_path_buf())
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

    /// 局域网镜像通道：只有「私网 IP 字面量 + http」能过。
    /// 域名与公网地址一律拒——DNS 解析结果无法提前确认落在私网。
    #[test]
    fn lan_http_sources_are_limited_to_private_ip_literals() {
        for ok in [
            "http://10.0.0.5:8765/manifest",
            "http://192.168.1.20/manifest",
            "http://127.0.0.1:8765/manifest",
            "http://[fe80::1]:8765/manifest",
        ] {
            assert!(is_allowed_update_url(ok), "{ok} 应放行");
        }
        for bad in [
            "http://intra.example/manifest",
            "http://8.8.8.8/manifest",
            "http://172.32.0.1/manifest",
            "http://192.169.0.1/manifest",
            "http://user@10.0.0.5/manifest",
            "http://user:pass@10.0.0.5/manifest",
            "file:///tmp/manifest.json",
            "ftp://10.0.0.5/manifest",
            "https:/intra.example/manifest.json",
            "",
        ] {
            assert!(!is_allowed_update_url(bad), "{bad} 不得放行");
        }
        // 原有 HTTPS 通道不受影响。
        assert!(is_allowed_update_url("https://intra.example/manifest.json"));
    }

    /// 局域网模式下清单的 `url` 只用来推断扩展名，取包一律按 sha256 内容寻址。
    #[test]
    fn lan_package_url_is_content_addressed() {
        let sha = "ab".repeat(32);
        let pending = PendingUpdate {
            transport: "lan".into(),
            source: "http://10.0.0.5:8765".into(),
            manifest: manifest_for("0.2.0", "lan://whatever.dmg", 10, &sha),
        };
        let pkg = &pending.manifest.packages[0];
        assert_eq!(
            package_source_url(&pending, pkg, Transport::Lan).unwrap(),
            format!("http://10.0.0.5:8765/package/{sha}")
        );
        // 大写哈希来自发布端也好使：取包前统一小写。
        let mut upper = pkg.clone();
        upper.sha256 = sha.to_uppercase();
        assert_eq!(
            package_source_url(&pending, &upper, Transport::Lan).unwrap(),
            format!("http://10.0.0.5:8765/package/{sha}")
        );
        // 非哈希摘要绝不能拼进路径：它就是由请求方提供的那一段。
        let mut bad = pkg.clone();
        bad.sha256 = "../../etc/passwd".into();
        assert!(package_source_url(&pending, &bad, Transport::Lan).is_err());

        // pending 文件是本机可写文件：把源改成公网 http 必须被拒，而不是照着连。
        let mut hijacked = PendingUpdate { transport: "lan".into(), source: "http://8.8.8.8:8765".into(), manifest: pending.manifest.clone() };
        assert!(matches!(
            package_source_url(&hijacked, pkg, Transport::Lan),
            Err(AppError::InsecureUpdateSource)
        ));
        hijacked.source = "http://10.0.0.5:8765".into();

        // HTTPS 通道仍只认清单里的 https 地址。
        let mut plain = pkg.clone();
        plain.url = "http://10.0.0.5:8765/app.dmg".into();
        assert!(matches!(
            package_source_url(&pending, &plain, Transport::Https),
            Err(AppError::InsecureUpdateSource)
        ));
    }

    /// 落盘文件名必须带清单声明的扩展名，否则 `open` 认不出这是 dmg。
    #[test]
    fn package_path_carries_the_manifest_extension() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path());
        let dmg = manifest_for("0.2.0", "lan://app.dmg", 10, &"ab".repeat(32)).packages.remove(0);
        let path = package_path(&core, "0.2.0", "macos", "aarch64", &dmg);
        assert!(path.to_string_lossy().ends_with("0.2.0-macos-aarch64.dmg"));

        // 清单里没有可识别扩展名时按平台兜底，仍然不是一个裸文件名。
        let noext = manifest_for("0.2.0", "lan://app", 10, &"ab".repeat(32)).packages.remove(0);
        assert!(package_path(&core, "0.2.0", "macos", "aarch64", &noext).to_string_lossy().ends_with(".dmg"));
    }

    /// 版本降级必须无效：源版本低于本机时界面显示「低于本机」并禁用按钮，而不是倒着升级。
    #[test]
    fn evaluate_manifest_never_downgrades() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path());
        let current = env!("CARGO_PKG_VERSION");
        let older = "0.0.0".to_string();

        let mut info = base_info(&core);
        evaluate_manifest(&core, &manifest_for(&older, "https://intra/app.dmg", 10, &"ab".repeat(32)), Transport::Https, &mut info).unwrap();
        assert!(!info.available, "比本机（{current}）旧的清单不得被判为可用更新");
        assert_eq!(info.latest_version.as_deref(), Some(older.as_str()), "低版本源仍要让界面看见版本号");

        let mut info2 = base_info(&core);
        evaluate_manifest(&core, &manifest_for("9.9.9", "https://intra/app.dmg", 10, &"ab".repeat(32)), Transport::Https, &mut info2).unwrap();
        assert!(info2.available);
        assert!(!info2.downloaded, "还没下载时不能报已下载");
    }

    /// `downloaded` 必须反映落盘事实：曾经硬编码 false，重新检查后安装按钮永远灰着。
    #[test]
    fn evaluate_manifest_recognises_a_complete_file_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path());
        let sha = "ab".repeat(32);
        let m = manifest_for("9.9.9", "https://intra/app.dmg", 4, &sha);
        let dest = package_path(&core, &m.version, std::env::consts::OS, std::env::consts::ARCH, &m.packages[0]);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();

        let mut info = base_info(&core);
        evaluate_manifest(&core, &m, Transport::Https, &mut info).unwrap();
        assert!(!info.downloaded, "文件不在时不得报已下载");

        // 尺寸不符（半成品）同样不算已下载。
        std::fs::write(&dest, b"ab").unwrap();
        let mut half = base_info(&core);
        evaluate_manifest(&core, &m, Transport::Https, &mut half).unwrap();
        assert!(!half.downloaded, "尺寸不符的半成品不得算作已下载");

        std::fs::write(&dest, b"abcd").unwrap();
        let mut full = base_info(&core);
        evaluate_manifest(&core, &m, Transport::Https, &mut full).unwrap();
        assert!(full.downloaded, "完整落盘的包必须被认出来");
    }

    #[test]
    fn manual_lan_source_accepts_host_port_and_normalises() {
        assert_eq!(normalize_lan_source("10.0.0.5:8765").as_deref(), Some("http://10.0.0.5:8765"));
        assert_eq!(
            normalize_lan_source(" http://10.0.0.5:8765 ").as_deref(),
            Some("http://10.0.0.5:8765")
        );
        assert_eq!(normalize_lan_source("8.8.8.8:8765"), None, "公网地址不得成为局域网源");
        assert_eq!(normalize_lan_source("intra.example:8765"), None, "域名不得成为局域网源");
        assert_eq!(normalize_lan_source("   "), None);
    }
}
