//! 答题助手：悬停取词状态机、快捷键与生命周期。
//!
//! 线程模型：每次启用只跑一条 `mda-quiz-hover` 线程，120ms 一轮；
//! 截屏与 OCR 在轮内同步执行，所以「同时在飞的识别最多一次」是结构保证。
//! 锁库、停用、退出都会让这条线程在下一轮自行退出。
//!
//! 隐私边界：本模块只把 OCR 原文交给匹配层，**不落盘、不写日志、不写审计**；
//! 审计只记录起停与配置变更这类动作本身。截图只存在于内存，用完即弃。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::error::{AppError, Result};
use crate::quick_launcher::shortcut;
use crate::quiz::capture::{self, Band, ScreenPermission};
use crate::quiz::matcher::{self, MatchHit, MAX_SCOPE_LIBRARIES};
use crate::quiz::ocr::{self, OcrLine};
use crate::quiz::store::{self, AssistantPreferences};
use crate::quiz::tip;
use crate::state::{AppCore, SharedCore};

/// 轮询间隔：120ms 内不重复 OCR 由下面的缓存保证。
pub const TICK_MS: u64 = 120;
/// 光标在同一处停留多久才开始识别（可在 200–2000 之间配置）。
pub const DEFAULT_DWELL_MS: i64 = 520;
/// 停留判定半径：手抖几个像素不该重置计时。
pub const STABLE_RADIUS_PX: f64 = 8.0;
/// 鼠标离上一次显示答案的位置超过这个距离就收起，避免答案跟着人走。
pub const MOVE_HIDE_PX: f64 = 260.0;
/// 没有新结果时，旧答案最多再留这么久。
pub const TIP_HOLD_MS: u64 = 1800;
/// 换题必须连续几次识别到同一个新结果才切换，防止 OCR 抖动导致答案闪跳。
pub const SWITCH_CONFIRM_POLLS: u32 = 2;
/// 同一格内的 OCR 文本复用时长。
const OCR_CACHE_MS: u64 = 700;
/// 光标落点网格：18 逻辑像素以内的移动视为同一处。
const CACHE_GRID_PX: f64 = 18.0;
/// 题干块最多几行、多少字。
const BLOCK_MAX_LINES: usize = 6;
const BLOCK_MAX_CHARS: usize = 300;
/// 相邻行与当前行的水平重叠下限，低于它说明是另一栏的文字。
const BLOCK_MIN_OVERLAP: f64 = 0.55;
/// 行距上限 = 中位行距 × 这个倍数。
const BLOCK_GAP_FACTOR: f64 = 1.8;
/// 连续这么多次截屏/识别失败就停用，别让每 120ms 一次的错误堆满日志。
const MAX_CONSECUTIVE_ERRORS: u32 = 3;

/// 运行中的悬停会话。
struct Session {
    epoch: u64,
    stop: Arc<AtomicBool>,
    #[allow(dead_code)]
    handle: std::thread::JoinHandle<()>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// 每次起停都换一代：旧线程在下一轮看到代号变了就退出，绝不允许两条线程同时识别。
static EPOCH: AtomicU64 = AtomicU64::new(0);
/// 当前已注册的助手快捷键（可能因为「只注册、未启用」而存在）。
static HOTKEY: Mutex<Option<String>> = Mutex::new(None);
/// 线程自行停用时要给界面留下原因，否则状态页只会显示「未运行」。
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn is_running() -> bool {
    SESSION.lock().map(|s| s.is_some()).unwrap_or(false)
}

pub fn last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|e| e.clone())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatus {
    pub running: bool,
    pub preferences: AssistantPreferences,
    pub ocr: ocr::OcrStatus,
    pub screen: capture::ScreenPermissionStatus,
    pub detail: Option<String>,
}

pub fn status(core: &AppCore, user: &str) -> Result<AssistantStatus> {
    Ok(AssistantStatus {
        running: is_running(),
        preferences: store::assistant_preferences(&core.db, user)?,
        ocr: ocr::status(),
        screen: capture::permission_status(),
        detail: last_error(),
    })
}

