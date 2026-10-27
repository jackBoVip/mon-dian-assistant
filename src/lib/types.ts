/**
 * 与 Rust 后端命令一一对应的类型（唯一事实来源：src-tauri/ 下的 Serialize/Deserialize 结构）。
 * 术语严格区分：
 *  - AppUser  = 本软件使用者（解锁保险库的人）
 *  - VaultTarget / VaultItem = 外部系统的目标地址 / 该目标下的一条外部系统账号凭据
 *  - 主密码 = 本软件使用者的解锁密码，绝不出现在台账类型里
 * 前端类型中永不出现秘密明文字段的默认值；明文只在显式 reveal_secret 后按后端返回的 visibleSeconds 短暂存在。
 */

import type { PageKey } from './pageMeta'

// —— 目标类型（与 repo::ALL_TYPES 对齐；后端字段是 String，未知值必须可呈现） ——
export const KNOWN_TARGET_TYPES = [
  'web',
  'terminal',
  'database',
  'network_device',
  'cloud_service',
  'file_transfer',
  'application',
  'generic_secret',
] as const

export type KnownTargetType = (typeof KNOWN_TARGET_TYPES)[number]

/** 后端 target_type/item_type 为自由字符串；界面按已知类型上色，未知类型回退展示原文，绝不丢弃行。 */
export type TargetType = KnownTargetType | (string & {})

export const TARGET_TYPE_LABELS: Record<KnownTargetType, string> = {
  web: '网页',
  terminal: '终端',
  database: '数据库',
  network_device: '网络设备',
  cloud_service: '云平台',
  file_transfer: '文件传输',
  application: '应用账号',
  generic_secret: '其他秘密',
}

export function targetTypeLabel(t: string): string {
  return TARGET_TYPE_LABELS[t as KnownTargetType] ?? t
}

export const TYPE_FILTERS: Array<{ key: 'all' | KnownTargetType; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'web', label: '网页' },
  { key: 'terminal', label: '终端' },
  { key: 'database', label: '数据库' },
  { key: 'network_device', label: '网络设备' },
  { key: 'cloud_service', label: '云平台' },
  { key: 'file_transfer', label: '文件传输' },
  { key: 'application', label: '应用账号' },
  { key: 'generic_secret', label: '其他' },
]

// —— 主题（内置四套与 Rust settings::THEME_STYLES 字面量完全一致；S 轮起只有原型那四套） ——
// 明暗身份由主题本身携带，不再有 AppearanceMode 轴，也没有玻璃强度滑杆。
// 0012 起还有一类**自定义档**：`custom-<id>`，令牌表存在 custom_themes 里、运行时注入成
// [data-theme="custom-<id>"] 一条规则。它们不在这份标签表里（那是编译期的四套），名字随用户起。
export type BuiltinThemeStyle = 'glass' | 'minimal' | 'obsidian' | 'cyber'
export type ThemeStyle = BuiltinThemeStyle | `custom-${string}`

export const CUSTOM_THEME_PREFIX = 'custom-'

export const BUILTIN_THEME_LABELS: Record<BuiltinThemeStyle, string> = {
  glass: '极光液态',
  minimal: '极简纯白',
  obsidian: '曜石暗夜',
  cyber: '赛博霓虹',
}

export function isBuiltinThemeStyle(v: string): v is BuiltinThemeStyle {
  return v in BUILTIN_THEME_LABELS
}

/** 后端返回的一档主题：id 是表主键（不含 custom- 前缀），tokens 是已校验的 JSON 对象串。 */
export interface CustomTheme {
  id: string
  name: string
  tokens: string
}

export function customThemeStyle(id: string): ThemeStyle {
  return `${CUSTOM_THEME_PREFIX}${id}` as ThemeStyle
}

export function customThemeId(style: string): string | null {
  return style.startsWith(CUSTOM_THEME_PREFIX) ? style.slice(CUSTOM_THEME_PREFIX.length) : null
}

