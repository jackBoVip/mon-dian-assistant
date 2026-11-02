//! 快捷启动器的查询入口与会话守卫。
//!
//! 关键约束：
//! - 仅在保险库解锁后可搜索；锁定时只能得到解锁提示，绝不返回缓存结果。
//! - 结果受 RBAC + 记录级 ACL + 目标/凭据启用状态过滤（在构建索引时即已按授权范围裁剪）。
//! - 动作走与主界面相同的 `commands` 授权路径。

use super::parser::{self, ParsedQuery};
use super::search::{MatchKind, SearchDoc, SearchIndex};
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

/// 一条命中来自哪一类内容。前端按它选行版式与 Enter 落点，`quick_reveal` 也按它分派。
///
/// `tool` 是「工具」页里的那些 HTML 页面（page_key=`html`）；`task` 是任务中心的任务定义。
/// 序列化线格式是 snake_case，与前端 `QuickSource` 同一份字面量，由 `ipcContract.test.ts` 比两侧。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickSource {
    Account,
    Note,
    Quiz,
    Tool,
    Task,
}

/// 保险库凭据命中。字段与扩展前的 `QuickResult` 逐一对应，一个没减：
/// `quick_action` 那条链（打开/填充/复制用户名/复制密码/查看详情/设为默认）读的就是这些键，
/// 前端的 `ACTION_LABELS` 与跨窗载荷也都钉在同一份形状上。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHit {
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
    pub match_kind: MatchKind,
}

/// 笔记命中：标题 + 正文去标签摘要，与笔记页左栏同一份内容形状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteHit {
    pub note_id: String,
    pub title: String,
    pub snippet: String,
    pub updated_at: String,
    pub match_kind: MatchKind,
}

/// 题库命中：定位用的是 `libraryId` + `seq`，落点页按 seq 算出该翻到第几页。
///
/// 刻意不带 `answerDisplay` 与选项：浮层是一枚置顶窗，答案跟着题干一起飘在桌面上，
/// 不是这道题该有的暴露面。要看答案的路径是落到题库页里那一行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizHit {
    pub question_id: String,
    pub library_id: String,
    pub library_name: String,
    pub seq: i64,
    pub qtype: String,
    pub stem: String,
    pub match_kind: MatchKind,
}

/// 工具（HTML 页面）命中：只有标题。正文不参与检索的口径见 `html_pages::store::search`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHit {
    pub page_id: String,
    pub title: String,
    pub updated_at: String,
    pub match_kind: MatchKind,
}

/// 任务中心命中：一枚任务定义的一档环境。`env` 是 `test`/`prod`，中文标签只在前端 `ENVS` 里。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskHit {
    pub task_key: String,
    pub label: String,
    pub env: String,
    pub match_kind: MatchKind,
}

/// 一行结果。`tag = "source"` 是内部标签：序列化后就是 `{"source":"note","noteId":...}`，
/// 前端按 `source` 判别后各走各的渲染与 Enter 分支。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum QuickHit {
    Account(AccountHit),
    Note(NoteHit),
    Quiz(QuizHit),
    Tool(ToolHit),
    Task(TaskHit),
}

impl QuickHit {
    pub fn source(&self) -> QuickSource {
        match self {
            QuickHit::Account(_) => QuickSource::Account,
            QuickHit::Note(_) => QuickSource::Note,
            QuickHit::Quiz(_) => QuickSource::Quiz,
            QuickHit::Tool(_) => QuickSource::Tool,
            QuickHit::Task(_) => QuickSource::Task,
        }
    }

    /// 同一匹配等级内的固定先后：账号 → 笔记 → 题库 → 工具 → 任务中心。
    ///
    /// 同级**不跨源比时间**：账号行的同级顺序由设置
    /// `quick_launcher_rank_recent_favorite` 决定（收藏 > 默认账号 > 最近使用，需求 line 294），
    /// 让笔记的 `updated_at` 插进去就会把那条设置改掉；而"最近使用"与"最近编辑笔记"
    /// 本来也不是同一个量，混在一起比不出一个能解释的次序。
    /// 于是同级按源的固定顺序排，各源内部的既有顺序由稳定排序保留。
    fn source_rank(&self) -> u8 {
        match self.source() {
            QuickSource::Account => 0,
            QuickSource::Note => 1,
            QuickSource::Quiz => 2,
            QuickSource::Tool => 3,
            QuickSource::Task => 4,
        }
    }

    pub fn match_kind(&self) -> MatchKind {
        match self {
            QuickHit::Account(h) => h.match_kind,
            QuickHit::Note(h) => h.match_kind,
            QuickHit::Quiz(h) => h.match_kind,
            QuickHit::Tool(h) => h.match_kind,
            QuickHit::Task(h) => h.match_kind,
        }
    }
}

