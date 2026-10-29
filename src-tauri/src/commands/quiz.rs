//! 题库命令：导入任务、复核表、题库台账。
//!
//! 解析在阻塞线程里跑（读文件 + 解压 + 逐行解析），**不占用数据库连接**：
//! 会话校验完成后再进 `spawn_blocking`，回来才写库——这样导入一份 2 万题的表格时，
//! 别的窗口读写保险库不会被一条解析中的命令卡住。
//!
//! 审计只记动作、任务 id、题库 id 与结果码；题干、答案、文件名之外的路径都不进审计。

use super::{audit, Result};
use crate::error::AppError;
use crate::quiz::matcher::MatchHit;
use crate::quiz::models::{
    ImportJobDetail, ImportJobDto, ImportRowPatch, ImportRowUpdated, Page, QuizLibraryDto, QuizQuestionDto,
};
use crate::quiz::parse;
use crate::quiz::store::{self, BulkEdit, NewImport};
use crate::rbac::{self, perm};

fn require_read() -> Result<(crate::state::SharedCore, String)> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_READ)?;
    Ok((core, user))
}

#[tauri::command]
pub fn quiz_list_libraries() -> Result<Vec<QuizLibraryDto>> {
    let (core, _user) = require_read()?;
    store::list_libraries(&core.db)
}

#[tauri::command]
pub fn quiz_library_questions(library_id: String, offset: i64, limit: i64) -> Result<Page<QuizQuestionDto>> {
    let (core, _user) = require_read()?;
    store::library_questions(&core.db, &library_id, offset, limit)
}

#[tauri::command]
pub fn quiz_rename_library(id: String, name: String) -> Result<QuizLibraryDto> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_MANAGE)?;
    let dto = store::rename_library(&core.db, &id, &name)?;
    audit(&core, Some(&user), "quiz.library.rename", Some("quiz_library"), Some(&id), true, None, "app");
    Ok(dto)
}

#[tauri::command]
pub fn quiz_delete_library(id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_MANAGE)?;
    store::delete_library(&core.db, &id)?;
    crate::quiz::matcher::invalidate();
    audit(&core, Some(&user), "quiz.library.delete", Some("quiz_library"), Some(&id), true, None, "app");
    Ok(())
}

/// 重建全文索引。返回重建后的题目总数，界面据此给出「已重建 N 题」。
#[tauri::command]
pub fn quiz_reindex() -> Result<i64> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_MANAGE)?;
    let count = store::reindex(&core.db)?;
    crate::quiz::matcher::invalidate();
    audit(&core, Some(&user), "quiz.library.reindex", Some("quiz_library"), None, true, None, "app");
    Ok(count)
}

/// 手动识别：拿一段文本在题库里找答案（界面上的「粘贴题干试一次」走这条）。
///
/// 悬停线程不经过这里：它每 700ms 就可能查一次，进审计表只会把台账淹掉。
#[tauri::command]
pub fn quiz_match_text(text: String, library_ids: Option<Vec<String>>) -> Result<Vec<MatchHit>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_ASSISTANT_USE)?;
    let hits = crate::quiz::matcher::match_text(&core.db, &text, library_ids.as_deref())?;
    audit(&core, Some(&user), "quiz.lookup.manual", Some("quiz_library"), None, true, None, "app");
    Ok(hits)
}

/// 解析一份题库文件并落成一次待复核任务。
///
/// 题库名默认取文件名（去扩展名）；复核阶段可以改，发布时也能再改一次。
/// 只回摘要：复核表按页另取（`quiz_import_job`），解析这一步不该顺带传回几千行。
#[tauri::command]
pub async fn quiz_import_parse(path: String) -> Result<ImportJobDto> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;

    let file = std::path::PathBuf::from(&path);
    let parsed = tauri::async_runtime::spawn_blocking(move || parse::parse_file(&file))
        .await
        .map_err(|e| AppError::internal("题库解析", &e))??;

    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if filename.is_empty() {
        return Err(AppError::InvalidInput);
    }
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let name = if stem.is_empty() { "未命名题库".to_string() } else { stem };

    let detail = store::create_job(
        &core.db,
        &user,
        NewImport {
            library_name: &name,
            format: parsed.format,
            filename: &filename,
            questions: &parsed.questions,
        },
    )?;
    audit(
        &core,
        Some(&user),
        "quiz.import.parse",
        Some("import_job"),
        Some(&detail.job.id),
        true,
        None,
        "app",
    );
    Ok(detail.job)
}