// —— 错误形状（AppError 序列化：code/message/detail；前端本地错误可能不带 detail） ——
export interface AppErrorShape {
  code: string
  message: string
  detail?: string
}

// —— vault 命令 ——

/** commands::mod::AppStatus（vault_status / vault_initialize / vault_unlock / change_master_password 返回） */
export interface AppStatus {
  initialized: boolean
  unlocked: boolean
  userCount: number
  appUserId: string | null
  nickname: string | null
  schemaVersion: number
  appVersion: string
  platform: string
  arch: string
}

/** commands::mod::LockoutInfo */
export interface LockoutInfo {
  locked: boolean
  failedCount: number
  secondsRemaining: number
  attemptsRemaining: number
}

/** commands::mod::LoginProfileUser（登录选择器用的精简信息） */
export interface LoginProfileUser {
  id: string
  nickname: string
  internalCode: string
}

/** commands::mod::LoginProfile（login_profile 返回；注意 users 是精简的 LoginProfileUser，不是 AppUserSummary）
 * L 轮起不再有 passwordPolicy 字段：主密码没有任何强度要求，解锁页那条"策略提示"显示的是不会生效的值。 */
export interface LoginProfile {
  initialized: boolean
  singleUser: boolean
  users: LoginProfileUser[]
  /** 只针对被选中/首个使用者展示锁定状态 */
  lockout: LockoutInfo | null
}

/** commands::mod::PasswordAssessmentView（password_strength 返回） */
export interface PasswordAssessment {
  acceptable: boolean
  score: number
  lengthOk: boolean
  hasClassVariation: boolean
  notCommon: boolean
  hint: string
}

/** auth::users::AppUserSummary（list_app_users / create_app_user 返回） */
export interface AppUserSummary {
  id: string
  nickname: string
  status: string
  roles: string[]
  lastLoginAt: string | null
  createdAt: string
  /** 内部标识仅供系统管理页展示，任何登录/解锁流程都不要求用户输入它 */
  generatedAccountCode: string
}

/** commands::vault::RoleSummary（list_roles 返回） */
export interface RoleSummary {
  code: string
  name: string
  description: string
  builtin: boolean
  /** active / disabled；停用角色不授予任何权限 */
  status: string
}

/** commands::rbac::RoleAdminSummary（list_roles_admin 返回） */
export interface RoleAdminSummary {
  id: string
  code: string
  name: string
  description: string
  status: string
  builtin: boolean
  userCount: number
  /** 菜单键与操作键混排，均按 permission_key 升序 */
  permissions: string[]
}

/** commands::rbac::PermissionRow（list_permissions 返回） */
export interface PermissionRow {
  key: string
  name: string
  type: 'menu' | 'action'
  description: string | null
}

/** commands::vault::keystore_diagnostics 返回（serde_json 动态对象）
 *  本包默认把数据库主密钥放在本机 0600 文件，不再探测系统安全存储（探针＝授权框）。 */
export interface KeystoreDiagnostics {
  /** 'local-file-0600' | 'unknown'：数据库主密钥的实际存放位置 */
  dbKeyStore: string
  /** 旧存放位置名称（macOS Keychain 等）。纯字符串，界面只用它说明那份旧库的密钥原本放在哪 */
  legacyBackend: string
  /** 文件密钥的同意来源（见 DeviceKeyConsentStatus.consent）；读不到标记时为 none */
  deviceKeyConsent: DeviceKeyConsentStatus['consent']
  note: string
}

/** commands::devicekey::device_key_consent_status 返回（serde_json 动态对象） */
export interface DeviceKeyConsentStatus {
  /** true：本机还没有密钥文件，必须先获得操作者显式同意才会写入任何字节 */
  needed: boolean
  /** none=尚未写入 / consented=本次由操作者显式同意后写入 / legacy-file=加设同意闸门前的旧版本遗留文件 */
  consent: 'none' | 'consented' | 'legacy-file'
  /** fresh=全新安装（同意后新生成一把）/ legacy-vault=库已在但密钥在旧存放位置，同意后原样迁移 */
  reason: 'fresh' | 'legacy-vault'
  legacyBackend: string
  keyFile: string
}

