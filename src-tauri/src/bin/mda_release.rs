//! 离线发布签名工具：生成发布密钥、为托管目录产出已签名清单。
//!
//! 为什么是独立可执行文件而不是应用里的一个按钮：签名私钥**不能**进入任何会分发给
//! 终端用户的产物。这个工具只在发布机上跑一次，产物是 `update-release.key`
//! （私钥）与 `update-release.pub`（公钥，随安装包部署或放进 MDA_CONFIG_DIR）。
//!
//! 用法：
//! ```text
//! mda_release keygen --out /secure/mda-release
//! mda_release sign --dir /srv/mda-lan --version 0.2.0 \
//!     --key /secure/mda-release/update-release.key --notes "修复若干问题"
//! ```
//!
//! `sign` 会扫 `<dir>/packages/*` 算 SHA-256 与大小，按服务器约定的规范串
//! （`update::canonical_of`）签名后写 `<dir>/manifest.json`。规范串与客户端验签
//! 共用同一份代码——这里绝不另写一份，否则签名永远对不上。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use sha2::Digest;

use mon_dian_assistant_lib::update::{canonical_of, Manifest, Pkg};

const KEY_FILE: &str = "update-release.key";
const PUB_FILE: &str = "update-release.pub";
const MANIFEST_FILE: &str = "manifest.json";
const PACKAGE_DIR: &str = "packages";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        usage();
        return ExitCode::from(2);
    };
    match command {
        "keygen" => match Flags::parse(&args[1..]).and_then(|f| keygen(&f)) {
            Ok(msg) => {
                println!("{msg}");
                ExitCode::SUCCESS
            }
            Err(e) => fail(&e),
        },
        "sign" => match Flags::parse(&args[1..]).and_then(|f| sign(&f)) {
            Ok(msg) => {
                println!("{msg}");
                ExitCode::SUCCESS
            }
            Err(e) => fail(&e),
        },
        "-h" | "--help" | "help" => {
            usage();
            ExitCode::SUCCESS
        }
        other => fail(&format!("未知子命令：{other}")),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("mda_release: {message}");
    ExitCode::FAILURE
}

