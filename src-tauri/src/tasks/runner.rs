//! 通用运行引擎：建运行、准备、发布、取消、重试上限、事件与日志落库。
//!
//! 引擎不认识任何站点。适配器只实现 [`TaskAdapter`] 的两个方法，拿到 [`RunContext`]
//! 之后可以写日志、可以问「是否已要求停止」，但拿不到数据库，也不该知道事件总线。
//!
//! 两条并发约束：
//! - 每个阶段用 `std::thread::scope` 起固定数量的工作线程，`limit` 由任务定义给出，
//!   硬上限 [`MAX_CONCURRENCY`]；每个条目只被一个线程处理。
//! - 取消是 `AtomicBool`（每个运行一枚），锁库时由 `cancel_all` 一次性置位。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension};
use tauri::Emitter;

use crate::db::repo;
use crate::error::{AppError, Result};
use crate::state::AppCore;

use super::{redact, task_def, Env};

/// 单个阶段的工作线程硬上限。任务定义里的并发数再大也压到这一档。
pub const MAX_CONCURRENCY: usize = 10;
/// 一个条目最多被尝试几次（准备与发布各计一次）。达到上限后只能重跑一份新的清单。
pub const MAX_ATTEMPTS: i64 = 3;

pub const RUN_PREPARING: &str = "preparing";
pub const RUN_READY: &str = "ready";
pub const RUN_RUNNING: &str = "running";
pub const RUN_CANCELLING: &str = "cancelling";
pub const RUN_SUCCEEDED: &str = "succeeded";
pub const RUN_PARTIAL: &str = "partial";
pub const RUN_FAILED: &str = "failed";
pub const RUN_CANCELLED: &str = "cancelled";

pub const ITEM_PENDING: &str = "pending";
pub const ITEM_RESOLVING: &str = "resolving";
pub const ITEM_READY: &str = "ready";
pub const ITEM_PUBLISHING: &str = "publishing";
pub const ITEM_WAITING: &str = "waiting";
pub const ITEM_SUCCEEDED: &str = "succeeded";
pub const ITEM_FAILED: &str = "failed";
pub const ITEM_SKIPPED: &str = "skipped";

pub const LOG_INFO: &str = "info";
pub const LOG_WARN: &str = "warn";
pub const LOG_ERROR: &str = "error";

/// 建运行时由调用方给出的条目：只有"要发什么"，线上状态由准备阶段填。
#[derive(Clone, Debug)]
pub struct NewRunItem {
    pub item_key: String,
    pub display_name: Option<String>,
    pub desired_tag: Option<String>,
}

/// 从库里读出的条目快照。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunItem {
    pub id: String,
    pub ordinal: i64,
    pub item_key: String,
    pub display_name: Option<String>,
    pub desired_tag: Option<String>,
    pub image_ref: Option<String>,
    pub app_id: Option<String>,
    pub service_update_at: Option<String>,
    pub tag_update_at: Option<String>,
    pub status: String,
    pub attempts: i64,
    pub message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub task_key: String,
    pub env: String,
    pub status: String,
    /// 输入摘要按约定不含凭据，但仍然不往外发：界面要看的已经是解好的条目行。
    #[serde(skip_serializing)]
    pub params_json: String,
    pub cancel_requested: bool,
    pub created_by: String,
}

