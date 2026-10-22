//! 解锁后由 Rust 后端构建的短生命周期内存搜索索引。
//!
//! 安全边界（需求 2.6.3）：
//! - 索引只含目标名称/地址摘要、账号别名、用户名、类型、分组、标签、非秘密备注。
//! - 绝不包含密码、Token、私钥，也绝不持久化到 SQLite / 日志 / 崩溃报告。
//! - 锁定、登出、超时、切换使用者、退出时必须清零。

use super::parser::{Condition, Field, ParsedQuery};
use zeroize::Zeroize;

/// 一条可搜索记录 = 目标下的一条具体凭据（粒度是凭据，不是目标）。
/// 这样 `地址 + 用户名` 必然落在同一条凭据及其所属目标关系上，不会跨账号拼接误命中。
#[derive(Debug, Clone)]
pub struct SearchDoc {
    pub target_id: String,
    pub item_id: String,
    pub system_name: String,
    pub address: String,
    pub host: String,
    pub port: String,
    pub username: String,
    pub account_alias: String,
    pub item_type: String,
    pub group_name: String,
    pub tags: Vec<String>,
    pub note: String,
    pub favorite: bool,
    pub is_default: bool,
    pub last_accessed_at: Option<String>,
    /// 该目标下当前使用者可见的有效凭据数量
    pub credential_count: usize,
}

impl SearchDoc {
    pub fn credential_count_hint(&self) -> usize {
        self.credential_count.max(1)
    }

    fn haystack(&self, field: Field) -> Vec<&str> {
        match field {
            Field::System => vec![&self.system_name],
            Field::Address => vec![&self.address, &self.host, &self.port],
            Field::Username => vec![&self.username],
            Field::AccountAlias => vec![&self.account_alias],
            Field::Type => vec![&self.item_type],
            Field::Tag => self.tags.iter().map(|s| s.as_str()).collect(),
            Field::Group => vec![&self.group_name],
            Field::Any => vec![
                &self.system_name,
                &self.address,
                &self.host,
                &self.account_alias,
                &self.username,
                &self.item_type,
                &self.group_name,
                &self.note,
            ],
        }
    }