/// 手动「在光标处试一次」的返回。字段与前端 `QuizLookup` 一一对应。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub text: String,
    pub hits: Vec<MatchHit>,
    pub ocr_ms: u64,
    pub match_ms: u64,
}

/// 截一条带、识别、匹配。**只服务手动按钮**：悬停线程走的是另一条带缓存的路径。
pub fn lookup_at_cursor(core: &AppCore, scope: Option<&[String]>) -> Result<Lookup> {
    let app = core.app_handle().ok_or(AppError::Internal)?;
    let shot = capture::capture_at_cursor(&app)?;

    let started = Instant::now();
    let lines = ocr::recognize(&shot.image)?;
    let ocr_ms = started.elapsed().as_millis() as u64;
    // 截图用完就丢：这里不留任何一份图像或文本。
    drop(shot.image);

    let text = ocr::join_text(&lines);
    let started = Instant::now();
    let hits = matcher::match_text(&core.db, &text, scope)?;
    let match_ms = started.elapsed().as_millis() as u64;
    Ok(Lookup { text, hits, ocr_ms, match_ms })
}

/// 快捷键处理器用：这个加速键是不是答题助手的。
pub fn matches_hotkey(accel: &str) -> bool {
    HOTKEY
        .lock()
        .ok()
        .and_then(|h| h.clone())
        .map(|h| shortcut::equivalent(&h, accel))
        .unwrap_or(false)
}

/// 启动悬停识别。权限、平台、快捷键冲突都在这里一次判完，失败不动任何状态。
pub fn start(app: &AppHandle, core: &SharedCore, user: &str, prefs: &AssistantPreferences) -> Result<()> {
    let screen = capture::permission_status();
    if !screen.supported {
        return Err(AppError::QuizUnsupportedPlatform);
    }
    if screen.permission == ScreenPermission::Denied {
        return Err(AppError::QuizScreenPermissionDenied);
    }
    if let Some(scope) = scope_of(prefs)? {
        if scope.len() > MAX_SCOPE_LIBRARIES {
            return Err(AppError::InvalidInput);
        }
    }

    tip::ensure_window(app)?;
    register_hotkey(app, core, &prefs.hotkey)?;
    store::set_assistant_enabled(&core.db, user, true)?;
    spawn_thread(app, core, user, prefs)?;
    Ok(())
}

/// 用户主动停用：线程停、快捷键摘掉、设置记为关闭（下次登录不再自动开始）。
pub fn stop(app: &AppHandle, core: &AppCore, user: &str) -> Result<()> {
    stop_runtime(app);
    store::set_assistant_enabled(&core.db, user, false)?;
    Ok(())
}

/// 保险库锁定：只停运行时，不改使用者「启用」这个偏好（下次解锁会按原样恢复）。
pub fn stop_for_lock() {
    let app = crate::state::try_core().and_then(|c| c.app_handle());
    match app {
        Some(app) => stop_runtime(&app),
        None => stop_threads_only(),
    }
}

/// 登录后恢复：上次关库时是启用状态的，直接恢复悬停并重新注册快捷键——
/// 这是「启用开关」的含义，而不是每次开机会话都要手点。
/// 从没启用过的账号不注册快捷键：不该给不用它的人占一个全局热键。
pub fn resume_for_login(app: &AppHandle, core: &SharedCore, user: &str) {
    let Ok(prefs) = store::assistant_preferences(&core.db, user) else { return };
    if !prefs.enabled {
        return;
    }
    if let Err(e) = start(app, core, user, &prefs) {
        log::warn!("答题助手未能自动恢复（{}）：{}", e.code(), e);
    }
}

/// 全局快捷键：在启用/停用之间切换。
pub fn toggle(app: &AppHandle, core: &SharedCore) {
    let Ok(user) = core.peek_session() else { return };
    if is_running() {
        if stop(app, core, &user).is_ok() {
            crate::commands::audit(
                core,
                Some(&user),
                "quiz.assistant.stop",
                Some("quiz_assistant"),
                None,
                true,
                None,
                "shortcut",
            );
        }
        return;
    }
    let Ok(prefs) = store::assistant_preferences(&core.db, &user) else {
        return;
    };
    match start(app, core, &user, &prefs) {
        Ok(()) => crate::commands::audit(
            core,
            Some(&user),
            "quiz.assistant.start",
            Some("quiz_assistant"),
            None,
            true,
            None,
            "shortcut",
        ),
        Err(e) => crate::commands::audit(
            core,
            Some(&user),
            "quiz.assistant.start",
            Some("quiz_assistant"),
            None,
            false,
            Some(e.code()),
            "shortcut",
        ),
    }
}

