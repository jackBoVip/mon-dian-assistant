//! 保险库密钥：随机 DEK + 每位使用者独立的 AES-256-GCM 封装。
//! 改密码只重新封装 DEK，绝不重新加密台账数据，因此不会使已有凭据不可恢复。

use super::aead;
use super::kdf::{self, KdfParams};
use super::{CryptoError, Result, SecretBytes, KEY_LEN, SALT_LEN};
use zeroize::Zeroizing;

pub const PAYLOAD_VERSION: i64 = 1;

/// 已解锁的保险库密钥上下文。
pub struct VaultKey {
    pub dek: SecretBytes,
    pub key_version: i64,
}

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "VaultKey(version={})", self.key_version)
    }
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.dek.0.zeroize();
    }
}

/// 落盘所需的全部内容（无任何明文密钥/明文口令）。
pub struct InitMaterial {
    pub verify_salt: Vec<u8>,
    pub verify_hash: Vec<u8>,
    pub wrap_salt: Vec<u8>,
    pub wrap_nonce: Vec<u8>,
    pub wrapped_dek: Vec<u8>,
    pub aad: String,
    pub kdf_m_kib: u32,
    pub kdf_t: u32,
    pub kdf_p: u32,
}

fn aad_for(user_id: &str, key_version: i64) -> String {
    format!("mda|user-key-wrapper-v1|{user_id}|k{key_version}")
}

/// 首次初始化：生成随机 DEK，并用主密码派生的 KEK 封装。
pub fn initialize(password: &str, user_id: &str, key_version: i64, params: &KdfParams) -> Result<(VaultKey, InitMaterial)> {
    if password.is_empty() {
        return Err(CryptoError::MalformedInput);
    }
    let dek = super::random_key();
    let material = wrap_dek(password, user_id, key_version, &dek, params)?;
    Ok((VaultKey { dek, key_version }, material))
}

pub fn wrap_dek(
    password: &str,
    user_id: &str,
    key_version: i64,
    dek: &SecretBytes,
    params: &KdfParams,
) -> Result<InitMaterial> {
    let verify_salt = super::random_bytes(SALT_LEN);
    let wrap_salt = super::random_bytes(SALT_LEN);
    let verify_hash = kdf::derive_verifier(password, &verify_salt, params)?;
    let kek = kdf::derive_wrap_key(password, &wrap_salt, params)?;
    let aad = aad_for(user_id, key_version);
    let (wrapped_dek, wrap_nonce) = aead::encrypt(&kek, dek.as_slice(), aad.as_bytes())?;
    Ok(InitMaterial {
        verify_salt,
        verify_hash: verify_hash.to_vec(),
        wrap_salt,
        wrap_nonce,
        wrapped_dek,
        aad,
        kdf_m_kib: params.m_kib,
        kdf_t: params.t,
        kdf_p: params.p,
    })
}

/// 校验主密码并解出 DEK。密码错误 → `AuthenticationFailed`，不返回任何密钥材料。
pub fn unlock(
    password: &str,
    user_id: &str,
    key_version: i64,
    verify_salt: &[u8],
    expected_verify: &[u8],
    wrap_salt: &[u8],
    wrap_nonce: &[u8],
    wrapped_dek: &[u8],
    params: &KdfParams,
) -> Result<VaultKey> {
    let candidate = kdf::derive_verifier(password, verify_salt, params)?;
    if !kdf::verifier_matches(expected_verify, candidate.as_slice()) {
        return Err(CryptoError::AuthenticationFailed);
    }
    let dek = unwrap_dek(password, user_id, key_version, wrap_salt, wrap_nonce, wrapped_dek, params)?;
    Ok(VaultKey { dek, key_version })
}

pub fn unwrap_dek(
    password: &str,
    user_id: &str,
    key_version: i64,
    wrap_salt: &[u8],
    wrap_nonce: &[u8],
    wrapped_dek: &[u8],
    params: &KdfParams,
) -> Result<SecretBytes> {
    let kek = kdf::derive_wrap_key(password, wrap_salt, params)?;
    let plain = aead::decrypt(&kek, wrapped_dek, wrap_nonce, aad_for(user_id, key_version).as_bytes())?;
    if plain.len() != KEY_LEN {
        return Err(CryptoError::MalformedInput);
    }
    Ok(SecretBytes::new(plain.to_vec()))
}

