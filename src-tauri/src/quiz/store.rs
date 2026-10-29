//! 题库与导入任务的存储层。
//!
//! 发布是**单事务**：只要有一行勾选的题缺题干或缺答案，整批回滚并报出行号——
//! 半份题库发布成功再报错，使用者根本不知道缺的是哪几道，检索时只会得到「查不到」。
//! 行号与原因码可以进错误 detail；题干与答案原文绝不进。

use chrono::Duration;
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use crate::db::repo::now;
use crate::db::Db;
use crate::error::{AppError, Result};
use crate::quiz::models::{
    ImportJobDetail, ImportJobDto, ImportRowDto, ImportRowPatch, ImportRowUpdated, Page, ParsedQuestion,
    QType, QuizAnswer, QuizLibraryDto, QuizOption, QuizQuestionDto,
};
use crate::quiz::parse::answer::{build, AnswerInput, CONFIDENCE_LOW};
use crate::quiz::parse::normalize::{normalize_options, normalize_text};
use crate::quiz::parse::Format;

pub const LIBRARY_NAME_MAX_CHARS: usize = 64;
/// 题库详情页与导入复核表一页的上限（界面自取 10 / 50）。
pub const MAX_PAGE: i64 = 200;

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > LIBRARY_NAME_MAX_CHARS {
        return Err(AppError::QuizLibraryNameInvalid);
    }
    Ok(name.to_string())
}

