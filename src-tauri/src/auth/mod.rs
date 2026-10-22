//! 认证、会话与保险库解锁状态。
//!
//! - 主密码只用于 Argon2id 派生 → 校验 + 解封 DEK，绝不保存可逆原文。
//! - 会话令牌不可预测，仅存内存，不落 localStorage。
//! - 锁定/超时/切换使用者时：清空索引、清空会话、撤销未使用票据。

pub mod lockout;
pub mod policy;
pub mod session;
pub mod users;

pub use session::{Session, SessionStore, VaultState};
pub use users::{AppUserSummary, UnlockOutcome};