/** commands::boot::boot_failure_status 返回（serde_json 固定键集，未失败时其余字段为空串） */
export interface BootFailureStatus {
  /** true：启动装配失败，界面只能渲染失败页，不得再发任何读库命令 */
  failed: boolean
  /** 失败阶段：data-dir=数据目录不可用 / device-key=取用数据库密钥失败 / assembly=建库与迁移失败 */
  stage: '' | 'data-dir' | 'device-key' | 'assembly'
  /** 后端稳定错误码（error.rs AppError::code()） */
  code: string
  /** 后端那句面向用户的中文说明（AppError 的 Display） */
  message: string
  /** 失败涉及的数据目录；目录本身不可用时为空串 */
  dataDir: string
}

/** commands::menus::MenuNode（list_menu_nodes 返回全部节点，含停用项） */
export interface MenuNode {
  id: string
  nodeKey: string
  parentId: string | null
  label: string
  pageKey: PageKey | null
  kind: 'group' | 'page'
  builtin: boolean
  status: 'active' | 'disabled'
  sortOrder: number
  /** 这个入口的菜单权限键（三枚旧键沿用，其余为 menu.node.<nodeKey>） */
  permKey: string
}

// —— 外部工具档（commands/external_tools.rs）——

/** 三档工具：浏览器与终端是固定两档，数据库按引擎可增删。 */
export type ToolKind = 'browser' | 'terminal' | 'database'

/** external_tools::ToolView（list_external_tools 返回；appPath 为空即未配置=交系统默认） */
export interface ExternalTool {
  id: string
  kind: ToolKind
  /** 仅数据库档非空，且已由后端归一化成小写引擎标识 */
  engine: string
  label: string
  appPath: string
  /** 由后端现查本机文件系统：配置过的应用在本机还在不在 */
  pathExists: boolean
}

// —— accounts 命令 ——

/** db::repo::TargetRow（list_targets / create_target / update_target / find_similar_targets 返回） */
export interface TargetRow {
  id: string
  targetType: TargetType
  displayName: string
  groupId: string | null
  status: string
  createdAt: string
  updatedAt: string
  credentialCount: number
}

/** commands::accounts::list_targets_paged 返回。total 是**符合筛选条件的总数**，不是本页条数。 */
export interface PagedTargets {
  rows: TargetRow[]
  total: number
  page: number
  pageSize: number
}

/** db::repo::ItemRow（target_detail 里嵌的 items；列表视图请用 ItemView） */
export interface ItemRow {
  id: string
  targetId: string
  accountAlias: string
  itemType: TargetType
  status: string
  favorite: boolean
  tags: string[]
  createdAt: string
  updatedAt: string
  version: number
  /** 当前使用者的默认账号标记（per-user preference） */
  isDefaultForCurrentUser: boolean
}

/** commands::accounts::ItemView = ItemRow 展平 + 脱敏/可用性标志（target_items / create_item / update_item 返回） */
export interface ItemView extends ItemRow {
  usernameMasked: string
  hasPassword: boolean
  hasToken: boolean
  hasPrivateKey: boolean
  canReveal: boolean
}

/**
 * commands::accounts::ItemDetail（item_detail 返回；ItemView 用 #[serde(flatten)] 展平，所以 JSON 仍是扁平对象）。
 * 这是编辑对话框的比较基准：只返回非秘密的可编辑字段，秘密（密码/令牌/私钥/口令短语）任何命令都不回显。
 * username 只在后端判定当前使用者可查看秘密时给出原文，否则为 null——此时前端不得假装知道原文，
 * 也不得因为"读不到"就把空串当成用户的清空意图。
 * canUpdate 为 false 表示当前使用者不能写这条凭据，界面不应提供保存动作。
 */
