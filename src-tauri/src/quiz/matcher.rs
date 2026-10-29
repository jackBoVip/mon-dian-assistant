//! 题干匹配：FTS5(trigram) 取候选 → 字符级打分 → 阈值门控。
//!
//! 为什么不是「一条 SQL 查完」：FTS 只负责把候选从几万题里缩到几百条，
//! 真正决定「是不是同一道题」的是字符级相似度——OCR 会认错一两个字，
//! 而 trigram 命中要求至少有一个连续 3 字片段完全相同。两者分工写在这里，
//! 是为了让「为什么这题没匹配上」永远能落到某一条可复现的规则上。
//!
//! 模块名不是 `match`：那是 Rust 关键字，文件名只能换个写法。
//!
//! 红线：**绝不猜答案**。分数不够就不出结果，宁可让人复制题干手动搜，
//! 也不把「最像的那题」的答案冒充成当前题的答案。

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::{params_from_iter, Row};
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, Result};
use crate::quiz::models::QuizOption;
use crate::quiz::parse::normalize::normalize_text;

/// 显示答案的最低分：低于这个分数一律不出结果（宁可空着）。
pub const DISPLAY_MIN: f64 = 0.62;
/// 第一与第二名的最小差距：两题分数咬得太近说明题面本身区分不开，不猜。
pub const DISPLAY_GAP: f64 = 0.08;
/// 同题刷新时用的维持阈值：已经在显示的结果，轻微抖动不该闪走。
pub const STICKY_MIN: f64 = 0.52;
/// 一次匹配最多返回几条候选（第一条用来显示，其余用于调试与「换一题」）。
pub const MAX_HITS: usize = 5;
/// 助手范围里最多点名几份题库；超过就退化成「全部」，由调用方拒绝而不是静默截断。
pub const MAX_SCOPE_LIBRARIES: usize = 50;

/// FTS 候选上限：先取 400 条再打分，避免长文本把打分拖成秒级。
const FTS_CANDIDATES: usize = 400;
/// 兜底 LIKE 扫描的题量上限：超过这个规模只走 FTS，不做全表扫描。
const LIKE_SCAN_MAX_QUESTIONS: i64 = 5000;
/// 查询切段长度：一段 6 个字符，任意一段命中就能把这道题带进候选。
const CHUNK_CHARS: usize = 6;
/// 最多取几段去拼 OR 查询。
const MAX_CHUNKS: usize = 6;
/// 匹配缓存的容量与存活时间：悬停每 tick 都会问一次，缓存是省电的主要手段。
const CACHE_CAPACITY: usize = 512;
const CACHE_TTL: Duration = Duration::from_secs(600);

/// 一条命中：题干与答案按发布时的原始形状返回，前端不需要再拼。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchHit {
    pub question_id: String,
    pub library_id: String,
    pub library_name: String,
    pub seq: i64,
    pub qtype: String,
    pub stem: String,
    pub options: Vec<QuizOption>,
    pub answer_display: String,
    pub tags: Vec<String>,
    /// 0.0–1.0，越大越像；显示门槛见 [`DISPLAY_MIN`]。
    pub score: f64,
}

struct Candidate {
    hit: MatchHit,
    stem_norm: String,
}

fn json_options(raw: &str) -> Vec<QuizOption> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn json_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// 题库范围条件。`None` = 全部题库；`Some(ids)` = 只查这几份。
fn scope_clause(scope: Option<&[String]>) -> String {
    match scope {
        Some(ids) if !ids.is_empty() => {
            let slots = vec!["?"; ids.len()].join(",");
            format!(" AND q.library_id IN ({slots})")
        }
        _ => String::new(),
    }
}

const CANDIDATE_COLUMNS: &str = "q.id, q.library_id, l.name, q.seq, q.qtype, q.stem, q.options_json, \
                                 q.answer_display, q.tags_json, q.stem_norm";

fn candidate_from_row(r: &Row) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        hit: MatchHit {
            question_id: r.get(0)?,
            library_id: r.get(1)?,
            library_name: r.get(2)?,
            seq: r.get(3)?,
            qtype: r.get(4)?,
            stem: r.get(5)?,
            options: json_options(&r.get::<_, String>(6)?),
            answer_display: r.get(7)?,
            tags: json_tags(&r.get::<_, String>(8)?),
            score: 0.0,
        },
        stem_norm: r.get(9)?,
    })
}