/// 配置变更后重启运行中的线程：新停留时长/范围立刻生效，不必让用户先关再开。
pub fn restart(app: &AppHandle, core: &SharedCore, user: &str, prefs: &AssistantPreferences) -> Result<()> {
    if !is_running() {
        return Ok(());
    }
    spawn_thread(app, core, user, prefs)
}

/// 改快捷键：与启动器同一套「先摘旧键、注册失败必须回滚」的规则。
pub fn rebind_hotkey(app: &AppHandle, core: &AppCore, accel: &str, old: Option<&str>) -> Result<()> {
    let want = shortcut::validate_accelerator(accel)?;
    if shortcut::equivalent(&core.shortcut.lock().clone(), &want) {
        return Err(AppError::ShortcutConflict);
    }
    if let Some(old) = old {
        if shortcut::equivalent(old, &want) && app.global_shortcut().is_registered(want.as_str()) {
            set_hotkey(&want);
            return Ok(());
        }
    }
    unregister_hotkey(app);
    match app.global_shortcut().register(want.as_str()) {
        Ok(()) => {
            set_hotkey(&want);
            Ok(())
        }
        Err(_) => {
            // 回滚：旧键必须恢复，否则用户手里的开关就没了。
            if let Some(old) = old {
                if app.global_shortcut().register(old).is_ok() {
                    set_hotkey(old);
                }
            }
            Err(AppError::ShortcutConflict)
        }
    }
}

/// 注销助手快捷键（停用、锁库、退出时）。
pub fn unregister_hotkey(app: &AppHandle) {
    if let Some(h) = HOTKEY.lock().ok().and_then(|mut h| h.take()) {
        let _ = app.global_shortcut().unregister(h.as_str());
    }
}

pub fn current_hotkey() -> Option<String> {
    HOTKEY.lock().ok().and_then(|h| h.clone())
}

fn register_hotkey(app: &AppHandle, core: &AppCore, accel: &str) -> Result<()> {
    let want = shortcut::validate_accelerator(accel)?;
    if shortcut::equivalent(&core.shortcut.lock().clone(), &want) {
        return Err(AppError::ShortcutConflict);
    }
    if matches_hotkey(&want) && app.global_shortcut().is_registered(want.as_str()) {
        return Ok(());
    }
    unregister_hotkey(app);
    app.global_shortcut()
        .register(want.as_str())
        .map_err(|_| AppError::ShortcutConflict)?;
    set_hotkey(&want);
    Ok(())
}

fn set_hotkey(accel: &str) {
    if let Ok(mut h) = HOTKEY.lock() {
        *h = Some(accel.to_string());
    }
}

fn scope_of(prefs: &AssistantPreferences) -> Result<Option<Vec<String>>> {
    if prefs.scope_mode == "all" {
        return Ok(None);
    }
    if prefs.library_ids.is_empty() {
        return Err(AppError::QuizScopeEmpty);
    }
    Ok(Some(prefs.library_ids.clone()))
}

fn stop_runtime(app: &AppHandle) {
    stop_threads_only();
    unregister_hotkey(app);
    let _ = tip::hide(app);
}

fn stop_threads_only() {
    EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = SESSION.lock() {
        if let Some(session) = guard.take() {
            session.stop.store(true, Ordering::SeqCst);
        }
    }
}

#[derive(Clone)]
struct ThreadConfig {
    user: String,
    dwell_ms: i64,
    show_options: bool,
}

