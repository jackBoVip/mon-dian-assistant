//! Tauri 命令层：前端唯一可调用的入口。
//!
//! 每条命令遵守同一流程：
//! 1. 会话/解锁校验（空闲超时即锁定，清空明文索引与密钥）；
//! 2. RBAC 权限校验（后端再校验，绝不信任前端传入的角色/权限）；
//! 3. 记录级 ACL 校验；
//! 4. 业务操作 + 审计（只写动作元数据，绝不写秘密）。
//!
//! 全局快捷启动器不拥有任何绕过 RBAC 的特权 API —— 它复用这里的同一批授权路径。

pub mod accounts;
pub mod boot;
pub mod data;
pub mod devicekey;
pub mod external_tools;
pub mod lan;
pub mod launcher;
pub mod menus;
pub mod quiz;
pub mod rbac;
pub mod system;
pub mod vault;

use serde::{Deserialize, Serialize};

use crate::db::repo;
use crate::error::{AppError, Result};
use crate::settings;
use crate::state::AppCore;

pub(crate) fn user(core: &AppCore) -> Result<String> {
    core.check_session()
}

/// 审计写入的简写：action / target_type / target_id / result。
pub(crate) fn audit(core: &AppCore, actor: Option<&str>, action: &str, ttype: Option<&str>, tid: Option<&str>, ok: bool, err: Option<&str>, source: &str) {
    let _ = crate::audit::record(
        &core.db,
        actor,
        action,
        ttype,
        tid,
        if ok { "success" } else { "failure" },
        err,
        Some(source),
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub user_count: i64,
    pub app_user_id: Option<String>,
    pub nickname: Option<String>,
    pub schema_version: i64,
    pub app_version: String,
    pub platform: String,
    pub arch: String,
}

impl AppStatus {
    pub(crate) fn build(core: &AppCore) -> Result<Self> {
        Ok(AppStatus {
            initialized: crate::auth::users::is_initialized(&core.db)?,
            unlocked: core.vault.is_unlocked(),
            user_count: crate::auth::users::user_count(&core.db)?,
            app_user_id: core.vault.active_user(),
            nickname: core
                .vault
                .active_user()
                .as_deref()
                .and_then(|u| vault::nickname_of(core, u)),
            schema_version: { let conn = core.db.lock_conn(); crate::db::migrate::version(&conn)? },
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockoutInfo {
    pub locked: bool,
    pub failed_count: i64,
    pub seconds_remaining: i64,
    pub attempts_remaining: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProfileUser {
    pub id: String,
    pub nickname: String,
    pub internal_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginProfile {
    /// 单用户模式只需主密码；多用户模式先选昵称/头像。两种模式都不出现用户名输入框。
    pub initialized: bool,
    pub single_user: bool,
    pub users: Vec<LoginProfileUser>,
    /// 只针对被选中/首个使用者展示锁定状态，用于提示剩余等待时间
    pub lockout: Option<LockoutInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordAssessmentView {
    pub acceptable: bool,
    pub score: u8,
    pub length_ok: bool,
    pub has_class_variation: bool,
    pub not_common: bool,
    pub hint: String,
}

impl From<crate::auth::policy::PasswordAssessment> for PasswordAssessmentView {
    fn from(a: crate::auth::policy::PasswordAssessment) -> Self {
        Self {
            acceptable: a.acceptable,
            score: a.score,
            length_ok: a.length_ok,
            has_class_variation: a.has_class_variation,
            not_common: a.not_common,
            hint: a.hint,
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetFilter {
    pub item_type: Option<String>,
    pub group_id: Option<String>,
    pub favorite_only: Option<bool>,
    pub keyword: Option<String>,
    /// 标签筛选（需求 §2.2 台账首页要求"标签"入口）。空串按"未筛选"处理。
    pub tag: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTargetInput {
    pub display_name: String,
    pub target_type: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub allowed_origin: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: String,
    #[serde(default)]
    pub database_name: String,
    #[serde(default)]
    pub tenant: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub protocol: String,
    pub group_id: Option<String>,
}

impl CreateTargetInput {
    fn into_new(self) -> repo::NewTarget {
        repo::NewTarget {
            target_type: self.target_type,
            display_name: self.display_name,
            group_id: self.group_id,
            meta: repo::TargetSecretPayload {
                url: self.url,
                allowed_origin: self.allowed_origin,
                host: self.host,
                port: self.port,
                database_name: self.database_name,
                tenant: self.tenant,
                vendor: self.vendor,
                protocol: self.protocol,
                extra: Default::default(),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateItemInput {
    pub target_id: String,
    pub account_alias: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub auth_method: String,
    #[serde(default)]
    pub browser_hint: String,
    #[serde(default)]
    pub login_url_override: String,
    pub confirm_before_fill: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub set_as_default: Option<bool>,
}

pub(crate) fn payload_of(i: &CreateItemInput) -> repo::CredentialPayload {
    repo::CredentialPayload {
        username: i.username.clone(),
        password: crate::crypto::SecretString::new(i.password.clone()),
        token: crate::crypto::SecretString::new(i.token.clone()),
        private_key: crate::crypto::SecretString::new(i.private_key.clone()),
        passphrase: crate::crypto::SecretString::new(i.passphrase.clone()),
        login_url_override: i.login_url_override.clone(),
        note: i.note.clone(),
        auth_method: i.auth_method.clone(),
        browser_hint: i.browser_hint.clone(),
        confirm_before_fill: i.confirm_before_fill.unwrap_or(true),
        custom: Default::default(),
    }
}

/// 编辑一条凭据：字段缺省（`None`）表示保留原值，显式传空串表示清空该字段。
/// 密文永不回显，若沿用整包替换语义，用户只改别名也会把密码清掉——因此必须逐字段合并。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateItemInput {
    pub account_alias: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub note: Option<String>,
    pub auth_method: Option<String>,
    pub browser_hint: Option<String>,
    pub login_url_override: Option<String>,
    pub confirm_before_fill: Option<bool>,
    pub tags: Option<Vec<String>>,
}

/// 把补丁合并进已解密的载荷：只覆盖调用方显式给出的字段。
pub(crate) fn merge_payload(base: repo::CredentialPayload, patch: &UpdateItemInput) -> repo::CredentialPayload {
    fn keep_str(cur: String, next: &Option<String>) -> String {
        match next {
            Some(v) => v.clone(),
            None => cur,
        }
    }
    fn keep_secret(cur: crate::crypto::SecretString, next: &Option<String>) -> crate::crypto::SecretString {
        match next {
            Some(v) => crate::crypto::SecretString::new(v.clone()),
            None => cur,
        }
    }
    repo::CredentialPayload {
        username: keep_str(base.username, &patch.username),
        password: keep_secret(base.password, &patch.password),
        token: keep_secret(base.token, &patch.token),
        private_key: keep_secret(base.private_key, &patch.private_key),
        passphrase: keep_secret(base.passphrase, &patch.passphrase),
        login_url_override: keep_str(base.login_url_override, &patch.login_url_override),
        note: keep_str(base.note, &patch.note),
        auth_method: keep_str(base.auth_method, &patch.auth_method),
        browser_hint: keep_str(base.browser_hint, &patch.browser_hint),
        confirm_before_fill: patch.confirm_before_fill.unwrap_or(base.confirm_before_fill),
        custom: base.custom,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDetail {
    pub target: repo::TargetRow,
    pub meta: repo::TargetSecretPayload,
    pub items: Vec<repo::ItemRow>,
    pub insecure_protocol: bool,
    pub fill_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecret {
    /// 明文只在显式“查看秘密”时返回，且受二次认证与自动隐藏时间约束。
    pub value: String,
    pub visible_seconds: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsView {
    pub target_count: i64,
    pub credential_count: i64,
    pub by_type: Vec<TypeCount>,
    pub favorite_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
    pub type_key: String,
    pub count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReply {
    pub action: String,
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard_cleared_in: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<crate::quick_launcher::actions::AccountCandidate>>,
    /// 一次性填充授权的状态摘要。票据原文只存在于 Rust 内存与 Native Messaging 通道，
    /// 绝不进入 URL、query、命令行参数或前端存储。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillGrant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillGrant {
    pub status: String,
    pub origin: String,
    pub expires_in_seconds: i64,
}

impl ActionReply {
    pub(crate) fn ok(action: &str, message: impl Into<String>) -> Self {
        Self {
            action: action.to_string(),
            ok: true,
            message: message.into(),
            clipboard_cleared_in: None,
            opened: None,
            candidates: None,
            fill: None,
        }
    }
    pub(crate) fn fail(action: &str, err: &AppError) -> Self {
        Self {
            action: action.to_string(),
            ok: false,
            message: err.to_string(),
            clipboard_cleared_in: None,
            opened: None,
            candidates: None,
            fill: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReply {
    pub locked: bool,
    pub results: Vec<crate::quick_launcher::query::QuickResult>,
    /// 解析失败时只回错误说明，绝不回显查询原文
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syntax_error: Option<String>,
    pub elapsed_ms: u128,
    pub indexed: usize,
}

pub(crate) fn stats_view(core: &AppCore) -> Result<StatsView> {
    let conn = core.db.lock_conn();
    let mut by_type = Vec::new();
    for t in repo::ALL_TYPES {
        let n: i64 = conn.query_row(
            "SELECT count(*) FROM vault_items i JOIN vault_targets g ON g.id=i.target_id
             WHERE g.target_type=?1 AND i.deleted_at IS NULL AND i.status='active' AND g.deleted_at IS NULL AND g.status='active'",
            rusqlite::params![t],
            |r| r.get(0),
        )?;
        by_type.push(TypeCount { type_key: t.to_string(), count: n });
    }
    Ok(StatsView {
        target_count: conn.query_row("SELECT count(*) FROM vault_targets WHERE deleted_at IS NULL AND status='active'", [], |r| r.get(0))?,
        credential_count: conn.query_row("SELECT count(*) FROM vault_items WHERE deleted_at IS NULL AND status='active'", [], |r| r.get(0))?,
        favorite_count: conn.query_row("SELECT count(*) FROM vault_items WHERE deleted_at IS NULL AND favorite=1", [], |r| r.get(0))?,
        by_type,
    })
}

pub(crate) fn action_policy(core: &AppCore) -> crate::quick_launcher::query::ActionPolicy {
    core.action_policy()
}

pub(crate) fn extension_gate(core: &AppCore) -> bool {
    core.extension_ready() && settings::get_bool(&core.db, "quick_launcher_fill_enabled", true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SecretString;

    fn base() -> repo::CredentialPayload {
        repo::CredentialPayload {
            username: "zhangsan".into(),
            password: SecretString::new("Ext#Pass1"),
            token: SecretString::new("tok-abc"),
            private_key: SecretString::new("PRIVATE-KEY"),
            passphrase: SecretString::new("pp"),
            login_url_override: "https://oa.example/login".into(),
            note: "备注".into(),
            auth_method: "password".into(),
            browser_hint: "chrome".into(),
            confirm_before_fill: true,
            custom: Default::default(),
        }
    }

    fn empty_patch() -> UpdateItemInput {
        UpdateItemInput {
            account_alias: None,
            username: None,
            password: None,
            token: None,
            private_key: None,
            passphrase: None,
            note: None,
            auth_method: None,
            browser_hint: None,
            login_url_override: None,
            confirm_before_fill: None,
            tags: None,
        }
    }

    /// 密文不回显给前端，因此"只改别名"绝不能把已存密码/令牌清掉。
    #[test]
    fn omitted_fields_keep_every_secret() {
        let patch = UpdateItemInput { account_alias: Some("新别名".into()), ..empty_patch() };
        let m = merge_payload(base(), &patch);
        assert_eq!(m.password.expose(), "Ext#Pass1");
        assert_eq!(m.token.expose(), "tok-abc");
        assert_eq!(m.private_key.expose(), "PRIVATE-KEY");
        assert_eq!(m.passphrase.expose(), "pp");
        assert_eq!(m.username, "zhangsan");
        assert_eq!(m.note, "备注");
        assert!(m.confirm_before_fill);
    }

    /// 换密码只影响密码字段；显式空串才表示清空。
    #[test]
    fn provided_values_are_field_local_and_empty_clears() {
        let patch = UpdateItemInput {
            password: Some("Rotated#2026".into()),
            token: Some(String::new()),
            confirm_before_fill: Some(false),
            ..empty_patch()
        };
        let m = merge_payload(base(), &patch);
        assert_eq!(m.password.expose(), "Rotated#2026");
        assert!(m.token.is_empty(), "显式空串表示清空令牌");
        assert_eq!(m.private_key.expose(), "PRIVATE-KEY");
        assert!(!m.confirm_before_fill);
    }
}
