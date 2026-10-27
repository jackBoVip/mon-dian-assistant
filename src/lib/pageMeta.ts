import type { IconName } from '../components/ui/icons';
import { PERM } from './permissions';

/**
 * 主窗口十二个落点。
 * - accounts：外部系统账号台账；
 * - users/roles/menus/permissions/audit：顶部「系统管理」下的五个二级页，左侧竖排导航；
 * - security/appearance/backup/update/tools：齿轮「设置」下拉第一组的五个独立页；
 * - launcher：齿轮下拉第二组的工具页。
 * 本文件只保留「页面名 / 说明 / 图标 / 所需权限」这张静态表；入口是否出现由
 * lib/menuTree.ts 结合 menu_nodes 表与当前权限推导。
 */
export type PageKey =
  | 'accounts'
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
export type TopKey = 'accounts' | 'system';
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
 * 十二个落点各自的权限门槛。
 * 左上角入口（accounts）与「系统管理」二级页还额外受菜单节点与父级菜单键约束，
 * 这部分在 menuTree.ts 里叠加，不写进这张表。
 */
export const PAGE_REQUIRES: Record<PageKey, string[]> = {
  accounts: [PERM.MENU_ACCOUNTS],
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

/** 系统管理左栏五项（顺序即默认顺序；实际渲染顺序由 menu_nodes 的 sort_order 决定）。 */
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

export function isAdminPage(page: PageKey): page is AdminPageKey {
  return ADMIN_KEYS.has(page);
}

export function isSettingsPage(page: PageKey): page is SettingsPageKey {
  return SETTINGS_ITEMS.some((item) => item.key === page);
}

/** 齿轮下拉覆盖的六个落点（五个设置页 + 一个工具页）。 */
export function isGearPage(page: PageKey): page is GearPageKey {
  return isSettingsPage(page) || page === 'launcher';
}