export interface ItemDetail extends ItemView {
  username: string | null
  note: string
  authMethod: string
  browserHint: string
  loginUrlOverride: string
  confirmBeforeFill: boolean
  canUpdate: boolean
}

/**
 * db::repo::DeletedItemRow（list_deleted_items 的元素）。
 * 回收站条目只有凭据行 + 所属系统名 + 删除时间：既没有秘密，也没有用户名原文
 * （ItemRow 本身不含 username），界面不得为这两类字段编造列。
 * 与 restore_item 一样要求 accounts.delete 权限，无权限时后端回 FORBIDDEN。
 */
export interface DeletedItemRow {
  item: ItemRow
  targetName: string
  deletedAt: string
}

/** db::repo::GroupRow（list_groups 返回；create_group 只返回新 id 字符串） */
export interface GroupRow {
  id: string
  name: string
  parentId: string | null
  targetCount: number
}

/** db::repo::TargetSecretPayload（target_detail.meta；serde 无 rename，字段本就 camelCase） */
export interface TargetMeta {
  url: string
  allowedOrigin: string
  host: string
  port: string
  databaseName: string
  tenant: string
  vendor: string
  protocol: string
  extra: Record<string, string>
}

/** commands::mod::TargetDetail（target_detail 返回） */
export interface TargetDetail {
  target: TargetRow
  meta: TargetMeta
  items: ItemRow[]
  insecureProtocol: boolean
  fillAvailable: boolean
}

/** commands::mod::StatsView（vault_stats 返回；byType 是数组不是 Record） */
export interface VaultStats {
  targetCount: number
  credentialCount: number
  byType: Array<{ typeKey: string; count: number }>
  favoriteCount: number
}

/** commands::accounts::RevealedSecret（reveal_secret 返回；无 itemId/username 字段） */
export interface RevealedSecret {
  value: string
  visibleSeconds: number
}

/** SecretField 枚举线格式：snake_case（reveal_secret 的 field 参数） */
export type SecretField = 'password' | 'token' | 'private_key' | 'passphrase'

/**
 * commands::accounts::TargetFilter（list_targets 的 filter 参数）。
 * serde deny_unknown_fields：不得多发任何一个键；Option 字段可省略。
 */
export interface TargetFilter {
  itemType?: string | null
  groupId?: string | null
  favoriteOnly?: boolean | null
  keyword?: string | null
  /** 标签筛选（需求 §2.2）。空串/缺省 = 不过滤；后端按凭据标签命中并大小写不敏感。 */
  tag?: string | null
}

/** commands::accounts::recent_access 返回。只有非秘密摘要：目标名、凭据别名、类型、访问时刻。 */
export interface RecentAccessRow {
  itemId: string
  targetId: string
  targetName: string
  itemType: string
  accountAlias: string
  lastAccessedAt: string
}

/**
 * commands::mod::CreateTargetInput（create_target / update_target 的 input 参数）。
 * deny_unknown_fields：字段与 Rust 结构完全一致（无 note 字段——备注属于凭据不属于目标）。
 */
export interface CreateTargetInput {
  displayName: string
  targetType: string
  url?: string
  allowedOrigin?: string
  host?: string
  port?: string
  databaseName?: string
  tenant?: string
  vendor?: string
  protocol?: string
  groupId?: string | null
}

/**
 * commands::mod::CreateItemInput（create_item 的 input 参数；update_item 请用 UpdateItemPatch）。
 * deny_unknown_fields：字段与 Rust 结构完全一致；#[serde(default)] 的字符串字段可省略。
 */
export interface CreateItemInput {
  targetId: string
  accountAlias: string
  username?: string
  password?: string
  token?: string
  privateKey?: string
  passphrase?: string
  note?: string
  authMethod?: string
  browserHint?: string
  loginUrlOverride?: string
  confirmBeforeFill?: boolean | null
  tags?: string[]
  setAsDefault?: boolean | null
}

