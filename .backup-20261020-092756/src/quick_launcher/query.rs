//! 快捷启动器的查询入口与会话守卫。
//!
//! 关键约束：
//! - 仅在保险库解锁后可搜索；锁定时只能得到解锁提示，绝不返回缓存结果。
//! - 结果受 RBAC + 记录级 ACL + 目标/凭据启用状态过滤（在构建索引时即已按授权范围裁剪）。
//! - 动作走与主界面相同的 `commands` 授权路径。

use super::parser::{self, ParsedQuery};
use super::search::{SearchDoc, SearchIndex};
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

/// 快捷动作。前端按此渲染，后端仍会二次校验权限。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickAction {
    OpenTarget,
    OpenAndFill,
    CopyUsername,
    CopyPassword,
    ViewDetail,
    SelectOtherAccount,
    SetDefault,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickResult {
    pub target_id: String,
    pub item_id: String,
    pub system_name: String,
    pub item_type: String,
    pub account_alias: String,
    /// 用户名按隐私策略脱敏后的展示值
    pub username_masked: String,
    pub address_summary: String,
    pub tags: Vec<String>,
    pub is_default: bool,
    pub favorite: bool,
    pub credential_count_on_target: usize,
    pub actions: Vec<QuickAction>,
    pub match_kind: &'static str,
}

/// 用户名脱敏：保留首尾各 1 个字符，中间打点；短于 3 字符整体打点。
pub fn mask_username(u: &str) -> String {
    let chars: Vec<char> = u.chars().collect();
    match chars.len() {
        0 => String::new(),
        1..=2 => "••".to_string(),
        n if n <= 6 => format!("{}•••{}", chars[0], chars[n - 1]),
        n => format!("{}••••••{}", chars[0], chars[n - 1]),
    }
}

/// 地址摘要：不暴露 URL 中可能携带的 query/token。
pub fn address_summary(addr: &str) -> String {
    let cut = addr.find(['?', '#']).unwrap_or(addr.len());
    addr[..cut].to_string()
}

pub fn allowed_actions(doc: &SearchDoc, extension_ready: bool, policy: &ActionPolicy) -> Vec<QuickAction> {
    let mut v = vec![QuickAction::ViewDetail, QuickAction::CopyUsername];
    if doc.item_type == "web" {
        v.push(QuickAction::OpenTarget);
        if extension_ready {
            v.insert(0, QuickAction::OpenAndFill);
        }
    } else {
        v.push(QuickAction::OpenTarget);
    }
    if policy.allow_copy_password {
        v.push(QuickAction::CopyPassword);
    }
    if doc.credential_count_hint() > 1 {
        v.push(QuickAction::SelectOtherAccount);
    }
    if !doc.is_default {
        v.push(QuickAction::SetDefault);
    }
    v
}

#[derive(Debug, Clone, Copy)]
pub struct ActionPolicy {
    pub allow_copy_password: bool,
    pub require_reauth_for_password: bool,
}

impl Default for ActionPolicy {
    fn default() -> Self {
        Self { allow_copy_password: true, require_reauth_for_password: true }
    }
}

/// 锁定状态下唯一允许的响应：只提示解锁，不含任何台账信息。
pub fn locked_response() -> Result<()> {
    Err(AppError::Locked)
}

