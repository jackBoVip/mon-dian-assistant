//! 托管目录加载：源机器只读一份**已签名**清单，自己不持有私钥。
//!
//! 目录约定（由 `mda_release sign` 生成）：
//! ```text
//! <serve_dir>/manifest.json
//! <serve_dir>/packages/<sha256>.<ext>
//! ```
//!
//! 启动自检任何一项不过就拒绝开启服务，绝不降级成「不校验也托管」——
//! 那样客户端会收到一份验不过的清单，故障现场从源机器转移到所有客户端。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};
use crate::update::{self, Manifest};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const PACKAGE_DIR: &str = "packages";

pub struct Share {
    /// 原样字节：`/manifest` 必须原样下发，重排 JSON 会导致客户端 canonical 对不上。
    pub manifest_bytes: Vec<u8>,
    pub manifest: Manifest,
    packages: HashMap<String, PathBuf>,
}

impl Share {
    pub fn package_path(&self, sha: &str) -> Option<&Path> {
        self.packages.get(sha).map(|p| p.as_path())
    }

    /// 测试专用：真 Socket 往返不需要真签名清单，但生产路径只能走 [`load`]。
    #[cfg(test)]
    pub(crate) fn for_test(manifest_bytes: Vec<u8>) -> Self {
        Share {
            manifest_bytes,
            manifest: Manifest {
                version: "0.2.0".into(),
                channel: "stable".into(),
                date: String::new(),
                notes: String::new(),
                packages: Vec::new(),
                canonical: String::new(),
                signature: String::new(),
                signer: String::new(),
            },
            packages: HashMap::new(),
        }
    }
}

/// 加载并自检托管目录。失败返回具体错误码，界面据此说明「为什么开不起来」。
pub fn load(dir: &Path) -> Result<Share> {
    if !dir.is_dir() {
        return Err(AppError::NotFound);
    }
    let manifest_bytes = std::fs::read(dir.join(MANIFEST_FILE)).map_err(|_| AppError::NotFound)?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| AppError::UpdateManifestInvalid)?;

    // 没有公钥就绝不开服务：源机器自证不了清单，客户端也一定验不过。
    let key = update::release_pubkey().ok_or(AppError::UpdateSignatureInvalid)?;
    update::verify_manifest(&manifest, &key)?;

    let mut packages = HashMap::new();
    for p in &manifest.packages {
        let sha = p.sha256.to_ascii_lowercase();
        if !is_sha256_hex(&sha) {
            return Err(AppError::UpdateManifestInvalid);
        }
        let path = dir
            .join(PACKAGE_DIR)
            .join(format!("{sha}.{}", update::package_extension(p)));
        let meta = std::fs::metadata(&path).map_err(|_| AppError::NotFound)?;
        if !meta.is_file() || (p.size > 0 && meta.len() != p.size as u64) {
            return Err(AppError::UpdateManifestInvalid);
        }
        packages.insert(sha, path);
    }
    if packages.is_empty() {
        return Err(AppError::UpdateManifestInvalid);
    }
    Ok(Share { manifest_bytes, manifest, packages })
}

/// 只认 64 位小写十六进制。路由表中它是唯一由请求方提供的片段，因此必须严格。
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_strict() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(is_sha256_hex(&"0123456789abcdef".repeat(4)));
        assert!(!is_sha256_hex(&"A".repeat(64)), "大写不接受：路由表用小写作键");
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(!is_sha256_hex(&"g".repeat(64)));
        assert!(!is_sha256_hex(""));
    }

    /// 自检失败必须返回错误，而不是返回一个空 `Share` 让服务照常起起来。
    #[test]
    fn missing_directory_and_manifest_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(load(&dir.path().join("nope")), Err(AppError::NotFound)));
        assert!(matches!(load(dir.path()), Err(AppError::NotFound)));
    }

    #[test]
    fn malformed_manifest_is_rejected_before_touching_packages() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(MANIFEST_FILE), b"not json").unwrap();
        assert!(matches!(load(dir.path()), Err(AppError::UpdateManifestInvalid)));
    }
}
