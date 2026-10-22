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
  ExtensionHostInstallResult,
  ExtensionHostStatus,
  ExtensionHostUninstallResult,
  GroupRow,
  ImportCommitResult,
  ImportPreview,
  ImportTemplate,
  ItemDetail,
  ItemView,
  KeystoreDiagnostics,
  LauncherPreferences,
  LauncherShortcutStatus,
  LoginProfile,
  MenuNode,
  PasswordAssessment,
  PagedTargets,
  PermissionRow,
  QuickAction,
  RecentAccessRow,
  RevealedSecret,
  RoleAdminSummary,
  RoleSummary,
  SearchReply,
  SecretField,
  SecurityStatus,
  SettingTuple,
  SystemInfo,
  TargetDetail,
  TargetFilter,
  TargetRow,
  ThemeStyle,
  ThemeView,
  UpdateInfo,
  VaultStats,
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

  // —— 打开 / 填充 / 终端连接 ——
  openTarget: (targetId: string) => call<ActionReply>('open_target', { targetId }),
  openAndFill: (targetId: string, credentialId?: string) => call<ActionReply>('open_and_fill', { targetId, credentialId }),
  connectTerminal: (itemId: string) => call<ActionReply>('connect_terminal', { itemId }),

  // —— 全局快捷启动器 ——
  quickSearch: (query: string) => call<SearchReply>('quick_search', { query }),
  quickAction: (action: QuickAction, itemId: string, targetId: string, credentialId?: string) =>
    call<ActionReply>('quick_action', { action, itemId, targetId, credentialId }),
  launcherVisibility: (visible: boolean) => call<void>('launcher_visibility', { visible }),
  launcherPreferences: () => call<LauncherPreferences>('launcher_preferences'),
  setLauncherShortcut: (accelerator: string) => call<LauncherShortcutStatus>('set_launcher_shortcut', { accelerator }),
  setLauncherEnabled: (enabled: boolean) => call<LauncherShortcutStatus>('set_launcher_enabled', { enabled }),

  // —— 系统管理 ——
  settings: () => call<SettingTuple[]>('get_settings'),
  updateSetting: (key: string, value: string) => call<void>('update_setting', { key, value }),
  theme: () => call<ThemeView>('get_theme'),
  setTheme: (style: ThemeStyle) => call<void>('set_theme', { style }),
  setReduceMotion: (enabled: boolean) => call<void>('set_reduce_motion', { enabled }),
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

  // —— 浏览器扩展宿主清单 ——
  extensionHostStatus: () => call<ExtensionHostStatus>('extension_host_status'),
  extensionHostInstall: () => call<ExtensionHostInstallResult>('extension_host_install'),
  extensionHostUninstall: () => call<ExtensionHostUninstallResult>('extension_host_uninstall'),
};

export { isTauri };
