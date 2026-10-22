//! 会话与保险库解锁状态机（内存态）。

use crate::crypto::vault_key::VaultKey;
use crate::quick_launcher::search::SearchIndex;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub started_at: i64,
    pub last_activity: i64,
    /// 最近一次二次认证的时刻（秒）。窗口长度由 reauth_window_seconds 在**校验时**读取，
    /// 因此管理员收紧策略后已发放的认证立即失效；这里绝不存"到期时刻"，否则窗口会被叠加成两倍。
    pub reauth_at: Option<i64>,
}

impl Session {
    pub fn is_expired(&self, idle_timeout_seconds: i64, now: i64) -> bool {
        idle_timeout_seconds > 0 && now - self.last_activity > idle_timeout_seconds
    }
    pub fn has_fresh_reauth(&self, window_seconds: i64, now: i64) -> bool {
        self.reauth_at.map(|t| now <= t + window_seconds).unwrap_or(false)
    }
}

/// 进程内的保险库状态。锁定后不得残留任何明文索引或密钥。
#[derive(Default)]
pub struct VaultState {
    inner: Mutex<VaultStateInner>,
}

#[derive(Default)]
struct VaultStateInner {
    unlocked: bool,
    session: Option<Session>,
    vk: Option<Arc<VaultKey>>,
    index: Option<Arc<SearchIndex>>,
    /// 用于检测「切换本地使用者」
    active_user: Option<String>,
}

impl VaultState {
    /// VaultState 的锁不可重入：guard 若被带进回调，回调里任何一次回碰 vault 状态
    /// （with_vk / with_index / replace_index / lock）都会同线程永久死锁。
    /// 测试构建下把它变成显式 panic（带定位信息），而不是无声挂死。
    fn lock_inner(&self) -> parking_lot::MutexGuard<'_, VaultStateInner> {
        #[cfg(test)]
        if self.inner.is_locked() {
            panic!("同线程重入锁定 VaultState（auth/session.rs::lock_inner）——会永久挂死进程；请先在锁内取出 Arc/克隆值，释放 guard 后再调用其它 vault 方法");
        }
        self.inner.lock()
    }

    pub fn lock(&self) {
        let mut g = self.lock_inner();
        // SearchIndex::drop 会清零明文字段；Arc 释放后 VaultKey::drop 清零 DEK
        g.index = None;
        g.vk = None;
        g.session = None;
        g.unlocked = false;
        g.active_user = None;
    }

    pub fn unlock(&self, session: Session, vk: Arc<VaultKey>, index: SearchIndex) {
        let mut g = self.lock_inner();
        if g.active_user.as_deref().map(|u| u != session.user_id.as_str()).unwrap_or(false) {
            // 切换使用者：先彻底清理上一位使用者的明文索引与密钥
            g.index = None;
            g.vk = None;
        }
        g.session = Some(session);
        let user = g.session.as_ref().map(|s| s.user_id.clone()).unwrap_or_default();
        g.vk = Some(vk);
        g.index = Some(Arc::new(index));
        g.unlocked = true;
        g.active_user = Some(user);
    }

    pub fn is_unlocked(&self) -> bool {
        self.lock_inner().unlocked
    }

    pub fn current_vk(&self) -> Option<Arc<VaultKey>> {
        let g = self.lock_inner();
        if g.unlocked {
            g.vk.clone()
        } else {
            None
        }
    }

    pub fn replace_index(&self, index: SearchIndex) {
        let mut g = self.lock_inner();
        g.index = Some(Arc::new(index));
    }

    pub fn active_user(&self) -> Option<String> {
        self.lock_inner().session.as_ref().map(|s| s.user_id.clone())
    }

    pub fn session_id(&self) -> Option<String> {
        self.lock_inner().session.as_ref().map(|s| s.id.clone())
    }

    pub fn touch(&self, now: i64) {
        if let Some(s) = self.lock_inner().session.as_mut() {
            s.last_activity = now;
        }
    }

    /// 记录"刚刚完成二次认证"的时刻；到期判定在读取侧按当前策略窗口计算。
    pub fn grant_reauth(&self, at: i64) {
        if let Some(s) = self.lock_inner().session.as_mut() {
            s.reauth_at = Some(at);
        }
    }

    /// 返回 Some(true) 表示空闲超时；无会话时视为已过期（调用方应转成 Locked）。
    pub fn session_expired(&self, idle_timeout_seconds: i64, now: i64) -> Option<bool> {
        let g = self.lock_inner();
        g.session.as_ref().map(|s| s.is_expired(idle_timeout_seconds, now))
    }

    pub fn reauth_fresh(&self, window_seconds: i64, now: i64) -> Option<bool> {
        let g = self.lock_inner();
        g.session.as_ref().map(|s| s.has_fresh_reauth(window_seconds, now))
    }

    pub fn started_at(&self) -> Option<i64> {
        self.lock_inner().session.as_ref().map(|s| s.started_at)
    }

    pub fn with_vk<T>(&self, f: impl FnOnce(&Arc<VaultKey>) -> crate::error::Result<T>) -> crate::error::Result<T> {
        let vk = {
            let g = self.lock_inner();
            if !g.unlocked {
                return Err(crate::error::AppError::Locked);
            }
            g.vk.clone().ok_or(crate::error::AppError::Locked)?
        };
        f(&vk)
    }

    /// 先在锁内取出 Arc 克隆、随释放锁，再执行回调。
    /// 若把守护 guard 带进回调，回调里任何一次回碰 vault 状态（with_vk / replace_index / lock）
    /// 或数据库锁都会同线程死锁；克隆 Arc 后这类重入不再成立。
    pub fn with_index<T>(&self, f: impl FnOnce(&SearchIndex) -> T) -> crate::error::Result<T> {
        let idx = {
            let g = self.lock_inner();
            if !g.unlocked {
                return Err(crate::error::AppError::Locked);
            }
            g.index.clone().ok_or(crate::error::AppError::Locked)?
        };
        Ok(f(&idx))
    }
}

