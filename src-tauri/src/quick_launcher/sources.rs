//! 快捷启动器的第二条腿：保险库以外的四类内容——笔记、题库、工具、任务中心。
//!
//! 三条口径：
//! 1. **缺哪枚读权限就不发那条查询**，不是"发了查询返回空"。没有 `notes.read` 的人看见
//!    "笔记这一类零命中"，等于让猜的人从空结果反推出权限判定结果；这与
//!    `query::allowed_actions` 里"不摆一颗点了必然被拒的按钮"是同一套判据。
//! 2. 用 `rbac::has_permission` 而不是 `require`：整条 `quick_search` 的门槛是
//!    `menu.quick_launcher`（命令层已判），这四类只是各自的读入口，一类无权限不该拒掉整次搜索。
//! 3. 每一路都带 `LIMIT`。笔记与工具要对正文/标题做 LIKE，这两张表都没有对应索引，
//!    不设上限就是一次无界全表扫；题库走 0015 建的 FTS5 trigram，本来就有候选上限。
//!
//! 取数一律走各源自己的 store，SQL 不进这一层——这四类的隔离口径（笔记按 `created_by`、
//! 工具与题库团队共用、任务只认权限）各自的测试已经钉着，重复实现一份必然漂移。

use super::query::{NoteHit, QuizHit, QuickHit, TaskHit, ToolHit};
use super::search::tier_of;
use crate::db::Db;
use crate::error::Result;
use crate::rbac::{self, perm};

/// 结果行里题干最多显示这么多字：一道题的 `stem` 可以是整段材料，浮层放不下，
/// 也不该在置顶窗里把整道题连同上下文一起摊在桌面上。落点页里有全文。
const STEM_EXCERPT_CHARS: usize = 100;

/// 四类内容各取若干，命中的等级按"名字字段"算：笔记看标题、题库看题干、工具看标题、任务看任务名。
///
/// `limit` 是每一类各自的上限（`query::PER_SOURCE_LIMIT`），不是最终显示条数。
pub fn search_sources(db: &Db, user: &str, term: &str, limit: usize) -> Result<Vec<QuickHit>> {
    let mut out = Vec::new();
    out.extend(search_notes(db, user, term, limit)?);
    out.extend(search_quiz(db, user, term, limit)?);
    out.extend(search_tools(db, user, term, limit)?);
    out.extend(search_tasks(db, user, term)?);
    Ok(out)
}

fn search_notes(db: &Db, user: &str, term: &str, limit: usize) -> Result<Vec<QuickHit>> {
    if !rbac::has_permission(db, user, perm::NOTES_READ)? {
        return Ok(Vec::new());
    }
    Ok(crate::notes::store::search(db, user, term, limit as i64)?
        .into_iter()
        .map(|n| NoteHit {
            match_kind: tier_of(&n.title, term),
            note_id: n.id,
            title: n.title,
            snippet: n.snippet,
            updated_at: n.updated_at,
        })
        .map(QuickHit::Note)
        .collect())
}

fn search_quiz(db: &Db, user: &str, term: &str, limit: usize) -> Result<Vec<QuickHit>> {
    if !rbac::has_permission(db, user, perm::QUIZ_LIBRARY_READ)? {
        return Ok(Vec::new());
    }
    Ok(crate::quiz::matcher::search_keyword(db, term, limit)?
        .into_iter()
        .map(|q| QuizHit {
            match_kind: tier_of(&q.stem, term),
            question_id: q.question_id,
            library_id: q.library_id,
            library_name: q.library_name,
            seq: q.seq,
            qtype: q.qtype,
            stem: excerpt(&q.stem),
        })
        .map(QuickHit::Quiz)
        .collect())
}

fn search_tools(db: &Db, user: &str, term: &str, limit: usize) -> Result<Vec<QuickHit>> {
    if !rbac::has_permission(db, user, perm::HTML_PAGE_READ)? {
        return Ok(Vec::new());
    }
    Ok(crate::html_pages::store::search(db, term, limit as i64)?
        .into_iter()
        .map(|p| ToolHit {
            match_kind: tier_of(&p.title, term),
            page_id: p.id,
            title: p.title,
            updated_at: p.updated_at,
        })
        .map(QuickHit::Tool)
        .collect())
}

/// 任务中心只搜定义，不发 SQL：任务类型是 `tasks::TASKS` 里硬编码的，
/// 环境又是固定两档，查库只会得到同一份答案。
fn search_tasks(db: &Db, user: &str, term: &str) -> Result<Vec<QuickHit>> {
    if !rbac::has_permission(db, user, perm::TASK_RELEASE_VIEW)? {
        return Ok(Vec::new());
    }
    Ok(crate::tasks::search_defs(term)
        .into_iter()
        .map(|(def, env)| TaskHit {
            match_kind: tier_of(def.label, term),
            task_key: def.key.to_string(),
            label: def.label.to_string(),
            // 只带 test/prod：中文标签（测试/生产）活在前端 ENVS 里，不复述一份，免得两处漂移
            env: env.as_str().to_string(),
        })
        .map(QuickHit::Task)
        .collect())
}

