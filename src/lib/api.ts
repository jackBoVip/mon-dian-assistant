import { invoke } from '@tauri-apps/api/core';
import type {
  ActionReply,
  AppErrorShape,
  AppStatus,
  AppUserSummary,
  AuditRow,
  BackupInfo,
  BootFailureStatus,
  ContainerCommitOpts,
  ContainerPreview,
  CreateItemInput,
  UpdateItemPatch,
  CreateTargetInput,
  DeletedItemRow,
  DeviceKeyConsentStatus,
  ExportCommitOpts,
  ExportOpts,
  ExportPreview,
  ExportResult,
  ExtensionChannelStatus,
  ExternalTool,
  ToolKind,
  ExtensionHostInstallResult,
  ExtensionHostStatus,
  ExtensionHostUninstallResult,
  GroupRow,
  HtmlPageRecord,
  HtmlPageSummary,
  ImportCommitResult,
  ImportPreview,
  ImportTemplate,
  ItemDetail,
  ItemView,
  KeystoreDiagnostics,
  LanStatus,
  LauncherPreferences,
  LauncherShortcutStatus,
  LoginProfile,
  MenuNode,
  NoteAsset,
  NoteDetail,
  NoteImportResult,
  NoteRecord,
  NoteSummary,
  PasswordAssessment,
  PagedTargets,
  PermissionRow,
  QuickAction,
  QuickSource,
  RecentAccessRow,
  RevealedSecret,
  RoleAdminSummary,
  RoleSummary,
  SearchReply,
  SecretField,
  SecurityStatus,
  TaskBinding,
  TaskDefinition,
  TaskEnv,
  TaskLogRow,
  TaskParsedNotes,
  TaskProbeReport,
  TaskProfileView,
  TaskRun,
  TaskRunDetail,
  TaskRunListItem,
  TaskSessionStatus,
  SettingTuple,
  SystemInfo,
  TargetDetail,
  TargetFilter,
  TargetRow,
  ThemeStyle,
  ThemeView,
  CustomTheme,
  UpdateInfo,
  VaultStats,
  WindowChrome,
  QuizAssistantPreferences,
  QuizAssistantPreferencesInput,
  QuizAssistantStatus,
  QuizBulkEdit,
  QuizImportJob,
  QuizImportJobDetail,
  QuizImportRowPatch,
  QuizImportRowUpdated,
  QuizImportTemplate,
  QuizLibraryRow,
  QuizLookup,
  QuizMatchHit,
  QuizOcrStatus,
  QuizQuestionPage,
  QuizScreenPermissionStatus,
} from './types';

/** 前端到 Rust 的唯一入口。前端不拼接 SQL、不持有密钥、不自行判定权限。 */
export class ApiError extends Error {
  code: string;
  detail?: string;

  constructor(shape: AppErrorShape) {
    super(shape.message);
    this.name = 'ApiError';
    this.code = shape.code;
    this.detail = shape.detail;
  }
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new ApiError({
      code: 'NOT_TAURI',
      message: '当前页面未运行在 Tauri 桌面环境中，后端能力不可用。',
      detail: '请使用 npm run tauri:dev 启动桌面应用；浏览器预览不会伪造任何数据。',
    });
  }
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    const shape = normaliseError(raw);
    throw new ApiError(shape);
  }
}

function normaliseError(raw: unknown): AppErrorShape {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return { code: o.code, message: o.message, detail: typeof o.detail === 'string' ? o.detail : undefined };
    }
  }
  return { code: 'UNKNOWN', message: '发生未预期的错误，请查看应用日志中的错误码。' };
}

/**
 * 命令包装约定：
 *  - JS 侧参数键一律 camelCase（Tauri v2 映射到 Rust snake_case 形参）；
 *  - Rust 形参 `app: tauri::AppHandle` 由 Tauri 注入，JS 不发送；
 *  - 带 deny_unknown_fields 的输入结构（TargetFilter/CreateTargetInput/CreateItemInput）
 *    只发送类型里声明的键，多发的键是硬运行时错误。
 */
