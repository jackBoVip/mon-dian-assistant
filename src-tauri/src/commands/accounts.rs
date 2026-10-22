//! 账号管理 = 外部系统账号/密码台账（凭据保险库）。
//! 这里所有 username/password 都是「别的系统的」，绝不是本软件的登录凭据。
//! 结构强制：`vault_targets`（地址/系统）与 `vault_items`（该地址下的一条账号凭据）分离，
//! 同一地址允许多条凭据；默认账号按 (本地使用者 × 目标) 保存。


use super::{
    action_policy, audit, extension_gate, payload_of, stats_view, ActionReply, CreateItemInput, CreateTargetInput, Result, StatsView, TargetDetail, TargetFilter, UpdateItemInput,
};
use crate::db::repo;
use crate::error::AppError;
use crate::quick_launcher::search::SearchDoc;
use crate::rbac::{self, perm};
use crate::settings;
use crate::state::AppCore;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecret {
    /// 明文只在显式「查看秘密」时返回，受二次认证与前端自动隐藏时间约束。
    pub value: String,
    pub visible_seconds: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    #[serde(flatten)]
    pub row: repo::ItemRow,
    pub username_masked: String,
    pub has_password: bool,
    pub has_token: bool,
    pub has_private_key: bool,
    pub can_reveal: bool,
}

fn to_view(core: &AppCore, user: &str, row: repo::ItemRow) -> ItemView {
    let can_reveal = rbac::has_permission(&core.db, user, perm::ACC_VIEW_SECRET).unwrap_or(false);
    let (username_masked, has_password, has_token, has_private_key) = if can_reveal {
        core.vault
            .with_vk(|vk| {
                let p = repo::item_payload(vk, &core.db, &row.id)?;
                Ok::<_, AppError>((
                    super::super::quick_launcher::query::mask_username(&p.username),
                    !p.password.is_empty(),
                    !p.token.is_empty(),
                    !p.private_key.is_empty(),
                ))
            })
            .unwrap_or_default()
    } else {
        // 无查看权限时连用户名都不解密，避免「是否存在」信息泄露
        ("—".to_string(), false, false, false)
    };
    ItemView {
        username_masked,
        has_password,
        has_token,
        has_private_key,
        can_reveal,
        row,
    }
}

#[tauri::command]
pub fn vault_stats() -> Result<StatsView> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    stats_view(&core)
}

/// 筛选语义（含"仅收藏"）全部在后端 SQL 里落地：前端传来的条件一个都不允许被静默忽略。
/// 本命令返回**完整**清单，供导出等需要全量的场景使用；台账列表走 `list_targets_paged`。
#[tauri::command]
pub fn list_targets(filter: Option<TargetFilter>) -> Result<Vec<repo::TargetRow>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    let f = filter.unwrap_or_default();
    let (rows, _) = repo::query_targets(&core.db, &target_query(&f, None, 0))?;
    Ok(rows)
}