/// 修改主密码：DEK 原样保留，只换验证材料与封装。已有台账保持可解密。
pub fn change_password(
    current_password: &str,
    new_password: &str,
    user_id: &str,
    key_version: i64,
    verify_salt: &[u8],
    expected_verify: &[u8],
    wrap_salt: &[u8],
    wrap_nonce: &[u8],
    wrapped_dek: &[u8],
    params: &KdfParams,
) -> Result<(VaultKey, InitMaterial)> {
    let dek = unlock(
        current_password,
        user_id,
        key_version,
        verify_salt,
        expected_verify,
        wrap_salt,
        wrap_nonce,
        wrapped_dek,
        params,
    )?;
    let material = wrap_dek(new_password, user_id, key_version, &dek.dek, params)?;
    Ok((VaultKey { dek: SecretBytes::new(dek.dek.as_slice().to_vec()), key_version }, material))
}

/// 用已解锁的 DEK 加密凭据载荷。
pub fn seal_payload(vk: &VaultKey, record_id: &str, record_type: &str, plaintext: &[u8]) -> Result<Sealed> {
    let aad = aead::build_aad(record_id, record_type, vk.key_version, PAYLOAD_VERSION);
    let (ciphertext, nonce) = aead::encrypt(vk.dek.as_slice(), plaintext, &aad)?;
    Ok(Sealed { ciphertext, nonce, algorithm: aead::ALGORITHM.to_string(), key_version: vk.key_version, payload_schema_version: PAYLOAD_VERSION })
}

pub fn open_payload(vk: &VaultKey, record_id: &str, record_type: &str, sealed: &Sealed) -> Result<Zeroizing<Vec<u8>>> {
    let aad = aead::build_aad(record_id, record_type, sealed.key_version, sealed.payload_schema_version);
    aead::decrypt(vk.dek.as_slice(), &sealed.ciphertext, &sealed.nonce, &aad)
}

#[derive(Debug, Clone)]
pub struct Sealed {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub algorithm: String,
    pub key_version: i64,
    pub payload_schema_version: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast() -> KdfParams {
        KdfParams { m_kib: 4096, t: 2, p: 1 }
    }

    #[test]
    fn unlock_with_correct_password_returns_same_dek() {
        let p = fast();
        let (vk, m) = initialize("Master#2026", "u-1", 1, &p).unwrap();
        let again = unlock("Master#2026", "u-1", 1, &m.verify_salt, &m.verify_hash, &m.wrap_salt, &m.wrap_nonce, &m.wrapped_dek, &p).unwrap();
        assert_eq!(vk.dek.as_slice(), again.dek.as_slice());
    }

    #[test]
    fn wrong_master_password_fails_and_leaks_nothing() {
        let p = fast();
        let (_, m) = initialize("Master#2026", "u-1", 1, &p).unwrap();
        let r = unlock("nope", "u-1", 1, &m.verify_salt, &m.verify_hash, &m.wrap_salt, &m.wrap_nonce, &m.wrapped_dek, &p);
        assert!(matches!(r, Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn wrapped_dek_does_not_contain_plaintext_key() {
        let p = fast();
        let (vk, m) = initialize("Master#2026", "u-1", 1, &p).unwrap();
        assert!(!m.wrapped_dek.windows(16).any(|w| w == &vk.dek.as_slice()[..16]));
    }

    #[test]
    fn change_password_keeps_dek_and_payload_decryptable() {
        let p = fast();
        let (vk, m) = initialize("Old#12345", "u-1", 1, &p).unwrap();
        let sealed = seal_payload(&vk, "item-1", "vault_item", b"external-site-password").unwrap();

        let (vk2, m2) = change_password("Old#12345", "New#99999", "u-1", 1, &m.verify_salt, &m.verify_hash, &m.wrap_salt, &m.wrap_nonce, &m.wrapped_dek, &p).unwrap();
        assert_eq!(vk.dek.as_slice(), vk2.dek.as_slice(), "DEK 必须保持不变");
        let pt = open_payload(&vk2, "item-1", "vault_item", &sealed).unwrap();
        assert_eq!(pt.as_slice(), b"external-site-password");
        // 旧密码不再能解锁新封装
        assert!(unlock("Old#12345", "u-1", 1, &m2.verify_salt, &m2.verify_hash, &m2.wrap_salt, &m2.wrap_nonce, &m2.wrapped_dek, &p).is_err());
    }

    #[test]
    fn wrapper_aad_binds_user_id() {
        let p = fast();
        let (_, m) = initialize("Master#2026", "u-1", 1, &p).unwrap();
        // 攻击者把 u-1 的封装挂到 u-2 名下
        let r = unwrap_dek("Master#2026", "u-2", 1, &m.wrap_salt, &m.wrap_nonce, &m.wrapped_dek, &p);
        assert!(r.is_err());
    }

    #[test]
    fn payload_aad_binds_record_id() {
        let p = fast();
        let (vk, _) = initialize("Master#2026", "u-1", 1, &p).unwrap();
        let sealed = seal_payload(&vk, "item-A", "vault_item", b"secret").unwrap();
        assert!(open_payload(&vk, "item-B", "vault_item", &sealed).is_err());
    }
}