fn usage() {
    eprintln!(
        "mda_release — 离线发布签名工具

  keygen --out <dir> [--force]
      生成 update-release.key（私钥，0600）与 update-release.pub（公钥）。
      已存在私钥时拒绝覆盖：一条发布密钥被顺手覆盖，所有已发布客户端都会验签失败。

  sign --dir <serve_dir> --version <x.y.z> --key <key 文件>
       [--channel stable|beta] [--notes 文本] [--date YYYY-MM-DD]
       [--platform macos] [--arch aarch64] [--pkg-url-prefix lan://]
      扫描 <serve_dir>/packages/* 生成 <serve_dir>/manifest.json。

  退出码：0 成功，1 失败，2 用法错误。"
    );
}

/// `--key value` 形式的极简参数表。缺值直接报错，不吞成空串。
struct Flags {
    values: BTreeMap<String, String>,
}

impl Flags {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut values = BTreeMap::new();
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let Some(name) = arg.strip_prefix("--") else {
                return Err(format!("无法识别的参数：{arg}"));
            };
            let Some(value) = it.next() else {
                return Err(format!("--{name} 缺少取值"));
            };
            values.insert(name.to_string(), value.clone());
        }
        Ok(Self { values })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn require(&self, key: &str) -> Result<&str, String> {
        match self.get(key) {
            Some(v) if !v.trim().is_empty() => Ok(v),
            _ => Err(format!("缺少 --{key}")),
        }
    }
}

fn keygen(flags: &Flags) -> Result<String, String> {
    let out = PathBuf::from(flags.require("out")?);
    std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败：{e}"))?;

    let private_path = out.join(KEY_FILE);
    let public_path = out.join(PUB_FILE);
    if private_path.exists() && flags.get("force").is_none() {
        return Err(format!(
            "{} 已存在。覆盖会让所有已发布客户端验签失败；确需轮换请加 --force，并随新安装包分发新公钥。",
            private_path.display()
        ));
    }

    // 私钥来自操作系统熵源；这里不落任何中间副本。
    use rand::RngCore;
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let signing = SigningKey::from_bytes(&secret);

    let engine = base64::engine::general_purpose::STANDARD;
    write_private(&private_path, engine.encode(secret).as_bytes())?;
    std::fs::write(&public_path, format!("{}\n", engine.encode(signing.verifying_key().to_bytes())))
        .map_err(|e| format!("写入公钥失败：{e}"))?;

    Ok(format!(
        "已生成发布密钥：\n  私钥（仅发布机持有，勿分发）：{}\n  公钥（随安装包部署）：{}",
        private_path.display(),
        public_path.display()
    ))
}

fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("写入私钥失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置私钥权限失败：{e}"))?;
    }
    Ok(())
}

fn sign(flags: &Flags) -> Result<String, String> {
    let dir = PathBuf::from(flags.require("dir")?);
    let version = flags.require("version")?.trim().to_string();
    if !version_is_parseable(&version) {
        return Err(format!("版本号 {version:?} 不是 x.y.z 形式：客户端会直接忽略这份清单"));
    }
    let channel = flags.get("channel").unwrap_or("stable").to_string();
    if channel != "stable" && channel != "beta" {
        return Err("--channel 只能是 stable 或 beta".to_string());
    }
    let notes = flags.get("notes").unwrap_or("").to_string();
    let date = match flags.get("date") {
        Some(d) => d.to_string(),
        None => chrono::Utc::now().format("%Y-%m-%d").to_string(),
    };
    let prefix = flags.get("pkg-url-prefix").unwrap_or("lan://").to_string();
    let key_path = PathBuf::from(flags.require("key")?);
    let signing = load_key(&key_path)?;

    let pkg_dir = dir.join(PACKAGE_DIR);
    if !pkg_dir.is_dir() {
        return Err(format!("{} 不存在：请先把安装包放进去", pkg_dir.display()));
    }
    let mut packages = Vec::new();
    let mut names: Vec<PathBuf> = std::fs::read_dir(&pkg_dir)
        .map_err(|e| format!("读取 {} 失败：{e}", pkg_dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false))
        .collect();
    names.sort();
    if names.is_empty() {
        return Err(format!("{} 里没有任何安装包", pkg_dir.display()));
    }

    for path in &names {
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        // 包地址必须带可识别的扩展名：客户端据此决定落盘文件名，进而决定能不能交给系统打开。
        let normalized_ext = match ext.as_str() {
            "dmg" | "pkg" | "exe" | "msi" | "deb" | "rpm" => ext.clone(),
            "appimage" => "AppImage".to_string(),
            _ => return Err(format!("{file_name} 的扩展名不被支持（dmg/pkg/exe/msi/deb/rpm/AppImage）")),
        };
        let bytes = std::fs::read(path).map_err(|e| format!("读取 {file_name} 失败：{e}"))?;
        let sha = hex::encode(sha2::Sha256::digest(&bytes));
        let default_platform = match normalized_ext.as_str() {
            "dmg" | "pkg" => "macos",
            "exe" | "msi" => "windows",
            _ => "linux",
        };
        packages.push(Pkg {
            platform: flags.get("platform").unwrap_or(default_platform).to_string(),
            arch: flags.get("arch").unwrap_or(std::env::consts::ARCH).to_string(),
            url: format!("{prefix}{sha}.{normalized_ext}"),
            size: bytes.len() as i64,
            sha256: sha,
        });
    }

    let canonical = canonical_of(&version, &channel, &date, &notes, &packages);
    let signature = signing.sign(canonical.as_bytes());
    let manifest = Manifest {
        version: version.clone(),
        channel: channel.clone(),
        date: date.clone(),
        notes,
        packages,
        canonical,
        signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
        signer: flags.get("signer").unwrap_or("mda-release").to_string(),
    };

    let json = serde_json::to_string_pretty(&manifest).map_err(|e| format!("序列化清单失败：{e}"))?;
    let target = dir.join(MANIFEST_FILE);
    std::fs::write(&target, json).map_err(|e| format!("写入 {} 失败：{e}", target.display()))?;

    Ok(format!(
        "已写入 {}：版本 {version}（{channel}，{date}），{} 个安装包",
        target.display(),
        manifest_entries(&target)
    ))
}

fn manifest_entries(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        .map(|m| m.packages.len())
        .unwrap_or(0)
}

fn load_key(path: &Path) -> Result<SigningKey, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("读取私钥 {} 失败：{e}", path.display()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| format!("{} 不是 base64 编码的私钥", path.display()))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| format!("{} 不是 32 字节私钥", path.display()))?;
    Ok(SigningKey::from_bytes(&arr))
}

/// 比客户端 `update::parse_version` 更严：客户端取前三段就能比较，所以 `1.2.3.4`
/// 在它那边「能用」；这里直接拒绝，免得签出一份名不副实的四段版本号。
/// 三段数字 + 可选 `-pre` 后缀是唯一被接受的形式。
fn version_is_parseable(v: &str) -> bool {
    let core = v.split('-').next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_check_matches_client_rules() {
        for ok in ["1.2.3", "0.1.0", "10.20.30", "1.2.3-pre"] {
            assert!(version_is_parseable(ok), "{ok} 应被接受");
        }
        for bad in ["1.2", "v1.2.3", "1.2.x", "", "1..3"] {
            assert!(!version_is_parseable(bad), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn flags_require_values() {
        let f = Flags::parse(&["--dir".into(), "/tmp/x".into(), "--notes".into(), "n".into()]).unwrap();
        assert_eq!(f.get("dir"), Some("/tmp/x"));
        assert_eq!(f.get("notes"), Some("n"));
        assert!(f.require("missing").is_err());
    }

    /// 缺值必须报错：静默吞成空串会签出一份 `notes` 与 `date` 都对不上的清单。
    #[test]
    fn flags_without_values_are_rejected() {
        assert!(Flags::parse(&["--dir".into(), "/tmp/x".into(), "--notes".into()]).is_err());
        assert!(Flags::parse(&["/tmp/x".into()]).is_err());
    }

    /// 端到端：真签一份清单，再用客户端验签的两步（重算 canonical、验 ed25519）回放。
    /// 任何一步对不上，签出来的清单在所有终端上都会被拒。
    #[test]
    fn signed_manifest_verifies_the_way_the_client_checks_it() {
        let dir = tempfile::tempdir().unwrap();
        let key_dir = dir.path().join("keys");
        let share = dir.path().join("share");
        std::fs::create_dir_all(share.join(PACKAGE_DIR)).unwrap();
        std::fs::write(share.join(PACKAGE_DIR).join("app.dmg"), b"fake dmg bytes").unwrap();

        let flags = Flags::parse(&["--out".into(), key_dir.display().to_string()]).unwrap();
        keygen(&flags).unwrap();
        let key_flags = Flags::parse(&[
            "--dir".into(),
            share.display().to_string(),
            "--version".into(),
            "0.2.0".into(),
            "--key".into(),
            key_dir.join(KEY_FILE).display().to_string(),
            "--notes".into(),
            "修复若干问题".into(),
        ])
        .unwrap();
        sign(&key_flags).unwrap();

        let manifest: Manifest =
            serde_json::from_str(&std::fs::read_to_string(share.join(MANIFEST_FILE)).unwrap()).unwrap();
        assert_eq!(manifest.packages.len(), 1);
        assert_eq!(manifest.packages[0].size, b"fake dmg bytes".len() as i64);
        // 内容寻址：url 里嵌的就是 sha256，局域网通道据此取包并复核哈希。
        assert!(manifest.packages[0].url.starts_with("lan://"));
        assert!(manifest.packages[0].url.ends_with(".dmg"));

        let expected = canonical_of(
            &manifest.version,
            &manifest.channel,
            &manifest.date,
            &manifest.notes,
            &manifest.packages,
        );
        assert_eq!(expected, manifest.canonical, "规范串必须能原样重算出来");

        let pub_raw = std::fs::read_to_string(key_dir.join(PUB_FILE)).unwrap();
        let pub_bytes = base64::engine::general_purpose::STANDARD.decode(pub_raw.trim()).unwrap();
        let verifying = ed25519_dalek::VerifyingKey::from_bytes(&pub_bytes.try_into().unwrap()).unwrap();
        let sig_bytes = base64::engine::general_purpose::STANDARD.decode(&manifest.signature).unwrap();
        let signature = ed25519_dalek::Signature::from_slice(&sig_bytes).unwrap();
        verifying.verify_strict(manifest.canonical.as_bytes(), &signature).unwrap();
    }
}