/**
 * commands::mod::UpdateItemInput（update_item 的 input 参数）。
 * 缺省（undefined）= 保留原值；显式空串 = 清空该字段。
 * 秘密不回显，所以绝不能用 CreateItemInput 整包覆盖，否则只改别名也会清空密码。
 */
export interface UpdateItemPatch {
  accountAlias?: string
  username?: string
  password?: string
  token?: string
  privateKey?: string
  passphrase?: string
  note?: string
  authMethod?: string
  browserHint?: string
  loginUrlOverride?: string
  confirmBeforeFill?: boolean
  tags?: string[]
}

// —— launcher 命令 ——

/** QuickAction 枚举线格式：snake_case（quick_action 的 action 参数、QuickResult.actions） */
export type QuickAction =
  | 'open_target'
  | 'open_and_fill'
  | 'copy_username'
  | 'copy_password'
  | 'view_detail'
  | 'select_other_account'
  | 'set_default'

/** quick_launcher::query::QuickResult */
export interface QuickResult {
  targetId: string
  itemId: string
  systemName: string
  itemType: TargetType
  accountAlias: string
  /** 用户名按隐私策略脱敏后的展示值 */
  usernameMasked: string
  addressSummary: string
  tags: string[]
  isDefault: boolean
  favorite: boolean
  credentialCountOnTarget: number
  actions: QuickAction[]
  matchKind: string
}

/** commands::mod::SearchReply（quick_search 返回；syntaxError 是纯字符串说明，无 code/message 结构） */
export interface SearchReply {
  locked: boolean
  results: QuickResult[]
  /** 解析失败时只回错误说明，绝不回显查询原文 */
  syntaxError?: string
  elapsedMs: number
  indexed: number
}

/** quick_launcher::actions::AccountCandidate */
export interface AccountCandidate {
  itemId: string
  accountAlias: string
  usernameMasked: string
  isDefault: boolean
}

/** commands::mod::FillGrant（一次性填充授权的状态摘要；票据原文绝不进前端） */
export interface FillGrant {
  status: string
  origin: string
  expiresInSeconds: number
}

/** commands::mod::ActionReply（open_target、open_and_fill、copy_username、copy_password、connect_target、quick_action 返回） */
export interface ActionReply {
  action: string
  ok: boolean
  message: string
  clipboardClearedIn?: number
  opened?: string
  /** 目标存在多个账号且无有效默认账号时，后端返回候选而不是随机挑选 */
  candidates?: AccountCandidate[]
  fill?: FillGrant
}

/** launcher::launcher_preferences 返回（serde_json 动态对象） */
export interface LauncherPreferences {
  shortcut: string
  default: string
  enabled: boolean
  showRecentWhenEmpty: boolean
  /** quick_launcher_rank_recent_favorite：同级结果内是否按 收藏>默认>最近 微调（需求 line 294 的可配置档） */
  rankRecentFavorite: boolean
  resultLimit: number
  /** 后端 parser::syntax_help() 的浮层语法提示；group 决定分带，字段名取自解析器自己的 label */
  syntax: LauncherSyntaxHint[]
}

/** syntax 的一行：pattern 是可照抄的写法，desc 说它匹配什么 */
export interface LauncherSyntaxHint {
  group: string
  pattern: string
  desc: string
}

/** launcher::rebind / apply_enabled 返回（set_launcher_shortcut / set_launcher_enabled） */
export interface LauncherShortcutStatus {
  shortcut: string
  registered: boolean
  default: string
  hint: string
}

// —— system 命令 ——

/** get_settings 返回：[key, value, scope] 三元组数组 */
export type SettingTuple = [key: string, value: string, scope: string]

/** commands::system::ThemeView（get_theme 返回；style 是 String，由前端 asThemeStyle 判定后才采用） */
export interface ThemeView {
  style: string
  reduceMotion: boolean
}