impl RunRow {
    pub fn env_value(&self) -> Option<Env> {
        Env::parse(&self.env)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Prepared {
    pub display_name: Option<String>,
    pub image_ref: Option<String>,
    pub app_id: Option<String>,
    pub service_update_at: Option<String>,
    pub tag_update_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PublishOutcome {
    pub ok: bool,
    pub message: String,
    pub service_update_at: Option<String>,
}

/// 站点适配器。实现方不得接触数据库与事件总线：需要的东西都在 `RunItem` / `RunContext` 里。
pub trait TaskAdapter: Send + Sync {
    fn prepare(&self, ctx: &RunContext, item: &RunItem) -> Result<Prepared>;
    fn publish(&self, ctx: &RunContext, item: &RunItem) -> Result<PublishOutcome>;
}

/// 传给适配器的一次运行上下文：只读的运行标识 + 停止信号 + 写日志的入口。
#[derive(Clone)]
pub struct RunContext {
    core: Arc<AppCore>,
    run_id: String,
    cancel: Arc<AtomicBool>,
}

impl RunContext {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// 用户取消或保险库锁定（`cancel_all`）都会置位。
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// 适配器在每一步前调它：已取消时回 `AppError::Cancelled`，绝不继续拼 URL / 发请求。
    pub fn ensure_active(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(AppError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// 可取消的等待。返回 false 表示期间被要求停止。
    pub fn sleep(&self, total: Duration) -> bool {
        const STEP: Duration = Duration::from_millis(200);
        let mut left = total;
        while left > Duration::ZERO {
            if self.is_cancelled() {
                return false;
            }
            let step = left.min(STEP);
            std::thread::sleep(step);
            left -= step;
        }
        !self.is_cancelled()
    }

    /// 写一条运行日志（落库前统一脱敏）。
    pub fn log(&self, level: &str, item_key: Option<&str>, message: &str) {
        append_log(&self.core, &self.run_id, level, item_key, message);
    }

    /// 报告"改完镜像、正在等生效"这一中间态。    ///
    /// 这是适配器唯一能写的状态：终态（成功/失败/跳过）一律由引擎落，
    /// 否则站点代码就能伪造一份发布历史。
    pub fn mark_waiting(&self, item: &RunItem) {        let attempts = item.attempts + 1;
        {
            let conn = self.core.db.lock_conn();
            let _ = conn.execute(
                "UPDATE task_run_items SET status=?1, updated_at=?2 WHERE id=?3 AND status=?4",
                params![ITEM_WAITING, repo::now(), item.id, ITEM_PUBLISHING],
            );
        }
        emit_item(&self.core, &self.run_id, &item.item_key, ITEM_WAITING, attempts, None);
    }

    /// 测试用：把这一次的停止信号交出去，让用例能在轮询中途按下取消。
    #[cfg(test)]
    pub fn cancel_handle_for_test(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

static CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取（或建）这个运行的停止信号。已存在的信号原样复用：若取消先于线程启动，
/// 置位状态必须能被后启动的线程看到。
fn token_for(run_id: &str) -> Arc<AtomicBool> {
    registry()
        .lock()
        .entry(run_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

/// 线程结束时摘掉自己的信号；只摘自己那一枚（重试可能已经换了新令牌）。
struct TokenGuard {
    run_id: String,
    token: Arc<AtomicBool>,
}

impl TokenGuard {
    fn acquire(run_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            token: token_for(run_id),
        }
    }
}

impl Drop for TokenGuard {
    fn drop(&mut self) {
        let mut reg = registry().lock();
        if let Some(current) = reg.get(&self.run_id) {
            if Arc::ptr_eq(current, &self.token) {
                reg.remove(&self.run_id);
            }
        }
    }
}

fn emit(core: &AppCore, event: &str, payload: serde_json::Value) {
    if let Some(app) = core.app_handle() {
        let _ = app.emit(event, payload);
    }
}

fn emit_run(core: &AppCore, run_id: &str) {
    let row: Option<(String, i64, i64, i64, i64)> = {
        let conn = core.db.lock_conn();
        conn.query_row(
            "SELECT r.status,
                    (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id),
                    (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='succeeded'),
                    (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='failed'),
                    (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='ready')
               FROM task_runs r WHERE r.id=?1",
            params![run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()
        .flatten()
    };
    let Some((status, total, succeeded, failed, ready)) = row else {
        return;
    };
    emit(
        core,
        "task://run",
        serde_json::json!({
            "runId": run_id,
            "status": status,
            "total": total,
            "ready": ready,
            "succeeded": succeeded,
            "failed": failed,
            "at": chrono::Utc::now().timestamp_millis(),
        }),
    );
}

fn emit_item(core: &AppCore, run_id: &str, item_key: &str, status: &str, attempts: i64, message: Option<&str>) {
    emit(
        core,
        "task://item",
        serde_json::json!({
            "runId": run_id,
            "itemKey": item_key,
            "status": status,
            "attempts": attempts,
            "message": message,
            "at": chrono::Utc::now().timestamp_millis(),
        }),
    );
}

/// 建一条运行与它的条目。`params_json` 只放输入摘要（服务清单/文件来源），调用方保证不含凭据。
pub fn create_run(
    core: &AppCore,
    task_key: &str,
    env: Env,
    params_json: &str,
    items: &[NewRunItem],
    actor: &str,
) -> Result<String> {
    let def = task_def(task_key).ok_or(AppError::InvalidInput)?;
    if !def.envs.contains(&env) || items.is_empty() {
        return Err(AppError::InvalidInput);
    }
    let mut seen = std::collections::HashSet::with_capacity(items.len());
    for item in items {
        let key = item.item_key.trim();
        if key.is_empty() || !seen.insert(key.to_string()) {
            return Err(AppError::InvalidInput);
        }
    }

    let run_id = uuid::Uuid::now_v7().to_string();
    let ts = repo::now();
    {
        let conn = core.db.lock_conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO task_runs (id,task_key,env,status,params_json,created_by,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![run_id, task_key, env.as_str(), RUN_PREPARING, params_json, actor, ts],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO task_run_items (id,run_id,ordinal,item_key,display_name,desired_tag,status,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for (ordinal, item) in items.iter().enumerate() {
                stmt.execute(params![
                    uuid::Uuid::now_v7().to_string(),
                    run_id,
                    ordinal as i64,
                    item.item_key.trim(),
                    item.display_name.as_deref(),
                    item.desired_tag.as_deref(),
                    ITEM_PENDING,
                    ts
                ])?;
            }
        }
        tx.commit()?;
    }
    emit_run(core, &run_id);
    Ok(run_id)
}

pub fn load_run(core: &AppCore, run_id: &str) -> Result<RunRow> {
    let conn = core.db.lock_conn();
    conn.query_row(
        "SELECT id,task_key,env,status,params_json,cancel_requested,created_by FROM task_runs WHERE id=?1",
        params![run_id],
        |r| {
            Ok(RunRow {
                id: r.get(0)?,
                task_key: r.get(1)?,
                env: r.get(2)?,
                status: r.get(3)?,
                params_json: r.get(4)?,
                cancel_requested: r.get::<_, i64>(5)? != 0,
                created_by: r.get(6)?,
            })
        },
    )
    .optional()?
    .ok_or(AppError::NotFound)
}

pub fn load_items(core: &AppCore, run_id: &str) -> Result<Vec<RunItem>> {
    let conn = core.db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT id,ordinal,item_key,display_name,desired_tag,image_ref,app_id,service_update_at,
                tag_update_at,status,attempts,message
           FROM task_run_items WHERE run_id=?1 ORDER BY ordinal",
    )?;
    let rows = stmt.query_map(params![run_id], |r| {
        Ok(RunItem {
            id: r.get(0)?,
            ordinal: r.get(1)?,
            item_key: r.get(2)?,
            display_name: r.get(3)?,
            desired_tag: r.get(4)?,
            image_ref: r.get(5)?,
            app_id: r.get(6)?,
            service_update_at: r.get(7)?,
            tag_update_at: r.get(8)?,
            status: r.get(9)?,
            attempts: r.get(10)?,
            message: r.get(11)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 启动准备阶段（立即返回；进度与结果走 `task://run` / `task://item` 事件）。
pub fn start_prepare(core: &Arc<AppCore>, run_id: &str, adapter: Arc<dyn TaskAdapter>) -> Result<()> {
    let run = load_run(core, run_id)?;
    if run.status != RUN_PREPARING {
        return Err(AppError::InvalidInput);
    }
    let core = core.clone();
    let rid = run_id.to_string();
    std::thread::Builder::new()
        .name("mda-task-prepare".into())
        .spawn(move || {
            if let Err(e) = prepare_blocking(&core, &rid, adapter.as_ref()) {
                log::warn!("任务准备阶段异常结束（{}）：{}", e.code(), e);
            }
        })
        .map_err(|e| AppError::internal("任务执行线程启动", &e))?;
    Ok(())
}

/// 启动发布阶段（立即返回）。
pub fn start_publish(core: &Arc<AppCore>, run_id: &str, adapter: Arc<dyn TaskAdapter>) -> Result<()> {
    let run = load_run(core, run_id)?;
    if run.status != RUN_READY {
        return Err(AppError::InvalidInput);
    }
    let core = core.clone();
    let rid = run_id.to_string();
    std::thread::Builder::new()
        .name("mda-task-publish".into())
        .spawn(move || {
            if let Err(e) = publish_blocking(&core, &rid, adapter.as_ref()) {
                log::warn!("任务发布阶段异常结束（{}）：{}", e.code(), e);
            }
        })
        .map_err(|e| AppError::internal("任务执行线程启动", &e))?;
    Ok(())
}

pub fn prepare_blocking(core: &Arc<AppCore>, run_id: &str, adapter: &dyn TaskAdapter) -> Result<()> {
    let run = load_run(core, run_id)?;
    if run.status != RUN_PREPARING {
        return Err(AppError::InvalidInput);
    }
    let def = task_def(&run.task_key).ok_or(AppError::InvalidInput)?;
    let guard = TokenGuard::acquire(run_id);
    if run.cancel_requested {
        guard.token.store(true, Ordering::SeqCst);
    }
    let ctx = RunContext {
        core: core.clone(),
        run_id: run_id.to_string(),
        cancel: guard.token.clone(),
    };

    if ctx.is_cancelled() {
        return finish_run(core, run_id, RUN_CANCELLED);
    }

    mark_run_started(core, run_id)?;
    let items = load_items(core, run_id)?;
    let todo: Vec<RunItem> = items
        .into_iter()
        .filter(|i| matches!(i.status.as_str(), ITEM_PENDING | ITEM_RESOLVING | ITEM_FAILED))
        .collect();
    append_log(core, run_id, LOG_INFO, None, &format!("开始读取发布信息：{} 项", todo.len()));

    for_each_bounded(&todo, def.prepare_concurrency, |item| {
        if ctx.is_cancelled() {
            return;
        }
        prepare_one(&ctx, adapter, item);
    });

    if ctx.is_cancelled() {
        append_log(core, run_id, LOG_WARN, None, "运行已取消，未开始的条目已跳过");
        return finish_run(core, run_id, RUN_CANCELLED);
    }

    let (ready, succeeded, failed) = item_counts(core, run_id)?;
    if ready == 0 && succeeded == 0 {
        append_log(core, run_id, LOG_ERROR, None, &format!("发布信息读取完成：{} 项全部失败", failed));
        finish_run(core, run_id, RUN_FAILED)
    } else {
        append_log(
            core,
            run_id,
            LOG_INFO,
            None,
            &format!("发布信息读取完成：{} 项可发布，{} 项失败", ready + succeeded, failed),
        );
        finish_run(core, run_id, RUN_READY)
    }
}

pub fn publish_blocking(core: &Arc<AppCore>, run_id: &str, adapter: &dyn TaskAdapter) -> Result<()> {
    let run = load_run(core, run_id)?;
    if run.status != RUN_READY {
        return Err(AppError::InvalidInput);
    }
    let def = task_def(&run.task_key).ok_or(AppError::InvalidInput)?;
    let guard = TokenGuard::acquire(run_id);
    if run.cancel_requested {
        guard.token.store(true, Ordering::SeqCst);
    }
    let ctx = RunContext {
        core: core.clone(),
        run_id: run_id.to_string(),
        cancel: guard.token.clone(),
    };

    let items = load_items(core, run_id)?;
    let todo: Vec<RunItem> = items.into_iter().filter(|i| i.status == ITEM_READY).collect();
    if todo.is_empty() {
        return Err(AppError::InvalidInput);
    }

    if ctx.is_cancelled() {
        return finish_run(core, run_id, RUN_CANCELLED);
    }

    mark_run_started(core, run_id)?;
    set_run_status(core, run_id, RUN_RUNNING)?;
    append_log(core, run_id, LOG_INFO, None, &format!("开始发布：{} 项", todo.len()));

    for_each_bounded(&todo, def.publish_concurrency, |item| {
        if ctx.is_cancelled() {
            return;
        }
        publish_one(&ctx, adapter, item);
    });

    if ctx.is_cancelled() {
        append_log(core, run_id, LOG_WARN, None, "运行已取消，未开始的条目已跳过");
        return finish_run(core, run_id, RUN_CANCELLED);
    }

    let (_, succeeded, failed) = item_counts(core, run_id)?;
    let status = if succeeded == 0 {
        RUN_FAILED
    } else if failed == 0 {
        RUN_SUCCEEDED
    } else {
        RUN_PARTIAL
    };
    append_log(
        core,
        run_id,
        if failed == 0 { LOG_INFO } else { LOG_WARN },
        None,
        &format!("发布结束：成功 {} 项，失败 {} 项", succeeded, failed),
    );
    finish_run(core, run_id, status)
}

fn prepare_one(ctx: &RunContext, adapter: &dyn TaskAdapter, item: &RunItem) {
    let core = &ctx.core;
    if mark_item_started(core, ctx.run_id(), item, ITEM_RESOLVING).is_err() {
        return;
    }
    ctx.log(LOG_INFO, Some(&item.item_key), &format!("读取「{}」的线上信息", item.item_key));
    match adapter.prepare(ctx, item) {
        Ok(prepared) => {
            let _ = finish_item_prepared(core, ctx.run_id(), item, &prepared);
        }
        Err(_) if ctx.is_cancelled() => {
            let _ = mark_item(core, ctx.run_id(), item, ITEM_SKIPPED, Some("已取消"), item.attempts + 1);
        }
        Err(e) => {
            let message = e.to_string();
            ctx.log(LOG_WARN, Some(&item.item_key), &format!("读取失败：{message}"));
            let _ = mark_item(core, ctx.run_id(), item, ITEM_FAILED, Some(&message), item.attempts + 1);
        }
    }
}

fn publish_one(ctx: &RunContext, adapter: &dyn TaskAdapter, item: &RunItem) {
    let core = &ctx.core;
    if mark_item_started(core, ctx.run_id(), item, ITEM_PUBLISHING).is_err() {
        return;
    }
    let target = item.image_ref.as_deref().or(item.desired_tag.as_deref()).unwrap_or(&item.item_key);
    ctx.log(LOG_INFO, Some(&item.item_key), &format!("开始发布：{target}"));
    match adapter.publish(ctx, item) {
        Ok(outcome) if outcome.ok => {
            ctx.log(LOG_INFO, Some(&item.item_key), &format!("发布成功：{}", outcome.message));
            let _ = mark_item_succeeded(core, ctx.run_id(), item, &outcome.message, outcome.service_update_at.as_deref(), item.attempts + 1);
        }
        Ok(_) if ctx.is_cancelled() => {
            let _ = mark_item(core, ctx.run_id(), item, ITEM_SKIPPED, Some("已取消"), item.attempts + 1);
        }
        Ok(outcome) => {
            ctx.log(LOG_WARN, Some(&item.item_key), &format!("发布失败：{}", outcome.message));
            let _ = mark_item(core, ctx.run_id(), item, ITEM_FAILED, Some(&outcome.message), item.attempts + 1);
        }
        Err(_) if ctx.is_cancelled() => {
            let _ = mark_item(core, ctx.run_id(), item, ITEM_SKIPPED, Some("已取消"), item.attempts + 1);
        }
        Err(e) => {
            let message = e.to_string();
            ctx.log(LOG_ERROR, Some(&item.item_key), &format!("发布失败：{message}"));
            let _ = mark_item(core, ctx.run_id(), item, ITEM_FAILED, Some(&message), item.attempts + 1);
        }
    }
}

/// 把失败项放回待读取、运行回到准备态。只重置还没用完尝试次数的条目。
pub fn reset_failed(core: &AppCore, run_id: &str) -> Result<usize> {
    let run = load_run(core, run_id)?;
    if !matches!(
        run.status.as_str(),
        RUN_READY | RUN_PARTIAL | RUN_FAILED | RUN_CANCELLED
    ) {
        return Err(AppError::InvalidInput);
    }
    let reset = {
        let conn = core.db.lock_conn();
        let reset = conn.execute(
            "UPDATE task_run_items SET status=?1, message=NULL, updated_at=?2
              WHERE run_id=?3 AND status=?4 AND attempts < ?5",
            params![ITEM_PENDING, repo::now(), run_id, ITEM_FAILED, MAX_ATTEMPTS],
        )?;
        if reset == 0 {
            // 要么真没有失败项，要么失败项都用完了尝试次数：两种都不该把运行放回准备态。
            return Err(AppError::InvalidInput);
        }
        conn.execute(
            "UPDATE task_runs SET status=?1, cancel_requested=0, finished_at=NULL WHERE id=?2",
            params![RUN_PREPARING, run_id],
        )?;
        reset
    };
    // 取消信号也清掉：这份运行要重新开始，别让上一轮的停止请求把它立刻掐掉。
    if let Some(token) = registry().lock().get(run_id) {
        token.store(false, Ordering::SeqCst);
    }
    emit_run(core, run_id);
    Ok(reset)
}

/// 请求取消。没有活动线程的运行（例如停在"待发布"）立即落地为已取消。
pub fn request_cancel(core: &AppCore, run_id: &str) -> Result<()> {
    let run = load_run(core, run_id)?;
    if !matches!(
        run.status.as_str(),
        RUN_PREPARING | RUN_READY | RUN_RUNNING | RUN_CANCELLING
    ) {
        return Err(AppError::InvalidInput);
    }
    let token = registry().lock().get(run_id).cloned();
    if let Some(token) = &token {
        token.store(true, Ordering::SeqCst);
    }
    {
        let conn = core.db.lock_conn();
        conn.execute(
            "UPDATE task_runs SET cancel_requested=1, status=?1
              WHERE id=?2 AND status IN (?3,?4,?5)",
            params![RUN_CANCELLING, run_id, RUN_PREPARING, RUN_READY, RUN_RUNNING],
        )?;
    }
    append_log(core, run_id, LOG_WARN, None, "收到取消请求，正在停止后续条目");
    emit_run(core, run_id);

    let awaiting_thread = token.is_some() && run.status != RUN_READY;
    if !awaiting_thread {
        finish_run(core, run_id, RUN_CANCELLED)?;
    }
    Ok(())
}

/// 保险库锁定/退出时的统一中止。
///
/// 只处理**这个库**里的运行：先落库（`cancel_requested=1` + `cancelling`），再置停止信号，
/// 最后把没有线程在跑的那几枚直接落地为已取消。顺序是有意的——在跑的那条线程可能正好
/// 越过了某一次信号检查，它收尾时 `finish_run` 会读到库里的取消请求，仍然按已取消记录。
pub fn cancel_all(core: &AppCore) {
    let open = {
        let conn = core.db.lock_conn();
        if conn
            .execute(
                "UPDATE task_runs SET cancel_requested=1, status=?1
                  WHERE finished_at IS NULL AND status IN (?2,?3,?4)",
                params![RUN_CANCELLING, RUN_PREPARING, RUN_READY, RUN_RUNNING],
            )
            .is_err()
        {
            return;
        }
        let mut stmt = match conn.prepare("SELECT id FROM task_runs WHERE status=?1 AND finished_at IS NULL") {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = match stmt.query_map(params![RUN_CANCELLING], |r| r.get::<_, String>(0)) {
            Ok(rows) => rows,
            Err(_) => return,
        };
        let ids = rows.filter_map(|r| r.ok()).collect::<Vec<_>>();
        ids
    };
    let mut reg = registry().lock();
    for run_id in &open {
        match reg.get(run_id) {
            Some(token) => token.store(true, Ordering::SeqCst),
            None => {
                drop(reg);
                let _ = finish_run(core, run_id, RUN_CANCELLED);
                reg = registry().lock();
            }
        }
    }
}

/// 这个运行现在有没有线程在跑。界面用它决定"取消"要不要立刻落地、"重试"能不能点。
pub fn is_active(run_id: &str) -> bool {
    registry().lock().contains_key(run_id)
}

/// 逐条运行日志（脱敏后落库）。
pub fn append_log(core: &AppCore, run_id: &str, level: &str, item_key: Option<&str>, message: &str) {
    let level = match level {
        LOG_WARN => LOG_WARN,
        LOG_ERROR => LOG_ERROR,
        _ => LOG_INFO,
    };
    let message: String = redact(message).chars().take(2000).collect();
    let conn = core.db.lock_conn();
    let _ = conn.execute(
        "INSERT INTO task_run_logs (run_id,seq,ts,level,item_key,message)
         SELECT ?1, COALESCE(MAX(seq),0)+1, ?2, ?3, ?4, ?5 FROM task_run_logs WHERE run_id=?1",
        params![run_id, repo::now(), level, item_key, message],
    );
}

fn mark_run_started(core: &AppCore, run_id: &str) -> Result<()> {
    {
        let conn = core.db.lock_conn();
        conn.execute(
            "UPDATE task_runs SET started_at=COALESCE(started_at,?1) WHERE id=?2",
            params![repo::now(), run_id],
        )?;
    }
    emit_run(core, run_id);
    Ok(())
}

fn set_run_status(core: &AppCore, run_id: &str, status: &str) -> Result<()> {
    {
        let conn = core.db.lock_conn();
        conn.execute("UPDATE task_runs SET status=?1 WHERE id=?2", params![status, run_id])?;
    }
    emit_run(core, run_id);
    Ok(())
}

/// 收尾。**库里的取消请求优先于线程算出来的结论**：置位停止信号与这条写入之间总有竞态，
/// 让"人已经按了取消"这个事实说话，历史里就不会出现"取消成功、库里记成发布成功"。
/// 判为已取消时，仍未开始的条目一并标为已跳过——它们确实没被碰过。
fn finish_run(core: &AppCore, run_id: &str, status: &str) -> Result<()> {
    {
        let conn = core.db.lock_conn();
        let cancel_requested: i64 = conn
            .query_row("SELECT cancel_requested FROM task_runs WHERE id=?1", params![run_id], |r| r.get(0))
            .unwrap_or(0);
        let final_status = if cancel_requested == 1 { RUN_CANCELLED } else { status };
        if final_status == RUN_CANCELLED {
            conn.execute(
                "UPDATE task_run_items SET status=?1, message=?2, updated_at=?3
                  WHERE run_id=?4 AND status IN (?5,?6,?7,?8,?9)",
                params![
                    ITEM_SKIPPED,
                    "已取消",
                    repo::now(),
                    run_id,
                    ITEM_PENDING,
                    ITEM_RESOLVING,
                    ITEM_READY,
                    ITEM_PUBLISHING,
                    ITEM_WAITING
                ],
            )?;
        }
        conn.execute(
            "UPDATE task_runs SET status=?1, finished_at=?2 WHERE id=?3",
            params![final_status, repo::now(), run_id],
        )?;
    }
    emit_run(core, run_id);
    Ok(())
}

fn item_counts(core: &AppCore, run_id: &str) -> Result<(i64, i64, i64)> {
    let conn = core.db.lock_conn();
    let count = |status: &str| -> Result<i64> {
        Ok(conn.query_row(
            "SELECT count(*) FROM task_run_items WHERE run_id=?1 AND status=?2",
            params![run_id, status],
            |r| r.get(0),
        )?)
    };
    let ready = count(ITEM_READY)?;
    let succeeded = count(ITEM_SUCCEEDED)?;
    let failed = count(ITEM_FAILED)?;
    Ok((ready, succeeded, failed))
}

fn mark_item_started(core: &AppCore, run_id: &str, item: &RunItem, status: &str) -> Result<()> {
    {
        let conn = core.db.lock_conn();
        conn.execute(
            "UPDATE task_run_items SET status=?1, attempts=attempts+1, message=NULL, updated_at=?2 WHERE id=?3",
            params![status, repo::now(), item.id],
        )?;
    }
    emit_item(core, run_id, &item.item_key, status, item.attempts + 1, None);
    Ok(())
}

fn finish_item_prepared(core: &AppCore, run_id: &str, item: &RunItem, prepared: &Prepared) -> Result<()> {
    let message = prepared.message.as_deref().map(redact);
    {
        let conn = core.db.lock_conn();
        conn.execute(
            "UPDATE task_run_items SET status=?1,
                    display_name=COALESCE(?2, display_name),
                    image_ref=COALESCE(?3, image_ref),
                    app_id=COALESCE(?4, app_id),
                    service_update_at=COALESCE(?5, service_update_at),
                    tag_update_at=COALESCE(?6, tag_update_at),
                    message=?7, updated_at=?8
              WHERE id=?9",
            params![
                ITEM_READY,
                prepared.display_name.as_deref(),
                prepared.image_ref.as_deref(),
                prepared.app_id.as_deref(),
                prepared.service_update_at.as_deref(),
                prepared.tag_update_at.as_deref(),
                message.as_deref(),
                repo::now(),
                item.id
            ],
        )?;
    }
    emit_item(core, run_id, &item.item_key, ITEM_READY, item.attempts + 1, message.as_deref());
    Ok(())
}

fn mark_item_succeeded(
    core: &AppCore,
    run_id: &str,
    item: &RunItem,
    message: &str,
    service_update_at: Option<&str>,
    attempts: i64,
) -> Result<()> {
    let message = redact(message);
    {
        let conn = core.db.lock_conn();
        conn.execute(
            "UPDATE task_run_items SET status=?1, message=?2,
                    service_update_at=COALESCE(?3, service_update_at), updated_at=?4
              WHERE id=?5",
            params![ITEM_SUCCEEDED, message, service_update_at, repo::now(), item.id],
        )?;
    }
    emit_item(core, run_id, &item.item_key, ITEM_SUCCEEDED, attempts, Some(&message));
    Ok(())
}

fn mark_item(core: &AppCore, run_id: &str, item: &RunItem, status: &str, message: Option<&str>, attempts: i64) -> Result<()> {
    let message = message.map(redact);
    {
        let conn = core.db.lock_conn();
        conn.execute(
            "UPDATE task_run_items SET status=?1, message=?2, updated_at=?3 WHERE id=?4",
            params![status, message.as_deref(), repo::now(), item.id],
        )?;
    }
    emit_item(core, run_id, &item.item_key, status, attempts, message.as_deref());
    Ok(())
}

fn for_each_bounded<T, F>(items: &[T], limit: usize, f: F)
where
    T: Sync,
    F: Fn(&T) + Sync,
{
    if items.is_empty() {
        return;
    }
    let workers = limit.clamp(1, MAX_CONCURRENCY).min(items.len());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= items.len() {
                    break;
                }
                f(&items[index]);
            });
        }
    });
}

/// 适配器侧的测试夹具：造一个真实的运行上下文（含一个内存库），
/// 让 prepare/publish 的读发与轮询逻辑能被离线跑通。
#[cfg(test)]
pub fn test_context(core: Arc<AppCore>, run_id: &str, cancelled: bool) -> RunContext {
    RunContext {
        core,
        run_id: run_id.to_string(),
        cancel: Arc::new(AtomicBool::new(cancelled)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SecretBytes;
    use crate::db::Db;
    use std::sync::atomic::AtomicUsize;

    fn test_core() -> Arc<AppCore> {
        let db = Db::open_in_memory(&[7u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            c.execute(
                "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
                 VALUES ('u1','GEN1','tester','argon2id',X'00',X'00',4096,2,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        Arc::new(AppCore::new(db, SecretBytes::new(vec![7u8; 32]), std::env::temp_dir()))
    }

    fn item(key: &str) -> NewRunItem {
        NewRunItem {
            item_key: key.to_string(),
            display_name: Some(key.to_string()),
            desired_tag: Some("20261030".to_string()),
        }
    }

    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            if cond() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("等待超时：{what}");
    }

    struct FakeAdapter {
        fail_prepare: Vec<&'static str>,
        fail_publish: Vec<&'static str>,
        gate: Option<Arc<AtomicBool>>,
        prepared: AtomicUsize,
        published: AtomicUsize,
    }

    impl FakeAdapter {
        fn new() -> Self {
            Self {
                fail_prepare: Vec::new(),
                fail_publish: Vec::new(),
                gate: None,
                prepared: AtomicUsize::new(0),
                published: AtomicUsize::new(0),
            }
        }

        fn wait_gate(&self, ctx: &RunContext) -> Result<()> {
            if let Some(gate) = &self.gate {
                while !gate.load(Ordering::SeqCst) {
                    ctx.ensure_active()?;
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Ok(())
        }
    }

    impl TaskAdapter for FakeAdapter {
        fn prepare(&self, ctx: &RunContext, item: &RunItem) -> Result<Prepared> {
            self.prepared.fetch_add(1, Ordering::SeqCst);
            self.wait_gate(ctx)?;
            if self.fail_prepare.contains(&item.item_key.as_str()) {
                return Err(AppError::InvalidInput);
            }
            Ok(Prepared {
                image_ref: Some(format!("harbor.example/{}:20261030", item.item_key)),
                app_id: Some(format!("app-{}", item.item_key)),
                service_update_at: Some("2026-10-29T00:00:00Z".into()),
                ..Default::default()
            })
        }

        fn publish(&self, ctx: &RunContext, item: &RunItem) -> Result<PublishOutcome> {
            self.published.fetch_add(1, Ordering::SeqCst);
            self.wait_gate(ctx)?;
            if self.fail_publish.contains(&item.item_key.as_str()) {
                return Ok(PublishOutcome {
                    ok: false,
                    message: "更新时间未变化".into(),
                    service_update_at: None,
                });
            }
            Ok(PublishOutcome {
                ok: true,
                message: "已生效".into(),
                service_update_at: Some("2026-10-30T00:00:00Z".into()),
            })
        }
    }

    #[test]
    fn prepare_then_publish_marks_items_and_run() {
        let core = test_core();
        let run_id = create_run(
            &core,
            "release",
            Env::Test,
            r#"{"services":3}"#,
            &[item("svc-a"), item("svc-b"), item("svc-c")],
            "u1",
        )
        .unwrap();
        assert_eq!(load_run(&core, &run_id).unwrap().status, RUN_PREPARING);

        let adapter = FakeAdapter::new();
        prepare_blocking(&core, &run_id, &adapter).unwrap();
        let run = load_run(&core, &run_id).unwrap();
        assert_eq!(run.status, RUN_READY);
        let items = load_items(&core, &run_id).unwrap();
        assert_eq!(items.len(), 3);
        for item in &items {
            assert_eq!(item.status, ITEM_READY);
            assert!(item.image_ref.as_deref().unwrap().contains("harbor.example"));
            assert_eq!(item.attempts, 1);
            assert!(item.service_update_at.is_some(), "准备阶段要带回线上更新时间");
        }

        publish_blocking(&core, &run_id, &adapter).unwrap();
        let run = load_run(&core, &run_id).unwrap();
        assert_eq!(run.status, RUN_SUCCEEDED);
        let items = load_items(&core, &run_id).unwrap();
        assert!(items.iter().all(|i| i.status == ITEM_SUCCEEDED && i.attempts == 2));
        assert_eq!(adapter.published.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn prepare_failure_leaves_run_ready_and_publish_partial() {
        let core = test_core();
        let run_id = create_run(&core, "release", Env::Prod, "{}", &[item("svc-a"), item("svc-b")], "u1").unwrap();
        let mut adapter = FakeAdapter::new();
        adapter.fail_prepare = vec!["svc-b"];
        prepare_blocking(&core, &run_id, &adapter).unwrap();
        assert_eq!(load_run(&core, &run_id).unwrap().status, RUN_READY);
        let items = load_items(&core, &run_id).unwrap();
        assert_eq!(items[0].status, ITEM_READY);
        assert_eq!(items[1].status, ITEM_FAILED);
        assert!(items[1].message.is_some(), "失败项必须带上原因");

        publish_blocking(&core, &run_id, &adapter).unwrap();
        assert_eq!(load_run(&core, &run_id).unwrap().status, RUN_PARTIAL);
        let items = load_items(&core, &run_id).unwrap();
        assert_eq!(items[0].status, ITEM_SUCCEEDED);
        assert_eq!(items[1].status, ITEM_FAILED);
    }

    #[test]
    fn cancel_stops_remaining_items_and_records_cancelled() {
        let core = test_core();
        let run_id = create_run(
            &core,
            "release",
            Env::Test,
            "{}",
            &[item("svc-a"), item("svc-b"), item("svc-c")],
            "u1",
        )
        .unwrap();
        let mut adapter = FakeAdapter::new();
        adapter.gate = Some(Arc::new(AtomicBool::new(false)));
        let adapter = Arc::new(adapter);
        let worker = {
            let core = core.clone();
            let run_id = run_id.clone();
            let adapter = adapter.clone();
            std::thread::spawn(move || prepare_blocking(&core, &run_id, adapter.as_ref()))
        };
        wait_until("第一项进入读取中", || {
            load_items(&core, &run_id)
                .unwrap()
                .iter()
                .any(|i| i.status == ITEM_RESOLVING)
        });
        request_cancel(&core, &run_id).unwrap();
        worker.join().unwrap().unwrap();

        assert_eq!(load_run(&core, &run_id).unwrap().status, RUN_CANCELLED);
        let items = load_items(&core, &run_id).unwrap();
        assert!(
            items.iter().all(|i| i.status == ITEM_SKIPPED || i.status == ITEM_FAILED),
            "取消后不该有仍在进行中的条目：{items:?}"
        );
        assert!(items.iter().any(|i| i.status == ITEM_SKIPPED));
    }

    #[test]
    fn vault_lock_cancels_running_runs() {
        let core = test_core();
        let run_id = create_run(&core, "release", Env::Test, "{}", &[item("svc-a")], "u1").unwrap();
        let mut adapter = FakeAdapter::new();
        adapter.gate = Some(Arc::new(AtomicBool::new(false)));
        let adapter = Arc::new(adapter);
        let worker = {
            let core = core.clone();
            let run_id = run_id.clone();
            let adapter = adapter.clone();
            std::thread::spawn(move || prepare_blocking(&core, &run_id, adapter.as_ref()))
        };
        // 等线程真的挂上停止信号，否则测的是"没人跑"那条分支
        wait_until("准备线程已登记停止信号", || is_active(&run_id));
        cancel_all(&core);
        worker.join().unwrap().unwrap();
        assert_eq!(load_run(&core, &run_id).unwrap().status, RUN_CANCELLED);
        assert_eq!(load_items(&core, &run_id).unwrap()[0].status, ITEM_SKIPPED);
    }

    #[test]
    fn reset_failed_stops_at_the_attempt_limit() {
        let core = test_core();
        let run_id = create_run(&core, "release", Env::Test, "{}", &[item("svc-a")], "u1").unwrap();
        let mut adapter = FakeAdapter::new();
        adapter.fail_prepare = vec!["svc-a"];
        prepare_blocking(&core, &run_id, &adapter).unwrap();
        let mut attempts = load_items(&core, &run_id).unwrap()[0].attempts;
        assert_eq!(attempts, 1);

        while attempts < MAX_ATTEMPTS {
            assert_eq!(reset_failed(&core, &run_id).unwrap(), 1);
            prepare_blocking(&core, &run_id, &adapter).unwrap();
            attempts = load_items(&core, &run_id).unwrap()[0].attempts;
        }
        assert_eq!(attempts, MAX_ATTEMPTS);
        assert!(reset_failed(&core, &run_id).is_err(), "达到尝试上限后不许无限重试");
        assert_eq!(load_run(&core, &run_id).unwrap().status, RUN_FAILED);
    }

    #[test]
    fn create_run_rejects_bad_input() {
        let core = test_core();
        assert!(create_run(&core, "nope", Env::Test, "{}", &[item("a")], "u1").is_err());
        assert!(create_run(&core, "release", Env::Test, "{}", &[], "u1").is_err());
        assert!(create_run(&core, "release", Env::Test, "{}", &[item("a"), item("a")], "u1").is_err());
        let run_id = create_run(&core, "release", Env::Test, "{}", &[item("a")], "u1").unwrap();
        // 准备未完成前不许直接发布
        assert!(start_publish(&core, &run_id, Arc::new(FakeAdapter::new())).is_err());
    }

    #[test]
    fn logs_are_redacted_and_sequenced() {
        let core = test_core();
        let run_id = create_run(&core, "release", Env::Test, "{}", &[item("a")], "u1").unwrap();
        append_log(&core, &run_id, LOG_WARN, Some("a"), "Cookie: SESSION=abc123; Authorization: Bearer token999");
        append_log(&core, &run_id, LOG_INFO, None, "普通一行");

        let conn = core.db.lock_conn();
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT seq,message FROM task_run_logs WHERE run_id=?1 ORDER BY seq")
                .unwrap();
            let rows = stmt
                .query_map(params![run_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            rows.collect::<std::result::Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), vec![1, 2]);
        assert!(!rows[0].1.contains("abc123"), "{}", rows[0].1);
        assert!(!rows[0].1.contains("token999"), "{}", rows[0].1);
        assert_eq!(rows[1].1, "普通一行");
    }
}