fn target_query(f: &TargetFilter, limit: Option<i64>, offset: i64) -> repo::TargetQuery<'_> {
    repo::TargetQuery {
        // "all" 是前端的标签页哨兵值，不是数据库里的类型
        item_type: f.item_type.as_deref().filter(|t| *t != "all"),
        group_id: f.group_id.as_deref().filter(|g| !g.trim().is_empty()),
        keyword: f.keyword.as_deref(),
        tag: f.tag.as_deref().filter(|t| !t.trim().is_empty()),
        favorite_only: f.favorite_only.unwrap_or(false),
        limit,
        offset,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedTargets {
    pub rows: Vec<repo::TargetRow>,
    /// 符合筛选条件的总数（不是当前页条数），界面用它渲染"共 N 条"与页数
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

/// 需求 §6：10,000 条数据下列表必须分页，不能把一万行一次性塞进 DOM。
/// 过滤与切片在同一条 SQL 里完成，`total` 用同一套条件统计，所以页内容和"共 N 条"不会打架。
#[tauri::command]
pub fn list_targets_paged(filter: Option<TargetFilter>, page: i64, page_size: i64) -> Result<PagedTargets> {
    if !page_in_range(page, page_size) {
        return Err(AppError::InvalidInput);
    }
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    let f = filter.unwrap_or_default();
    let offset = (page - 1).saturating_mul(page_size);
    let (rows, total) = repo::query_targets(&core.db, &target_query(&f, Some(page_size), offset))?;
    Ok(PagedTargets { rows, total, page, page_size })
}

/// 页码与页大小都从 1 起算；上限 200 是防止"一页要一万行"把分页变成摆设。
fn page_in_range(page: i64, page_size: i64) -> bool {
    (1..).contains(&page) && (1..=200).contains(&page_size)
}

#[tauri::command]
pub fn list_groups() -> Result<Vec<repo::GroupRow>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    repo::list_groups(&core.db)
}

/// 台账首页的标签筛选下拉数据源（需求 §2.2）。只是标签文本，不含任何凭据字段。
#[tauri::command]
pub fn list_item_tags() -> Result<Vec<String>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    repo::list_item_tags(&core.db)
}

/// 台账首页的「最近访问」入口（需求 §2.2）。返回的是非秘密摘要：目标名、凭据别名、类型、访问时刻。
/// 上限 100 条：这一栏是给"接着用"的快捷入口，不是列表替代品，没必要一次搬几百行。
#[tauri::command]
pub fn recent_access(limit: Option<i64>) -> Result<Vec<repo::RecentAccessRow>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    repo::recent_access(&core.db, limit.unwrap_or(10).clamp(1, 100))
}

#[tauri::command]
pub fn create_group(name: String, parent_id: Option<String>) -> Result<String> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_CREATE)?;
    let id = repo::create_group(&core.db, &user, &name, parent_id.as_deref())?;
    audit(&core, Some(&user), "accounts.group.create", Some("group"), Some(&id), true, None, "app");
    Ok(id)
}

#[tauri::command]
pub fn target_items(target_id: String) -> Result<Vec<ItemView>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    let rows = repo::list_items_for_target(&core.db, &target_id, &user)?;
    Ok(rows.into_iter().filter(|r| can_see(&core, &user, &r.id)).map(|r| to_view(&core, &user, r)).collect())
}

fn can_see(core: &AppCore, user: &str, item_id: &str) -> bool {
    repo::can_access_item(&core.db.lock_conn(), user, item_id).unwrap_or(false)
}

/// 详情侧的弱协议判定。拆成独立函数的理由：命令本体要先 `state::core()`，单元测试进不来
/// （`set_global_core` 只在 `finish_boot` 里调用），而审查 F4 恰恰是这一行的参数错位——
/// 原先把 `meta.protocol` 同时当 `target_type` 与 `protocol` 传，两个分支都不成立、判定恒 false，
/// 抽屉里那枚"明文协议"徽章永远不显示，而 400 条测试一条都不会红（前端测试把它当 mock 入参喂 true）。
/// 单独可测之后，"第一参必须是目标类型"这件事第一次有了回归网。
fn insecure_flag(target: &repo::TargetRow, meta: &repo::TargetSecretPayload, allow_weak: bool) -> bool {
    repo::is_insecure_protocol(&target.target_type, &meta.protocol) && !allow_weak
}

#[tauri::command]
pub fn target_detail(target_id: String) -> Result<TargetDetail> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    let target = repo::get_target_row(&core.db, &target_id)?;
    let items: Vec<repo::ItemRow> = repo::list_items_for_target(&core.db, &target_id, &user)?
        .into_iter()
        .filter(|r| can_see(&core, &user, &r.id))
        .collect();
    let meta = core.vault.with_vk(|vk| repo::target_meta(vk, &core.db, &target_id))?;
    let allow_weak = settings::get_bool(&core.db, "allow_insecure_protocols", false);
    // 先算再进结构体：`target` 会在同一个字面量里被 move 走。
    let insecure_protocol = insecure_flag(&target, &meta, allow_weak);
    Ok(TargetDetail {
        target,
        meta: meta.clone(),
        items,
        insecure_protocol,
        fill_available: extension_gate(&core),
    })
}