fn spawn_thread(app: &AppHandle, core: &SharedCore, user: &str, prefs: &AssistantPreferences) -> Result<()> {
    // 只停上一代线程：它可能正卡在 OCR 里，最多再花几秒，期间不会发出任何事件。
    // 这里**不能**走 stop_runtime——那会把刚注册好的快捷键连同浮层一起摘掉。
    stop_threads_only();
    let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut err) = LAST_ERROR.lock() {
        *err = None;
    }
    let cfg = ThreadConfig {
        user: user.to_string(),
        dwell_ms: prefs
            .dwell_ms
            .clamp(store::ASSISTANT_MIN_DWELL_MS, store::ASSISTANT_MAX_DWELL_MS),
        show_options: prefs.show_options,
    };
    let app_handle = app.clone();
    let core_handle: SharedCore = Arc::clone(core);
    let stop_flag = Arc::clone(&stop);
    let handle = std::thread::Builder::new()
        .name("mda-quiz-hover".into())
        .spawn(move || hover_loop(app_handle, core_handle, cfg, epoch, stop_flag))
        .map_err(|e| AppError::internal("答题助手线程", &e))?;
    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some(Session { epoch, stop, handle });
    }
    Ok(())
}

struct Shown {
    question_id: String,
    at: Instant,
    /// 显示答案时的光标位置（逻辑坐标）。
    anchor: (f64, f64),
}

#[derive(Default)]
struct HoverState {
    anchor: Option<(f64, f64, Instant)>,
    shown: Option<Shown>,
    pending: Option<(String, u32)>,
    /// 最近一次 OCR 的落点格子与时间。同格内的那几轮不再截屏——
    /// 结果已经匹配过，重跑一遍只会得到同一个答案。
    cache: Option<((i64, i64), Instant)>,
    /// 光标这一处目前是否还停在已显示的题上。缓存复用的那些 tick 据此决定
    /// 是给旧答案续命还是开始倒计时收起。
    last_round_hit: bool,
}

fn hover_loop(app: AppHandle, core: SharedCore, cfg: ThreadConfig, epoch: u64, stop: Arc<AtomicBool>) {
    let mut st = HoverState::default();
    let mut errors = 0u32;
    let mut prefs: Option<AssistantPreferences> = None;
    let mut tick_no: u32 = 0;
    loop {
        if stop.load(Ordering::SeqCst) || EPOCH.load(Ordering::SeqCst) != epoch {
            break;
        }
        // 只查不续期：鼠标停在题目上不等于有人在用这个保险库。
        if core.peek_session().is_err() {
            break;
        }
        // 设置约每秒重读一次：停用命令本身就会把线程停掉，这里只是兜底，
        // 不必每 120ms 去抢一次数据库连接锁。
        if prefs.is_none() || tick_no % 8 == 0 {
            let Ok(fresh) = store::assistant_preferences(&core.db, &cfg.user) else { break };
            prefs = Some(fresh);
        }
        tick_no = tick_no.wrapping_add(1);
        let Some(current) = prefs.as_ref() else { break };
        if !current.enabled {
            break;
        }
        match tick(&app, &core, &cfg, current, &mut st) {
            Ok(()) => errors = 0,
            Err(e) => {
                errors += 1;
                let fatal = matches!(
                    e,
                    AppError::QuizScreenPermissionDenied
                        | AppError::QuizUnsupportedPlatform
                        | AppError::QuizOcrUnavailable
                );
                if fatal || errors >= MAX_CONSECUTIVE_ERRORS {
                    set_last_error(&e);
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(TICK_MS));
    }
    if let Ok(mut guard) = SESSION.lock() {
        if guard.as_ref().map(|s| s.epoch) == Some(epoch) {
            guard.take();
        }
    }
    // 被新一代线程顶掉时不能动全局状态：快捷键是新的那条会话的，
    // 这里再摘一次就等于把刚起来的助手掐死。
    if EPOCH.load(Ordering::SeqCst) == epoch {
        let _ = tip::hide(&app);
        unregister_hotkey(&app);
    }
}

fn set_last_error(e: &AppError) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = Some(format!("{}（{}）", e, e.code()));
    }
    log::warn!("答题助手已停用：{}（{}）", e.code(), e);
}

