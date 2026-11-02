import type { IconName } from '../components/ui/icons';
import { PERM } from './permissions';

/**
 * 主窗口十六个落点。
 * - accounts：外部系统账号台账；
 * - quiz：题库与答题助手（一级入口，与账号中心同级）；
 * - notes：个人笔记（一级入口，与账号中心同级）；
 * - html：页面库（一级「工具」入口；右栏用嵌入的子 webview 直接跑，脚本在别处也可用）；
 * - release：「任务中心」下的第一枚二级页（微服务发布），左侧竖排导航；顶栏不给它胶囊，从快速启动浮层进；
 * - users/roles/menus/permissions/audit：右上角齿轮下拉里的五个系统管理页，进去后左侧竖排导航；
 * - security/appearance/backup/update/tools：齿轮「设置」下拉第一组的五个独立页；
 * - launcher：齿轮下拉第二组的工具页。
 * 本文件只保留「页面名 / 说明 / 图标 / 所需权限」这张静态表；入口是否出现由
 * lib/menuTree.ts 结合 menu_nodes 表与当前权限推导。
 */
export type PageKey =
  | 'accounts'
  | 'quiz'
  | 'notes'
  | 'html'
  | 'release'
  | 'users'
  | 'roles'
  | 'menus'
  | 'permissions'
  | 'audit'
  | 'security'
  | 'appearance'
  | 'backup'
  | 'update'
  | 'tools'
  | 'launcher';

export type AdminPageKey = Extract<PageKey, 'users' | 'roles' | 'menus' | 'permissions' | 'audit'>;
export type SettingsPageKey = Extract<PageKey, 'security' | 'appearance' | 'backup' | 'update' | 'tools'>;
export type TaskPageKey = Extract<PageKey, 'release'>;
/**
 * 顶栏胶囊的四枚一级页。
 * 「任务中心」与「系统管理」不再占位（交付方 2026-11-02）：前者只从快速启动浮层进，
 * 后者的五枚二级页并进右上角齿轮。所以这里剩下的成员必须与 lib/menuTree.ts 推导出的那四枚一致。
 */
export type TopKey = 'accounts' | 'quiz' | 'notes' | 'html';
export type GearPageKey = SettingsPageKey | Extract<PageKey, 'launcher'>;

export interface PageMeta {
  label: string;
  desc: string;
}

export interface NavItem<K extends PageKey = PageKey> extends PageMeta {
  key: K;
  icon: IconName;
  /** 全部满足才显示入口。空数组 = 无需额外权限。 */
  requires: string[];
}