/// 编辑对话框所需的单条凭据明细。秘密（密码/令牌/私钥/口令）一律不回显，
/// 提交走 update_item 的补丁语义（缺省=保留、空串=清空）；无「查看秘密」权限时
/// 连用户名都不返回，只给掩码，避免编辑对话框成为绕过权限的读取通道。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    #[serde(flatten)]
    pub view: ItemView,
    pub username: Option<String>,
    pub note: String,
    pub auth_method: String,
    pub browser_hint: String,
    pub login_url_override: String,
    pub confirm_before_fill: bool,
    pub can_update: bool,
}

#[tauri::command]
pub fn item_detail(item_id: String) -> Result<ItemDetail> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    if !can_see(&core, &user, &item_id) {
        return Err(AppError::NotFound);
    }
    let row = repo::get_item_row(&core.db, &user, &item_id)?;
    let can_reveal = rbac::has_permission(&core.db, &user, perm::ACC_VIEW_SECRET).unwrap_or(false);
    let (username, note, auth_method, browser_hint, login_url_override, confirm_before_fill) = core
        .vault
        .with_vk(|vk| {
            let p = repo::item_payload(vk, &core.db, &item_id)?;
            Ok::<_, AppError>((p.username, p.note, p.auth_method, p.browser_hint, p.login_url_override, p.confirm_before_fill))
        })?;
    let view = to_view(&core, &user, row);
    Ok(ItemDetail {
        username: can_reveal.then_some(username),
        note,
        auth_method,
        browser_hint,
        login_url_override,
        confirm_before_fill,
        can_update: rbac::has_permission(&core.db, &user, perm::ACC_UPDATE).unwrap_or(false),
        view,
    })
}

#[tauri::command]
pub fn find_similar_targets(address: String) -> Result<Vec<repo::TargetRow>> {    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_CREATE)?;
    // 只作为提示：绝不因 URL 相同自动合并不同租户/环境
    core.vault.with_vk(|vk| repo::find_similar_targets(&core.db, vk, &address))
}

#[tauri::command]
pub fn create_target(input: CreateTargetInput) -> Result<repo::TargetRow> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_CREATE)?;
    let nt = input.into_new();
    if nt.target_type == "terminal" || nt.target_type == "file_transfer" {
        let allow_weak = settings::get_bool(&core.db, "allow_insecure_protocols", false);
        if repo::is_insecure_protocol(&nt.target_type, &nt.meta.protocol) && !allow_weak {
            return Err(AppError::InsecureProtocolDisabled);
        }
    }
    let id = core.vault.with_vk(|vk| repo::create_target(&core.db, vk, &user, &nt))?;
    audit(&core, Some(&user), "accounts.target.create", Some("target"), Some(&id), true, None, "app");
    core.mark_index_dirty();
    repo::get_target_row(&core.db, &id)
}

#[tauri::command]
pub fn update_target(target_id: String, input: CreateTargetInput) -> Result<repo::TargetRow> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_UPDATE)?;
    let nt = input.into_new();
    if repo::is_insecure_protocol(&nt.target_type, &nt.meta.protocol) && !settings::get_bool(&core.db, "allow_insecure_protocols", false) {
        return Err(AppError::InsecureProtocolDisabled);
    }
    core.vault.with_vk(|vk| repo::update_target_meta(&core.db, vk, &user, &target_id, &nt.meta, Some(nt.display_name.as_str()), Some(nt.group_id.as_deref())))?;
    audit(&core, Some(&user), "accounts.target.update", Some("target"), Some(&target_id), true, None, "app");
    core.mark_index_dirty();
    repo::get_target_row(&core.db, &target_id)
}