fn tick(
    app: &AppHandle,
    core: &SharedCore,
    cfg: &ThreadConfig,
    prefs: &AssistantPreferences,
    st: &mut HoverState,
) -> Result<()> {
    // 光标压在本应用自己的窗口上时不识别：否则会把界面文字当成题目。
    let Some((px, py)) = pointer(app) else { return Ok(()) };
    if over_own_window(app, px, py) {
        st.anchor = None;
        st.pending = None;
        st.last_round_hit = false;
        if st.shown.take().is_some() {
            let _ = tip::hide(app);
        }
        return Ok(());
    }

    let (cx, cy) = capture::cursor_logical(app)?;
    let now = Instant::now();
    match st.anchor {
        None => {
            st.anchor = Some((cx, cy, now));
            return Ok(());
        }
        Some((ax, ay, at)) => {
            if (cx - ax).hypot(cy - ay) > STABLE_RADIUS_PX {
                st.anchor = Some((cx, cy, now));
                return Ok(());
            }
            if at.elapsed() < Duration::from_millis(cfg.dwell_ms.max(0) as u64) {
                return Ok(());
            }
        }
    }

    // 人已经走到别处：旧答案不能跟过去。
    if let Some(shown) = &st.shown {
        if (cx - shown.anchor.0).hypot(cy - shown.anchor.1) > MOVE_HIDE_PX {
            st.shown = None;
            st.pending = None;
            let _ = tip::hide(app);
        }
    }

    // 同一格子里 OCR 结果没变：不重复截屏与匹配，只处理「旧答案该续命还是该收起」。
    // 枚举显示器与截屏都在这一行之后，所以光标不动时每 120ms 只读一次光标坐标。
    let key = grid_key(cx, cy);
    if let Some((k, at)) = st.cache {
        if k == key && at.elapsed() < Duration::from_millis(OCR_CACHE_MS) {
            return hold(app, st);
        }
    }

    let band = capture::band_at_cursor(app)?;
    let (lines, cursor_img) = take_lines(&band, key, st)?;
    let variants = stem_variants(&lines, cursor_img);
    if variants.is_empty() {
        return miss(app, st);
    }

    let scope = scope_of(prefs)?;
    let mut best: Option<Vec<MatchHit>> = None;
    for variant in &variants {
        let hits = matcher::match_text(&core.db, variant, scope.as_deref())?;
        let better = match (best.as_ref(), hits.first()) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(cur), Some(h)) => cur
                .first()
                .map(|c| h.score > c.score)
                .unwrap_or(true),
        };
        if better {
            best = Some(hits);
        }
    }
    let Some(hits) = best else { return miss(app, st) };
    let Some(hit) = hits.first().cloned() else { return miss(app, st) };

    let same = st
        .shown
        .as_ref()
        .map(|s| s.question_id == hit.question_id)
        .unwrap_or(false);
    let accept = if same {
        // 已经在显示同一题：只要没掉到维持阈值以下就别动，避免 OCR 抖动把浮层闪掉。
        hit.score >= matcher::STICKY_MIN
    } else if matcher::passes_display_gate(&hits, false) {
        if st.shown.is_none() {
            true
        } else {
            let n = match &st.pending {
                Some((id, n)) if id == &hit.question_id => *n + 1,
                _ => 1,
            };
            st.pending = Some((hit.question_id.clone(), n));
            if n >= SWITCH_CONFIRM_POLLS {
                true
            } else {
                return Ok(());
            }
        }
    } else {
        st.pending = None;
        false
    };
    if !accept {
        return miss(app, st);
    }
    st.pending = None;
    st.last_round_hit = true;

    if same {
        if let Some(shown) = st.shown.as_mut() {
            shown.at = now;
        }
        if !tip::is_visible(app) {
            tip::show(app, &band, hit, cfg.show_options)?;
        }
        return Ok(());
    }
    if tip::show(app, &band, hit.clone(), cfg.show_options)? {
        st.shown = Some(Shown { question_id: hit.question_id, at: now, anchor: (cx, cy) });
    } else {
        // 屏幕小到放不下浮层：宁可不出，也不能压进取景带把自己的答案 OCR 进去。
        st.shown = None;
    }
    Ok(())
}