    fn extra_haystack(&self, field: Field) -> Vec<String> {
        match field {
            Field::Tag => self.tags.clone(),
            Field::Any => self.tags.iter().map(|s| s.to_lowercase()).collect(),
            _ => vec![],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MatchKind {
    Exact,
    Prefix,
    Contains,
}

fn field_match(doc: &SearchDoc, cond: &Condition) -> Option<MatchKind> {
    let term = &cond.term;
    let mut best: Option<MatchKind> = None;
    let mut consider = |v: &str| {
        if v.is_empty() {
            return;
        }
        let k = if v == term {
            Some(MatchKind::Exact)
        } else if v.starts_with(term.as_str()) {
            Some(MatchKind::Prefix)
        } else if v.contains(term.as_str()) {
            Some(MatchKind::Contains)
        } else {
            None
        };
        if let Some(k) = k {
            if best.map(|b| (k as u8) < (b as u8)).unwrap_or(true) {
                best = Some(k);
            }
        }
    };

    for v in doc.haystack(cond.field) {
        consider(v);
    }
    for v in doc.extra_haystack(cond.field) {
        consider(&v);
    }
    // 类型条件支持中文显示名匹配
    if cond.field == Field::Type || cond.field == Field::Any {
        consider(super::parser::normalize_type_value(&doc.item_type).as_str());
    }
    best
}

/// AND 语义：所有条件都必须命中同一条记录。空查询不产生结果（由上层决定展示收藏/最近）。
pub fn matches(doc: &SearchDoc, query: &ParsedQuery) -> Option<MatchKind> {
    if query.conditions.is_empty() {
        return None;
    }
    let mut worst = MatchKind::Exact;
    let mut seen = false;
    for cond in &query.conditions {
        let kind = field_match(doc, cond)?;
        // 取最宽松的命中等级，避免把「包含」夸大成「完全匹配」
        if !seen || (kind as u8) > (worst as u8) {
            worst = kind;
        }
        seen = true;
    }
    Some(worst)
}

/// 排序配置（需求 line 294：优先级为 完全匹配 → 前缀匹配 → 包含匹配 → 最近使用/收藏，
/// 其中"最近使用/收藏"这一档**可配置**，且任何情况下都不得覆盖 AND 过滤的结果）。
#[derive(Debug, Clone, Copy)]
pub struct RankConfig {
    /// false = 匹配等级之外不再做同级微调（忽略收藏/默认/最近使用）。
    pub recent_favorite_first: bool,
}

impl Default for RankConfig {
    fn default() -> Self {
        Self { recent_favorite_first: true }
    }
}

/// 同一匹配等级内的先后：收藏 > 默认账号 > 最近使用（按访问时刻倒序）。
/// 关闭该档时一律视为相等，交给 sort_by 的稳定性保留索引原序。
fn tiebreak(a: &SearchDoc, b: &SearchDoc, cfg: &RankConfig) -> std::cmp::Ordering {
    if !cfg.recent_favorite_first {
        return std::cmp::Ordering::Equal;
    }
    b.favorite
        .cmp(&a.favorite)
        .then_with(|| b.is_default.cmp(&a.is_default))
        .then_with(|| {
            // last_accessed_at 是统一 UTC 格式的时间戳字符串，字典序即时间序
            b.last_accessed_at.as_deref().unwrap_or("").cmp(a.last_accessed_at.as_deref().unwrap_or(""))
        })
}

/// 短生命周期索引。Drop 时清零所有明文搜索字段。
///
/// 查询词在解析阶段已统一小写，因此匹配必须发生在小写副本上；
/// 否则 `系统:OA` 这类含大写字母的输入会漏掉 `OA办公系统`。
/// 建索引时一次性生成小写副本，查询期不再逐条分配字符串。
pub struct SearchIndex {
    docs: Vec<SearchDoc>,
    folded: Vec<SearchDoc>,
    built_at: i64,
    zeroized: bool,
}

/// 只小写可搜索的文本字段，其余（id、布尔、时间戳）原样保留。
fn fold_case(d: &SearchDoc) -> SearchDoc {
    SearchDoc {
        target_id: d.target_id.clone(),
        item_id: d.item_id.clone(),
        system_name: d.system_name.to_lowercase(),
        address: d.address.to_lowercase(),
        host: d.host.to_lowercase(),
        port: d.port.to_lowercase(),
        username: d.username.to_lowercase(),
        account_alias: d.account_alias.to_lowercase(),
        item_type: d.item_type.to_lowercase(),
        group_name: d.group_name.to_lowercase(),
        tags: d.tags.iter().map(|t| t.to_lowercase()).collect(),
        note: d.note.to_lowercase(),
        favorite: d.favorite,
        is_default: d.is_default,
        last_accessed_at: d.last_accessed_at.clone(),
        credential_count: d.credential_count,
    }
}

impl SearchIndex {
    pub fn new(docs: Vec<SearchDoc>) -> Self {
        let folded = docs.iter().map(fold_case).collect();
        Self { docs, folded, built_at: chrono::Utc::now().timestamp(), zeroized: false }
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    pub fn built_at(&self) -> i64 {
        self.built_at
    }

    /// 只返回匹配摘要，不返回任何秘密。默认按"收藏/默认/最近使用"做同级微调。
    pub fn search(&self, query: &ParsedQuery, limit: usize) -> Vec<(SearchDoc, MatchKind)> {
        self.search_ranked(query, limit, &RankConfig::default())
    }

    /// 同 `search`，但同级微调档由设置 `quick_launcher_rank_recent_favorite` 决定（需求 line 294：可配置）。
    /// 过滤永远先于排序：`matches()` 通不过的记录不会因为收藏或最近使用被排回来。
    pub fn search_ranked(&self, query: &ParsedQuery, limit: usize, cfg: &RankConfig) -> Vec<(SearchDoc, MatchKind)> {
        let mut hits: Vec<(usize, MatchKind)> = self
            .folded
            .iter()
            .enumerate()
            .filter_map(|(i, f)| matches(f, query).map(|k| (i, k)))
            .collect();
        // MatchKind 的声明顺序是 Exact(0) < Prefix(1) < Contains(2)，所以升序才是"完全匹配在前"。
        // sort_by 是稳定排序：等级与同级档都相等时保持索引原序。
        hits.sort_by(|a, b| {
            let (ka, kb) = (a.1 as u8, b.1 as u8);
            if ka != kb {
                ka.cmp(&kb)
            } else {
                tiebreak(&self.folded[a.0], &self.folded[b.0], cfg)
            }
        });
        hits.truncate(limit);
        hits.into_iter().map(|(i, k)| (self.docs[i].clone(), k)).collect()
    }

    /// 空查询时展示收藏/最近使用（仅非秘密摘要）。
    pub fn defaults(&self, limit: usize) -> Vec<SearchDoc> {
        let mut v: Vec<SearchDoc> = self
            .docs
            .iter()
            .filter(|d| d.favorite || d.last_accessed_at.is_some())
            .cloned()
            .collect();
        v.sort_by(|a, b| {
            b.favorite.cmp(&a.favorite).then_with(|| {
                b.last_accessed_at.as_deref().unwrap_or("").cmp(a.last_accessed_at.as_deref().unwrap_or(""))
            })
        });
        v.truncate(limit);
        v
    }

    pub fn get(&self, item_id: &str) -> Option<&SearchDoc> {
        self.docs.iter().find(|d| d.item_id == item_id)
    }

    /// 导入查重用：去重后的 (target_id, 地址摘要, 主机)。只含已解密摘要，不落盘。
    pub fn target_hints(&self) -> Vec<(String, String, String)> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for d in &self.docs {
            if seen.insert(d.target_id.clone()) {
                out.push((d.target_id.clone(), d.address.clone(), d.host.clone()));
            }
        }
        out
    }

    /// 锁定/登出/超时/切换使用者时调用。
    pub fn wipe(&mut self) {
        for d in self.docs.iter_mut().chain(self.folded.iter_mut()) {
            d.system_name.zeroize();
            d.address.zeroize();
            d.host.zeroize();
            d.port.zeroize();
            d.username.zeroize();
            d.account_alias.zeroize();
            d.note.zeroize();
            d.group_name.zeroize();
            for t in d.tags.iter_mut() {
                t.zeroize();
            }
        }
        self.docs.clear();
        self.folded.clear();
        self.zeroized = true;
    }
}

impl Drop for SearchIndex {
    fn drop(&mut self) {
        if !self.zeroized {
            self.wipe();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quick_launcher::parser::parse;

    fn doc(item: &str, target: &str, addr: &str, user: &str, alias: &str, ty: &str, tags: &[&str]) -> SearchDoc {
        SearchDoc {
            target_id: format!("t-{target}"),
            item_id: item.into(),
            system_name: target.into(),
            address: addr.into(),
            host: addr.split([':', '/']).next().unwrap_or(addr).into(),
            port: "".into(),
            username: user.into(),
            account_alias: alias.into(),
            item_type: ty.into(),
            group_name: "运维".into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            note: "".into(),
            favorite: false,
            is_default: false,
            last_accessed_at: None,
            credential_count: 1,
        }
    }

    fn index() -> SearchIndex {
        SearchIndex::new(vec![
            doc("c-oa-personal", "OA办公系统", "https://oa.nmgdl.cn", "lisi", "日常办公", "web", &["门户", "内部"]),
            doc("c-oa-ops", "OA办公系统", "https://oa.nmgdl.cn", "ops_admin", "运维账号", "web", &["门户", "运维"]),
            doc("c-db-prod", "生产数据库", "10.0.0.22:3306", "root", "运维账号", "database", &["生产"]),
            doc("c-ssh-jump", "设备运维终端", "10.0.12.22", "root", "跳板机", "terminal", &["运维"]),
        ])
    }

    #[test]
    fn and_semantics_both_conditions_must_hit_same_credential() {
        let idx = index();
        let hits = idx.search(&parse("地址:10.0.0.22, 账号:root").unwrap(), 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.item_id, "c-db-prod");
    }

    #[test]
    fn and_semantics_rejects_cross_record_stitching() {
        let idx = index();
        // lisi 在 OA，10.0.0.22 在生产数据库 —— 不存在同时满足的凭据
        let hits = idx.search(&parse("地址:10.0.0.22, 账号:lisi").unwrap(), 10);
        assert!(hits.is_empty(), "不得把不同凭据的字段拼接成误命中");
    }

    #[test]
    fn chinese_comma_multi_condition_on_same_target() {
        let idx = index();
        let hits = idx.search(&parse("OA，zhangsan").unwrap(), 10);
        assert!(hits.is_empty());
        let hits = idx.search(&parse("OA，lisi").unwrap(), 10);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn three_conditions_all_required() {
        let idx = index();
        let q = parse("系统:OA办公系统, 账号别名:日常办公, 类型:网页").unwrap();
        let hits = idx.search(&q, 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.item_id, "c-oa-personal");
    }

    #[test]
    fn type_filter_works_in_chinese() {
        let idx = index();
        let hits = idx.search(&parse("运维账号，类型:数据库").unwrap(), 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.item_id, "c-db-prod");
    }

    #[test]
    fn tag_field_qualifier() {
        let idx = index();
        let hits = idx.search(&parse("标签:生产").unwrap(), 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.item_id, "c-db-prod");
    }

    #[test]
    fn same_url_multiple_accounts_both_searchable() {
        let idx = index();
        let hits = idx.search(&parse("地址:oa.nmgdl.cn").unwrap(), 10);
        assert_eq!(hits.len(), 2, "同一地址下的多条凭据都应可被搜到");
    }

    #[test]
    fn secrets_are_never_in_the_index() {
        let idx = index();
        // 索引里没有任何密码字段可搜索；即便用户输入密码原文也命中不了
        let hits = idx.search(&parse("S3cr3t-Pa55w0rd").unwrap(), 10);
        assert!(hits.is_empty());
    }

    #[test]
    fn exact_beats_prefix_beats_contains() {
        let idx = SearchIndex::new(vec![
            doc("exact", "OA", "a", "u", "OA", "web", &[]),
            doc("prefix", "OA办公系统", "a", "u", "x", "web", &[]),
            doc("contains", "内部OA门户", "a", "u", "x", "web", &[]),
        ]);
        let hits = idx.search(&parse("系统:OA").unwrap(), 10);
        let ids: Vec<&str> = hits.iter().map(|h| h.0.item_id.as_str()).collect();
        assert_eq!(ids, vec!["exact", "prefix", "contains"]);
    }

    #[test]
    fn wipe_removes_all_plaintext_fields() {
        let mut idx = index();
        idx.wipe();
        assert_eq!(idx.len(), 0);
        assert!(idx.search(&parse("OA").unwrap(), 10).is_empty());
    }

    #[test]
    fn empty_query_returns_nothing_from_search() {
        let idx = index();
        assert!(idx.search(&parse("").unwrap(), 10).is_empty());
    }

    #[test]
    fn limit_is_respected() {
        let idx = index();
        assert_eq!(idx.search(&parse("OA").unwrap(), 1).len(), 1);
    }

    /// 需求 §285：空输入的「最近使用/收藏」应**由设置启用**。关掉后后端必须一条都不给，
    /// 而不是只靠前端不去请求——直接调用命令同样拿不到内容。
    #[test]
    fn empty_input_suggestions_follow_the_show_recent_setting() {
        use crate::quick_launcher::query::{search_unlocked, ActionPolicy};

        let mut fav = doc("c-fav", "OA办公系统", "https://oa.nmgdl.cn", "lisi", "日常办公", "web", &["门户"]);
        fav.favorite = true;
        let mut recent = doc("c-recent", "生产数据库", "10.0.0.22:3306", "root", "运维账号", "database", &["生产"]);
        recent.last_accessed_at = Some("2026-01-05T00:00:00Z".into());
        let plain = doc("c-plain", "无关系统", "https://x.cn", "u", "别名", "web", &[]);
        let idx = SearchIndex::new(vec![fav, recent, plain]);
        let policy = ActionPolicy::default();

        let on = search_unlocked(&idx, "", 10, false, &policy, true, true).unwrap();
        assert_eq!(
            on.iter().map(|r| r.item_id.as_str()).collect::<Vec<_>>(),
            vec!["c-fav", "c-recent"],
            "开启时只给收藏与最近使用，收藏在前；无关记录不得混进来"
        );

        let off = search_unlocked(&idx, "", 10, false, &policy, false, true).unwrap();
        assert!(off.is_empty(), "设置关闭时空输入必须不返回任何保险库记录");

        // 该设置只管"没有任何条件"这一种输入：有真实条件时照常搜
        let typed = search_unlocked(&idx, "OA", 10, false, &policy, false, true).unwrap();
        assert_eq!(typed.len(), 1);
        assert_eq!(typed[0].item_id, "c-fav");

        // 只有一个分隔符（语法上等于空输入）也归"空输入"，不得绕过设置
        assert!(search_unlocked(&idx, "，", 10, false, &policy, false, true).unwrap().is_empty());
    }

    /// 需求 line 294：优先级是 完全 > 前缀 > 包含，"最近使用/收藏"只在**同一等级内部**微调。
    /// 收藏且刚用过的"包含匹配"不得排到一条朴素的"完全匹配"之前。
    #[test]
    fn match_tier_always_outranks_favorite_and_recent() {
        let mut fav_contains = doc("c-fav-contains", "内部OA门户", "a", "u", "x", "web", &[]);
        fav_contains.favorite = true;
        fav_contains.is_default = true;
        fav_contains.last_accessed_at = Some("2026-01-09T00:00:00Z".into());
        let exact = doc("c-exact", "OA", "a", "u", "x", "web", &[]);
        let mut prefix = doc("c-prefix", "OA办公系统", "a", "u", "x", "web", &[]);
        prefix.favorite = true;
        let idx = SearchIndex::new(vec![fav_contains, exact, prefix]);

        let hits = idx.search(&parse("系统:OA").unwrap(), 10);
        assert_eq!(
            hits.iter().map(|h| h.0.item_id.as_str()).collect::<Vec<_>>(),
            vec!["c-exact", "c-prefix", "c-fav-contains"],
            "等级顺序必须是 完全→前缀→包含，收藏与最近使用不能跨越等级"
        );
        assert_eq!(hits[0].1, MatchKind::Exact);
        assert_eq!(hits[2].1, MatchKind::Contains);
    }

    /// 同一等级内部的顺序：收藏 > 默认账号 > 最近使用（按访问时刻倒序，而不是"用过就算"）。
    #[test]
    fn same_tier_orders_favorite_then_default_then_most_recent() {
        let fav_stale = {
            let mut d = doc("c-fav-stale", "OA", "a", "u", "x", "web", &[]);
            d.favorite = true;
            d
        };
        let fav_recent = {
            let mut d = doc("c-fav-recent", "OA", "a", "u", "x", "web", &[]);
            d.favorite = true;
            d.last_accessed_at = Some("2026-01-02T00:00:00Z".into());
            d
        };
        let default_doc = {
            let mut d = doc("c-default", "OA", "a", "u", "x", "web", &[]);
            d.is_default = true;
            d.last_accessed_at = Some("2026-01-01T00:00:00Z".into());
            d
        };
        let plain_recent = {
            let mut d = doc("c-plain-recent", "OA", "a", "u", "x", "web", &[]);
            d.last_accessed_at = Some("2026-01-09T00:00:00Z".into());
            d
        };
        let idx = SearchIndex::new(vec![fav_stale, fav_recent, default_doc, plain_recent]);
        let ids = |v: &[(SearchDoc, MatchKind)]| v.iter().map(|h| h.0.item_id.clone()).collect::<Vec<_>>();

        let on = idx.search_ranked(&parse("系统:OA").unwrap(), 10, &RankConfig { recent_favorite_first: true });
        assert_eq!(ids(&on), vec!["c-fav-recent", "c-fav-stale", "c-default", "c-plain-recent"]);

        // 可配置的那一档关掉：只剩等级顺序，同级保持索引原序
        let off = idx.search_ranked(&parse("系统:OA").unwrap(), 10, &RankConfig { recent_favorite_first: false });
        assert_eq!(ids(&off), vec!["c-fav-stale", "c-fav-recent", "c-default", "c-plain-recent"]);
    }

    /// 排序档再怎么配置都不能把 AND 过滤掉的记录排回来。
    #[test]
    fn ranking_config_never_resurrects_records_rejected_by_and_filter() {
        let mut loved = doc("c-loved", "OA办公系统", "10.0.0.22:3306", "lisi", "日常办公", "web", &["门户"]);
        loved.favorite = true;
        loved.is_default = true;
        loved.last_accessed_at = Some("2026-01-09T00:00:00Z".into());
        // 只有这条同时满足 地址 + 账号
        let mut exact_hit = doc("c-hit", "营销系统", "10.0.0.22:3306", "root", "运维账号", "database", &[]);
        exact_hit.last_accessed_at = Some("2026-01-01T00:00:00Z".into());
        let idx = SearchIndex::new(vec![loved, exact_hit]);

        for cfg in [RankConfig::default(), RankConfig { recent_favorite_first: false }] {
            let hits = idx.search_ranked(&parse("地址:10.0.0.22，账号:root").unwrap(), 10, &cfg);
            assert_eq!(
                hits.iter().map(|h| h.0.item_id.as_str()).collect::<Vec<_>>(),
                vec!["c-hit"],
                "收藏/默认/最近使用都不得越过 AND 过滤"
            );
        }
        // 对照：这条记录本身是可搜的（证明上面的断言不是空查询造成的假绿）
        assert!(idx.search(&parse("系统:OA办公系统").unwrap(), 10).iter().any(|h| h.0.item_id == "c-loved"));
    }
}