export const api = {
  // —— 保险库生命周期与本软件使用者（vault）——
  status: () => call<AppStatus>('vault_status'),
  initialize: (nickname: string, password: string) => call<AppStatus>('vault_initialize', { nickname, password }),
  passwordStrength: (password: string) => call<PasswordAssessment>('password_strength', { password }),
  loginProfile: () => call<LoginProfile>('login_profile'),
  unlock: (appUserId: string, password: string) => call<AppStatus>('vault_unlock', { appUserId, password }),
  lock: () => call<void>('vault_lock'),
  reauthenticate: (password: string) => call<void>('reauthenticate', { password }),
  changeMasterPassword: (current: string, next: string) => call<AppStatus>('change_master_password', { current, next }),
  /** 改自己的昵称（个人信息页）：后端回新的 AppStatus，顶栏头像与下拉名字随之换。 */
  updateOwnNickname: (nickname: string) => call<AppStatus>('update_own_nickname', { nickname }),
  listUsers: () => call<AppUserSummary[]>('list_app_users'),
  listRoles: () => call<RoleSummary[]>('list_roles'),
  createUser: (nickname: string, initialPassword: string, roleKey: string) =>
    call<AppUserSummary>('create_app_user', { nickname, initialPassword, roleKey }),
  setUserStatus: (targetUserId: string, status: 'active' | 'disabled') =>
    call<void>('set_user_status', { targetUserId, status }),
  adminResetPassword: (targetUserId: string, newPassword: string) =>
    call<void>('admin_reset_password', { targetUserId, newPassword }),
  // —— RBAC 管理 ——
  myPermissions: () => call<string[]>('my_permissions'),
  listPermissions: () => call<PermissionRow[]>('list_permissions'),
  listRolesAdmin: () => call<RoleAdminSummary[]>('list_roles_admin'),
  // —— 菜单节点（导航结构；启停只需系统角色管理权限、不再二次认证，见 commands/menus.rs） ——
  // 改名 / 排序 / 删除三条命令后端仍在（`rename_menu_node` 等），但菜单管理页本轮按交付方要求
  // 撤掉了「操作」列，前端不再暴露入口——留在这里就是一段永远不会被调用的死码。
  listMenuNodes: () => call<MenuNode[]>('list_menu_nodes'),
  createMenuNode: (label: string, pageKey: string) =>
    call<string>('create_menu_node', { label, pageKey }),
  setMenuNodeStatus: (id: string, status: 'active' | 'disabled') =>
    call<void>('set_menu_node_status', { id, status }),
  createRole: (code: string, name: string, description: string) =>
    call<string>('create_role', { code, name, description }),
  updateRole: (roleId: string, name: string, description: string, status: 'active' | 'disabled') =>
    call<void>('update_role', { roleId, name, description, status }),
  deleteRole: (roleId: string) => call<void>('delete_role', { roleId }),
  setRoleActionPermissions: (roleId: string, permissionKeys: string[]) =>
    call<void>('set_role_action_permissions', { roleId, permissionKeys }),
  setRoleMenuPermissions: (roleId: string, permissionKeys: string[]) =>
    call<void>('set_role_menu_permissions', { roleId, permissionKeys }),
  setUserRoles: (targetUserId: string, roleCodes: string[]) =>
    call<void>('set_user_roles', { targetUserId, roleCodes }),
  keystoreDiagnostics: () => call<KeystoreDiagnostics>('keystore_diagnostics'),
  // 启动装配失败状态：界面第一条就问它，问到失败就不再碰任何读库命令
  bootFailureStatus: () => call<BootFailureStatus>('boot_failure_status'),
  // 数据库主密钥的本机文件降级闸门：在保险库装配之前也必须可用（Rust 侧走 try_core/待确认状态）
  deviceKeyConsentStatus: () => call<DeviceKeyConsentStatus>('device_key_consent_status'),
  grantDeviceKeyFallback: () => call<void>('grant_device_key_fallback'),
  declineDeviceKeyAndExit: () => call<void>('decline_and_exit'),

  // —— 账号管理（外部系统账号台账）——
  stats: () => call<VaultStats>('vault_stats'),
  listTargets: (filter?: TargetFilter) => call<TargetRow[]>('list_targets', { filter }),
  // 台账列表走后端分页（需求：≥10000 条时不得把整表塞进 DOM）；listTargets 仅供导出等全量场景
  listTargetsPaged: (filter: TargetFilter, page: number, pageSize: number) =>
    call<PagedTargets>('list_targets_paged', { filter, page, pageSize }),
  listGroups: () => call<GroupRow[]>('list_groups'),
  // 标签下拉与「最近访问」入口（需求 §2.2 台账首页要求）
  listItemTags: () => call<string[]>('list_item_tags'),
  recentAccess: (limit?: number) => call<RecentAccessRow[]>('recent_access', { limit }),
  createGroup: (name: string, parentId?: string | null) => call<string>('create_group', { name, parentId }),
  targetItems: (targetId: string) => call<ItemView[]>('target_items', { targetId }),
  targetDetail: (targetId: string) => call<TargetDetail>('target_detail', { targetId }),
  // 单条凭据的非秘密明细：编辑对话框的初值与补丁基准（读不到时对用户名保持 null，绝不编造）
  itemDetail: (itemId: string) => call<ItemDetail>('item_detail', { itemId }),
  similarTargets: (address: string) => call<TargetRow[]>('find_similar_targets', { address }),
  createTarget: (input: CreateTargetInput) => call<TargetRow>('create_target', { input }),
  updateTarget: (targetId: string, input: CreateTargetInput) => call<TargetRow>('update_target', { targetId, input }),
  setTargetStatus: (targetId: string, status: 'active' | 'disabled') => call<void>('set_target_status', { targetId, status }),
  // 软删除系统：后端在同一条事务里把该系统下的账号一起软删
  deleteTarget: (targetId: string) => call<void>('soft_delete_target', { targetId }),
  createItem: (input: CreateItemInput) => call<ItemView>('create_item', { input }),
  // 只发改动过的键：缺省=后端保留原值，显式空串=清空该字段（见 UpdateItemPatch 与 lib/itemPatch）
  updateItem: (itemId: string, patch: UpdateItemPatch) => call<ItemView>('update_item', { itemId, input: patch }),
  setItemStatus: (itemId: string, status: 'active' | 'disabled') => call<void>('set_item_status', { itemId, status }),
  deleteItem: (itemId: string) => call<void>('soft_delete_item', { itemId }),
  // 回收站：limit 为 Rust Option<i64>，省略即由后端取默认 200（上限 1000）；与 restore_item 同样要求 accounts.delete 权限
  listDeletedItems: (limit?: number) => call<DeletedItemRow[]>('list_deleted_items', { limit }),
  restoreItem: (itemId: string) => call<void>('restore_item', { itemId }),
  setFavorite: (itemId: string, favorite: boolean) => call<void>('set_favorite', { itemId, favorite }),
  setDefaultCredential: (targetId: string, itemId: string) => call<void>('set_default_credential', { targetId, itemId }),
  revealSecret: (itemId: string, field: SecretField) => call<RevealedSecret>('reveal_secret', { itemId, field }),
  copyUsername: (itemId: string) => call<ActionReply>('copy_username', { itemId }),
  copyPassword: (itemId: string) => call<ActionReply>('copy_password', { itemId }),

  // —— 打开 / 填充 / 按配置的工具有跳转 ——
  openTarget: (targetId: string) => call<ActionReply>('open_target', { targetId }),
  openAndFill: (targetId: string, credentialId?: string) => call<ActionReply>('open_and_fill', { targetId, credentialId }),
  connectTarget: (itemId: string) => call<ActionReply>('connect_target', { itemId }),

  // —— 外部工具档 ——
  externalTools: () => call<ExternalTool[]>('list_external_tools'),
  setExternalTool: (kind: ToolKind, appPath: string) => call<ExternalTool>('set_external_tool', { kind, appPath }),
  upsertDatabaseTool: (id: string | null, engine: string, label: string, appPath: string) =>
    call<ExternalTool>('upsert_database_tool', { id, engine, label, appPath }),
  deleteExternalTool: (id: string) => call<void>('delete_external_tool', { id }),

  // —— 全局快捷启动器 ——
  quickSearch: (query: string) => call<SearchReply>('quick_search', { query }),
  quickAction: (action: QuickAction, itemId: string, targetId: string, credentialId?: string) =>
    call<ActionReply>('quick_action', { action, itemId, targetId, credentialId }),
  /**
   * 浮层里非账号那四类的 Enter：把这一条落到主窗对应页面。
   * 只交回来源与一个 id——题在哪份库、第几序号由后端现查，权限也在那一侧重判一遍。
   * 账号那一类不在这里，它的动作集仍走 `quickAction`。
   */
  quickReveal: (source: QuickSource, id: string, env?: TaskEnv) =>
    call<ActionReply>('quick_reveal', { source, id, env: env ?? null }),
  launcherVisibility: (visible: boolean) => call<void>('launcher_visibility', { visible }),
  launcherPreferences: () => call<LauncherPreferences>('launcher_preferences'),
  setLauncherShortcut: (accelerator: string) => call<LauncherShortcutStatus>('set_launcher_shortcut', { accelerator }),
  setLauncherEnabled: (enabled: boolean) => call<LauncherShortcutStatus>('set_launcher_enabled', { enabled }),

  // —— 系统管理 ——
  /** 窗口形态查询：免会话可用（锁屏页与启动失败页也要知道该不该画窗口按钮）。 */
  windowChrome: () => call<WindowChrome>('window_chrome'),
  settings: () => call<SettingTuple[]>('get_settings'),
  updateSetting: (key: string, value: string) => call<void>('update_setting', { key, value }),
  theme: () => call<ThemeView>('get_theme'),
  setTheme: (style: ThemeStyle) => call<void>('set_theme', { style }),
  setReduceMotion: (enabled: boolean) => call<void>('set_reduce_motion', { enabled }),
  customThemes: () => call<CustomTheme[]>('list_custom_themes'),
  addCustomTheme: (id: string, name: string, tokens: string) => call<void>('add_custom_theme', { id, name, tokens }),
  deleteCustomTheme: (id: string) => call<void>('delete_custom_theme', { id }),
  securityStatus: () => call<SecurityStatus>('security_status'),
  audit: (limit: number) => call<AuditRow[]>('list_audit_events', { limit }),
  systemInfo: () => call<SystemInfo>('system_info'),
  extensionChannelStatus: () => call<ExtensionChannelStatus>('extension_channel_status'),

  // —— 备份 / 恢复 ——
  createBackup: () => call<BackupInfo>('create_backup'),
  listBackups: () => call<BackupInfo[]>('list_backups'),
  verifyBackup: (id: string) => call<BackupInfo>('verify_backup', { id }),
  restoreBackup: (id: string, confirmed: boolean) => call<void>('restore_backup', { id, confirmed }),

  // —— 批量导入导出 ——
  importTemplate: () => call<ImportTemplate>('import_template'),
  importPreview: (path: string) => call<ImportPreview>('import_preview', { path }),
  importCommit: (jobId: string, conflictPolicy: 'skip' | 'update' | 'abort', defaults?: Record<string, string>) =>
    call<ImportCommitResult>('import_commit', { jobId, conflictPolicy, defaults }),
  exportPreview: (opts: ExportOpts) => call<ExportPreview>('export_preview', { opts }),
  exportCommit: (opts: ExportCommitOpts) => call<ExportResult>('export_commit', { opts }),
  /** 口令加密容器的读取侧：口令只用于本机派生密钥，前端不留存、不进日志。 */
  containerPreview: (path: string, passphrase: string) =>
    call<ContainerPreview>('container_preview', { path, passphrase }),
  containerCommit: (opts: ContainerCommitOpts) => call<ImportCommitResult>('container_commit', { opts }),

  // —— 更新 ——
  checkUpdate: () => call<UpdateInfo>('check_update'),
  downloadUpdate: () => call<UpdateInfo>('download_update'),
  installUpdate: () => call<UpdateInfo>('install_update'),

  // —— 局域网更新通道 ——
  /** 发现状态与源列表；轮询调用，不携带任何秘密 */
  lanStatus: () => call<LanStatus>('lan_status'),
  /** 开关本机托管；dir 为空时后端拒绝开启（没有托管目录就没有可服务的包） */
  lanSetServe: (enabled: boolean, dir?: string) =>
    call<LanStatus>('lan_set_serve', { enabled, dir: dir ?? null }),
  /** 从指定源（实例号或手填 IP:端口）或最优发现源拉清单并验签 */
  lanCheck: (source?: string) => call<UpdateInfo>('lan_check', { source: source ?? null }),
  /** 按上一次 lan_check 的清单从局域网取包；阶段与 HTTPS 下载一致 */
  lanDownload: () => call<UpdateInfo>('lan_download'),

  // —— 浏览器扩展宿主清单 ——
  extensionHostStatus: () => call<ExtensionHostStatus>('extension_host_status'),
  extensionHostInstall: () => call<ExtensionHostInstallResult>('extension_host_install'),
  extensionHostUninstall: () => call<ExtensionHostUninstallResult>('extension_host_uninstall'),

  // —— 题库与导入任务 ——
  // 读题库只要求 quiz.library.read；重命名/删除/重建索引要 quiz.library.manage，
  // 解析/复核/发布要 quiz.library.import——前端只按权限裁剪入口，真正的拒绝在 Rust。
  quizLibraries: () => call<QuizLibraryRow[]>('quiz_list_libraries'),
  quizLibraryQuestions: (libraryId: string, offset: number, limit: number) =>
    call<QuizQuestionPage>('quiz_library_questions', { libraryId, offset, limit }),
  quizRenameLibrary: (id: string, name: string) => call<QuizLibraryRow>('quiz_rename_library', { id, name }),
  quizDeleteLibrary: (id: string) => call<void>('quiz_delete_library', { id }),
  /** 重建 FTS 索引，返回重建后的题目总数。 */
  quizReindex: () => call<number>('quiz_reindex'),
  /** 读文件与解析在 Rust 的阻塞线程里跑；只回任务摘要，复核表按页另取。 */
  quizImportParse: (path: string) => call<QuizImportJob>('quiz_import_parse', { path }),
  quizImportJob: (jobId: string, offset: number, limit: number, onlyIssues: boolean) =>
    call<QuizImportJobDetail>('quiz_import_job', { jobId, offset, limit, onlyIssues }),
  quizImportUpdateRow: (jobId: string, rowId: string, patch: QuizImportRowPatch) =>
    call<QuizImportRowUpdated>('quiz_import_update_row', { jobId, rowId, patch }),
  quizImportBulkUpdate: (jobId: string, edit: QuizBulkEdit) =>
    call<QuizImportJob>('quiz_import_bulk_update', { jobId, edit }),
  quizImportPublish: (jobId: string, libraryName?: string | null) =>
    call<QuizLibraryRow>('quiz_import_publish', { jobId, libraryName: libraryName ?? null }),
  quizImportDiscard: (jobId: string) => call<void>('quiz_import_discard', { jobId }),
  /** 导入模板：静态示例 CSV，内容由解析层 `grid::template_csv()` 给出并被同一套测试读回。 */
  quizImportTemplate: () => call<QuizImportTemplate>('quiz_import_template'),
  /** 手动识别：`libraryIds` 省略/null = 在全部题库里查；空数组会被后端按「范围为空」拒绝。 */
  quizMatchText: (text: string, libraryIds?: string[] | null) =>
    call<QuizMatchHit[]>('quiz_match_text', { text, libraryIds: libraryIds ?? null }),
  quizLookupAtCursor: (libraryIds?: string[] | null) =>
    call<QuizLookup>('quiz_lookup_at_cursor', { libraryIds: libraryIds ?? null }),
  quizOcrStatus: () => call<QuizOcrStatus>('quiz_ocr_status'),
  quizScreenPermission: () => call<QuizScreenPermissionStatus>('quiz_screen_permission'),
  quizRequestScreenPermission: () => call<QuizScreenPermissionStatus>('quiz_request_screen_permission'),
  /** 助手的运行状态与已保存设置。起停、改配置之后都要重问一次。 */
  quizAssistantStatus: () => call<QuizAssistantStatus>('quiz_assistant_status'),
  quizAssistantSetPreferences: (input: QuizAssistantPreferencesInput) =>
    call<QuizAssistantPreferences>('quiz_assistant_set_preferences', { input }),
  quizAssistantStart: () => call<QuizAssistantStatus>('quiz_assistant_start'),
  quizAssistantStop: () => call<QuizAssistantStatus>('quiz_assistant_stop'),

  // —— 笔记 ——
  // 读只需 notes.read；新建/改/删/插图/导入要 notes.write。
  // 自动保存走 notes_update，后端刻意不写审计——写进台账会被自己的保存动作淹掉。
  notesList: (q?: string | null) => call<NoteSummary[]>('notes_list', { q: q ?? null }),
  /** 一次带回正文与该笔记的全部素材 data URL，编辑器渲染图片不再逐张发 IPC。 */
  notesGet: (id: string) => call<NoteDetail>('notes_get', { id }),
  notesCreate: () => call<NoteDetail>('notes_create'),
  notesUpdate: (id: string, title: string, html: string) =>
    call<NoteRecord>('notes_update', { id, title, html }),
  notesDelete: (id: string) => call<void>('notes_delete', { id }),
  /** 图片类型由后端按魔数嗅探，前端传的扩展名与 mime 都不作数。 */
  noteUploadAssetFromPath: (noteId: string, path: string) =>
    call<NoteAsset>('note_upload_asset_from_path', { noteId, path }),
  /** 剪贴板粘贴：base64 可以是裸串，也可以是 `data:image/…;base64,` 整条 data URL。 */
  noteUploadAssetBytes: (noteId: string, dataB64: string) =>
    call<NoteAsset>('note_upload_asset_bytes', { noteId, dataB64 }),
  notesReadTextFile: (path: string) => call<string>('notes_read_text_file', { path }),
  notesExportMarkdown: (path: string, markdown: string) =>
    call<void>('notes_export_markdown', { path, markdown }),
  /** 只导当前使用者自己的笔记；换账号导不到别人的内容。 */
  notesExportZip: (path: string) => call<void>('notes_export_zip', { path }),
  notesImportZip: (path: string) => call<NoteImportResult>('notes_import_zip', { path }),

  // —— 页面库 ——
  // 读与预览走 html.page.read；新建/改/删各要一枚写权限。
  // 预览地址由后端拼：回环端口与令牌只存在于 Rust 侧，前端拿到的是一条完整 URL。
  htmlPageList: () => call<HtmlPageSummary[]>('html_page_list'),
  htmlPageGet: (id: string) => call<HtmlPageRecord>('html_page_get', { id }),
  htmlPageCreate: (title: string, html: string) => call<HtmlPageRecord>('html_page_create', { title, html }),
  htmlPageUpdate: (id: string, title: string, html: string) =>
    call<HtmlPageRecord>('html_page_update', { id, title, html }),
  htmlPageDelete: (id: string) => call<void>('html_page_delete', { id }),
  htmlPagePreviewUrl: (id: string) => call<string>('html_page_preview_url', { id }),
  /** 在独立无 capability 的窗口里打开：脚本可执行、可联网，但调不到本应用任何命令。 */
  htmlPagePreviewOpen: (id: string) => call<void>('html_page_preview_open', { id }),
  /**
   * 右栏嵌入块：位置尺寸是占位块的 CSS 像素（= 逻辑像素），原生层不猜布局。
   * 内容同样来自回环服务，是 remote origin；跑得了脚本，但拿不到本应用任何命令。
   */
  // version 传选中页的 updatedAt：同版本重放（窗口重新获得焦点）只摆位置，不重新加载。
  htmlPageEmbedOpen: (id: string, version: string, x: number, y: number, width: number, height: number) =>
    call<void>('html_page_embed_open', { id, version, x, y, width, height }),
  htmlPageEmbedSync: (x: number, y: number, width: number, height: number) =>
    call<void>('html_page_embed_sync', { x, y, width, height }),
  htmlPageEmbedVisible: (visible: boolean) => call<void>('html_page_embed_visible', { visible }),
  htmlPageEmbedClose: () => call<void>('html_page_embed_close'),

  // —— 任务中心 ——
  // 看走 task.release.view；配置环境走 task.release.configure；
  // 发测试要 task.release.run，发生产另要 task.release.run_prod（后端按**运行自己记的环境**判，
  // 不看前端传来的环境串），所以这里的参数只是"要哪一档"，权限判定全在 Rust 侧。
  taskDefinitions: () => call<TaskDefinition[]>('task_definitions'),
  taskProfileGet: (taskKey: string, env: TaskEnv) => call<TaskProfileView>('task_profile_get', { taskKey, env }),
  /** 存前就在后端解析并校验过一遍：返回的是被规整后的那份 JSON，界面直接用它刷新显示。 */
  taskProfileUpdate: (taskKey: string, env: TaskEnv, profileJson: string) =>
    call<TaskProfileView>('task_profile_update', { taskKey, env, profileJson }),
  taskBindingGet: (taskKey: string, env: TaskEnv) => call<TaskBinding | null>('task_binding_get', { taskKey, env }),
  /** 只绑保险库里的凭据 id：这条链路上没有任何口令出入口。 */
  taskBindingUpdate: (taskKey: string, env: TaskEnv, loginUrl: string, credentialItemId: string) =>
    call<TaskBinding>('task_binding_update', { taskKey, env, loginUrl, credentialItemId }),
  taskBindingDelete: (taskKey: string, env: TaskEnv) => call<void>('task_binding_delete', { taskKey, env }),
  taskSessionStatus: (taskKey: string, env: TaskEnv) => call<TaskSessionStatus>('task_session_status', { taskKey, env }),
  /** 隐藏 WebView 静默登录：用户不打开浏览器、不做任何操作。force=true 是"会话失效，重来一次"。 */
  taskSessionLogin: (taskKey: string, env: TaskEnv, force: boolean) =>
    call<TaskSessionStatus>('task_session_login', { taskKey, env, force }),
  /** 现场取证：登录走到哪一步、拿到哪几枚 Cookie 名、接口那一发是什么分类。没有值。 */
  taskProbeLogin: (taskKey: string, env: TaskEnv, probeService?: string | null) =>
    call<TaskProbeReport>('task_probe_login', { taskKey, env, probeService: probeService ?? null }),
  /** 读发布说明（.docx）：只把表格变成待发行，不碰线上。 */
  taskReleaseParse: (path: string) => call<TaskParsedNotes>('task_release_parse', { path }),
  taskRunCreate: (taskKey: string, env: TaskEnv, items: { itemKey: string; displayName?: string | null; desiredTag?: string | null }[]) =>
    call<TaskRun>('task_run_create', { taskKey, env, items }),
  taskRunPrepare: (runId: string) => call<TaskRun>('task_run_prepare', { runId }),
  taskRunPublish: (runId: string) => call<TaskRun>('task_run_publish', { runId }),
  taskRunCancel: (runId: string) => call<TaskRun>('task_run_cancel', { runId }),
  /** 重试只把失败项放回待读取；发布仍然是人的那一下。 */
  taskRunRetry: (runId: string) => call<TaskRun>('task_run_retry', { runId }),
  taskRunGet: (runId: string) => call<TaskRunDetail>('task_run_get', { runId }),
  taskRunList: (taskKey: string, env: TaskEnv, limit?: number) =>
    call<TaskRunListItem[]>('task_run_list', { taskKey, env, limit: limit ?? null }),
  taskRunLogs: (runId: string, afterSeq?: number, limit?: number) =>
    call<TaskLogRow[]>('task_run_logs', { runId, afterSeq: afterSeq ?? null, limit: limit ?? null }),
};

export { isTauri };