export const PAGE_META: Record<PageKey, PageMeta> = {
  accounts: {
    label: '账号中心',
    desc: '管理外部系统的账号与密码台账——这里的用户名/密码不是本软件的登录凭据。',
  },
  quiz: {
    label: '题库',
    desc: '导入多份题库并管理题目；答题助手在光标处识别题干后跨题库检索答案，可限定只查其中几份。',
  },
  notes: {
    label: '笔记',
    desc: '个人笔记按使用者隔离，正文与图片都存在本机保险库、解锁后才能读写；可插入表格、代码块与图片。单篇导出 Markdown（图片内联），全部导出 zip 备份。',
  },
  html: {
    label: '页面库',
    desc: '把 HTML 粘进来、起个标题存好，左侧列表、右侧直接可用：脚本、图片与 CDN 资源照常运行，但页面拿不到本应用的任何命令。想让页面单独占一扇窗（或放到另一块屏幕）时点「运行脚本」。',
  },
  release: {
    label: '微服务发布',
    desc: '从发布说明里读出服务与目标镜像，先取回线上版本再逐项改镜像；生产环境那一发要单独的生产发布权限，并会逐条核对镜像。',
  },
  users: {
    label: '用户管理',
    desc: '统一管理本软件的使用者、角色绑定与启用状态。新增、停用及重置主密码需具备 system.user.manage；调整角色需具备 system.role.manage。',
  },
  roles: {
    label: '角色管理',
    desc: '维护角色的名称、说明与启用状态，界定可授予使用者的职责范围。内置角色的元数据受保护、权限仍可调整；删除自定义角色前，须先解除全部使用者绑定。',
  },
  menus: {
    label: '菜单管理',
    desc: '用表格树维护导航菜单：可新增入口（只能绑定现有页面），状态列的开关即时启用/停用。停用后无法再回到本页的那几枚入口会被锁住不让停用。菜单只决定入口是否出现，不授予权限——真正的拒绝仍由后端按操作权限完成。',
  },
  permissions: {
    label: '权限管理',
    desc: '按角色维护菜单入口与操作权限：一级、二级入口各自授权，切换角色后勾选即可。菜单权限随菜单创建自动生成；操作权限由版本定义，不能增删；保存后后端从下一条命令起按新权限校验。',
  },
  audit: {
    label: '审计日志',
    desc: '记录本机上谁在什么时候查看、复制、导出过什么；日志里不含任何秘密原文。',
  },
  security: {
    label: '安全策略',
    desc: '安全设置、密钥库诊断、扩展通道与系统信息；这一组只改「蒙电信产助手」自身。',
  },
  appearance: {
    label: '界面外观',
    desc: '界面主题与减少动态；只影响本机外观，不改任何安全策略。',
  },
  backup: {
    label: '备份与恢复',
    desc: '保险库备份的创建、校验与恢复；恢复会覆盖当前数据，需要近期二次认证。',
  },
  update: {
    label: '系统更新',
    desc: '更新通道、签名校验与下载安装；下载/安装按钮另需 system.update.install 权限。',
  },
  tools: {
    label: '外部工具',
    desc: '配置打开账号时用哪个本机应用：浏览器、终端，以及按数据库引擎分的客户端。留空即用系统默认；这里的配置对本机所有使用者生效，换机后路径若已失效会自动回退系统默认。',
  },
  launcher: {
    label: '快速启动器',
    desc: '快捷键由 Rust 后端注册并检测冲突；应用需保持后台运行才能唤起浮层。',
  },
};

/**
 * 十六个落点各自的权限门槛。
 * 左上角入口（accounts）、「任务中心」与「系统管理」二级页还额外受菜单节点与父级菜单键约束，
 * 这部分在 menuTree.ts 里叠加，不写进这张表。
 */
export const PAGE_REQUIRES: Record<PageKey, string[]> = {
  accounts: [PERM.MENU_ACCOUNTS],
  // 一级入口键由 list_menu_nodes 下发，这里只钉页面本身的能力门槛。
  quiz: [PERM.QUIZ_LIBRARY_READ],
  notes: [PERM.NOTES_READ],
  // 页面库同样是一级入口：入口键由菜单节点下发，页面本身只要求能读页面。
  html: [PERM.HTML_PAGE_READ],
  // 入口键同样由菜单节点下发；页面本身要求能读发布信息与运行历史。
  release: [PERM.TASK_RELEASE_VIEW],
  users: [PERM.SYS_USER_READ],
  roles: [PERM.SYS_ROLE_MANAGE],
  menus: [PERM.SYS_ROLE_MANAGE],
  permissions: [PERM.SYS_ROLE_MANAGE],
  audit: [PERM.SYS_AUDIT_READ],
  security: [PERM.SYS_SECURITY_CONFIG],
  appearance: [],
  backup: [PERM.SYS_BACKUP_MANAGE],
  update: [PERM.SYS_UPDATE_CONFIG],
  // 这一页写的每一条都要 system.security.config（后端四条命令同一道门槛）；
  // 入口再叠一枚菜单键。少了前者，点进去就是满屏 FORBIDDEN。
  tools: [PERM.SYS_SECURITY_CONFIG],
  launcher: [PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG],
};