/** commands::system::SecurityStatus（security_status 返回；dbEncrypted 只有 encrypted/unknown 两值） */
export interface SecurityStatus {
  dbEncrypted: string
  /** 数据库主密钥存放位置：本包默认为 local-file-0600；读不到标记时 unknown */
  dbKeyStore: string
  /** 该文件密钥的同意来源（见 DeviceKeyConsentStatus.consent） */
  deviceKeyConsent: DeviceKeyConsentStatus['consent']
  schemaVersion: number
  idleTimeoutMinutes: number
  maxFailedAttempts: number
  lockoutSeconds: number
  /** 当前生效值，后端已夹紧到内置下限之上，界面显示的就是登录时的判定值 */
  minPasswordLength: number
  lockOnSystemSleep: boolean
  copyPasswordEnabled: boolean
  copyPasswordRequiresReauth: boolean
  exportRequiresReauth: boolean
  revealRequiresReauth: boolean
  insecureProtocolsAllowed: boolean
  lastBackupAt: string | null
  updateSourceConfigured: boolean
  updateSourceScheme: string
  updateSignatureKeyConfigured: boolean
  extensionReady: boolean
  telemetry: string
  sessionStartedAt: number | null
}

/** commands::system::AuditRow（list_audit_events 返回） */
export interface AuditRow {
  id: string
  ts: string
  actorId: string | null
  actorNickname: string | null
  action: string
  targetType: string | null
  targetId: string | null
  result: string
  errorCode: string | null
  source: string | null
}

/** commands::system::BackupInfo（create_backup / list_backups / verify_backup 返回） */
export interface BackupInfo {
  id: string
  fileName: string
  createdAt: string
  sizeBytes: number
  schemaVersion: number
  encrypted: boolean
  sha256: string
  verifiedAt: string | null
}

/** commands::system::system_info 返回（serde_json 动态对象，已剔除路径/密钥/凭据） */
export interface SystemInfo {
  appVersion: string
  os: string
  arch: string
  family: string
  schemaVersion: number
  targetCount: number
  /** 数据库主密钥存放位置（本包默认 local-file-0600） */
  dbKeyStore: string
  telemetry: string
}

/** commands::system::channel_state / extension_channel_status 返回 */
export interface ExtensionChannelStatus {
  ready: boolean
  hostManifestPath: string | null
  channelFilePresent: boolean
  pendingTickets: number
  note: string
}

// —— data 命令 ——

/** data::import_template 返回 */
export interface ImportTemplate {
  csv: string
  columns: string[]
  note: string
}

/** importexport::RowError */
export interface RowError {
  rowNo: number
  code: string
  message: string
  field: string | null
}

/** importexport::ConflictHint */
export interface ConflictHint {
  rowNo: number
  targetName: string
  reason: string
}

/** importexport::ImportPreview（import_preview 返回） */
export interface ImportPreview {
  jobId: string
  filename: string
  /** 后端按内容识别出来的来源格式（csv / xlsx），界面那句"已识别为 …"要说这个真值 */
  fileFormat: string
  totalRows: number
  validRows: number
  errorRows: number
  conflictRows: number
  newTargets: number
  columns: string[]
  errors: RowError[]
  /** 冲突摘要：只给行号与目标名，不给凭据内容 */
  conflicts: ConflictHint[]
  truncated: boolean
  message: string
}

/** importexport::ImportCommitResult（import_commit 返回） */
export interface ImportCommitResult {
  jobId: string
  importedRows: number
  createdTargets: number
  createdItems: number
  skippedRows: number
  conflictRows: number
  errors: RowError[]
  message: string
}

/** importexport::ContainerPreview（container_preview 返回；无列头，只有计数与文件摘要） */
export interface ContainerPreview {
  filename: string
  /** 整个容器文件的 SHA-256；提交时原样带回，后端重算不符即拒（CONTAINER_STALE） */
  fingerprint: string
  totalRows: number
  validRows: number
  errorRows: number
  conflictRows: number
  newTargets: number
  /** 后端只回答"这份容器里有没有秘密列"，不带任何内容 */
  containsSecrets: boolean
  errors: RowError[]
  conflicts: ConflictHint[]
  truncated: boolean
  message: string
}

