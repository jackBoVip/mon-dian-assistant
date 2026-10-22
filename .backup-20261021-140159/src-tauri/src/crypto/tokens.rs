//! 一次性授权票据：桌面端 ↔ Native Messaging 宿主 ↔ 浏览器扩展。
//! 绑定 (target_id, credential_id, origin, app_user_id, session)，短时、一次性、防重放。
//! 内存中只保存票据的 HMAC 摘要，即使进程内存转储也不暴露可重放的原始票据。

use super::aead::hmac_sha256;
use crate::error::{AppError, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use zeroize::Zeroizing;

pub const TICKER_TTL_SECONDS: i64 = 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketBinding {
    pub target_id: String,
    pub credential_id: String,
    pub origin: String,
    pub app_user_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IssuedTicket {
    pub id: String,
    pub secret: Zeroizing<String>,
    pub expires_at: i64,
}

struct Stored {
    binding: TicketBinding,
    digest: Vec<u8>,
    expires_at: i64,
    /// AEAD 封装的一次性秘密（密钥由 pepper 派生），保证内存对象即使被 dump 也不含可读秘密
    sealed_secret: Vec<u8>,
}

impl Stored {
    fn reveal(&self, pepper: &[u8]) -> Option<Zeroizing<String>> {
        let key = hmac_sha256(pepper, b"ticket-secret-key-v1");
        let nonce: &[u8] = self.sealed_secret.get(..crate::crypto::NONCE_LEN)?;
        let ct: &[u8] = self.sealed_secret.get(crate::crypto::NONCE_LEN..)?;
        let pt = crate::crypto::aead::decrypt(key.as_ref(), ct, nonce, SECRET_AAD).ok()?;
        String::from_utf8(pt.to_vec()).map(Zeroizing::new).ok()
    }
}

#[derive(Default)]
pub struct TicketStore {
    inner: Mutex<HashMap<String, Stored>>,
    pepper: Mutex<Option<Vec<u8>>>,
}

fn now_epoch() -> i64 {
    chrono::Utc::now().timestamp()
}

const SECRET_AAD: &[u8] = b"ticket-secret-v1";

fn digest(pepper: &[u8], id: &str, secret: &str) -> Vec<u8> {
    hmac_sha256(pepper, format!("{id}|{secret}").as_bytes()).to_vec()
}

/// 票据秘密在内存里也以 AEAD 封装保存，只有出示时（redeem 比对摘要）与
/// Native Messaging 交付（grant_for_origin）才解密，Drop 后立即清零。
fn seal_secret(pepper: &[u8], secret: &str) -> Vec<u8> {
    let key = hmac_sha256(pepper, b"ticket-secret-key-v1");
    let (ct, nonce) = crate::crypto::aead::encrypt(key.as_ref(), secret.as_bytes(), SECRET_AAD)
        .expect("AES-GCM 加密固定长度密钥不会失败");
    let mut out = Vec::with_capacity(nonce.len() + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

impl TicketStore {
    fn pepper(&self) -> Vec<u8> {
        let mut guard = self.pepper.lock();
        if guard.is_none() {
            *guard = Some(crate::crypto::random_bytes(32));
        }
        guard.clone().unwrap()
    }

    pub fn issue(&self, binding: TicketBinding) -> Result<IssuedTicket> {
        let id = uuid::Uuid::now_v7().to_string();
        let secret = Zeroizing::new(base64_secret(&crate::crypto::random_bytes(32)));
        let expires_at = now_epoch() + TICKER_TTL_SECONDS;
        let pepper = self.pepper();
        let d = digest(&pepper, &id, secret.as_str());
        let sealed = seal_secret(&pepper, secret.as_str());
        self.inner.lock().insert(id.clone(), Stored { binding, digest: d, expires_at, sealed_secret: sealed });
        self.sweep_expired();
        Ok(IssuedTicket { id, secret, expires_at })
    }

    /// 校验并消费。任何一项不符都返回 Err，且票据无论成功失败都被移除（一次性）。
    pub fn redeem(&self, id: &str, secret: &str, presented: &TicketBinding) -> Result<TicketBinding> {
        let removed = self.inner.lock().remove(id);
        let stored = removed.ok_or(AppError::TicketUnknown)?;
        if now_epoch() > stored.expires_at {
            return Err(AppError::TicketExpired);
        }
        let expected = digest(&self.pepper(), id, secret);
        if !constant_time_eq::constant_time_eq(&expected, &stored.digest) {
            return Err(AppError::TicketInvalid);
        }
        if stored.binding != *presented {
            return Err(AppError::TicketBindingMismatch);
        }
        Ok(stored.binding)
    }

    /// 会话失效 / 应用锁定时撤销该会话下所有未使用票据。
    pub fn revoke_session(&self, session_id: &str) {
        let mut g = self.inner.lock();
        g.retain(|_, v| v.binding.session_id != session_id);
    }

    /// 供 Native Messaging 通道查询：该 Origin 是否存在未消费的填充授权。
    /// 返回票据 id + 一次性秘密；命中后不立即删除，由 `redeem` 在扩展出示时消费（一次性）。
    pub fn grant_for_origin(&self, origin: &str, session_id: &str) -> Option<(String, Zeroizing<String>, TicketBinding)> {
        let pepper = self.pepper();
        let g = self.inner.lock();
        for (id, st) in g.iter() {
            if st.binding.origin == origin && st.binding.session_id == session_id && now_epoch() <= st.expires_at {
                let secret = st.reveal(&pepper)?;
                return Some((id.clone(), secret, st.binding.clone()));
            }
        }
        None
    }

    pub fn expires_at(&self, id: &str) -> Option<i64> {
        self.inner.lock().get(id).map(|s| s.expires_at)
    }

    pub fn pending_count(&self) -> usize {
        self.inner.lock().len()
    }

    fn sweep_expired(&self) {
        let now = now_epoch();
        let mut g = self.inner.lock();
        g.retain(|_, v| v.expires_at > now);
    }
}

fn base64_secret(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> TicketBinding {
        TicketBinding {
            target_id: "t-1".into(),
            credential_id: "c-1".into(),
            origin: "https://oa.example.cn".into(),
            app_user_id: "u-1".into(),
            session_id: "s-1".into(),
        }
    }

    #[test]
    fn redeem_succeeds_once() {
        let s = TicketStore::default();
        let t = s.issue(binding()).unwrap();
        assert_eq!(s.redeem(&t.id, &t.secret, &binding()).unwrap().credential_id, "c-1");
        assert!(matches!(s.redeem(&t.id, &t.secret, &binding()), Err(AppError::TicketUnknown)));
    }

    #[test]
    fn wrong_secret_rejected() {
        let s = TicketStore::default();
        let t = s.issue(binding()).unwrap();
        assert!(matches!(s.redeem(&t.id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &binding()), Err(AppError::TicketInvalid)));
    }

    #[test]
    fn cannot_fill_a_different_credential_with_same_ticket() {
        let s = TicketStore::default();
        let t = s.issue(binding()).unwrap();
        let other = TicketBinding { credential_id: "c-OTHER".into(), ..binding() };
        assert!(matches!(s.redeem(&t.id, &t.secret, &other), Err(AppError::TicketBindingMismatch)));
    }

    #[test]
    fn origin_and_session_are_bound() {
        let s = TicketStore::default();
        let t = s.issue(binding()).unwrap();
        assert!(s.redeem(&t.id, &t.secret, &TicketBinding { origin: "https://evil.example.cn".into(), ..binding() }).is_err());
        assert!(s.redeem(&t.id, &t.secret, &TicketBinding { session_id: "s-2".into(), ..binding() }).is_err());
    }

    #[test]
    fn revoke_session_kills_pending_tickets() {
        let s = TicketStore::default();
        s.issue(binding()).unwrap();
        assert_eq!(s.pending_count(), 1);
        s.revoke_session("s-1");
        assert_eq!(s.pending_count(), 0);
    }
}