/// 平铺混排：先按匹配等级（完全 > 前缀 > 包含），同级按源顺序，最后截到 `limit`。
///
/// 传进来的每一段必须**已经按各自的规则排好**，这里只负责合并；`sort_by_key` 是稳定排序，
/// 同等级同源的原序不会被打乱。
pub fn merge_ranked(hits: Vec<QuickHit>, limit: usize) -> Vec<QuickHit> {
    let mut hits = hits;
    hits.sort_by_key(|h| (h.match_kind() as u8, h.source_rank()));
    hits.truncate(limit);
    hits
}

/// 保险库以外的四个源，每类各自先取这么多，合并后再截到设置里的全局上限。
///
/// 不跟全局上限同值是有意的：平铺混排先比匹配等级，账号那一类命中得多时能把整份预算占满，
/// 那样「支持搜笔记/题库/工具/任务」就等于没兑现。每类先各留 5 条进合并池，
/// 保证一次搜索里五类都有机会露头。
pub const PER_SOURCE_LIMIT: usize = 5;

/// 这条查询能不能扇出到保险库以外的四个源，能的话喂给它们哪个词。
///
/// 三个条件全过才有值，合成一个判据是因为分开写会给出两个互相矛盾的答案
/// （`系统:OA` 是"无字段限定"吗？它字段限定得明明白白）：
/// 1. **有真实条件**。空输入走的是"收藏/最近使用"那一档，那是保险库自己的推荐位，
///    笔记没有收藏、任务没有最近使用，凑不出同一件事。
/// 2. **没有任何字段限定**。`系统:OA`、`标签:生产` 里的字段名是保险库的列，
///    笔记/题库/工具/任务都没有对应字段，硬套只会给出解释不了的命中。
/// 3. **恰好一个条件**。多条件没有单个词可喂，而每类各实现一遍 AND 会得到四种形状的 AND
///    （保险库是同一条记录上全命中，FTS 是分片 OR，LIKE 是多子句 AND）。
///
/// 第 2、3 条挡掉的查询不是静默降级：`SearchReply.vault_only` 会把它带到界面上说破，
/// 否则"输入 系统:OA 之后笔记那一类整体消失"看起来就是坏了。
pub fn fan_out_term(parsed: &ParsedQuery) -> Option<&str> {
    if parsed.conditions.len() != 1 {
        return None;
    }
    let cond = &parsed.conditions[0];
    if cond.field != parser::Field::Any {
        return None;
    }
    Some(cond.term.as_str())
}

/// 这次是不是"只搜了保险库"——有真实条件、却没扇出去（被字段限定或多条件挡下）。
///
/// 与 [`fan_out_term`] 成对：一个决定扇不扇，一个把"没扇"这件事说给界面听。
/// 判据只能有一处，否则浮层的说明和实际搜了什么是两个来源，早晚会各说各话。
pub fn is_vault_only(parsed: &ParsedQuery) -> bool {
    !parsed.conditions.is_empty() && fan_out_term(parsed).is_none()
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
    // 审查 F2：用户名能不能拿走，判据是 accounts.view_secret（authorize() 那一处现在也这么要求）。
    // 列表侧必须跟着同一判据走，否则启动器会摆出一颗**点了必然被拒**的动作——
    // 那既难用，也把"这条凭据存在"的泄露留在了界面上。
    let mut v = vec![QuickAction::ViewDetail];
    if policy.can_copy_username {
        v.push(QuickAction::CopyUsername);
    }
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
    /// 当前使用者能不能取得用户名明文（= 有没有 accounts.view_secret）。
    pub can_copy_username: bool,
}

impl Default for ActionPolicy {
    fn default() -> Self {
        Self { allow_copy_password: true, require_reauth_for_password: true, can_copy_username: true }
    }
}

