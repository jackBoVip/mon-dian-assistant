//! 镜像串：`name[:tag]` 的拆分、按构建时间挑最新、指定镜像的精确匹配。
//!
//! 原实现把这套逻辑写在 `updateServiceWithRecentTag` 里，靠"列表第一个就是最新"的
//! 隐含约定（它前面确实排了一次序）。这里把约定写成显式规则，并把端口号那个坑钉住：
//! `harbor.example.com:8080/ns/svc` 里的冒号属于主机，不是 tag。

/// 一个可选的镜像 tag 及其构建时间（毫秒）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagCandidate {
    pub tag: String,
    pub updated_ms: i64,
}

/// `镜像[:tag]` → `(名字, 尾部 tag)`。
///
/// 只认**最后一个斜杠之后**的冒号：仓库地址常带端口（`:8080/`），把它当 tag 会切掉端口。
pub fn split_name_tag(raw: &str) -> (String, Option<String>) {
    let text = raw.trim();
    let tail_start = text.rfind('/').map(|i| i + 1).unwrap_or(0);
    let (head, colon) = text[tail_start..].split_once(':').map(|(n, t)| (n, Some(t))).unwrap_or((&text[tail_start..], None));
    if colon.unwrap_or_default().is_empty() {
        return (text.to_string(), None);
    }
    let name = format!("{}{}", &text[..tail_start], head);
    (name, colon.map(|t| t.to_string()))
}

/// 从「镜像」列的原文里取 tag：只有写全了 `名字:tag` 才算指定了 tag。
pub fn tag_from_hint(raw: &str) -> Option<String> {
    split_name_tag(raw).1.filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string())
}

/// 把 tag 拼到仓库地址上：先剥掉地址里已有的 tag，避免出现 `svc:a:b`。
pub fn with_tag(public_url: &str, tag: &str) -> String {
    let (name, _) = split_name_tag(public_url);
    format!("{name}:{}", tag.trim())
}

/// 挑 tag 的结果。四种都要给界面不同的话术——"没找到指定镜像"和"仓库里没有 tag"不是一回事。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Choice {
    Empty,
    Latest(TagCandidate),
    Designated(TagCandidate),
    DesignatedNotFound(String),
}

impl Choice {
    pub fn candidate(&self) -> Option<&TagCandidate> {
        match self {
            Choice::Latest(c) | Choice::Designated(c) => Some(c),
            _ => None,
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, Choice::Empty)
    }
}

/// 按构建时间取最新；同刻并发的构建按 tag 字典序倒排，保证同样输入永远同一个结果
/// （发布这件事上，可复现比"合理"更重要）。
pub fn choose(candidates: &[TagCandidate], designated: Option<&str>) -> Choice {
    let designated = designated.map(str::trim).filter(|t| !t.is_empty());
    let mut sorted: Vec<TagCandidate> = candidates.to_vec();
    sorted.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then_with(|| b.tag.cmp(&a.tag)));
    let Some(tag) = designated else {
        return match sorted.into_iter().next() {
            Some(c) => Choice::Latest(c),
            None => Choice::Empty,
        };
    };
    // 指定镜像必须精确命中：模糊匹配会把人点名的那次构建换成别的构建。
    match candidates.iter().find(|c| c.tag == tag).cloned() {
        Some(c) => Choice::Designated(c),
        None => Choice::DesignatedNotFound(tag.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_keeps_the_registry_port_in_the_name() {
        assert_eq!(
            split_name_tag("harbor.example.com/ns/svc:20261030"),
            ("harbor.example.com/ns/svc".to_string(), Some("20261030".to_string()))
        );
        assert_eq!(
            split_name_tag("harbor.example.com:8080/ns/svc"),
            ("harbor.example.com:8080/ns/svc".to_string(), None)
        );
        assert_eq!(
            split_name_tag("harbor.example.com:8080/ns/svc:20261030"),
            ("harbor.example.com:8080/ns/svc".to_string(), Some("20261030".to_string()))
        );
        assert_eq!(split_name_tag("svc"), ("svc".to_string(), None));
        assert_eq!(split_name_tag("svc:"), ("svc:".to_string(), None), "尾部空 tag 不算指定");
    }

    #[test]
    fn tag_from_hint_only_counts_a_qualified_reference() {
        assert_eq!(tag_from_hint("harbor/ns/svc:20261030").as_deref(), Some("20261030"));
        assert_eq!(tag_from_hint("harbor/ns/svc"), None);
        assert_eq!(tag_from_hint("  "), None);
    }

    #[test]
    fn with_tag_replaces_an_existing_tag() {
        assert_eq!(with_tag("harbor/ns/svc:old", "20261030"), "harbor/ns/svc:20261030");
        assert_eq!(with_tag("harbor:8080/ns/svc", "20261030"), "harbor:8080/ns/svc:20261030");
    }

    fn c(tag: &str, ms: i64) -> TagCandidate {
        TagCandidate { tag: tag.to_string(), updated_ms: ms }
    }

    #[test]
    fn choose_picks_the_newest_build_and_is_deterministic_on_ties() {
        let list = vec![c("20261028", 100), c("20261030", 300), c("20261029", 200)];
        match choose(&list, None) {
            Choice::Latest(candidate) => assert_eq!(candidate.tag, "20261030"),
            other => panic!("应取最新构建，实际 {other:?}"),
        }
        // 同一毫秒：按 tag 倒序，不再看输入顺序
        let tied = vec![c("a", 100), c("c", 100), c("b", 100)];
        assert_eq!(choose(&tied, None).candidate().unwrap().tag, "c");
    }

    #[test]
    fn designated_tag_matches_exactly_or_reports_back() {
        let list = vec![c("20261028", 100), c("20261030", 300)];
        assert_eq!(choose(&list, Some("20261028")), Choice::Designated(c("20261028", 100)));
        // 空白与缺失都要如实分开
        assert_eq!(choose(&list, Some("  ")), Choice::Latest(c("20261030", 300)), "空指定等于没指定");
        assert_eq!(choose(&list, Some("20261029")), Choice::DesignatedNotFound("20261029".to_string()));
        assert_eq!(choose(&[], Some("20261029")), Choice::DesignatedNotFound("20261029".to_string()));
        assert!(choose(&[], None).is_empty());
    }
}