/// 会话令牌登记表：签发、解析、撤销。令牌本身是高熵随机值。
#[derive(Default)]
pub struct SessionStore {
    inner: Mutex<HashMap<String, String>>,
}

impl SessionStore {
    pub fn issue(&self, user_id: &str) -> String {
        let token = crate::crypto::random_bytes(32);
        let encoded = base64_url(token.as_slice());
        self.inner.lock().insert(encoded.clone(), user_id.to_string());
        encoded
    }

    pub fn resolve(&self, token: &str) -> Option<String> {
        self.inner.lock().get(token).cloned()
    }

    pub fn revoke(&self, token: &str) {
        self.inner.lock().remove(token);
    }

    pub fn revoke_user(&self, user_id: &str) {
        let mut g = self.inner.lock();
        g.retain(|_, v| v != user_id);
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::vault_key;

    fn vk() -> Arc<VaultKey> {
        Arc::new(vault_key::initialize("Master#2026", "u1", 1, &Default::default()).unwrap().0)
    }

    fn session(user: &str) -> Session {
        Session { id: user.into(), user_id: user.into(), started_at: 0, last_activity: 0, reauth_at: None }
    }

    #[test]
    fn locked_state_rejects_access() {
        let s = VaultState::default();
        assert!(!s.is_unlocked());
        assert!(matches!(s.with_vk(|_| Ok(())), Err(crate::error::AppError::Locked)));
    }

    #[test]
    fn nested_state_calls_from_callbacks_do_not_deadlock() {
        // rebuild_index 的真实形态：with_vk 回调里再 replace_index；
        // with_index 回调里再读 session/active_user。任一 guard 被带进回调都会触发 lock_inner 的断言。
        let s = VaultState::default();
        s.unlock(session("u1"), vk(), SearchIndex::new(vec![]));
        s.with_vk(|_| {
            s.replace_index(SearchIndex::new(vec![]));
            assert!(s.is_unlocked());
            Ok(())
        })
        .unwrap();
        s.with_index(|_| s.active_user()).unwrap();
        s.with_index(|_| s.session_id()).unwrap();
        assert_eq!(s.active_user().as_deref(), Some("u1"));
    }

    #[test]
    fn lock_clears_key_index_and_session() {        let s = VaultState::default();
        s.unlock(session("u1"), vk(), SearchIndex::new(vec![]));
        assert!(s.is_unlocked());
        s.lock();
        assert!(!s.is_unlocked());
        assert_eq!(s.active_user(), None);
    }

    #[test]
    fn switching_user_wipes_previous_plaintext_index() {
        let s = VaultState::default();
        s.unlock(session("u1"), vk(), SearchIndex::new(vec![]));
        s.unlock(session("u2"), vk(), SearchIndex::new(vec![]));
        assert_eq!(s.active_user().as_deref(), Some("u2"));
    }

    #[test]
    fn idle_timeout_expires_session() {
        let mut sess = session("u1");
        sess.last_activity = 1000;
        assert!(!sess.is_expired(600, 1500));
        assert!(sess.is_expired(600, 1700));
        assert!(!sess.is_expired(0, 999_999), "0 表示不启用超时");
    }

    #[test]
    fn reauth_window() {
        let mut sess = session("u1");
        assert!(!sess.has_fresh_reauth(60, 100));
        // reauth_at 是"认证发生的时刻"：窗口 60 秒 ⇒ 恰好在 +60 仍有效，+61 起失效。
        sess.reauth_at = Some(100);
        assert!(sess.has_fresh_reauth(60, 100));
        assert!(sess.has_fresh_reauth(60, 160));
        assert!(!sess.has_fresh_reauth(60, 161));
        // 管理员把窗口收紧到 10 秒，已发放的认证立刻按新策略判定（不再等到期时刻）。
        assert!(!sess.has_fresh_reauth(10, 111));
    }

    #[test]
    fn session_tokens_are_unpredictable_and_revocable() {
        let store = SessionStore::default();
        let a = store.issue("u1");
        let b = store.issue("u1");
        assert_ne!(a, b);
        assert!(a.len() >= 32);
        assert_eq!(store.resolve(&a).as_deref(), Some("u1"));
        store.revoke(&a);
        assert_eq!(store.resolve(&a), None);
        store.revoke_user("u1");
        assert!(store.is_empty());
    }
}