export const PAGE_ICONS: Record<PageKey, IconName> = {
  accounts: 'database',
  quiz: 'fileSheet',
  notes: 'notebookPen',
  html: 'code',
  release: 'rocket',
  users: 'users',
  roles: 'shield',
  menus: 'listTree',
  permissions: 'key',
  audit: 'scrollText',
  security: 'shield',
  appearance: 'palette',
  backup: 'database',
  update: 'refresh',
  tools: 'externalLink',
  launcher: 'zap',
};

/** 「任务中心」左栏：今天是「微服务发布」一枚，后续任务按同一结构追加。 */
export const TASK_ITEMS: NavItem<TaskPageKey>[] = [
  { key: 'release', ...PAGE_META.release, icon: PAGE_ICONS.release, requires: PAGE_REQUIRES.release },
];

/** 系统管理五页（齿轮下拉最后一组，进去后是左侧竖排导航；顺序由 menu_nodes 的 sort_order 决定）。 */
export const ADMIN_ITEMS: NavItem<AdminPageKey>[] = [
  { key: 'users', ...PAGE_META.users, icon: PAGE_ICONS.users, requires: PAGE_REQUIRES.users },
  { key: 'roles', ...PAGE_META.roles, icon: PAGE_ICONS.roles, requires: PAGE_REQUIRES.roles },
  { key: 'menus', ...PAGE_META.menus, icon: PAGE_ICONS.menus, requires: PAGE_REQUIRES.menus },
  {
    key: 'permissions',
    ...PAGE_META.permissions,
    icon: PAGE_ICONS.permissions,
    requires: PAGE_REQUIRES.permissions,
  },
  { key: 'audit', ...PAGE_META.audit, icon: PAGE_ICONS.audit, requires: PAGE_REQUIRES.audit },
];

/** 齿轮下拉第一组：五个独立设置页。 */
export const SETTINGS_ITEMS: NavItem<SettingsPageKey>[] = [
  {
    key: 'security',
    ...PAGE_META.security,
    icon: PAGE_ICONS.security,
    requires: PAGE_REQUIRES.security,
  },
  {
    key: 'appearance',
    ...PAGE_META.appearance,
    icon: PAGE_ICONS.appearance,
    requires: PAGE_REQUIRES.appearance,
  },
  { key: 'backup', ...PAGE_META.backup, icon: PAGE_ICONS.backup, requires: PAGE_REQUIRES.backup },
  { key: 'update', ...PAGE_META.update, icon: PAGE_ICONS.update, requires: PAGE_REQUIRES.update },
  { key: 'tools', ...PAGE_META.tools, icon: PAGE_ICONS.tools, requires: PAGE_REQUIRES.tools },
];

/**
 * 齿轮下拉第二组：工具页。
 * 快速启动器页的写命令后端要求安全策略权限，所以入口同时要 menu.quick_launcher 与
 * system.security.config——否则点进去只会满屏 FORBIDDEN。
 */
export const UTILITY_ITEMS: NavItem<'launcher'>[] = [
  {
    key: 'launcher',
    ...PAGE_META.launcher,
    icon: PAGE_ICONS.launcher,
    requires: PAGE_REQUIRES.launcher,
  },
];

const ADMIN_KEYS = new Set<string>(ADMIN_ITEMS.map((item) => item.key));
const TASK_KEYS = new Set<string>(TASK_ITEMS.map((item) => item.key));

export function isAdminPage(page: PageKey): page is AdminPageKey {
  return ADMIN_KEYS.has(page);
}

export function isTaskPage(page: PageKey): page is TaskPageKey {
  return TASK_KEYS.has(page);
}

export function isSettingsPage(page: PageKey): page is SettingsPageKey {
  return SETTINGS_ITEMS.some((item) => item.key === page);
}

/** 齿轮下拉覆盖的六个落点（五个设置页 + 一个工具页）。 */
export function isGearPage(page: PageKey): page is GearPageKey {
  return isSettingsPage(page) || page === 'launcher';
}