/// 复核表的一页。`only_issues` 卡的是解析层落库的问题码，不是界面的二次判断。
#[tauri::command]
pub fn quiz_import_job(job_id: String, offset: i64, limit: i64, only_issues: bool) -> Result<ImportJobDetail> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;
    store::job_detail(&core.db, &job_id, offset, limit, only_issues)
}

#[tauri::command]
pub fn quiz_import_update_row(job_id: String, row_id: String, patch: ImportRowPatch) -> Result<ImportRowUpdated> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;
    let updated = store::update_row(&core.db, &job_id, &row_id, &patch)?;
    audit(&core, Some(&user), "quiz.import.update", Some("import_job"), Some(&job_id), true, None, "app");
    Ok(updated)
}

#[tauri::command]
pub fn quiz_import_bulk_update(job_id: String, edit: BulkEdit) -> Result<ImportJobDto> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;
    let job = store::bulk_update(&core.db, &job_id, &edit)?;
    audit(&core, Some(&user), "quiz.import.update", Some("import_job"), Some(&job_id), true, None, "app");
    Ok(job)
}

#[tauri::command]
pub fn quiz_import_publish(job_id: String, library_name: Option<String>) -> Result<QuizLibraryDto> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;
    let lib = store::publish(&core.db, &job_id, library_name.as_deref())?;
    crate::quiz::matcher::invalidate();
    audit(
        &core,
        Some(&user),
        "quiz.import.publish",
        Some("quiz_library"),
        Some(&lib.id),
        true,
        None,
        "app",
    );
    Ok(lib)
}

#[tauri::command]
pub fn quiz_import_discard(job_id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;
    store::discard(&core.db, &job_id)?;
    audit(&core, Some(&user), "quiz.import.discard", Some("import_job"), Some(&job_id), true, None, "app");
    Ok(())
}

/// 导入模板：一份能被本解析器原样读回的 CSV（列序见 `parse::grid::TEMPLATE_COLUMNS`）。
///
/// 不读库、不落盘，产出的是静态示例题，因此不进审计；界面把它交给系统下载通道写出。
#[tauri::command]
pub fn quiz_import_template() -> Result<serde_json::Value> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_LIBRARY_IMPORT)?;
    Ok(serde_json::json!({
        "csv": parse::grid::template_csv(),
        "columns": parse::grid::TEMPLATE_COLUMNS,
        "note": "四行示例题覆盖单选 / 多选 / 判断 / 填空；按同样的列填完即可导入，表头认不出时按这一列序读。",
    }))
}

// ---- 答题助手：单次取词与引擎状态 ----

/// 在光标处截一条横带、识别、再在题库里找答案。
///
/// 这条和 `quiz_match_text` 一样属于**手动**动作：一次点击进审计一行。
/// 悬停线程不经过命令层，也不会写审计（P6）。
#[tauri::command]
pub fn quiz_lookup_at_cursor(library_ids: Option<Vec<String>>) -> Result<crate::quiz::assistant::Lookup> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_ASSISTANT_USE)?;
    let out = crate::quiz::assistant::lookup_at_cursor(&core, library_ids.as_deref())?;
    audit(&core, Some(&user), "quiz.lookup.manual", Some("quiz_library"), None, true, None, "app");
    Ok(out)
}

/// 引擎状态：界面用它决定「试一次」按钮可用性与提示文案。
#[tauri::command]
pub fn quiz_ocr_status() -> Result<crate::quiz::ocr::OcrStatus> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_ASSISTANT_USE)?;
    Ok(crate::quiz::ocr::status())
}

/// 屏幕录制权限状态（macOS 之外恒为已授予）。
#[tauri::command]
pub fn quiz_screen_permission() -> Result<crate::quiz::capture::ScreenPermissionStatus> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_ASSISTANT_USE)?;
    Ok(crate::quiz::capture::permission_status())
}

// ---- 答题助手：开关、检索范围、快捷键 ----

fn require_assistant() -> Result<(crate::state::SharedCore, String)> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_ASSISTANT_USE)?;
    Ok((core, user))
}

fn app_of(core: &crate::state::AppCore) -> Result<tauri::AppHandle> {
    core.app_handle().ok_or(AppError::Internal)
}