#[tauri::command]
pub fn set_target_status(target_id: String, status: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_DISABLE)?;
    repo::set_target_status(&core.db, &user, &target_id, &status)?;
    audit(&core, Some(&user), "accounts.target.status", Some("target"), Some(&target_id), true, None, "app");
    core.mark_index_dirty();
    Ok(())
}

/// 删除系统：软删除目标，并连同其下未删的账号一起软删。
/// 权限沿用 accounts.delete（迁移里该权限的描述是「删除/恢复账号」，本轮起也覆盖目标删除）。
#[tauri::command]
pub fn soft_delete_target(target_id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_DELETE)?;
    repo::soft_delete_target(&core.db, &user, &target_id)?;
    audit(&core, Some(&user), "accounts.target.delete", Some("target"), Some(&target_id), true, None, "app");
    core.mark_index_dirty();
    Ok(())
}

#[tauri::command]
pub fn create_item(input: CreateItemInput) -> Result<ItemView> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_CREATE)?;
    if !repo::target_is_active(&core.db, &input.target_id)? {
        return Err(AppError::NotFound);
    }
    let it = repo::NewItem {
        target_id: input.target_id.clone(),
        account_alias: input.account_alias.clone(),
        tags: input.tags.clone(),
        favorite: false,
        payload: payload_of(&input),
        set_as_default: input.set_as_default.unwrap_or(false),
    };
    let id = core.vault.with_vk(|vk| repo::create_item(&core.db, vk, &user, &it))?;
    audit(&core, Some(&user), "accounts.item.create", Some("item"), Some(&id), true, None, "app");
    core.mark_index_dirty();
    Ok(to_view(&core, &user, repo::get_item_row(&core.db, &user, &id)?))
}

#[tauri::command]
pub fn update_item(item_id: String, input: UpdateItemInput) -> Result<ItemView> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_UPDATE)?;
    if !can_see(&core, &user, &item_id) {
        return Err(AppError::Forbidden);
    }
    core.vault.with_vk(|vk| {
        let base = repo::item_payload(vk, &core.db, &item_id)?;
        let payload = super::merge_payload(base, &input);
        repo::update_item_payload(
            &core.db,
            vk,
            &user,
            &item_id,
            &payload,
            input.account_alias.as_deref(),
            input.tags.as_deref(),
        )
    })?;
    audit(&core, Some(&user), "accounts.item.update", Some("item"), Some(&item_id), true, None, "app");
    core.mark_index_dirty();
    Ok(to_view(&core, &user, repo::get_item_row(&core.db, &user, &item_id)?))
}

#[tauri::command]
pub fn set_item_status(item_id: String, status: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_UPDATE)?;
    if !can_see(&core, &user, &item_id) {
        return Err(AppError::Forbidden);
    }
    if status != "active" && status != "disabled" {
        return Err(AppError::InvalidInput);
    }
    repo::set_item_status(&core.db, &user, &item_id, &status)?;
    audit(&core, Some(&user), "accounts.item.status", Some("item"), Some(&item_id), true, None, "app");
    core.mark_index_dirty();
    Ok(())
}

#[tauri::command]
pub fn soft_delete_item(item_id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_DELETE)?;
    if !can_see(&core, &user, &item_id) {
        return Err(AppError::Forbidden);
    }
    repo::soft_delete_item(&core.db, &user, &item_id)?;
    audit(&core, Some(&user), "accounts.item.delete", Some("item"), Some(&item_id), true, None, "app");
    core.mark_index_dirty();
    Ok(())
}

#[tauri::command]
pub fn list_deleted_items(limit: Option<i64>) -> Result<Vec<repo::DeletedItemRow>> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_DELETE)?;
    repo::list_deleted_items(&core.db, &user, limit.unwrap_or(200).clamp(1, 1000))
}

