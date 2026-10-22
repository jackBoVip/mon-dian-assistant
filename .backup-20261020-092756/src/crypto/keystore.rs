//! 系统安全存储：**本包只读它一次，用来把旧版本存放的数据库主密钥迁移出来**。
//!
//! 为什么不再是首选存放位置（操作者 2026-10-17 的决定，需求 §7.2 的偏离声明见
//! docs/密钥生命周期与加密边界.md）：macOS 把钥匙串条目的访问控制绑定在应用的签名身份上，
//! 本包是 ad-hoc 签名，每次重新打包身份都变，于是每次换包首启都会弹一次授权对话框——
//! 现场每升级一次就要有人点一次，误点"拒绝"应用停在启动失败页。
//! 数据库主密钥改用本机 0600 文件密钥（默认存放位置）后，全新安装**一次都不会**访问钥匙串。
//!
//! 因此这个模块里**不许再有写入、探测或删除**：`set_password` 与 `delete_credential`
//! 都是会弹授权框的调用，`lib.rs` 的 `production_source_has_no_keystore_writes` 守着这条。
//! 只读也不许在没有旧库的时候发生——调用点在 `lib.rs` 的 `TryMigrateFromKeystore` 那一格。

use super::{CryptoError, Result, SecretBytes, KEY_LEN};

const SERVICE: &str = "com.mda.assistant";
const DB_KEY_ACCOUNT: &str = "vault-db-key-v1";

/// 读取旧版本存放在系统安全存储里的数据库主密钥。
///
/// 这是本包唯一一处钥匙串访问，只在"vault.db 已存在但本机没有文件密钥"时被调用一次。
/// macOS Keychain / Windows Credential Manager / Linux Secret Service 都按同一套键名读。
pub fn load_db_key() -> Result<SecretBytes> {
    let entry = keyring::Entry::new(SERVICE, DB_KEY_ACCOUNT).map_err(|_| CryptoError::KeyStoreUnavailable)?;
    // 把安全存储给出的原因文本写进日志（只有原因，不含任何密钥材料）：
    // "条目本来就不存在"和"授权被拒/钥匙串被锁"要分得开，否则运维在授权框上点错一次无从排查。
    let encoded = entry.get_password().map_err(|e| {
        log::warn!("系统安全存储未取到数据库密钥：{}", e);
        CryptoError::KeyStoreUnavailable
    })?;
    let raw = key_b64::decode(&encoded).map_err(|_| CryptoError::MalformedInput)?;
    if raw.len() != KEY_LEN {
        return Err(CryptoError::MalformedInput);
    }
    Ok(SecretBytes::new(raw))
}

/// 不叫 `base64` 是为了不和依赖同名：测试里要直接用 `base64` crate 本身，同名会挡路。
mod key_b64 {
    pub fn decode(s: &str) -> std::result::Result<Vec<u8>, ()> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn key_length_is_256_bits() {
        assert_eq!(KEY_LEN, 32);
    }

    /// 生产侧只需要解码（密钥只进不出），所以这里用标准库自己编码、只断言本模块的解码认它。
    #[test]
    fn decoder_reads_standard_base64() {
        let raw = super::super::random_bytes(32);
        let text = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(key_b64::decode(&text).unwrap(), raw);
    }
}

/// 旧存放位置的平台后端名称，只用于界面如实显示"那份旧密钥原本放在哪"。
/// 纯字符串，不会因为这个调用去访问钥匙串。
pub fn platform_backend() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(target_os = "windows") {
        "Windows Credential Manager (DPAPI)"
    } else {
        "Secret Service / libsecret"
    }
}
