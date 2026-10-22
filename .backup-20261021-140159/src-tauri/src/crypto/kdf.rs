//! Argon2id 口令派生。同一主密码 + 独立盐 + 用途标签 → 验证材料与封装密钥不可互推。

use super::aead::hmac_sha256;
use super::{CryptoError, Result, KEY_LEN};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;

/// 企业桌面基线：19 MiB / 2 轮 / 1 并行度。
pub const DEFAULT_M_KIB: u32 = 19 * 1024;
pub const DEFAULT_T: u32 = 2;
pub const DEFAULT_P: u32 = 1;

pub const VERIFY_CONTEXT: &[u8] = b"mda/password-verifier-v1";
pub const WRAP_CONTEXT: &[u8] = b"mda/dek-wrapper-v1";

#[derive(Debug, Clone, Copy)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self { m_kib: DEFAULT_M_KIB, t: DEFAULT_T, p: DEFAULT_P }
    }
}

/// Argon2id 派生 32 字节，再用 HMAC 混入用途标签 `context`。
pub fn derive(password: &str, salt: &[u8], context: &[u8], params: &KdfParams) -> Result<Zeroizing<Vec<u8>>> {
    if salt.len() < 8 {
        return Err(CryptoError::MalformedInput);
    }
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(params.m_kib, params.t, params.p, Some(KEY_LEN))
            .map_err(|_| CryptoError::KdfFailed)?,
    );
    let mut out = vec![0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|_| CryptoError::KdfFailed)?;
    let mixed = hmac_sha256(&out, context);
    out.copy_from_slice(mixed.as_slice());
    Ok(Zeroizing::new(out))
}

pub fn derive_verifier(password: &str, salt: &[u8], params: &KdfParams) -> Result<Zeroizing<Vec<u8>>> {
    derive(password, salt, VERIFY_CONTEXT, params)
}

pub fn derive_wrap_key(password: &str, salt: &[u8], params: &KdfParams) -> Result<Zeroizing<Vec<u8>>> {
    derive(password, salt, WRAP_CONTEXT, params)
}

/// 常量时间比较，避免通过耗时差异判断口令是否正确。
pub fn verifier_matches(expected: &[u8], candidate: &[u8]) -> bool {
    constant_time_eq::constant_time_eq(expected, candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams { m_kib: 4096, t: 2, p: 1 };

    #[test]
    fn same_password_different_salt_yields_different_output() {
        let a = derive_verifier("correct horse", b"0123456789abcdef", &FAST).unwrap();
        let b = derive_verifier("correct horse", b"fedcba9876543210", &FAST).unwrap();
        assert_ne!(a.as_slice(), b.as_slice());
        assert_eq!(a.len(), KEY_LEN);
    }

    #[test]
    fn deterministic_for_same_inputs() {
        let a = derive_verifier("pw", b"salt-salt-salt", &FAST).unwrap();
        let b = derive_verifier("pw", b"salt-salt-salt", &FAST).unwrap();
        assert_eq!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn verifier_and_wrap_key_differ_even_with_same_salt() {
        let salt = b"shared-salt-123456";
        let v = derive_verifier("pw", salt, &FAST).unwrap();
        let w = derive_wrap_key("pw", salt, &FAST).unwrap();
        assert_ne!(v.as_slice(), w.as_slice());
    }

    #[test]
    fn wrong_password_yields_different_verifier() {
        let v1 = derive_verifier("right", b"0000000000000000", &FAST).unwrap();
        let v2 = derive_verifier("wrong", b"0000000000000000", &FAST).unwrap();
        assert!(!verifier_matches(v1.as_slice(), v2.as_slice()));
        assert!(verifier_matches(v1.as_slice(), v1.as_slice()));
    }

    #[test]
    fn rejects_short_salt() {
        assert!(matches!(derive_verifier("pw", b"tiny", &FAST), Err(CryptoError::MalformedInput)));
    }
}