/// FTS 查询串：把归一化文本切成若干 6 字片段，每段加双引号后 OR。
///
/// 为什么不用整句做短语查询：OCR 错一个字，整句就不是「连续子串」了，
/// 候选会直接归零；切成几段后，错字只毁掉它所在的那一段，其余段照样能带回候选。
fn fts_query(normalized: &str) -> Option<String> {
    let mut chunks: Vec<String> = Vec::new();
    for word in normalized.split_whitespace() {
        let chars: Vec<char> = word.chars().collect();
        for window in chars.chunks(CHUNK_CHARS) {
            if window.len() < 3 {
                continue;
            }
            chunks.push(window.iter().collect());
        }
    }
    chunks.sort_by_key(|c| std::cmp::Reverse(c.chars().count()));
    chunks.dedup();
    chunks.truncate(MAX_CHUNKS);
    if chunks.is_empty() {
        return None;
    }
    Some(chunks.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(" OR "))
}

fn fetch_candidates(db: &Db, normalized: &str, scope: Option<&[String]>) -> Result<Vec<Candidate>> {
    let conn = db.lock_conn();
    let clause = scope_clause(scope);
    let scope_ids: &[String] = scope.unwrap_or(&[]);
    let chars = normalized.chars().count();

    // trigram 分词器最短只认 3 个字符；2 字以内直接走 LIKE，而不是让 FTS 返回空。
    if chars >= 3 {
        if let Some(fts) = fts_query(normalized) {
            let sql = format!(
                "SELECT {CANDIDATE_COLUMNS}
                   FROM quiz_question_fts f
                   JOIN quiz_questions q ON q.rowid = f.rowid
                   JOIN quiz_libraries l ON l.id = q.library_id
                  WHERE quiz_question_fts MATCH ?1{clause}
                  ORDER BY bm25(quiz_question_fts, 3.0, 1.0)
                  LIMIT {FTS_CANDIDATES}"
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&fts];
            for id in scope_ids {
                params.push(id);
            }
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(params), candidate_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
    }

    // 兜底：题量小的时候允许一次 LIKE 扫描；题量大就承认「查不到」，不拿 CPU 去换空结果。
    let count_sql = format!("SELECT count(*) FROM quiz_questions q WHERE 1=1{clause}");
    let count: i64 = conn.query_row(
        &count_sql,
        params_from_iter(scope_ids.iter()),
        |r| r.get(0),
    )?;
    if count > LIKE_SCAN_MAX_QUESTIONS {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {CANDIDATE_COLUMNS}
           FROM quiz_questions q
           JOIN quiz_libraries l ON l.id = q.library_id
          WHERE (q.stem_norm LIKE '%' || ?1 || '%' OR q.options_norm LIKE '%' || ?1 || '%'){clause}
          ORDER BY q.library_id, q.seq
          LIMIT 200"
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&normalized];
    for id in scope_ids {
        params.push(id);
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(params), candidate_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn bigrams(chars: &[char]) -> HashSet<(char, char)> {
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

fn trigrams(chars: &[char]) -> HashSet<(char, char, char)> {
    chars.windows(3).map(|w| (w[0], w[1], w[2])).collect()
}

fn jaccard<T: Eq + Hash>(a: &HashSet<T>, b: &HashSet<T>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    inter / union
}

/// 关键片段覆盖：归一化文本按 [`CHUNK_CHARS`] 切成的片段里，有几段能在题干里原样找到。
///
/// 用「片段」而不是「整词」：中文题干没有空格，整句当一个词的话，
/// OCR 错一个字覆盖率就归零，一道 13 字的题会因此掉到显示门槛以下（实测 0.58）。
/// 片段与 FTS 召回用的是同一种切法，所以「能召回」与「算得分」对同一处错字的容忍度一致。
fn chunk_coverage(normalized: &str, stem_norm: &str) -> f64 {
    let mut total = 0usize;
    let mut hit = 0usize;
    for word in normalized.split_whitespace() {
        let chars: Vec<char> = word.chars().collect();
        for window in chars.chunks(CHUNK_CHARS) {
            if window.len() < 3 {
                continue;
            }
            total += 1;
            let chunk: String = window.iter().collect();
            if stem_norm.contains(&chunk) {
                hit += 1;
            }
        }
    }
    if total == 0 {
        return 0.0;
    }
    hit as f64 / total as f64
}

/// 打分：五项加权，权重和为 1。
///
/// - 双字组 Jaccard 0.45：中文题干的主要相似度来源，容一两个错字；
/// - 三字组 Jaccard 0.20：更严格，压住「词序相似但内容不同」的干扰项；
/// - 关键片段覆盖 0.18：6 字片段里原样命中的比例；
/// - 包含度 0.10：查询的双字组有多少落在题干里（非对称，长题面不吃亏）；
/// - 长度相似 0.07：长度差太多说明不是同一题（例如选项被 OCR 拼进题干）。
pub fn score(normalized: &str, stem_norm: &str) -> f64 {
    let q: Vec<char> = normalized.chars().filter(|c| !c.is_whitespace()).collect();
    let c: Vec<char> = stem_norm.chars().filter(|ch| !ch.is_whitespace()).collect();
    if q.is_empty() || c.is_empty() {
        return 0.0;
    }

    let q_bi = bigrams(&q);
    let c_bi = bigrams(&c);
    let q_tri = trigrams(&q);
    let c_tri = trigrams(&c);

    let bi = jaccard(&q_bi, &c_bi);
    let tri = jaccard(&q_tri, &c_tri);
    let coverage = chunk_coverage(normalized, stem_norm);
    let containment = if q_bi.is_empty() {
        0.0
    } else {
        q_bi.intersection(&c_bi).count() as f64 / q_bi.len() as f64
    };
    let length_sim = {
        let (a, b) = (q.len() as f64, c.len() as f64);
        1.0 - (a - b).abs() / a.max(b)
    };

    let total = 0.45 * bi + 0.20 * tri + 0.18 * coverage + 0.10 * containment + 0.07 * length_sim;
    total.clamp(0.0, 1.0)
}

/// 显示门控：分数够高，且与第二名拉开差距。
///
/// 已经在显示的结果（`sticky`）用更低的阈值维持——OCR 每 700ms 重识别一次，
/// 同一个题面会有一两分的抖动，用同一个门槛会让浮层闪来闪去。
pub fn passes_display_gate(hits: &[MatchHit], sticky: bool) -> bool {
    let Some(best) = hits.first() else { return false };
    let threshold = if sticky { STICKY_MIN } else { DISPLAY_MIN };
    if best.score < threshold {
        return false;
    }
    match hits.get(1) {
        Some(second) => best.score - second.score >= DISPLAY_GAP,
        None => true,
    }
}

struct CacheEntry {
    at: Instant,
    hits: Vec<MatchHit>,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(usize, u64, String), CacheEntry>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn cache_key(db: &Db, scope: Option<&[String]>, normalized: &str) -> (usize, u64, String) {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match scope {
        Some(ids) => {
            1u8.hash(&mut hasher);
            let mut sorted: Vec<&String> = ids.iter().collect();
            sorted.sort();
            for id in sorted {
                id.hash(&mut hasher);
            }
        }
        None => 0u8.hash(&mut hasher),
    }
    (db.instance_id(), hasher.finish(), normalized.to_string())
}

fn cache_get(key: &(usize, u64, String)) -> Option<Vec<MatchHit>> {
    let mut guard = CACHE.lock();
    let cache = guard.get_or_insert_with(Cache::default);
    let entry = cache.entries.get(key)?;
    if entry.at.elapsed() > CACHE_TTL {
        cache.entries.remove(key);
        return None;
    }
    Some(entry.hits.clone())
}

fn cache_put(key: (usize, u64, String), hits: Vec<MatchHit>) {
    let mut guard = CACHE.lock();
    let cache = guard.get_or_insert_with(Cache::default);
    if cache.entries.len() >= CACHE_CAPACITY && !cache.entries.contains_key(&key) {
        cache.entries.retain(|_, e| e.at.elapsed() <= CACHE_TTL);
        while cache.entries.len() >= CACHE_CAPACITY {
            let oldest = cache
                .entries
                .iter()
                .min_by_key(|(_, e)| e.at)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    cache.entries.remove(&k);
                }
                None => break,
            }
        }
    }
    cache.entries.insert(key, CacheEntry { at: Instant::now(), hits });
}

/// 题库发布/删除/重建索引后调用：缓存里可能还留着旧题干或已删除的题。
pub fn invalidate() {
    if let Some(cache) = CACHE.lock().as_mut() {
        cache.entries.clear();
    }
}

/// 在给定范围内匹配一段文本，返回按分数从高到低的前 [`MAX_HITS`] 条。
///
/// `scope`：`None` = 全部题库，`Some(ids)` = 只查这几份；空列表按
/// [`AppError::QuizScopeEmpty`] 拒绝——「限定零份题库」不该被当成「全部」。
pub fn match_text(db: &Db, text: &str, scope: Option<&[String]>) -> Result<Vec<MatchHit>> {
    if let Some(ids) = scope {
        if ids.is_empty() {
            return Err(AppError::QuizScopeEmpty);
        }
        if ids.len() > MAX_SCOPE_LIBRARIES {
            return Err(AppError::InvalidInput);
        }
    }

    let normalized = normalize_text(text);
    if normalized.chars().count() < 2 {
        return Ok(Vec::new());
    }

    let key = cache_key(db, scope, &normalized);
    if let Some(hits) = cache_get(&key) {
        return Ok(hits);
    }

    let mut candidates = fetch_candidates(db, &normalized, scope)?;
    for candidate in &mut candidates {
        candidate.hit.score = score(&normalized, &candidate.stem_norm);
    }
    candidates.sort_by(|a, b| {
        b.hit
            .score
            .partial_cmp(&a.hit.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.hit.seq.cmp(&b.hit.seq))
    });
    let hits: Vec<MatchHit> = candidates.into_iter().take(MAX_HITS).map(|c| c.hit).collect();

    cache_put(key, hits.clone());
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::{ParsedQuestion, QType};
    use crate::quiz::parse::answer::{build, AnswerInput};
    use crate::quiz::parse::Format;
    use crate::quiz::store::{self, NewImport};

    fn db() -> Db {
        Db::open_in_memory(&vec![21u8; 32]).unwrap()
    }

    fn question(stem: &str, answer: &str, options: &[(&str, &str)]) -> ParsedQuestion {
        build(AnswerInput {
            qtype_hint: Some(if options.is_empty() { QType::TrueFalse } else { QType::Single }),
            stem,
            options: options
                .iter()
                .map(|(k, t)| QuizOption { key: (*k).into(), text: (*t).into() })
                .collect(),
            answer_raw: answer,
            tags: vec![],
            source_ref: None,
        })
    }

    fn publish(db: &Db, name: &str, questions: &[ParsedQuestion]) -> String {
        let detail = store::create_job(
            db,
            "u-admin",
            NewImport { library_name: name, format: Format::Text, filename: "题库.txt", questions },
        )
        .unwrap();
        store::publish(db, &detail.job.id, None).unwrap().id
    }

    fn seed(db: &Db) -> String {
        publish(
            db,
            "安规题库",
            &[
                question(
                    "下列设备中属于一次设备的是",
                    "A",
                    &[("A", "变压器"), ("B", "电流互感器二次回路"), ("C", "继电保护装置")],
                ),
                question("隔离开关可以带负荷拉合", "错误", &[]),
            ],
        )
    }

    #[test]
    fn identical_stem_scores_near_one() {
        let d = db();
        seed(&d);
        let hits = match_text(&d, "下列设备中属于一次设备的是（ ）", None).unwrap();
        assert!(!hits.is_empty());
        assert!(hits[0].score >= 0.95, "score={}", hits[0].score);
        assert_eq!(hits[0].answer_display, "A");
        assert_eq!(hits[0].library_name, "安规题库");
        assert!(passes_display_gate(&hits, false));
    }

    #[test]
    fn one_wrong_ocr_char_still_passes_the_display_threshold() {
        let d = db();
        seed(&d);
        // OCR 把「次」认成了「交」——错一个字仍然要能显示。
        let hits = match_text(&d, "下列设备中属于一交设备的是", None).unwrap();
        assert!(!hits.is_empty(), "错一个字就查不到，等于助手不可用");
        assert!(hits[0].score >= DISPLAY_MIN, "score={}", hits[0].score);
        assert!(passes_display_gate(&hits, false));
    }

    #[test]
    fn a_different_question_stays_below_the_display_threshold() {
        let d = db();
        seed(&d);
        let hits = match_text(&d, "变压器可以带负荷拉合隔离开关的说法是否正确", None).unwrap();
        let best = hits.first().map(|h| h.score).unwrap_or(0.0);
        assert!(best < DISPLAY_MIN, "干扰句不该被当成命中，score={best}");
    }

    #[test]
    fn two_close_candidates_are_not_displayed() {
        let best = MatchHit {
            question_id: "a".into(),
            library_id: "l".into(),
            library_name: "库".into(),
            seq: 1,
            qtype: "single".into(),
            stem: "题干".into(),
            options: vec![],
            answer_display: "A".into(),
            tags: vec![],
            score: 0.80,
        };
        let mut second = best.clone();
        second.score = 0.75;
        assert!(!passes_display_gate(&[best.clone(), second], false), "差距不足 0.08 时不许猜");

        let mut clear = best.clone();
        clear.score = 0.60;
        assert!(passes_display_gate(&[best.clone(), clear], false));

        // 已经在显示的结果用维持阈值 0.52。
        let mut shaky = best.clone();
        shaky.score = 0.55;
        assert!(!passes_display_gate(&[shaky.clone()], false));
        assert!(passes_display_gate(&[shaky], true));
    }

    #[test]
    fn scope_limits_the_search_to_named_libraries() {
        let d = db();
        let first = seed(&d);
        let second = publish(&d, "第二份题库", &[question("下列设备中属于一次设备的是", "B", &[
            ("A", "断路器"), ("B", "变压器"),
        ])]);

        let all = match_text(&d, "下列设备中属于一次设备的是", None).unwrap();
        assert_eq!(all.len(), 2, "默认要在全部题库里检索");

        let only_second = match_text(&d, "下列设备中属于一次设备的是", Some(&[second.clone()])).unwrap();
        assert!(only_second.iter().all(|h| h.library_id == second));
        assert_eq!(only_second.len(), 1);

        let only_first = match_text(&d, "下列设备中属于一次设备的是", Some(&[first])).unwrap();
        assert_eq!(only_first.len(), 1);

        // 限定零份题库不是「全部」。
        assert!(matches!(
            match_text(&d, "下列设备中属于一次设备的是", Some(&[])),
            Err(AppError::QuizScopeEmpty)
        ));
    }

    #[test]
    fn short_queries_fall_back_to_like() {
        let d = db();
        seed(&d);
        // trigram 最短 3 字：2 字查询在 FTS 上必然空，只能靠 LIKE 兜底。
        let hits = match_text(&d, "一次", None).unwrap();
        assert!(!hits.is_empty(), "2 字查询要能落到 LIKE 兜底上");
    }

    #[test]
    fn fts_trigram_needs_three_characters() {
        let d = db();
        seed(&d);
        let conn = d.lock_conn();
        let three: i64 = conn
            .query_row(
                "SELECT count(*) FROM quiz_question_fts WHERE quiz_question_fts MATCH '\"一次设\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(three > 0, "3 字以上应命中 trigram 索引");
        let two: i64 = conn
            .query_row(
                "SELECT count(*) FROM quiz_question_fts WHERE quiz_question_fts MATCH '\"一次\"'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(two, 0, "2 字在 trigram 上永远为空——这就是需要 LIKE 兜底的原因");
    }

    #[test]
    fn cache_returns_the_same_hits_and_invalidate_drops_them() {
        let d = db();
        seed(&d);
        let first = match_text(&d, "下列设备中属于一次设备的是", None).unwrap();
        let second = match_text(&d, "下列设备中属于一次设备的是", None).unwrap();
        assert_eq!(first.len(), second.len());
        assert_eq!(first[0].question_id, second[0].question_id);

        // 发布新题库后必须立刻可见：缓存不能把新题挡在门外。
        publish(&d, "第三份", &[question("新发布的一道题", "正确", &[])]);
        invalidate();
        let after = match_text(&d, "新发布的一道题", None).unwrap();
        assert_eq!(after.len(), 1);
    }

    #[test]
    fn too_short_text_returns_nothing() {
        let d = db();
        seed(&d);
        assert!(match_text(&d, "一", None).unwrap().is_empty());
        assert!(match_text(&d, "   ", None).unwrap().is_empty());
    }

    /// 2 万题的检索耗时。默认不跑（构建 2 万行的夹具本身要几十秒）：
    /// `cargo test -p mon-dian-assistant --release perf_20k_questions -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_20k_questions() {
        let d = db();
        let questions: Vec<ParsedQuestion> = (0..20_000)
            .map(|i| {
                question(
                    &format!("第{i}号设备的额定电流与绝缘水平测试要求"),
                    "A",
                    &[("A", "变压器"), ("B", "断路器")],
                )
            })
            .collect();
        publish(&d, "压测题库", &questions);

        let started = Instant::now();
        let hits = match_text(&d, "第12345号设备的额定电流与绝缘水平测试要求", None).unwrap();
        let elapsed = started.elapsed();
        println!("20k 题首次匹配：{elapsed:?}，命中 {} 条", hits.len());
        assert!(!hits.is_empty());
        assert!(elapsed < Duration::from_millis(150), "20k 题匹配超过 150ms：{elapsed:?}");
    }
}