fn excerpt(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= STEM_EXCERPT_CHARS {
        return text.to_string();
    }
    let mut head: String = chars.iter().take(STEM_EXCERPT_CHARS).collect();
    head.push('…');
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quick_launcher::search::MatchKind;
    use crate::db::Db;

    fn db() -> Db {
        Db::open_in_memory(&vec![21u8; 32]).unwrap()
    }

    /// 空库上四条腿都要能跑通并返回空——这是"扇出不会把一次正常搜索带崩"的最低判据。
    #[test]
    fn empty_db_returns_no_hits() {
        let db = db();
        assert!(search_sources(&db, "u-nobody", "电碳", 5).unwrap().is_empty());
    }

    /// 缺哪枚读权限就不发那条查询：不是"发了查询返回空"，而是这一类根本不出现在结果里。
    ///
    /// 判据是反着下的——先让这条笔记**能被搜到**，再撤权限，看它是不是真的消失了。
    /// 只断言"无权限的用户结果为空"证明不了什么：那可能只是他本来就没有笔记。
    /// 而"撤一枚权限把别的一类也带走"同样是回归：这四类各判各的，整条搜索的门槛是
    /// `menu.quick_launcher`，由命令层把关，不在这里。
    #[test]
    fn a_source_without_its_read_permission_contributes_nothing() {
        use crate::auth::users;

        let d = db();
        let (uid, _vk) = users::initialize(&d, "管理员", "Admin#Pass2026").unwrap();
        let note = crate::notes::store::create(&d, &uid).unwrap();
        crate::notes::store::update(&d, &uid, &note.note.id, "电碳采集笔记", "<p>正文</p>").unwrap();
        crate::html_pages::store::create(&d, &uid, "电碳采集看板", "<div>正文</div>").unwrap();

        let before = search_sources(&d, &uid, "电碳", 5).unwrap();
        assert!(before.iter().any(|h| matches!(h, QuickHit::Note(_))), "有 notes.read 时这篇笔记必须被搜到：{before:?}");
        assert!(before.iter().any(|h| matches!(h, QuickHit::Tool(_))), "有 html.page.read 时这页必须被搜到：{before:?}");

        {
            let conn = d.lock_conn();
            conn.execute(
                "DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE permission_key='notes.read')",
                [],
            )
            .unwrap();
        }

        let after = search_sources(&d, &uid, "电碳", 5).unwrap();
        assert!(!after.iter().any(|h| matches!(h, QuickHit::Note(_))), "撤掉 notes.read 之后还在给笔记");
        assert!(after.iter().any(|h| matches!(h, QuickHit::Tool(_))), "撤一枚权限不得把另一类也带走");
    }

    /// 命中等级按"名字字段"算：标题/题干完全等于词才是 exact，前缀是 prefix，
    /// 只在正文里出现的一律落到 contains——正文命中说明不了名字层面的任何事。
    #[test]
    fn tiers_come_from_the_name_field() {
        use crate::auth::users;

        let d = db();
        let (uid, _vk) = users::initialize(&d, "管理员", "Admin#Pass2026").unwrap();
        for title in ["电碳", "电碳采集周报", "本周电碳采集"] {
            let n = crate::notes::store::create(&d, &uid).unwrap();
            crate::notes::store::update(&d, &uid, &n.note.id, title, "<p>无关正文</p>").unwrap();
        }
        let hits = search_sources(&d, &uid, "电碳", 5).unwrap();
        let kinds: Vec<(String, MatchKind)> = hits
            .iter()
            .filter_map(|h| match h {
                QuickHit::Note(n) => Some((n.title.clone(), n.match_kind)),
                _ => None,
            })
            .collect();
        assert!(kinds.contains(&("电碳".to_string(), MatchKind::Exact)), "{kinds:?}");
        assert!(kinds.contains(&("电碳采集周报".to_string(), MatchKind::Prefix)), "{kinds:?}");
        assert!(kinds.contains(&("本周电碳采集".to_string(), MatchKind::Contains)), "{kinds:?}");
    }

    #[test]
    fn excerpt_keeps_short_stems_and_cuts_long_ones() {
        assert_eq!(excerpt("简答题干"), "简答题干");
        let long = "依".repeat(STEM_EXCERPT_CHARS + 10);
        let cut = excerpt(&long);
        assert_eq!(cut.chars().count(), STEM_EXCERPT_CHARS + 1);
        assert!(cut.ends_with('…'));
    }
}