/// 助手状态：运行中与否、已保存的偏好、OCR 引擎与屏幕权限。卡片每次打开都问一次。
#[tauri::command]
pub fn quiz_assistant_status() -> Result<crate::quiz::assistant::AssistantStatus> {
    let (core, user) = require_assistant()?;
    crate::quiz::assistant::status(&core, &user)
}

/// 改配置。整份覆盖：范围、停留时长、快捷键、是否显示选项一次提交。
///
/// 运行中改配置立即生效（重启悬停线程）；换快捷键失败时必须把库里的值改回旧的，
/// 否则界面显示新键、实际注册的是旧键，用户会以为快捷键坏了。
#[tauri::command]
pub fn quiz_assistant_set_preferences(
    input: crate::quiz::store::AssistantPreferencesInput,
) -> Result<crate::quiz::store::AssistantPreferences> {
    let (core, user) = require_assistant()?;
    let app = app_of(&core)?;
    let old = store::assistant_preferences(&core.db, &user)?;
    let prefs = store::save_assistant_preferences(&core.db, &user, &input)?;

    // 只有快捷键当前真的注册着才需要重新绑定；没运行的时候下一次启用会直接用新键。
    let hotkey_live = crate::quiz::assistant::current_hotkey().is_some();
    if hotkey_live && !crate::quick_launcher::shortcut::equivalent(&old.hotkey, &prefs.hotkey) {
        if let Err(e) = crate::quiz::assistant::rebind_hotkey(&app, &core, &prefs.hotkey, Some(&old.hotkey)) {
            let _ = store::save_assistant_preferences(
                &core.db,
                &user,
                &crate::quiz::store::AssistantPreferencesInput {
                    scope_mode: prefs.scope_mode.clone(),
                    dwell_ms: prefs.dwell_ms,
                    hotkey: old.hotkey.clone(),
                    show_options: prefs.show_options,
                    library_ids: prefs.library_ids.clone(),
                },
            );
            audit(&core, Some(&user), "quiz.assistant.config", Some("quiz_assistant"), None, false, Some(e.code()), "app");
            return Err(e);
        }
    }

    if crate::quiz::assistant::is_running() {
        if let Err(e) = crate::quiz::assistant::restart(&app, &core, &user, &prefs) {
            audit(&core, Some(&user), "quiz.assistant.config", Some("quiz_assistant"), None, false, Some(e.code()), "app");
            return Err(e);
        }
    }
    audit(&core, Some(&user), "quiz.assistant.config", Some("quiz_assistant"), None, true, None, "app");
    Ok(prefs)
}

/// 启用悬停识别。屏幕权限、平台、快捷键冲突都在这条命令里一次性判完。
#[tauri::command]
pub fn quiz_assistant_start() -> Result<crate::quiz::assistant::AssistantStatus> {
    let (core, user) = require_assistant()?;
    let app = app_of(&core)?;
    let prefs = store::assistant_preferences(&core.db, &user)?;
    match crate::quiz::assistant::start(&app, &core, &user, &prefs) {
        Ok(()) => {
            audit(&core, Some(&user), "quiz.assistant.start", Some("quiz_assistant"), None, true, None, "app");
            crate::quiz::assistant::status(&core, &user)
        }
        Err(e) => {
            audit(&core, Some(&user), "quiz.assistant.start", Some("quiz_assistant"), None, false, Some(e.code()), "app");
            Err(e)
        }
    }
}

/// 停用：线程停、快捷键摘掉，并记住「下次登录不要自动开始」。
#[tauri::command]
pub fn quiz_assistant_stop() -> Result<crate::quiz::assistant::AssistantStatus> {
    let (core, user) = require_assistant()?;
    let app = app_of(&core)?;
    crate::quiz::assistant::stop(&app, &core, &user)?;
    audit(&core, Some(&user), "quiz.assistant.stop", Some("quiz_assistant"), None, true, None, "app");
    crate::quiz::assistant::status(&core, &user)
}

/// 只在用户点「申请权限」时调用：macOS 会弹系统授权框（授权后通常要重启应用才生效）。
#[tauri::command]
pub fn quiz_request_screen_permission() -> Result<crate::quiz::capture::ScreenPermissionStatus> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::QUIZ_ASSISTANT_USE)?;
    let status = crate::quiz::capture::request_permission();
    let ok = status.permission == crate::quiz::capture::ScreenPermission::Granted;
    audit(&core, Some(&user), "quiz.permission.request", Some("quiz_assistant"), None, ok, None, "app");
    Ok(status)
}