fn take_lines(band: &Band, key: (i64, i64), st: &mut HoverState) -> Result<(Vec<OcrLine>, (f64, f64))> {
    let image = capture::capture_band(band)?;
    let lines = ocr::recognize(&image)?;
    st.cache = Some((key, Instant::now()));
    Ok((lines, band.cursor_px()))
}

/// 缓存命中的那些轮：不再截屏，只处理已有浮层的去留。
///
/// 上一轮还停在某题上就续命——光标没动、答案还在，没必要每 700ms 重新倒计时；
/// 上一轮什么都没匹配到时，才让旧答案按 TIP_HOLD_MS 自然收起。
fn hold(app: &AppHandle, st: &mut HoverState) -> Result<()> {
    let Some(shown) = st.shown.as_mut() else { return Ok(()) };
    if st.last_round_hit {
        shown.at = Instant::now();
        return Ok(());
    }
    if shown.at.elapsed() >= Duration::from_millis(TIP_HOLD_MS) {
        st.shown = None;
        tip::hide(app)?;
    }
    Ok(())
}

fn miss(app: &AppHandle, st: &mut HoverState) -> Result<()> {
    st.pending = None;
    st.last_round_hit = false;
    let expired = st
        .shown
        .as_ref()
        .map(|s| s.at.elapsed() >= Duration::from_millis(TIP_HOLD_MS))
        .unwrap_or(false);
    if expired {
        st.shown = None;
        tip::hide(app)?;
    }
    Ok(())
}

fn grid_key(x: f64, y: f64) -> (i64, i64) {
    (
        (x / CACHE_GRID_PX).round() as i64,
        (y / CACHE_GRID_PX).round() as i64,
    )
}

fn pointer(app: &AppHandle) -> Option<(f64, f64)> {
    app.cursor_position().ok().map(|p| (p.x, p.y))
}

fn over_own_window(app: &AppHandle, px: f64, py: f64) -> bool {
    for label in ["main", crate::launcher::LAUNCHER_LABEL, tip::TIP_LABEL] {
        let Some(w) = app.get_webview_window(label) else { continue };
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { continue };
        let (x, y) = (pos.x as f64, pos.y as f64);
        let (right, bottom) = (x + size.width as f64, y + size.height as f64);
        if px >= x && py >= y && px < right && py < bottom {
            return true;
        }
    }
    false
}

// ---- 题干块选取与变体 ----

/// OCR 行（已过滤噪声），坐标与 [`OcrLine`] 同一套单位。
#[derive(Clone, Debug, PartialEq)]
pub struct BlockLine {
    pub text: String,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl BlockLine {
    fn height(&self) -> f64 {
        (self.bottom - self.top).max(1.0)
    }

    fn center_y(&self) -> f64 {
        (self.top + self.bottom) / 2.0
    }
}

/// 从一段 OCR 结果里挑出光标所在的那一块题干，并生成几个候选文本。
///
/// 为什么不是「把整带文字直接丢给匹配」：取景带里除了题干，往往还有导航按钮、
/// 进度数字和相邻题的选项；整段送进去会把真正要查的那道题淹掉。
pub fn stem_variants(lines: &[OcrLine], cursor: (f64, f64)) -> Vec<String> {
    let lines = filter_lines(lines);
    let Some(anchor) = anchor_index(&lines, cursor.1) else {
        return Vec::new();
    };
    let (lo, hi) = expand(&lines, anchor);
    let block = &lines[lo..=hi];

    let mut out: Vec<String> = Vec::new();
    push_variant(&mut out, join_lines(block));

    let no_options: Vec<BlockLine> = block
        .iter()
        .filter(|l| !is_option_line(&l.text))
        .cloned()
        .collect();
    if !no_options.is_empty() {
        push_variant(&mut out, join_lines(&no_options));
    }

    let lo2 = anchor.saturating_sub(1).max(lo);
    let hi2 = (anchor + 1).min(hi);
    push_variant(&mut out, join_lines(&lines[lo2..=hi2]));
    push_variant(&mut out, lines[anchor].text.clone());

    if !no_options.is_empty() {
        push_variant(&mut out, strip_placeholders(&join_lines(&no_options)));
    }
    out
}

fn push_variant(out: &mut Vec<String>, raw: String) {
    let text = cap_chars(raw.trim(), BLOCK_MAX_CHARS);
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        return;
    }
    if !out.contains(&text) {
        out.push(text);
    }
}

