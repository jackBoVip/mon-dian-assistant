//! 加密边界：
//! - 主密码：Argon2id 派生，只产生「验证材料」与「密钥封装密钥(KEK)」，两者使用独立盐。
//! - 保险库数据密钥(DEK)：随机高熵，永不落盘明文；由 KEK 通过 AES-256-GCM 封装保存。
//! - 可恢复凭据（外部系统密码/Token/私钥）：AEAD 加密，AAD 绑定记录 ID + 类型 + 版本。
//! - 本模块绝不提供「加密后保存主密码原文」的路径。

pub mod aead;
pub mod kdf;
pub mod keystore;
pub mod tokens;
pub mod vault_key;

use thiserror::Error;
use zeroize::Zeroize;

pub use vault_key::VaultKey;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("CRYPTO_KDF_FAILED")]
    KdfFailed,
    #[error("CRYPTO_AEAD_FAILED")]
    AeadFailed,
    #[error("CRYPTO_AUTH_FAILED")]
    AuthenticationFailed,
    #[error("CRYPTO_NONCE_EXHAUSTED")]
    NonceExhausted,
    #[error("CRYPTO_KEYSTORE_UNAVAILABLE")]
    KeyStoreUnavailable,
    #[error("CRYPTO_MALFORMED_INPUT")]
    MalformedInput,
}

pub type Result<T> = std::result::Result<T, CryptoError>;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;

/// 32 字节密钥材料，离开作用域即清零。
#[derive(Clone, zeroize::Zeroize)]
#[zeroize(drop)]
pub struct SecretBytes(pub Vec<u8>);

impl SecretBytes {
    pub fn new(v: Vec<u8>) -> Self {
        Self(v)
    }
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretBytes(<redacted:{}>)", self.0.len())
    }
}

/// 秘密字符串：序列化进加密载荷时保留明文，Debug 输出永远脱敏，Drop 时清零。
#[derive(Clone, Default, zeroize::Zeroize)]
#[zeroize(drop)]
pub struct SecretString(zeroize::Zeroizing<String>);

impl SecretString {
    pub fn new(v: impl Into<String>) -> Self {
        Self(zeroize::Zeroizing::new(v.into()))
    }
    /// 仅在确需使用明文时调用（写剪贴板、填充请求）。
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretString(<redacted:{}>)", self.0.chars().count())
    }
}

impl serde::Serialize for SecretString {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.0.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for SecretString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(d)?;
        Ok(SecretString(zeroize::Zeroizing::new(raw)))
    }
}

impl From<&str> for SecretString {
    fn from(v: &str) -> Self {
        SecretString::new(v)
    }
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut out = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut out);
    out
}

pub fn random_key() -> SecretBytes {
    SecretBytes::new(random_bytes(KEY_LEN))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_bytes_are_distinct_and_correct_length() {
        let a = random_bytes(32);
        let b = random_bytes(32);
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}

/// 标准 base64 编码：只用于通道令牌、清单标识等非秘密值；秘密本身从不编码落盘。
pub fn b64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