/** data::ContainerCommitOpts（container_commit 的 opts；passphrase 只在本次调用中转手） */
export interface ContainerCommitOpts {
  path: string
  passphrase: string
  fingerprint: string
  conflictPolicy: 'skip' | 'update' | 'abort'
}

/** data::ExportOpts（export_preview 的 opts；无 deny_unknown_fields，但仍按 Rust 字段发） */
export type ExportFormat = 'csv' | 'xlsx' | 'container'
/** ledger = 本台账 18 列；browser = Chrome / Edge 那五列（name,url,username,password,note） */
export type ExportShape = 'ledger' | 'browser'

export interface ExportOpts {
  includeSecrets: boolean
  targetIds?: string[] | null
  /** 缺省时后端沿用旧语义：含秘密→container，不含→csv */
  format?: ExportFormat | null
  shape?: ExportShape | null
}

/** data::ExportCommitOpts（export_commit 的 opts） */
export interface ExportCommitOpts {
  path: string
  includeSecrets: boolean
  passphrase?: string | null
  targetIds?: string[] | null
  format?: ExportFormat | null
  shape?: ExportShape | null
}

/** importexport::ExportPreview（export_preview 返回） */
export interface ExportPreview {
  targets: number
  items: number
  includeSecrets: boolean
  format: string
  columns: string[]
  warning: string
}

/** importexport::ExportResult（export_commit 返回） */
export interface ExportResult {
  path: string
  bytes: number
  items: number
  format: string
  encrypted: boolean
  sha256: string
  message: string
}

/** update::UpdateInfo（check_update / download_update / install_update 返回；signatureValid: ok/failed/unknown） */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string | null
  channel: string
  sourceUrl: string
  releaseDate: string | null
  notes: string | null
  platform: string
  arch: string
  packageSize: number | null
  /** ok / failed / unknown（未配置公钥时为 unknown，不得显示为安全） */
  signatureValid: string
  signer: string | null
  available: boolean
  downloaded: boolean
  installed: boolean
  /** 从局域网源拉取时为「主机名（http://ip:port）」，HTTPS 通道为 null */
  lanSource: string | null
  /** 是否已把安装包交给系统打开（本版本不静默替换自身） */
  opened: boolean
  message: string
}

/** lan::LanSourceView：组播发现到的同网段更新源 */
export interface LanSourceView {
  instance: string
  host: string
  ip: string
  version: string
  platform: string
  arch: string
  port: number
  /** 源版本高于本机；false 时界面必须禁用「从局域网更新」，绝不降级 */
  newerThanLocal: boolean
}

/** lan::LanStatus（lan_status / lan_set_serve 返回） */
export interface LanStatus {
  discoveryEnabled: boolean
  /** 组播监听失败原因；非空即代表只能用手填地址 */
  discoveryError: string | null
  /** 发现线程已运行毫秒数：区分「还在扫描」与「确实没有源」 */
  elapsedMs: number
  sources: LanSourceView[]
  serving: boolean
  servePort: number | null
  serveDir: string | null
  serveError: string | null
  manualSource: string | null
  localVersion: string
}

/** data::extension_host_status 返回（ready  true/false 两分支的联合） */
export interface ExtensionHostStatusReady {
  ready: true
  prepared: Record<string, unknown>
  channel: ExtensionChannelStatus
}
export interface ExtensionHostStatusFailed {
  ready: false
  code: string
  reason: string
  channel: ExtensionChannelStatus
}
export type ExtensionHostStatus = ExtensionHostStatusReady | ExtensionHostStatusFailed

/** data::extension_host_install 返回 */
export interface ExtensionHostInstallResult {
  installed: Array<{ browser: string; path: string }>
  failed: Array<{ browser: string; reason: string }>
  registryHint: string | null
  hostPath: string | null
  note: string
}

/** data::extension_host_uninstall 返回 */
export interface ExtensionHostUninstallResult {
  removed: string[]
}