#[tauri::command]
pub fn restore_item(item_id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_DELETE)?;
    repo::restore_item(&core.db, &user, &item_id)?;
    audit(&core, Some(&user), "accounts.item.restore", Some("item"), Some(&item_id), true, None, "app");
    core.mark_index_dirty();
    Ok(())
}

#[tauri::command]
pub fn set_favorite(item_id: String, favorite: bool) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_READ)?;
    if !can_see(&core, &user, &item_id) {
        return Err(AppError::Forbidden);
    }
    repo::set_favorite(&core.db, &item_id, favorite)?;
    core.mark_index_dirty();
    Ok(())
}

/// 设为默认：只是偏好变更。后端在事务中校验归属/状态/同目标，绝不改动其它凭据内容。
#[tauri::command]
pub fn set_default_credential(target_id: String, item_id: String) -> Result<()> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_SET_DEFAULT)?;
    repo::set_default_credential(&core.db, &user, &target_id, &item_id)?;
    audit(&core, Some(&user), "accounts.default.set", Some("item"), Some(&item_id), true, None, "app");
    core.mark_index_dirty();
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretField {
    Password,
    Token,
    PrivateKey,
    Passphrase,
}

pub(crate) fn pick_field(p: &repo::CredentialPayload, f: &SecretField) -> String {
    match f {
        SecretField::Password => p.password.expose().to_string(),
        SecretField::Token => p.token.expose().to_string(),
        SecretField::PrivateKey => p.private_key.expose().to_string(),
        SecretField::Passphrase => p.passphrase.expose().to_string(),
    }
}

#[tauri::command]
pub fn reveal_secret(item_id: String, field: SecretField) -> Result<RevealedSecret> {
    let core = crate::state::core();
    let user = core.check_session()?;
    rbac::require(&core.db, &user, perm::ACC_VIEW_SECRET)?;
    if !can_see(&core, &user, &item_id) {
        return Err(AppError::Forbidden);
    }
    if settings::get_bool(&core.db, "reveal_requires_reauth", true) {
        core.require_reauth()?;
    }
    let value = core.vault.with_vk(|vk| {
        let p = repo::item_payload(vk, &core.db, &item_id)?;
        Ok::<String, AppError>(pick_field(&p, &field))
    })?;
    audit(&core, Some(&user), "accounts.secret.reveal", Some("item"), Some(&item_id), true, None, "app");
    Ok(RevealedSecret { value, visible_seconds: settings::get_i64(&core.db, "secret_visible_seconds", 15) })
}

/// 复制用户名：由 Rust 写入系统剪贴板，明文不经过前端 JS 堆。
#[tauri::command]
pub fn copy_username(item_id: String) -> Result<ActionReply> {
    let core = crate::state::core();
    let user = core.check_session()?;
    crate::quick_launcher::actions::authorize(&core.db, &core.vault, &user, crate::quick_launcher::QuickAction::CopyUsername, &item_id)?;
    let value = core.vault.with_vk(|vk| {
        let p = repo::item_payload(vk, &core.db, &item_id)?;
        Ok::<String, AppError>(p.username)
    })?;
    write_clipboard(&value)?;
    repo::touch_last_accessed(&core.db, &item_id)?;
    audit(&core, Some(&user), "accounts.copy.username", Some("item"), Some(&item_id), true, None, "app");
    Ok(ActionReply::ok("copy_username", "用户名已复制到剪贴板"))
}