fn cap_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn join_lines(lines: &[BlockLine]) -> String {
    let mut out = String::new();
    for line in lines {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line.text);
    }
    out
}

fn filter_lines(lines: &[OcrLine]) -> Vec<BlockLine> {
    let mut out: Vec<BlockLine> = lines
        .iter()
        .filter(|l| l.confidence >= ocr::MIN_CONFIDENCE)
        .map(|l| BlockLine {
            text: l.text.trim().to_string(),
            left: l.left,
            top: l.top,
            right: l.right,
            bottom: l.bottom,
        })
        .filter(|l| !is_noise(&l.text))
        .collect();
    out.sort_by(|a, b| {
        a.top
            .partial_cmp(&b.top)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.left.partial_cmp(&b.left).unwrap_or(std::cmp::Ordering::Equal))
    });
    out
}

const ANSWER_PREFIXES: &[&str] = &[
    "答案",
    "参考答案",
    "正确答案",
    "答案：",
    "答案:",
    "解析",
    "答案解析",
    "试题解析",
];

fn is_noise(text: &str) -> bool {
    let trimmed = text.trim();
    // 「1/10」「00:12」「—」这类进度/装饰没有了字母或汉字，不可能出现在题干里。
    let core: String = trimmed
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string();
    if core.chars().count() < 2 {
        return true;
    }
    if !core.chars().any(|c| !c.is_ascii_digit()) {
        return true;
    }
    // 单独的选项标记 A / B …
    if core.chars().count() <= 2 && core.chars().all(|c| c.is_ascii_alphabetic()) {
        return true;
    }
    // 「答案：A」这类行属于答案本身，混进题干只会把匹配带偏。
    if ANSWER_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
        return true;
    }
    false
}

fn is_option_line(text: &str) -> bool {
    let mut chars = text.trim_start().chars();
    match (chars.next(), chars.next()) {
        (Some(c), Some(sep)) => {
            c.is_ascii_uppercase() && matches!(sep, '.' | '、' | '．' | ')' | '）' | ':' | '：')
        }
        _ => false,
    }
}

fn strip_placeholders(text: &str) -> String {
    let mut out = text.to_string();
    for token in ["（ ）", "（  ）", "( )", "（　）", "（）", "()", "____", "___", "＿"] {
        out = out.replace(token, " ");
    }
    out
}

fn anchor_index(lines: &[BlockLine], cursor_y: f64) -> Option<usize> {
    let mut best: Option<usize> = None;
    let mut best_d = f64::INFINITY;
    for (i, line) in lines.iter().enumerate() {
        if cursor_y >= line.top && cursor_y <= line.bottom {
            return Some(i);
        }
        let d = (line.center_y() - cursor_y).abs();
        if d < best_d {
            best_d = d;
            best = Some(i);
        }
    }
    best
}

fn center_gap(a: &BlockLine, b: &BlockLine) -> f64 {
    (a.center_y() - b.center_y()).abs()
}

fn median_gap(lines: &[BlockLine]) -> f64 {
    if lines.len() < 2 {
        return lines.first().map(|l| l.height()).unwrap_or(20.0);
    }
    let mut gaps: Vec<f64> = lines.windows(2).map(|w| center_gap(&w[0], &w[1])).collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    gaps[gaps.len() / 2]
}

fn overlap_ratio(a: &BlockLine, b: &BlockLine) -> f64 {
    let left = a.left.max(b.left);
    let right = a.right.min(b.right);
    let inter = (right - left).max(0.0);
    let denom = (a.right - a.left).min(b.right - b.left).max(1.0);
    (inter / denom).clamp(0.0, 1.0)
}