/// 保险库那一条腿：在内存索引里查已解析好的查询。
///
/// 入参是 `&ParsedQuery` 而不是原始串：解析由命令层做一次，同一份结果还要用来判断
/// "这条查询能不能扇出到另外四类"（见 [`fan_out_term`]），解析两遍等于给同一个问题留两处答案。
///
/// `show_recent_when_empty` 是设置 `quick_launcher_show_recent` 的当前值：需求 §285 要求"输入为空时可显示
/// 最近使用项/收藏项（应由设置启用）"，所以关掉时空输入必须一条都不返回，而不是只让前端自己不去请求。
///
/// `rank_recent_favorite` 是设置 `quick_launcher_rank_recent_favorite` 的当前值：需求 line 294 要求
/// "完全匹配、前缀匹配、包含匹配、最近使用/收藏"里的最后一档**可配置**。它只影响同一匹配等级内部的先后，
/// 永远不可能把 AND 过滤掉的记录排回来。
pub fn search_vault(
    index: &SearchIndex,
    parsed: &ParsedQuery,
    limit: usize,
    extension_ready: bool,
    policy: &ActionPolicy,
    show_recent_when_empty: bool,
    rank_recent_favorite: bool,
) -> Vec<AccountHit> {
    let hits = if parsed.conditions.is_empty() {
        if show_recent_when_empty {
            index
                .defaults(limit)
                .into_iter()
                .map(|d| (d, MatchKind::Contains))
                .collect()
        } else {
            // 空输入 + 设置关闭：不给任何保险库内容
            Vec::new()
        }
    } else {
        index.search_ranked(parsed, limit, &super::search::RankConfig { recent_favorite_first: rank_recent_favorite })
    };
    hits
        .into_iter()
        .map(|(d, kind)| AccountHit {
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
            match_kind: kind,
        })
        .collect()
}

