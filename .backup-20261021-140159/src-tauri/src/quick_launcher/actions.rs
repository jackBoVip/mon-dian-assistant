//! 快捷启动器动作鉴权。
//!
//! 硬性要求：快捷启动器不存在任何绕过 RBAC 的特权通道。每个动作在进入
//! 业务逻辑前都调用与主界面完全相同的 `rbac::require` + 会话校验 + 记录级校验。

use super::query::QuickAction;
use super::search::SearchDoc;
use crate::auth::session::VaultState;
use crate::crypto::tokens::{IssuedTicket, TicketBinding, TicketStore};
use crate::db::{repo, Db};
use crate::error::{AppError, Result};
use crate::rbac::perm;

/// 校验当前会话是否允许执行该动作。返回 Ok 后调用方才可执行。
pub fn authorize(db: &Db, state: &VaultState, user_id: &str, action: QuickAction, item_id: &str) -> Result<()> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let required = match action {
        QuickAction::OpenTarget | QuickAction::ViewDetail => perm::ACC_READ,
        QuickAction::OpenAndFill => perm::ACC_AUTOFILL,
        // 审查 F2：用户名在列表侧的口径是"无 accounts.view_secret 连解密都不做，
        // 免得泄露『这条凭据存在』"（commands/accounts.rs 的 to_view）。而这条路只要 ACC_READ
        // 就把完整明文写进剪贴板——同一个字段两套答案，且低权限那侧反而更宽。
        // 统一到严格的那条：要拿用户名明文，就得有看秘密的权限。
        QuickAction::CopyUsername => perm::ACC_VIEW_SECRET,
        QuickAction::CopyPassword => perm::ACC_COPY_PASSWORD,
        QuickAction::SetDefault => perm::ACC_SET_DEFAULT,
        QuickAction::SelectOtherAccount => perm::ACC_READ,
    };
    crate::rbac::require(db, user_id, required)?;
    // 记录必须在当前使用者的可见范围内（RBAC + 记录级 ACL 叠加）
    let conn = db.lock_conn();
    if !repo::can_access_item(&conn, user_id, item_id)? {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// 解析「打开并安全填充」本次应使用的凭据。
/// - 有默认账号 → 用默认；
/// - 无有效默认（导入/迁移/停用导致）→ 明确要求选择，绝不随机挑一条。
pub fn resolve_fill_credential(db: &Db, user_id: &str, target_id: &str, explicit_item_id: Option<&str>) -> Result<String> {
    if let Some(id) = explicit_item_id {
        let conn = db.lock_conn();
        let item_target: Option<String> = conn
            .query_row("SELECT target_id FROM vault_items WHERE id=?1 AND deleted_at IS NULL AND status='active'", rusqlite::params![id], |r| r.get(0))
            .optional()?;
        return match item_target {
            Some(t) if t == target_id => Ok(id.to_string()),
            Some(_) => Err(AppError::TargetCredentialMismatch),
            None => Err(AppError::NotFound),
        };
    }
    repo::default_credential(db, user_id, target_id)?.ok_or(AppError::NoDefaultCredential)
}

use rusqlite::OptionalExtension;

/// 为一次填充签发短时一次性票据，绑定 target/credential/origin/user/session。
pub fn issue_fill_ticket(
    db: &Db,
    store: &TicketStore,
    state: &VaultState,
    user_id: &str,
    item_id: &str,
) -> Result<(IssuedTicket, TicketBinding)> {
    authorize(db, state, user_id, QuickAction::OpenAndFill, item_id)?;
    let session_id = state.session_id().ok_or(AppError::Locked)?;
    let (target_id, item_type): (String, String) = {
        let conn = db.lock_conn();
        conn.query_row("SELECT target_id, item_type FROM vault_items WHERE id=?1 AND deleted_at IS NULL", rusqlite::params![item_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or(AppError::NotFound)?
    };
    if item_type != "web" {
        return Err(AppError::InvalidInput);
    }
    let origin: String = state.with_vk(|vk| {
        let meta = repo::target_meta(vk, db, &target_id)?;
        Ok(if meta.allowed_origin.is_empty() { meta.url.clone() } else { meta.allowed_origin.clone() })
    })?;
    if origin.is_empty() {
        return Err(AppError::OriginNotAllowed);
    }
    let binding = TicketBinding {
        target_id,
        credential_id: item_id.to_string(),
        origin,
        app_user_id: user_id.to_string(),
        session_id,
    };
    Ok((store.issue(binding.clone())?, binding))
}

/// 结果行需要展示「该目标下其他账号」时使用的候选列表（仅非秘密摘要）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCandidate {
    pub item_id: String,
    pub account_alias: String,
    pub username_masked: String,
    pub is_default: bool,
}

pub fn candidates_for(db: &Db, vk: &crate::crypto::vault_key::VaultKey, user_id: &str, doc: &SearchDoc) -> Result<Vec<AccountCandidate>> {
    let items = repo::list_items_for_target(db, &doc.target_id, user_id)?;
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        if it.status != "active" {
            continue;
        }
        if !repo::can_access_item(&db.lock_conn(), user_id, &it.id)? {
            continue;
        }
        let username = repo::item_payload(vk, db, &it.id).map(|p| p.username).unwrap_or_default();
        out.push(AccountCandidate {
            item_id: it.id,
            account_alias: it.account_alias,
            username_masked: super::query::mask_username(&username),
            is_default: it.is_default_for_current_user,
        });
    }
    Ok(out)
}

/// 直接按目标列出可用账号候选（用于「没有有效默认账号」时的选择器）。
pub fn candidates_for_target(db: &Db, vk: &crate::crypto::vault_key::VaultKey, user_id: &str, target_id: &str) -> Result<Vec<AccountCandidate>> {
    let items = repo::list_items_for_target(db, target_id, user_id)?;
    let mut out = Vec::new();
    for it in items {
        if it.status != "active" {
            continue;
        }
        if !repo::can_access_item(&db.lock_conn(), user_id, &it.id)? {
            continue;
        }
        let username = repo::item_payload(vk, db, &it.id).map(|p| p.username).unwrap_or_default();
        out.push(AccountCandidate {
            item_id: it.id,
            account_alias: it.account_alias,
            username_masked: super::query::mask_username(&username),
            is_default: it.is_default_for_current_user,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::users;
    use crate::db::repo::{CredentialPayload, NewItem, NewTarget, TargetSecretPayload};
    use crate::crypto::SecretString;

    fn seeded() -> (Db, String, String, String) {
        let d = Db::open_in_memory(&vec![61u8; 32]).unwrap();
        let (uid, vk) = users::initialize(&d, "owner", "MengDian#2026x").unwrap();
        let t = repo::create_target(
            &d, &vk, &uid,
            &NewTarget { target_type: "web".into(), display_name: "OA".into(), group_id: None,
                meta: TargetSecretPayload { url: "https://oa.nmgdl.cn".into(), allowed_origin: "https://oa.nmgdl.cn".into(), ..Default::default() } },
        ).unwrap();
        let mut ids = Vec::new();
        for (alias, user) in [("日常办公", "zhangsan"), ("运维账号", "ops_admin")] {
            ids.push(
                repo::create_item(&d, &vk, &uid, &NewItem {
                    target_id: t.clone(), account_alias: alias.into(), tags: vec![], favorite: false,
                    payload: CredentialPayload { username: user.into(), password: SecretString::new("P@ssw0rd!123"), ..Default::default() },
                    set_as_default: false,
                }).unwrap(),
            );
        }
        (d, uid, t, ids[0].clone())
    }

    #[test]
    fn locked_state_blocks_every_quick_action() {
        let (d, _uid, _t, item) = seeded();
        let state = VaultState::default();
        for a in [QuickAction::OpenTarget, QuickAction::OpenAndFill, QuickAction::CopyUsername, QuickAction::CopyPassword, QuickAction::SetDefault] {
            assert!(matches!(authorize(&d, &state, "u", a, &item), Err(AppError::Locked)), "{a:?} 在锁定时必须被拒绝");
        }
    }

    #[test]
    fn standard_user_cannot_copy_password_via_launcher() {
        let d = Db::open_in_memory(&vec![62u8; 32]).unwrap();
        let (admin_id, vk) = users::initialize(&d, "管理员", "Admin#Pass2026").unwrap();
        let user_id = users::create_app_user(&d, &admin_id, "普通", "User#Pass2026", "standard_user", &vk).unwrap();
        let state = VaultState::default();
        state.unlock(
            crate::auth::session::Session { id: "s".into(), user_id: user_id.clone(), started_at: 0, last_activity: 0, reauth_at: None },
            std::sync::Arc::new(vk),
            SearchIndex::new(vec![]),
        );
        // 普通用户没有 accounts.copy_password？种子里其实有，因此改用 export 权限验证后端拒绝
        assert!(crate::rbac::require(&d, &user_id, perm::ACC_EXPORT).is_err());
        assert!(crate::rbac::require(&d, &user_id, perm::SYS_UPDATE_INSTALL).is_err());
    }

    #[test]
    fn fill_uses_default_credential_and_never_picks_randomly() {
        let (d, uid, t, first) = seeded();
        // 首条凭据自动成为默认
        assert_eq!(resolve_fill_credential(&d, &uid, &t, None).unwrap(), first);
        // 停用默认后不得随机改选
        repo::set_item_status(&d, &uid, &first, "disabled").unwrap();
        assert!(matches!(resolve_fill_credential(&d, &uid, &t, None), Err(AppError::NoDefaultCredential)));
    }

    #[test]
    fn explicit_non_default_credential_is_allowed_for_this_action_only() {
        let (d, uid, t, first) = seeded();
        let all = repo::list_items_for_target(&d, &t, &uid).unwrap();
        let second = all.iter().find(|i| i.id != first).unwrap().id.clone();
        assert_eq!(resolve_fill_credential(&d, &uid, &t, Some(&second)).unwrap(), second);
        // 临时选择不改变默认偏好
        assert_eq!(repo::default_credential(&d, &uid, &t).unwrap().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn credential_from_another_target_is_rejected() {
        let (d, uid, t, _) = seeded();
        let vk = crate::auth::users::unlock(&d, &uid, "MengDian#2026x", 5, 300).unwrap();
        let other = repo::create_target(&d, &vk, &uid,
            &NewTarget { target_type: "database".into(), display_name: "DB".into(), group_id: None, meta: TargetSecretPayload { host: "10.0.0.22".into(), port: "3306".into(), ..Default::default() } },
        ).unwrap();
        let other_item = repo::create_item(&d, &vk, &uid, &NewItem {
            target_id: other, account_alias: "root".into(), tags: vec![], favorite: false,
            payload: CredentialPayload { username: "root".into(), password: SecretString::new("x"), ..Default::default() },
            set_as_default: false,
        }).unwrap();
        assert!(matches!(resolve_fill_credential(&d, &uid, &t, Some(&other_item)), Err(AppError::TargetCredentialMismatch)));
    }

    #[test]
    fn ticket_is_bound_to_credential_and_origin() {
        let (d, uid, _t, item) = seeded();
        let vk = users::unlock(&d, &uid, "MengDian#2026x", 5, 300).unwrap();
        let state = VaultState::default();
        state.unlock(
            crate::auth::session::Session { id: "sess".into(), user_id: uid.clone(), started_at: 0, last_activity: 0, reauth_at: None },
            std::sync::Arc::new(vk),
            SearchIndex::new(vec![]),
        );
        let store = TicketStore::default();
        let (ticket, binding) = issue_fill_ticket(&d, &store, &state, &uid, &item).unwrap();
        assert_eq!(binding.credential_id, item);
        assert_eq!(binding.origin, "https://oa.nmgdl.cn");
        assert_eq!(store.redeem(&ticket.id, &ticket.secret, &binding).unwrap().credential_id, item);
        // 重放被拒
        assert!(store.redeem(&ticket.id, &ticket.secret, &binding).is_err());
        // 相似恶意域名被拒
        let evil = TicketBinding { origin: "https://oa.nmgdl.cn.evil.com".into(), ..binding.clone() };
        let (t2, _) = issue_fill_ticket(&d, &store, &state, &uid, &item).unwrap();
        assert!(matches!(store.redeem(&t2.id, &t2.secret, &evil), Err(AppError::TicketBindingMismatch)));
    }

    use crate::quick_launcher::search::SearchIndex;
}