/// `show_recent_when_empty` 是设置 `quick_launcher_show_recent` 的当前值：需求 §285 要求"输入为空时可显示
/// 最近使用项/收藏项（应由设置启用）"，所以关掉时空输入必须一条都不返回，而不是只让前端自己不去请求。
///
/// `rank_recent_favorite` 是设置 `quick_launcher_rank_recent_favorite` 的当前值：需求 line 294 要求
/// "完全匹配、前缀匹配、包含匹配、最近使用/收藏"里的最后一档**可配置**。它只影响同一匹配等级内部的先后，
/// 永远不可能把 AND 过滤掉的记录排回来。
pub fn search_unlocked(
    index: &SearchIndex,
    raw_query: &str,
    limit: usize,
    extension_ready: bool,
    policy: &ActionPolicy,
    show_recent_when_empty: bool,
    rank_recent_favorite: bool,
) -> Result<Vec<QuickResult>> {
    let parsed: ParsedQuery = parser::parse(raw_query)?;
    let hits = if parsed.conditions.is_empty() {
        if show_recent_when_empty {
            index
                .defaults(limit)
                .into_iter()
                .map(|d| (d, super::search::MatchKind::Contains))
                .collect()
        } else {
            // 空输入 + 设置关闭：不给任何保险库内容
            Vec::new()
        }
    } else {
        index.search_ranked(&parsed, limit, &super::search::RankConfig { recent_favorite_first: rank_recent_favorite })
    };
    Ok(hits
        .into_iter()
        .map(|(d, kind)| QuickResult {
            target_id: d.target_id.clone(),
            item_id: d.item_id.clone(),
            system_name: d.system_name.clone(),
            item_type: d.item_type.clone(),
            account_alias: d.account_alias.clone(),
            username_masked: mask_username(&d.username),
            address_summary: address_summary(&d.address),
            tags: d.tags.clone(),
            is_default: d.is_default,
            favorite: d.favorite,
            credential_count_on_target: d.credential_count_hint(),
            actions: allowed_actions(&d, extension_ready, policy),
            match_kind: match kind {
                super::search::MatchKind::Exact => "exact",
                super::search::MatchKind::Prefix => "prefix",
                super::search::MatchKind::Contains => "contains",
            },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_usernames_without_leaking_them() {
        assert_eq!(mask_username("zhangsan"), "z••••••n");
        assert_eq!(mask_username("abc"), "a•••c");
        assert_eq!(mask_username("ab"), "••");
        assert_eq!(mask_username(""), "");
    }

    #[test]
    fn address_summary_strips_query_and_fragment() {
        assert_eq!(address_summary("https://x.cn/login?token=abc#f"), "https://x.cn/login");
    }

    /// 一次给出各种组合下的动作列表，形状 = (类型, 扩展就绪, 允许复制密码, 该目标账号数, 是否默认)
    fn actions_for(item_type: &str, extension_ready: bool, allow_pwd: bool, count: usize, is_default: bool) -> Vec<QuickAction> {
        let d = SearchDoc {
            target_id: "t-1".into(),
            item_id: "i-1".into(),
            system_name: "OA办公系统".into(),
            address: "https://oa.nmgdl.cn".into(),
            host: "oa.nmgdl.cn".into(),
            port: String::new(),
            username: "lisi".into(),
            account_alias: "日常办公".into(),
            item_type: item_type.into(),
            group_name: String::new(),
            tags: vec![],
            note: String::new(),
            favorite: false,
            is_default,
            last_accessed_at: None,
            credential_count: count,
        };
        allowed_actions(&d, extension_ready, &ActionPolicy { allow_copy_password: allow_pwd, require_reauth_for_password: true })
    }

    /// 需求 §304/§605：「复制密码」只能是单独、明确的动作，Enter 的主操作在任何动作形状下都不能落在它上面。
    /// 前端 primaryAction() 的规则（open_and_fill → open_target → 第一个非 copy_password）依赖后端给出的顺序，
    /// 这里把这个顺序固定成契约，防止以后调整 allowed_actions() 时把密码悄悄变成默认动作。
    #[test]
    fn enter_default_is_never_copy_password_for_any_action_shape() {
        for ty in ["web", "terminal", "database"] {
            for ext in [false, true] {
                for pwd in [false, true] {
                    for count in [1usize, 3] {
                        for def in [false, true] {
                            let a = actions_for(ty, ext, pwd, count, def);
                            let shape = format!("{ty}/ext={ext}/pwd={pwd}/count={count}/default={def}");
                            assert!(!a.is_empty(), "{shape}：至少要有一个可执行动作");
                            let primary = if a.contains(&QuickAction::OpenAndFill) {
                                Some(QuickAction::OpenAndFill)
                            } else if a.contains(&QuickAction::OpenTarget) {
                                Some(QuickAction::OpenTarget)
                            } else {
                                a.iter().copied().find(|x| *x != QuickAction::CopyPassword)
                            };
                            assert_ne!(primary, Some(QuickAction::CopyPassword), "{shape}：Enter 主操作不得是复制密码");
                            if !pwd {
                                assert!(!a.contains(&QuickAction::CopyPassword), "{shape}：策略禁止时不得给出复制密码");
                            }
                            assert!(!a.contains(&QuickAction::OpenAndFill) || (ty == "web" && ext), "{shape}：只有网页且扩展就绪才给填充");
                            assert_eq!(a.contains(&QuickAction::SetDefault), !def, "{shape}：已是默认就不必再给设为默认");
                            assert_eq!(a.contains(&QuickAction::SelectOtherAccount), count > 1, "{shape}：单账号目标不给选择其他账号");
                        }
                    }
                }
            }
        }
    }
}