/// 保险库以外的四类内容（笔记、题库、工具、任务中心）在 `super::sources`，
/// 命令层用 [`fan_out_term`] 决定这一腿要不要跑、喂哪个词。


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
        allowed_actions(
            &d,
            extension_ready,
            &ActionPolicy { allow_copy_password: allow_pwd, require_reauth_for_password: true, can_copy_username: true },
        )
    }

    /// 审查 F2：没有 accounts.view_secret 的使用者，动作列表里不该出现「复制用户名」——
    /// 后端 authorize 现在按同一条权限拦，列表若还摆着这颗按钮，用户点下去只会收到一句拒绝。
    #[test]
    fn copy_username_action_disappears_without_view_secret_permission() {
        let mut d = sample_doc();
        d.item_type = "terminal".into();
        let with = allowed_actions(
            &d,
            false,
            &ActionPolicy { allow_copy_password: true, require_reauth_for_password: true, can_copy_username: true },
        );
        let without = allowed_actions(
            &d,
            false,
            &ActionPolicy { allow_copy_password: true, require_reauth_for_password: true, can_copy_username: false },
        );
        assert!(with.contains(&QuickAction::CopyUsername));
        assert!(!without.contains(&QuickAction::CopyUsername), "无查看秘密权限时不得提供复制用户名");
        assert!(!without.is_empty(), "撤掉这一颗之后仍要有可用动作（ViewDetail 兜底），否则启动器会出现零动作的行");
    }

    fn sample_doc() -> SearchDoc {
        SearchDoc {
            target_id: "t-1".into(),
            item_id: "i-1".into(),
            system_name: "OA办公系统".into(),
            address: "https://oa.nmgdl.cn".into(),
            host: "oa.nmgdl.cn".into(),
            port: String::new(),
            username: "lisi".into(),
            account_alias: "日常办公".into(),
            item_type: "web".into(),
            group_name: String::new(),
            tags: vec![],
            note: String::new(),
            favorite: false,
            is_default: true,
            last_accessed_at: None,
            credential_count: 1,
        }
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

    fn note_hit(id: &str, title: &str, kind: MatchKind) -> QuickHit {
        QuickHit::Note(NoteHit {
            note_id: id.into(),
            title: title.into(),
            snippet: String::new(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
            match_kind: kind,
        })
    }

    fn tool_hit(id: &str, kind: MatchKind) -> QuickHit {
        QuickHit::Tool(ToolHit {
            page_id: id.into(),
            title: id.into(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
            match_kind: kind,
        })
    }

    /// 平铺混排的第一判据永远是匹配等级：一条"包含"命中的笔记不能排到一条"完全匹配"的账号之前。
    /// 同一等级内按源的固定顺序——不跨源比时间，因为账号那一条的同级顺序是设置
    /// `quick_launcher_rank_recent_favorite` 说了算的（需求 line 294），让笔记的时间戳插进去就把那条设置改掉了。
    #[test]
    fn merge_orders_by_tier_first_then_source() {
        let merged = merge_ranked(
            vec![
                note_hit("n-exact", "电碳", MatchKind::Exact),
                tool_hit("t-contains", MatchKind::Contains),
                note_hit("n-contains", "别的电碳", MatchKind::Contains),
                tool_hit("t-prefix", MatchKind::Prefix),
            ],
            10,
        );
        assert_eq!(
            merged.iter().map(|h| h.match_kind()).collect::<Vec<_>>(),
            vec![MatchKind::Exact, MatchKind::Prefix, MatchKind::Contains, MatchKind::Contains],
        );
        // 同为 Contains 时笔记在工具之前
        assert_eq!(merged[2].source(), QuickSource::Note);
        assert_eq!(merged[3].source(), QuickSource::Tool);
    }

    /// 同源同级的原序必须原样保留：各源内部各自已经排好了（账号按收藏/默认/最近，其余按更新时间），
    /// 合并这一层不该把它们的顺序洗成别的。
    #[test]
    fn merge_is_stable_within_one_source() {
        let merged = merge_ranked(
            vec![
                note_hit("n-1", "甲", MatchKind::Contains),
                note_hit("n-2", "乙", MatchKind::Contains),
                note_hit("n-3", "丙", MatchKind::Contains),
            ],
            10,
        );
        assert_eq!(
            merged.iter().map(|h| h.source()).collect::<Vec<_>>(),
            vec![QuickSource::Note; 3],
        );
        let QuickHit::Note(first) = &merged[0] else { panic!("首条应是笔记") };
        assert_eq!(first.note_id, "n-1");

        let cut = merge_ranked(vec![note_hit("n-1", "甲", MatchKind::Contains), note_hit("n-2", "乙", MatchKind::Contains)], 1);
        assert_eq!(cut.len(), 1, "设置里的上限是最终显示条数的唯一判据");
    }

    /// 扇出的门槛：字段限定、多条件、空输入都挡下，只有一条光秃秃的关键词才扇。
    /// `is_vault_only` 是同一件事的另一半——挡下了就要在界面上说破，不能悄悄少搜四类。
    #[test]
    fn fan_out_only_for_a_bare_single_keyword() {
        assert_eq!(fan_out_term(&parser::parse("电碳").unwrap()), Some("电碳"));
        assert!(!is_vault_only(&parser::parse("电碳").unwrap()), "单关键词是两类都搜，不是只搜保险库");

        assert_eq!(fan_out_term(&parser::parse("系统:OA").unwrap()), None);
        assert_eq!(fan_out_term(&parser::parse("标签:生产").unwrap()), None);
        assert_eq!(fan_out_term(&parser::parse("电碳,检修").unwrap()), None, "多条件没有单个词可喂");
        assert_eq!(fan_out_term(&parser::parse("").unwrap()), None);
        assert_eq!(fan_out_term(&parser::parse("，").unwrap()), None, "只有一个分隔符等于空输入");

        assert!(is_vault_only(&parser::parse("系统:OA").unwrap()));
        assert!(is_vault_only(&parser::parse("电碳,检修").unwrap()));
        // 空输入既没扇出、也不算"只搜了保险库"：那一档是收藏/最近使用的推荐位，四类本来就没有对应物
        assert!(!is_vault_only(&parser::parse("").unwrap()));
    }

    /// 序列化线格式：`source` 是判别键，值与前端 `QuickSource` 同一份字面量。
    /// 这条是浮层渲染分支的依据，漂一个字面量就是一片空白行。
    #[test]
    fn hits_serialize_with_a_source_discriminator() {
        let json = serde_json::to_value(note_hit("n-1", "电碳台账", MatchKind::Prefix)).unwrap();
        assert_eq!(json["source"], "note");
        assert_eq!(json["noteId"], "n-1");
        assert_eq!(json["matchKind"], "prefix");

        let account = QuickHit::Account(AccountHit {
            target_id: "t".into(),
            item_id: "i".into(),
            system_name: "OA".into(),
            item_type: "web".into(),
            account_alias: "日常".into(),
            username_masked: "z•••n".into(),
            address_summary: "https://oa.cn".into(),
            tags: vec![],
            is_default: true,
            favorite: false,
            credential_count_on_target: 1,
            actions: vec![QuickAction::OpenTarget],
            match_kind: MatchKind::Exact,
        });
        let json = serde_json::to_value(&account).unwrap();
        assert_eq!(json["source"], "account");
        // 账号那一条的键一个都不能少：quick_action 与前端行渲染都读这些
        for key in ["targetId", "itemId", "systemName", "itemType", "accountAlias", "usernameMasked", "addressSummary", "isDefault", "favorite", "credentialCountOnTarget", "actions"] {
            assert!(json.get(key).is_some(), "账号命中少了 {key}：{json}");
        }

        let task = QuickHit::Task(TaskHit { task_key: "release".into(), label: "微服务发布".into(), env: "prod".into(), match_kind: MatchKind::Exact });
        assert_eq!(serde_json::to_value(&task).unwrap()["source"], "task");
        let quiz = QuickHit::Quiz(QuizHit { question_id: "q".into(), library_id: "l".into(), library_name: "安规".into(), seq: 42, qtype: "single".into(), stem: "题干".into(), match_kind: MatchKind::Contains });
        assert_eq!(serde_json::to_value(&quiz).unwrap()["source"], "quiz");
    }
}
