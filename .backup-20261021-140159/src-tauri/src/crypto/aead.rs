//! AES-256-GCM AEAD。每次加密随机 nonce，AAD 绑定「记录 ID + 类型 + 密钥版本 + 载荷版本」，
//! 使密文在记录之间调换时必然解密失败（fail-closed）。

use super::{CryptoError, Result, NONCE_LEN};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

pub const ALGORITHM: &str = "AES-256-GCM";

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(msg);
    Zeroizing::new(mac.finalize().into_bytes().to_vec())
}

/// 构造与记录绑定的 AAD。
pub fn build_aad(record_id: &str, record_type: &str, key_version: i64, payload_version: i64) -> Vec<u8> {
    format!("v1|{record_type}|{record_id}|k{key_version}|p{payload_version}").into_bytes()
}

pub fn encrypt(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::MalformedInput)?;
    let nonce_bytes = super::random_bytes(NONCE_LEN);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError::AeadFailed)?;
    Ok((ct, nonce_bytes))
}

pub fn decrypt(key: &[u8], ciphertext: &[u8], nonce: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::MalformedInput);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::MalformedInput)?;
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| CryptoError::AuthenticationFailed)?;
    Ok(Zeroizing::new(pt))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Vec<u8> {
        (0u8..32).collect()
    }

    #[test]
    fn roundtrip() {
        let k = key();
        let aad = build_aad("item-1", "vault_item", 1, 1);
        let (ct, nonce) = encrypt(&k, b"my-password", &aad).unwrap();
        assert_ne!(&ct[..], b"my-password".as_slice());
        let pt = decrypt(&k, &ct, &nonce, &aad).unwrap();
        assert_eq!(pt.as_slice(), b"my-password");
    }

    #[test]
    fn wrong_key_fails_closed() {
        let k = key();
        let aad = build_aad("item-1", "vault_item", 1, 1);
        let (ct, nonce) = encrypt(&k, b"secret", &aad).unwrap();
        let other: Vec<u8> = (32u8..64).collect();
        assert!(matches!(decrypt(&other, &ct, &nonce, &aad), Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let k = key();
        let aad = build_aad("item-1", "vault_item", 1, 1);
        let (mut ct, nonce) = encrypt(&k, b"secret", &aad).unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0x01;
        assert!(decrypt(&k, &ct, &nonce, &aad).is_err());
    }

    #[test]
    fn ciphertext_swap_between_records_is_rejected() {
        let k = key();
        let aad_a = build_aad("item-A", "vault_item", 1, 1);
        let aad_b = build_aad("item-B", "vault_item", 1, 1);
        let (ct_a, nonce_a) = encrypt(&k, b"a-password", &aad_a).unwrap();
        // 攻击者把 A 的密文搬到 B 名下
        assert!(matches!(decrypt(&k, &ct_a, &nonce_a, &aad_b), Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn nonce_is_randomized() {
        let k = key();
        let aad = build_aad("i", "vault_item", 1, 1);
        let (_, n1) = encrypt(&k, b"x", &aad).unwrap();
        let (_, n2) = encrypt(&k, b"x", &aad).unwrap();
        assert_ne!(n1, n2);
    }
}