fn json_options(raw: &str) -> Vec<QuizOption> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn json_tags(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn json_answer(raw: &str) -> QuizAnswer {
    serde_json::from_str(raw).unwrap_or(QuizAnswer::Text { blanks: Vec::new() })
}

fn json_str<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn job_from_row(r: &Row) -> rusqlite::Result<ImportJobDto> {
    Ok(ImportJobDto {
        id: r.get(0)?,
        library_name: r.get(1)?,
        source_format: r.get(2)?,
        source_filename: r.get(3)?,
        status: r.get(4)?,
        total_rows: r.get(5)?,
        included_rows: r.get(6)?,
        issue_rows: r.get(7)?,
        error_code: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        published_library_id: r.get(11)?,
    })
}

const JOB_COLUMNS: &str = "id, library_name, source_format, source_filename, status, total_rows, \
                           included_rows, issue_rows, error_code, created_at, updated_at, published_library_id";

fn row_from_row(r: &Row) -> rusqlite::Result<ImportRowDto> {
    let answer_json: String = r.get(5)?;
    Ok(ImportRowDto {
        id: r.get(0)?,
        seq: r.get(1)?,
        qtype: r.get(2)?,
        stem: r.get(3)?,
        options: json_options(&r.get::<_, String>(4)?),
        answer_display: json_answer(&answer_json).display(),
        tags: json_tags(&r.get::<_, String>(6)?),
        confidence: r.get(7)?,
        issues: json_tags(&r.get::<_, String>(8)?),
        source_ref: r.get(9)?,
        include: r.get::<_, i64>(10)? == 1,
        edited: r.get::<_, i64>(11)? == 1,
    })
}

const ROW_COLUMNS: &str =
    "id, seq, qtype, stem, options_json, answer_json, tags_json, confidence, issues_json, \
     source_ref, include, edited";

fn clamp_page(offset: i64, limit: i64) -> (i64, i64) {
    (offset.max(0), limit.clamp(1, MAX_PAGE))
}

pub fn list_libraries(db: &Db) -> Result<Vec<QuizLibraryDto>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.source_format, l.source_filename, count(q.id), l.created_at, l.updated_at
           FROM quiz_libraries l LEFT JOIN quiz_questions q ON q.library_id = l.id
          GROUP BY l.id
          ORDER BY l.updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(QuizLibraryDto {
                id: r.get(0)?,
                name: r.get(1)?,
                source_format: r.get(2)?,
                source_filename: r.get(3)?,
                question_count: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn library_exists(db: &Db, id: &str) -> Result<bool> {
    let conn = db.lock_conn();
    Ok(conn
        .query_row("SELECT 1 FROM quiz_libraries WHERE id=?1", params![id], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some())
}

pub fn library_questions(db: &Db, library_id: &str, offset: i64, limit: i64) -> Result<Page<QuizQuestionDto>> {
    let (offset, limit) = clamp_page(offset, limit);
    let conn = db.lock_conn();
    let total: i64 = conn.query_row(
        "SELECT count(*) FROM quiz_questions WHERE library_id=?1",
        params![library_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, library_id, seq, qtype, stem, options_json, answer_display, tags_json, \
                confidence, issues_json, source_ref
           FROM quiz_questions WHERE library_id=?1 ORDER BY seq LIMIT ?2 OFFSET ?3",
    )?;
    let items = stmt
        .query_map(params![library_id, limit, offset], |r| {
            Ok(QuizQuestionDto {
                id: r.get(0)?,
                library_id: r.get(1)?,
                seq: r.get(2)?,
                qtype: r.get(3)?,
                stem: r.get(4)?,
                options: json_options(&r.get::<_, String>(5)?),
                answer_display: r.get(6)?,
                tags: json_tags(&r.get::<_, String>(7)?),
                confidence: r.get(8)?,
                issues: json_tags(&r.get::<_, String>(9)?),
                source_ref: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Page { items, total })
}

pub fn rename_library(db: &Db, id: &str, name: &str) -> Result<QuizLibraryDto> {
    let name = validate_name(name)?;
    let conn = db.lock_conn();
    let changed = conn.execute(
        "UPDATE quiz_libraries SET name=?2, updated_at=?3 WHERE id=?1",
        params![id, name, now()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.source_format, l.source_filename, count(q.id), l.created_at, l.updated_at
           FROM quiz_libraries l LEFT JOIN quiz_questions q ON q.library_id = l.id
          WHERE l.id=?1 GROUP BY l.id",
    )?;
    let dto = stmt.query_row(params![id], |r| {
        Ok(QuizLibraryDto {
            id: r.get(0)?,
            name: r.get(1)?,
            source_format: r.get(2)?,
            source_filename: r.get(3)?,
            question_count: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
        })
    })?;
    Ok(dto)
}

/// 先显式删题再删库：FTS 的 `AFTER DELETE` 触发器只认 `quiz_questions` 上的删除，
/// 靠外键级联时触发器同样会跑，但显式写出来能保证「题库页删掉后检索立刻不再命中」
/// 不依赖 PRAGMA foreign_keys 的开关状态。
pub fn delete_library(db: &Db, id: &str) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute("DELETE FROM quiz_questions WHERE library_id=?1", params![id])?;
    let removed = conn.execute("DELETE FROM quiz_libraries WHERE id=?1", params![id])?;
    if removed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// 重建整库索引：先清空 FTS 再按 `stem_norm/options_norm` 回填。
pub fn reindex(db: &Db) -> Result<i64> {
    let conn = db.lock_conn();
    conn.execute("INSERT INTO quiz_question_fts(quiz_question_fts) VALUES('rebuild')", [])?;
    Ok(conn.query_row("SELECT count(*) FROM quiz_questions", [], |r| r.get(0))?)
}

pub fn cleanup(db: &Db) -> Result<()> {
    let review_cut = (chrono::Utc::now() - Duration::hours(24)).to_rfc3339();
    let history_cut = (chrono::Utc::now() - Duration::days(7)).to_rfc3339();
    let conn = db.lock_conn();
    conn.execute(
        "DELETE FROM quiz_import_jobs WHERE status='review' AND updated_at < ?1",
        params![review_cut],
    )?;
    conn.execute(
        "DELETE FROM quiz_import_jobs WHERE status<>'review' AND updated_at < ?1",
        params![history_cut],
    )?;
    Ok(())
}

pub struct NewImport<'a> {
    pub library_name: &'a str,
    pub format: Format,
    pub filename: &'a str,
    pub questions: &'a [ParsedQuestion],
}

pub fn create_job(db: &Db, user: &str, new: NewImport<'_>) -> Result<ImportJobDetail> {
    let name = validate_name(new.library_name)?;
    cleanup(db)?;
    let job_id = new_id();
    let ts = now();
    let total = new.questions.len() as i64;
    let included = new.questions.iter().filter(|q| q.include).count() as i64;
    let issue_rows = new.questions.iter().filter(|q| !q.issues.is_empty()).count() as i64;

    {
        let mut conn = db.lock_conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO quiz_import_jobs
               (id, library_name, source_format, source_filename, status, total_rows, included_rows,
                issue_rows, error_code, created_by, created_at, updated_at, published_library_id)
             VALUES (?1,?2,?3,?4,'review',?5,?6,?7,NULL,?8,?9,?9,NULL)",
            params![job_id, name, new.format.as_str(), new.filename, total, included, issue_rows, user, ts],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO quiz_import_rows
                   (id, job_id, seq, qtype, stem, options_json, answer_json, tags_json, confidence,
                    issues_json, source_ref, include, edited)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0)",
            )?;
            for (idx, q) in new.questions.iter().enumerate() {
                stmt.execute(params![
                    new_id(),
                    &job_id,
                    (idx + 1) as i64,
                    q.qtype.as_str(),
                    &q.stem,
                    json_str(&q.options)?,
                    q.answer.json(),
                    json_str(&q.tags)?,
                    q.confidence,
                    json_str(&q.issues)?,
                    q.source_ref.as_deref(),
                    i64::from(q.include),
                ])?;
            }
        }
        tx.commit()?;
    }
    // 调用方（命令层）只要摘要；第一页交回是为了让直接读 `create_job` 的测试能核对落库内容。
    job_detail(db, &job_id, 0, MAX_PAGE, false)
}

pub fn job_exists(db: &Db, job_id: &str) -> Result<bool> {
    let conn = db.lock_conn();
    Ok(conn
        .query_row("SELECT 1 FROM quiz_import_jobs WHERE id=?1", params![job_id], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some())
}

fn read_job(conn: &rusqlite::Connection, job_id: &str) -> Result<ImportJobDto> {
    conn.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM quiz_import_jobs WHERE id=?1"),
        params![job_id],
        job_from_row,
    )
    .optional()?
    .ok_or(AppError::QuizJobNotFound)
}

/// 复核表的一页。`only_issues` 只认库里 `issues_json` 非空的行——「有问题」以解析层落库的
/// 问题码为准，不该由界面按一堆本地规则再猜一遍；`total` 也是**这一档筛选下**的行数，
/// 而不是任务总行数（那在 `job.total_rows` 里）。
pub fn job_detail(db: &Db, job_id: &str, offset: i64, limit: i64, only_issues: bool) -> Result<ImportJobDetail> {
    let (offset, limit) = clamp_page(offset, limit);
    let conn = db.lock_conn();
    let job = read_job(&conn, job_id)?;
    let filter = if only_issues { " AND issues_json <> '[]'" } else { "" };
    let total: i64 = conn.query_row(
        &format!("SELECT count(*) FROM quiz_import_rows WHERE job_id=?1{filter}"),
        params![job_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM quiz_import_rows WHERE job_id=?1{filter} ORDER BY seq LIMIT ?2 OFFSET ?3"
    ))?;
    let rows = stmt
        .query_map(params![job_id, limit, offset], row_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ImportJobDetail { job, rows, total })
}

struct StoredRow {
    id: String,
    seq: i64,
    qtype: String,
    stem: String,
    options: Vec<QuizOption>,
    answer: QuizAnswer,
    tags: Vec<String>,
    source_ref: Option<String>,
    include: bool,
}

fn load_row(tx: &Transaction, job_id: &str, row_id: &str) -> Result<StoredRow> {
    tx.query_row(
        "SELECT id, seq, qtype, stem, options_json, answer_json, tags_json, source_ref, include
           FROM quiz_import_rows WHERE id=?1 AND job_id=?2",
        params![row_id, job_id],
        |r| {
            let answer_json: String = r.get(5)?;
            Ok(StoredRow {
                id: r.get(0)?,
                seq: r.get(1)?,
                qtype: r.get(2)?,
                stem: r.get(3)?,
                options: json_options(&r.get::<_, String>(4)?),
                answer: json_answer(&answer_json),
                tags: json_tags(&r.get::<_, String>(6)?),
                source_ref: r.get(7)?,
                include: r.get::<_, i64>(8)? == 1,
            })
        },
    )
    .optional()?
    .ok_or(AppError::NotFound)
}

fn ensure_review(tx: &Transaction, job_id: &str) -> Result<()> {
    let status: Option<String> = tx
        .query_row("SELECT status FROM quiz_import_jobs WHERE id=?1", params![job_id], |r| r.get(0))
        .optional()?;
    match status.as_deref() {
        Some("review") => Ok(()),
        Some(_) => Err(AppError::QuizJobClosed),
        None => Err(AppError::QuizJobNotFound),
    }
}

fn refresh_job_counts(tx: &Transaction, job_id: &str) -> Result<()> {
    tx.execute(
        "UPDATE quiz_import_jobs SET
           included_rows = (SELECT count(*) FROM quiz_import_rows WHERE job_id=?1 AND include=1),
           issue_rows = (SELECT count(*) FROM quiz_import_rows WHERE job_id=?1 AND issues_json<>'[]'),
           updated_at = ?2
         WHERE id=?1",
        params![job_id, now()],
    )?;
    Ok(())
}

/// 把补丁写进一行。返回写回后的形状（与从库里读出来的完全一致）。
fn write_patch(tx: &Transaction, stored: StoredRow, patch: &ImportRowPatch) -> Result<ImportRowDto> {
    let qtype_hint = match patch.qtype.as_deref() {
        Some(raw) => Some(
            QType::parse(raw).ok_or_else(|| AppError::QuizRowInvalid(format!("第 {} 行：题型不合法", stored.seq)))?,
        ),
        None => QType::parse(&stored.qtype),
    };
    let stem = match patch.stem.as_deref() {
        Some(raw) => raw.trim().to_string(),
        None => stored.stem.clone(),
    };
    if stem.is_empty() {
        return Err(AppError::QuizRowInvalid(format!("第 {} 行：题干不能为空", stored.seq)));
    }
    let options = patch.options.clone().unwrap_or_else(|| stored.options.clone());
    let tags = patch.tags.clone().unwrap_or_else(|| stored.tags.clone());
    let answer_raw = patch.answer_text.clone().unwrap_or_else(|| stored.answer.display());
    let include = patch.include.unwrap_or(stored.include);

    let rebuilt = build(AnswerInput {
        qtype_hint,
        stem: &stem,
        options,
        answer_raw: &answer_raw,
        tags,
        source_ref: stored.source_ref.clone(),
    });

    tx.execute(
        "UPDATE quiz_import_rows SET qtype=?2, stem=?3, options_json=?4, answer_json=?5, tags_json=?6,
                confidence=?7, issues_json=?8, include=?9, edited=1
          WHERE id=?1",
        params![
            &stored.id,
            rebuilt.qtype.as_str(),
            &rebuilt.stem,
            json_str(&rebuilt.options)?,
            rebuilt.answer.json(),
            json_str(&rebuilt.tags)?,
            rebuilt.confidence,
            json_str(&rebuilt.issues)?,
            i64::from(include),
        ],
    )?;

    Ok(ImportRowDto {
        id: stored.id,
        seq: stored.seq,
        qtype: rebuilt.qtype.as_str().to_string(),
        stem: rebuilt.stem,
        options: rebuilt.options,
        answer_display: rebuilt.answer.display(),
        tags: rebuilt.tags,
        confidence: rebuilt.confidence,
        issues: rebuilt.issues,
        source_ref: rebuilt.source_ref,
        include,
        edited: true,
    })
}

pub fn update_row(db: &Db, job_id: &str, row_id: &str, patch: &ImportRowPatch) -> Result<ImportRowUpdated> {
    let mut conn = db.lock_conn();
    let tx = conn.transaction()?;
    ensure_review(&tx, job_id)?;
    let stored = load_row(&tx, job_id, row_id)?;
    let row = write_patch(&tx, stored, patch)?;
    refresh_job_counts(&tx, job_id)?;
    tx.commit()?;
    let job = read_job(&conn, job_id)?;
    Ok(ImportRowUpdated { row, job })
}

/// 复核表的批量操作。`ids` 为空表示「作用于全部行」，`remove` 例外——它必须点名。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkEdit {
    /// set_qtype | set_include | exclude_low_confidence | exclude_duplicates | remove
    pub op: String,
    pub qtype: Option<String>,
    pub include: Option<bool>,
    pub threshold: Option<f64>,
    pub ids: Option<Vec<String>>,
}

/// 返回刷新后的摘要，而不是某几页的行：批量操作会跨页改动，「哪一页该留哪些行」
/// 只有界面自己知道当前在哪一页、开着哪档筛选——它拿摘要去核对，再按原参数重取当前页。
pub fn bulk_update(db: &Db, job_id: &str, edit: &BulkEdit) -> Result<ImportJobDto> {
    let mut conn = db.lock_conn();
    let tx = conn.transaction()?;
    ensure_review(&tx, job_id)?;

    let ids = edit.ids.clone().unwrap_or_default();
    match edit.op.as_str() {
        "set_qtype" => {
            let raw = edit.qtype.as_deref().unwrap_or("");
            let _ = QType::parse(raw).ok_or(AppError::InvalidInput)?;
            let targets = target_ids(&tx, job_id, &ids)?;
            for row_id in targets {
                let stored = load_row(&tx, job_id, &row_id)?;
                let patch = ImportRowPatch { qtype: Some(raw.to_string()), ..Default::default() };
                write_patch(&tx, stored, &patch)?;
            }
        }
        "set_include" => {
            let include = i64::from(edit.include.ok_or(AppError::InvalidInput)?);
            if ids.is_empty() {
                tx.execute(
                    "UPDATE quiz_import_rows SET include=?2 WHERE job_id=?1",
                    params![job_id, include],
                )?;
            } else {
                for row_id in &ids {
                    tx.execute(
                        "UPDATE quiz_import_rows SET include=?3 WHERE job_id=?1 AND id=?2",
                        params![job_id, row_id, include],
                    )?;
                }
            }
        }
        "exclude_low_confidence" => {
            let threshold = edit.threshold.unwrap_or(CONFIDENCE_LOW).clamp(0.0, 1.0);
            tx.execute(
                "UPDATE quiz_import_rows SET include=0 WHERE job_id=?1 AND confidence < ?2",
                params![job_id, threshold],
            )?;
        }
        "exclude_duplicates" => {
            tx.execute(
                "UPDATE quiz_import_rows SET include=0 WHERE job_id=?1 AND issues_json LIKE '%duplicate_in_file%'",
                params![job_id],
            )?;
        }
        "remove" => {
            if ids.is_empty() {
                return Err(AppError::InvalidInput);
            }
            for row_id in &ids {
                tx.execute(
                    "DELETE FROM quiz_import_rows WHERE job_id=?1 AND id=?2",
                    params![job_id, row_id],
                )?;
            }
        }
        _ => return Err(AppError::InvalidInput),
    }

    refresh_job_counts(&tx, job_id)?;
    tx.commit()?;
    read_job(&conn, job_id)
}

fn target_ids(tx: &Transaction, job_id: &str, ids: &[String]) -> Result<Vec<String>> {
    if !ids.is_empty() {
        return Ok(ids.to_vec());
    }
    let mut stmt = tx.prepare("SELECT id FROM quiz_import_rows WHERE job_id=?1 ORDER BY seq")?;
    let rows = stmt
        .query_map(params![job_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn publish(db: &Db, job_id: &str, library_name: Option<&str>) -> Result<QuizLibraryDto> {
    let mut conn = db.lock_conn();
    let tx = conn.transaction()?;

    let (job_name, format, filename, status): (String, String, String, String) = tx
        .query_row(
            "SELECT library_name, source_format, source_filename, status FROM quiz_import_jobs WHERE id=?1",
            params![job_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
        .ok_or(AppError::QuizJobNotFound)?;
    if status != "review" {
        return Err(AppError::QuizJobClosed);
    }
    let name = validate_name(library_name.unwrap_or(&job_name))?;

    let mut stmt = tx.prepare(&format!(
        "SELECT {ROW_COLUMNS} FROM quiz_import_rows WHERE job_id=?1 AND include=1 ORDER BY seq"
    ))?;
    let rows = stmt
        .query_map(params![job_id], row_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    if rows.is_empty() {
        return Err(AppError::QuizRowInvalid("没有勾选任何题目，无法发布".into()));
    }

    // 缺答案的题发布出去只会在检索里制造「命中但没答案」，与「绝不猜答案」的红线冲突，
    // 所以这里按行拦下并给出第一个问题行，让人回到复核表补。
    let mut answers: Vec<QuizAnswer> = Vec::with_capacity(rows.len());
    for row in &rows {
        let answer = json_answer(&row_answer_json(&tx, job_id, &row.id)?);
        let problem = if row.stem.trim().is_empty() {
            Some("题干为空")
        } else if row.issues.iter().any(|i| i == "missing_answer") {
            Some("缺少答案")
        } else {
            match &answer {
                QuizAnswer::Choice { keys } if keys.is_empty() => Some("缺少答案"),
                QuizAnswer::Text { blanks } if blanks.is_empty() => Some("缺少答案"),
                _ => None,
            }
        };
        if let Some(reason) = problem {
            return Err(AppError::QuizRowInvalid(format!("第 {} 行：{reason}", row.seq)));
        }
        answers.push(answer);
    }

    let lib_id = new_id();
    let ts = now();
    tx.execute(
        "INSERT INTO quiz_libraries (id, name, source_format, source_filename, created_by, created_at, updated_at)
         VALUES (?1,?2,?3,?4,(SELECT created_by FROM quiz_import_jobs WHERE id=?5),?6,?6)",
        params![lib_id, name, format, filename, job_id, ts],
    )?;

    {
        let mut ins = tx.prepare(
            "INSERT INTO quiz_questions
               (id, library_id, seq, qtype, stem, stem_norm, options_json, options_norm, answer_json,
                answer_display, answer_norm, tags_json, confidence, issues_json, source_ref, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        )?;
        for (idx, (row, answer)) in rows.iter().zip(answers.iter()).enumerate() {
            ins.execute(params![
                new_id(),
                lib_id,
                (idx + 1) as i64,
                &row.qtype,
                &row.stem,
                normalize_text(&row.stem),
                json_str(&row.options)?,
                normalize_options(&row.options),
                answer.json(),
                answer.display(),
                answer.norm(),
                json_str(&row.tags)?,
                row.confidence,
                json_str(&row.issues)?,
                &row.source_ref,
                &ts,
            ])?;
        }
    }

    tx.execute(
        "UPDATE quiz_import_jobs SET status='published', published_library_id=?2, library_name=?3,
                included_rows=?4, updated_at=?5 WHERE id=?1",
        params![job_id, lib_id, name, rows.len() as i64, now()],
    )?;
    tx.commit()?;

    Ok(QuizLibraryDto {
        id: lib_id,
        name,
        source_format: format,
        source_filename: filename,
        question_count: rows.len() as i64,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

pub fn discard(db: &Db, job_id: &str) -> Result<()> {
    let conn = db.lock_conn();
    let changed = conn.execute(
        "UPDATE quiz_import_jobs SET status='discarded', updated_at=?2 WHERE id=?1 AND status='review'",
        params![job_id, now()],
    )?;
    if changed == 0 {
        let exists = conn
            .query_row("SELECT 1 FROM quiz_import_jobs WHERE id=?1", params![job_id], |r| r.get::<_, i64>(0))
            .optional()?
            .is_some();
        return Err(if exists { AppError::QuizJobClosed } else { AppError::QuizJobNotFound });
    }
    Ok(())
}

fn row_answer_json(tx: &Transaction, job_id: &str, row_id: &str) -> Result<String> {
    Ok(tx.query_row(
        "SELECT answer_json FROM quiz_import_rows WHERE id=?1 AND job_id=?2",
        params![row_id, job_id],
        |r| r.get(0),
    )?)
}



// ---- 答题助手偏好 ----

pub const ASSISTANT_MIN_DWELL_MS: i64 = 200;
pub const ASSISTANT_MAX_DWELL_MS: i64 = 2000;
pub const ASSISTANT_DEFAULT_DWELL_MS: i64 = 520;
pub const ASSISTANT_HOTKEY_MAX_CHARS: usize = 64;

/// 平台默认快捷键：与启动器同一套加速键校验器，macOS 用 Cmd、其余用 Ctrl。
pub fn assistant_default_hotkey() -> &'static str {
    if cfg!(target_os = "macos") {
        "Cmd+Alt+Q"
    } else {
        "Ctrl+Alt+Q"
    }
}

/// 一名使用者的答题助手设置。`enabled` 只由起停命令改，`set_preferences` 不碰它。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPreferences {
    pub enabled: bool,
    pub scope_mode: String,
    pub dwell_ms: i64,
    pub hotkey: String,
    pub show_options: bool,
    /// `scope_mode='selected'` 时的白名单；空集合在调匹配前就会被拒绝。
    pub library_ids: Vec<String>,
}

impl Default for AssistantPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            scope_mode: "all".to_string(),
            dwell_ms: ASSISTANT_DEFAULT_DWELL_MS,
            hotkey: assistant_default_hotkey().to_string(),
            show_options: true,
            library_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPreferencesInput {
    pub scope_mode: String,
    pub dwell_ms: i64,
    pub hotkey: String,
    pub show_options: bool,
    #[serde(default)]
    pub library_ids: Vec<String>,
}

/// 没有记录时返回默认值（全部题库、未启用），调用方无需先判断行是否存在。
pub fn assistant_preferences(db: &Db, user: &str) -> Result<AssistantPreferences> {
    let conn = db.lock_conn();
    let row = conn
        .query_row(
            "SELECT enabled, scope_mode, dwell_ms, hotkey, show_options
               FROM quiz_assistant_preferences WHERE app_user_id=?1",
            params![user],
            |r| {
                Ok(AssistantPreferences {
                    enabled: r.get::<_, i64>(0)? == 1,
                    scope_mode: r.get(1)?,
                    dwell_ms: r.get(2)?,
                    hotkey: r.get(3)?,
                    show_options: r.get::<_, i64>(4)? == 1,
                    library_ids: Vec::new(),
                })
            },
        )
        .optional()?;
    let mut prefs = row.unwrap_or_default();
    let mut stmt = conn.prepare(
        "SELECT library_id FROM quiz_assistant_scope WHERE app_user_id=?1 ORDER BY library_id",
    )?;
    prefs.library_ids = stmt
        .query_map(params![user], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(prefs)
}

/// 校验后整份覆盖：指定题库是**替换**而不是增量，勾掉一份就真的不再检索。
pub fn save_assistant_preferences(
    db: &Db,
    user: &str,
    input: &AssistantPreferencesInput,
) -> Result<AssistantPreferences> {
    if input.scope_mode != "all" && input.scope_mode != "selected" {
        return Err(AppError::InvalidInput);
    }
    if !(ASSISTANT_MIN_DWELL_MS..=ASSISTANT_MAX_DWELL_MS).contains(&input.dwell_ms) {
        return Err(AppError::InvalidInput);
    }
    let hotkey = crate::quick_launcher::shortcut::validate_accelerator(&input.hotkey)?;
    if hotkey.chars().count() > ASSISTANT_HOTKEY_MAX_CHARS {
        return Err(AppError::InvalidInput);
    }
    let mut library_ids: Vec<String> = Vec::new();
    for id in &input.library_ids {
        if !library_ids.iter().any(|x| x == id) {
            library_ids.push(id.clone());
        }
    }
    // 「全部题库」时白名单没有意义；留着会让用户下次切回「指定」时看到早已不用的勾选。
    if input.scope_mode == "all" {
        library_ids.clear();
    }
    if library_ids.len() > crate::quiz::matcher::MAX_SCOPE_LIBRARIES {
        return Err(AppError::InvalidInput);
    }
    if input.scope_mode == "selected" {
        if library_ids.is_empty() {
            return Err(AppError::QuizScopeEmpty);
        }
        for id in &library_ids {
            if !library_exists(db, id)? {
                return Err(AppError::NotFound);
            }
        }
    }

    let ts = now();
    {
        let mut conn = db.lock_conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO quiz_assistant_preferences
               (app_user_id, enabled, scope_mode, dwell_ms, hotkey, show_options, updated_at)
             VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(app_user_id) DO UPDATE SET
               scope_mode=excluded.scope_mode, dwell_ms=excluded.dwell_ms,
               hotkey=excluded.hotkey, show_options=excluded.show_options,
               updated_at=excluded.updated_at",
            params![user, input.scope_mode, input.dwell_ms, hotkey, input.show_options as i64, ts],
        )?;
        tx.execute("DELETE FROM quiz_assistant_scope WHERE app_user_id=?1", params![user])?;
        for id in &library_ids {
            tx.execute(
                "INSERT OR IGNORE INTO quiz_assistant_scope (app_user_id, library_id) VALUES (?1, ?2)",
                params![user, id],
            )?;
        }
        tx.commit()?;
    }
    assistant_preferences(db, user)
}

/// 起停开关：只改 `enabled`，其余设置保持不动（首次起停时按默认值落一行）。
pub fn set_assistant_enabled(db: &Db, user: &str, enabled: bool) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO quiz_assistant_preferences
           (app_user_id, enabled, scope_mode, dwell_ms, hotkey, show_options, updated_at)
         VALUES (?1, ?2, 'all', ?3, ?4, 1, ?5)
         ON CONFLICT(app_user_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at",
        params![user, enabled as i64, ASSISTANT_DEFAULT_DWELL_MS, assistant_default_hotkey(), now()],
    )?;
    Ok(())
}

/// 悬停线程要的检索范围：`all` → None；`selected` → Some(ids)（空集合按 `QUIZ_SCOPE_EMPTY` 拒绝）。
pub fn assistant_scope(db: &Db, user: &str) -> Result<Option<Vec<String>>> {
    let prefs = assistant_preferences(db, user)?;
    if prefs.scope_mode == "all" {
        return Ok(None);
    }
    if prefs.library_ids.is_empty() {
        return Err(AppError::QuizScopeEmpty);
    }
    Ok(Some(prefs.library_ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::models::QType;

    fn db() -> Db {
        Db::open_in_memory(&vec![21u8; 32]).unwrap()
    }

    fn sample() -> Vec<ParsedQuestion> {
        vec![
            build(AnswerInput {
                qtype_hint: Some(QType::Single),
                stem: "下列设备中属于一次设备的是",
                options: vec![
                    QuizOption { key: "A".into(), text: "变压器".into() },
                    QuizOption { key: "B".into(), text: "电流表".into() },
                ],
                answer_raw: "A",
                tags: vec!["一次设备".into()],
                source_ref: Some("line:1".into()),
            }),
            build(AnswerInput {
                qtype_hint: Some(QType::TrueFalse),
                stem: "变压器可以带负荷拉合隔离开关",
                options: vec![],
                answer_raw: "错误",
                tags: vec![],
                source_ref: Some("line:5".into()),
            }),
        ]
    }

    fn new_import(qs: &[ParsedQuestion]) -> NewImport<'_> {
        NewImport { library_name: "安规题库", format: Format::Text, filename: "安规.txt", questions: qs }
    }

    /// 偏好表对 `app_users` 有外键，设置类测试得先有真人。
    fn user(d: &Db, id: &str) {
        d.lock_conn()
            .execute(
                "INSERT INTO app_users
                 (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,
                  pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
                 VALUES (?1,?1,'测试者','argon2id','salt','hash',4096,2,1,?2,?2)",
                params![id, now()],
            )
            .unwrap();
    }

    #[test]
    fn job_round_trip_and_publish_creates_library() {
        let d = db();
        let qs = sample();
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        assert_eq!(detail.job.status, "review");
        assert_eq!(detail.rows.len(), 2);
        assert_eq!(detail.rows[0].answer_display, "A");

        let lib = publish(&d, &detail.job.id, None).unwrap();
        assert_eq!(lib.name, "安规题库");
        assert_eq!(lib.question_count, 2);
        let libs = list_libraries(&d).unwrap();
        assert_eq!(libs.len(), 1);
        let page = library_questions(&d, &lib.id, 0, 50).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items[1].qtype, "true_false");
        assert_eq!(page.items[1].answer_display, "错误");

        let again = publish(&d, &detail.job.id, None).unwrap_err();
        assert_eq!(again.code(), "QUIZ_JOB_CLOSED");
    }

    #[test]
    fn publish_rolls_back_whole_batch_when_a_row_has_no_answer() {
        let d = db();
        let mut qs = sample();
        qs[1] = build(AnswerInput {
            qtype_hint: Some(QType::TrueFalse),
            stem: "电流互感器二次侧不允许开路",
            options: vec![],
            answer_raw: "",
            tags: vec![],
            source_ref: None,
        });
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        let err = publish(&d, &detail.job.id, None).unwrap_err();
        assert_eq!(err.code(), "QUIZ_ROW_INVALID");
        assert!(err.safe_detail().contains("第 2 行"), "{}", err.safe_detail());
        assert!(list_libraries(&d).unwrap().is_empty(), "失败必须整批回滚");
        // 任务仍是 review，补完后可以再发布
        assert_eq!(job_detail(&d, &detail.job.id, 0, MAX_PAGE, false).unwrap().job.status, "review");
    }

    #[test]
    fn editing_a_row_rebuilds_its_answer_and_marks_it_edited() {
        let d = db();
        let qs = sample();
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        let row = &detail.rows[0];
        let patch = ImportRowPatch { answer_text: Some("B".into()), include: Some(true), ..Default::default() };
        let updated = update_row(&d, &detail.job.id, &row.id, &patch).unwrap();
        assert_eq!(updated.row.answer_display, "B");
        assert!(updated.row.edited);
        assert!(updated.row.issues.iter().all(|i| i != "answer_not_in_options"));
        // 摘要随行一起交回，界面才不用为了刷新计数重取当前页
        assert_eq!(updated.job.id, detail.job.id);
    }

    /// 复核表按页取：`total` 是当前筛选下的行数，offset/limit 只在这一档里切。
    #[test]
    fn job_detail_pages_and_filters_issue_rows() {
        let d = db();
        let mut qs = sample();
        qs[1] = build(AnswerInput {
            qtype_hint: Some(QType::TrueFalse),
            stem: "电流互感器二次侧不允许开路",
            options: vec![],
            answer_raw: "",
            tags: vec![],
            source_ref: None,
        });
        qs.push(build(AnswerInput {
            qtype_hint: Some(QType::Single),
            stem: "隔离开关的作用是",
            options: vec![
                QuizOption { key: "A".into(), text: "隔离电源".into() },
                QuizOption { key: "B".into(), text: "切断短路电流".into() },
            ],
            answer_raw: "A",
            tags: vec![],
            source_ref: None,
        }));
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        assert_eq!(detail.job.issue_rows, 1);

        let first = job_detail(&d, &detail.job.id, 0, 2, false).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);

        let second = job_detail(&d, &detail.job.id, 2, 2, false).unwrap();
        assert_eq!(second.total, 3);
        assert_eq!(second.rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3]);

        let issues = job_detail(&d, &detail.job.id, 0, 50, true).unwrap();
        assert_eq!(issues.total, 1);
        assert_eq!(issues.rows.len(), 1);
        assert_eq!(issues.rows[0].seq, 2);
        assert!(!issues.rows[0].issues.is_empty());
    }

    #[test]
    fn bulk_operations_toggle_inclusion_without_touching_published_rows() {        let d = db();
        let mut qs = sample();
        qs[1].confidence = 0.3;
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        let edit = BulkEdit { op: "exclude_low_confidence".into(), threshold: Some(0.5), ..Default::default() };
        let after = bulk_update(&d, &detail.job.id, &edit).unwrap();
        assert_eq!(after.included_rows, 1);
        assert!(!job_detail(&d, &detail.job.id, 0, MAX_PAGE, false).unwrap().rows[1].include);

        let all_off = BulkEdit { op: "set_include".into(), include: Some(false), ..Default::default() };
        let after = bulk_update(&d, &detail.job.id, &all_off).unwrap();
        assert_eq!(after.included_rows, 0);
        assert!(
            job_detail(&d, &detail.job.id, 0, MAX_PAGE, false)
                .unwrap()
                .rows
                .iter()
                .all(|r| !r.include)
        );
        assert_eq!(
            publish(&d, &detail.job.id, None).unwrap_err().code(),
            "QUIZ_ROW_INVALID"
        );

        discard(&d, &detail.job.id).unwrap();
        assert_eq!(job_detail(&d, &detail.job.id, 0, MAX_PAGE, false).unwrap().job.status, "discarded");
        assert_eq!(
            bulk_update(&d, &detail.job.id, &all_off).unwrap_err().code(),
            "QUIZ_JOB_CLOSED"
        );
    }

    #[test]
    fn library_names_are_trimmed_and_limited() {
        let d = db();
        let qs = sample();
        let detail = create_job(&d, "u-admin", NewImport { library_name: "  安规  ", ..new_import(&qs) }).unwrap();
        assert_eq!(detail.job.library_name, "安规");
        let long = "题".repeat(LIBRARY_NAME_MAX_CHARS + 1);
        assert_eq!(
            create_job(&d, "u-admin", NewImport { library_name: &long, ..new_import(&qs) }).unwrap_err().code(),
            "QUIZ_LIBRARY_NAME_INVALID"
        );
    }

    #[test]
    fn deleting_a_library_removes_its_questions_from_search() {
        let d = db();
        let qs = sample();
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        let lib = publish(&d, &detail.job.id, None).unwrap();
        delete_library(&d, &lib.id).unwrap();
        assert!(list_libraries(&d).unwrap().is_empty());
        let conn = d.lock_conn();
        let fts: i64 = conn.query_row("SELECT count(*) FROM quiz_question_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0, "触发器必须把 FTS 行一并删掉");
    }
    /// 助手设置是整份覆盖：勾掉的题库必须真的从白名单里消失，而不是只加不减。
    #[test]
    fn assistant_preferences_are_replaced_not_merged() {
        let d = db();
        user(&d, "u1");
        let qs = sample();
        let detail = create_job(&d, "u-admin", new_import(&qs)).unwrap();
        let lib = publish(&d, &detail.job.id, None).unwrap();
        let input = AssistantPreferencesInput {
            scope_mode: "selected".to_string(),
            dwell_ms: 600,
            hotkey: "Ctrl+Alt+Q".to_string(),
            show_options: false,
            library_ids: vec![lib.id.clone()],
        };
        let saved = save_assistant_preferences(&d, "u1", &input).unwrap();
        assert_eq!(saved.scope_mode, "selected");
        assert_eq!(saved.library_ids, vec![lib.id.clone()]);
        assert!(!saved.enabled, "设置不该顺手把助手打开");

        let cleared = save_assistant_preferences(
            &d,
            "u1",
            &AssistantPreferencesInput { scope_mode: "all".to_string(), ..input.clone() },
        )
        .unwrap();
        assert!(cleared.library_ids.is_empty(), "切回全部题库时白名单必须清空");
        assert_eq!(cleared.dwell_ms, 600);
    }

    /// 指定题库但一份都没勾：必须报 QUIZ_SCOPE_EMPTY，不能退化成「全部」。
    #[test]
    fn empty_selected_scope_is_rejected() {
        let d = db();
        user(&d, "u1");
        let input = AssistantPreferencesInput {
            scope_mode: "selected".to_string(),
            dwell_ms: 520,
            hotkey: "Ctrl+Alt+Q".to_string(),
            show_options: true,
            library_ids: vec![],
        };
        assert!(matches!(save_assistant_preferences(&d, "u1", &input), Err(AppError::QuizScopeEmpty)));
    }

    /// 停留时长与快捷键都由后端判定，界面传越界值不能落库。
    #[test]
    fn invalid_dwell_and_hotkey_are_rejected() {
        let d = db();
        user(&d, "u1");
        let base = AssistantPreferencesInput {
            scope_mode: "all".to_string(),
            dwell_ms: 520,
            hotkey: "Ctrl+Alt+Q".to_string(),
            show_options: true,
            library_ids: vec![],
        };
        assert!(matches!(
            save_assistant_preferences(&d, "u1", &AssistantPreferencesInput { dwell_ms: 50, ..base.clone() }),
            Err(AppError::InvalidInput)
        ));
        assert!(matches!(
            save_assistant_preferences(&d, "u1", &AssistantPreferencesInput { hotkey: "Q".to_string(), ..base.clone() }),
            Err(AppError::QuerySyntax(_))
        ));
    }

    /// 起停只碰 enabled：先把设置改成非默认值，再开关一次，其余字段不得被重写成默认。
    #[test]
    fn enabling_keeps_other_preferences() {
        let d = db();
        user(&d, "u1");
        let input = AssistantPreferencesInput {
            scope_mode: "all".to_string(),
            dwell_ms: 900,
            hotkey: "Ctrl+Shift+U".to_string(),
            show_options: false,
            library_ids: vec![],
        };
        save_assistant_preferences(&d, "u1", &input).unwrap();
        set_assistant_enabled(&d, "u1", true).unwrap();
        let prefs = assistant_preferences(&d, "u1").unwrap();
        assert!(prefs.enabled);
        assert_eq!(prefs.dwell_ms, 900);
        assert_eq!(prefs.hotkey, "Ctrl+Shift+U");
        assert!(!prefs.show_options);
    }

}