/// 复制密码：独立、明确的动作；按策略要求二次认证；可选尽力而为的剪贴板清理。
#[tauri::command]
pub fn copy_password(item_id: String) -> Result<ActionReply> {
    let core = crate::state::core();
    let user = core.check_session()?;
    crate::quick_launcher::actions::authorize(&core.db, &core.vault, &user, crate::quick_launcher::QuickAction::CopyPassword, &item_id)?;
    let policy = action_policy(&core);
    if !policy.allow_copy_password {
        return Err(AppError::Forbidden);
    }
    if policy.require_reauth_for_password {
        core.require_reauth()?;
    }
    let value = core.vault.with_vk(|vk| {
        let p = repo::item_payload(vk, &core.db, &item_id)?;
        Ok::<String, AppError>(p.password.expose().to_string())
    })?;
    write_clipboard(&value)?;
    repo::touch_last_accessed(&core.db, &item_id)?;
    audit(&core, Some(&user), "accounts.copy.password", Some("item"), Some(&item_id), true, None, "app");
    let delay = settings::get_i64(&core.db, "clipboard_clear_after_seconds", 30);
    let mut reply = ActionReply::ok("copy_password", "密码已复制到剪贴板");
    if delay > 0 {
        // 把"当初写入的值"交给清理线程做一致性比对，比对通过才清空；随后立即释放本地副本
        schedule_clipboard_clear(delay, value);
        reply.clipboard_cleared_in = Some(delay);
    } else {
        drop(value);
    }
    Ok(reply)
}

pub(crate) fn write_clipboard(text: &str) -> Result<()> {
    let mut cb = arboard::Clipboard::new().map_err(|e| AppError::internal("账号命令", &e))?;
    cb.set_text(text.to_string()).map_err(|e| AppError::internal("账号命令", &e))?;
    Ok(())
}

/// 只有当前内容仍等于本应用写入的值时才清空；用户后来复制的其它内容必须原样保留。
/// 单独成函数是为了能被测试：真机剪贴板是全局状态，测试里不能依赖它。
pub(crate) fn should_clear_clipboard(current: &str, expected: &str) -> bool {
    current == expected
}

/// 尽力而为的剪贴板清理：只有当前内容仍等于本应用写入的值时才清空。
/// 系统剪贴板历史/同步/其他进程可能保留副本，不能承诺彻底清除（文档已说明该限制）。
pub(crate) fn schedule_clipboard_clear(seconds: i64, expected: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(seconds.max(1) as u64));
        if let Ok(mut cb) = arboard::Clipboard::new() {
            if let Ok(cur) = cb.get_text() {
                if should_clear_clipboard(&cur, &expected) {
                    let _ = cb.clear();
                }
            }
        }
    });
}