fn expand(lines: &[BlockLine], anchor: usize) -> (usize, usize) {
    let limit = median_gap(lines) * BLOCK_GAP_FACTOR;
    let mut lo = anchor;
    let mut hi = anchor;
    while lo > 0 && hi - lo + 1 < BLOCK_MAX_LINES {
        let candidate = &lines[lo - 1];
        let current = &lines[lo];
        if center_gap(candidate, current) <= limit
            && overlap_ratio(candidate, current) >= BLOCK_MIN_OVERLAP
        {
            lo -= 1;
        } else {
            break;
        }
    }
    while hi + 1 < lines.len() && hi - lo + 1 < BLOCK_MAX_LINES {
        let candidate = &lines[hi + 1];
        let current = &lines[hi];
        if center_gap(current, candidate) <= limit
            && overlap_ratio(candidate, current) >= BLOCK_MIN_OVERLAP
        {
            hi += 1;
        } else {
            break;
        }
    }
    (lo, hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, top: f64, left: f64, width: f64) -> OcrLine {
        OcrLine {
            text: text.to_string(),
            confidence: 0.95,
            left,
            top,
            right: left + width,
            bottom: top + 20.0,
        }
    }

    #[test]
    fn block_stops_at_a_different_column() {
        let lines = vec![
            line("下列设备中属于一次设备的是（ ）", 10.0, 100.0, 300.0),
            line("变压器", 36.0, 100.0, 120.0),
            line("侧边导航", 36.0, 600.0, 80.0),
        ];
        let variants = stem_variants(&lines, (200.0, 45.0));
        assert!(!variants.is_empty());
        assert!(
            variants.iter().all(|v| !v.contains("侧边导航")),
            "另一栏的文字不能被并进题干：{variants:?}"
        );
        assert!(variants[0].contains("一次设备"));
    }

    #[test]
    fn answer_and_progress_lines_never_reach_the_query() {
        let lines = vec![
            line("变压器可以带负荷拉合隔离开关", 10.0, 100.0, 300.0),
            line("答案：错误", 36.0, 100.0, 160.0),
            line("3/20", 10.0, 700.0, 40.0),
        ];
        let variants = stem_variants(&lines, (200.0, 15.0));
        assert!(variants.iter().all(|v| !v.contains("答案")));
        assert!(variants.iter().all(|v| !v.contains("3/20")));
    }

    #[test]
    fn option_lines_are_dropped_from_one_variant_but_kept_in_full_block() {
        let lines = vec![
            line("电压互感器二次侧不允许", 10.0, 100.0, 300.0),
            line("A. 开路", 36.0, 100.0, 120.0),
            line("B. 短路", 62.0, 100.0, 120.0),
            line("C. 接地", 88.0, 100.0, 120.0),
        ];
        let variants = stem_variants(&lines, (200.0, 40.0));
        assert!(variants.iter().any(|v| v.contains("A. 开路")), "整块变体里应保留选项");
        assert!(
            variants.iter().any(|v| !v.contains("A. 开路") && v.contains("电压互感器")),
            "至少有一个只含题干的变体"
        );
    }

    #[test]
    fn block_is_capped_and_truncated() {
        let mut lines = Vec::new();
        for i in 0..10 {
            lines.push(line(&format!("第{i}行题干文字"), 10.0 + i as f64 * 26.0, 100.0, 300.0));
        }
        let variants = stem_variants(&lines, (200.0, 40.0));
        let longest = variants.iter().map(|v| v.chars().count()).max().unwrap_or(0);
        assert!(longest <= BLOCK_MAX_CHARS);
        assert!(!variants.is_empty());
    }

    #[test]
    fn placeholders_are_stripped_in_one_variant() {
        let lines = vec![line("电流互感器二次侧不得（ ）", 10.0, 100.0, 300.0)];
        let variants = stem_variants(&lines, (200.0, 15.0));
        assert!(variants.iter().any(|v| v.contains("不得")));
    }

    #[test]
    fn empty_or_noisy_ocr_yields_no_query() {
        let lines = vec![line("12", 10.0, 100.0, 20.0), line("A.", 36.0, 100.0, 20.0)];
        assert!(stem_variants(&lines, (200.0, 15.0)).is_empty());
    }

    #[test]
    fn grid_key_is_stable_within_a_cell() {
        assert_eq!(grid_key(100.0, 200.0), grid_key(104.0, 204.0));
        assert_ne!(grid_key(100.0, 200.0), grid_key(100.0, 230.0));
    }
}