pub(crate) fn doc_of(core: &AppCore, item_id: &str) -> Option<SearchDoc> {
    // 尽力而为地先补建索引：这里返回的是 Option，锁定时两条路（ensure 与 with_index）
    // 都会失败并得到 None，与改动前的行为一致。
    let _ = core.ensure_index_fresh();
    core.vault.with_index(|idx| idx.get(item_id).cloned()).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::{insecure_flag, page_in_range, should_clear_clipboard, target_query, TargetFilter};
    use crate::db::repo;

    /// 验收 9.1：清理只在本应用写入的值仍在剪贴板时尝试；用户后来复制的内容不得被覆盖。
    #[test]
    fn clipboard_clear_only_touches_the_value_this_app_wrote() {
        assert!(should_clear_clipboard("Pa55w0rd!", "Pa55w0rd!"));
        assert!(!should_clear_clipboard("用户后来复制的网址", "Pa55w0rd!"));
        assert!(!should_clear_clipboard("", "Pa55w0rd!"), "剪贴板已被清空时不再写");
        assert!(!should_clear_clipboard("Pa55w0rd! ", "Pa55w0rd!"), "多一个空格就是别的内容");
    }

    fn filter(item_type: Option<&str>, group_id: Option<&str>, favorite_only: Option<bool>, keyword: Option<&str>) -> TargetFilter {
        TargetFilter {
            item_type: item_type.map(str::to_string),
            group_id: group_id.map(str::to_string),
            favorite_only,
            keyword: keyword.map(str::to_string),
            tag: None,
        }
    }

    /// 审查 F4 的回归：详情侧原先把 `meta.protocol` 同时当 `target_type` 与 `protocol` 传，
    /// 两个分支都不成立 → 徽章恒不显示。命令本体要 `state::core()`（测试进不来），
    /// 所以判定拆成 `insecure_flag` 在这里第一次被测到。
    #[test]
    fn detail_insecure_flag_pairs_target_type_with_protocol() {
        let row = |t: &str| repo::TargetRow {
            id: "t1".into(),
            target_type: t.into(),
            display_name: "D".into(),
            group_id: None,
            status: "active".into(),
            created_at: "2026-10-20T00:00:00Z".into(),
            updated_at: "2026-10-20T00:00:00Z".into(),
            credential_count: 0,
        };
        let meta = |p: &str| repo::TargetSecretPayload { protocol: p.into(), ..Default::default() };

        assert!(insecure_flag(&row("terminal"), &meta("telnet"), false), "terminal+telnet 在策略关闭时必须报出来");
        assert!(insecure_flag(&row("file_transfer"), &meta("FTP"), false), "协议大小写不该影响判定");
        assert!(!insecure_flag(&row("terminal"), &meta("ssh"), false), "加密协议不该报");
        assert!(!insecure_flag(&row("terminal"), &meta("telnet"), true), "管理员显式放行后不该再报");
        // 当年那个形状：两参同源时判定永远 false——这条断言把错位钉死在测试里。
        assert!(!insecure_flag(&row("telnet"), &meta("telnet"), false), "把协议当目标类型传一定判不出来，这正是 F4");
    }

    /// 前端标签页的 "all" 是哨兵值，绝不能当成数据库里的类型去筛（否则列表直接空）。
    #[test]
    fn all_sentinel_and_blank_group_are_not_treated_as_filter_values() {
        let f = filter(Some("all"), Some("  "), Some(true), Some("OA"));
        let q = target_query(&f, Some(20), 40);
        assert_eq!(q.item_type, None);
        assert_eq!(q.group_id, None);
        assert!(q.favorite_only, "「仅收藏」必须真的传下去");
        assert_eq!(q.keyword, Some("OA"));
        assert_eq!((q.limit, q.offset), (Some(20), 40));

        let f2 = filter(Some("web"), Some("g1"), None, None);
        let real = target_query(&f2, None, 0);
        assert_eq!(real.item_type, Some("web"));
        assert_eq!(real.group_id, Some("g1"));
        assert!(!real.favorite_only, "缺省即不按收藏筛");
        assert_eq!(real.limit, None, "全量查询不带 LIMIT");
    }

    /// 标签是需求 §2.2 明确要的筛选入口：前端传来的 `tag` 必须落到查询条件里，空白值不算条件。
    #[test]
    fn tag_arriving_from_frontend_reaches_the_query_and_blank_is_no_filter() {
        let f: TargetFilter = serde_json::from_str(r#"{"itemType":"web","tag":"生产"}"#).unwrap();
        let q = target_query(&f, Some(20), 0);
        assert_eq!(q.tag, Some("生产"), "前端发了 tag 后端却不读，就等于又做一个死控件");

        let blank: TargetFilter = serde_json::from_str(r#"{"tag":"   "}"#).unwrap();
        assert_eq!(target_query(&blank, None, 0).tag, None, "空白标签不是筛选条件");

        // 老前端只发四个键也必须能反序列化（新增字段不能破坏兼容）
        let legacy: TargetFilter =
            serde_json::from_str(r#"{"itemType":"all","keyword":"OA","groupId":null,"favoriteOnly":true}"#).unwrap();
        assert_eq!(legacy.tag, None);
        assert!(legacy.favorite_only.unwrap_or(false));
    }

    #[test]
    fn page_bounds_are_validated_before_touching_the_database() {
        assert!(page_in_range(1, 20));
        assert!(page_in_range(500, 200), "最后一页不论多大都要能取到");
        assert!(!page_in_range(0, 20), "页码从 1 起算");
        assert!(!page_in_range(-1, 20));
        assert!(!page_in_range(1, 0), "一页 0 条没有意义");
        assert!(!page_in_range(1, 201), "页大小上限 200：否则分页只是摆设");
    }
}
