import type { IconName } from '../components/ui/icons';
import { PERM, allows, has } from './permissions';

/**
 * 主窗口十二个落点。
 * - accounts：外部系统账号台账；
 * - users/roles/menus/permissions/audit：顶部「系统管理」下的五个二级页，左侧竖排导航；
 * - security/appearance/backup/update：齿轮「设置」下拉第一组的四个独立页；
 * - launcher/data：齿轮下拉第二组的工具页。
 * 二级页本身由操作权限决定，一级菜单可见性只决定顶栏入口是否出现。
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
  | 'launcher'
  | 'data';

export type AdminPageKey = Extract<PageKey, 'users' | 'roles' | 'menus' | 'permissions' | 'audit'>;
export type SettingsPageKey = Extract<PageKey, 'security' | 'appearance' | 'backup' | 'update'>;
export type TopKey = 'accounts' | 'system';
export type GearPageKey = SettingsPageKey | Extract<PageKey, 'launcher' | 'data'>;

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
    desc: '当前版本固定三枚一级菜单，本页只决定角色能看到哪几枚；二级页面由操作权限决定——菜单可见性只决定入口是否出现，真正的拒绝由后端按操作权限完成。',
  },
  permissions: {
    label: '权限管理',
    desc: '权限项由版本定义，不能增删；勾选后即时生效，后端从下一条命令起按新权限校验。这里只维护操作权限（action），菜单可见性在菜单管理页。',
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
  launcher: {
    label: '快速启动器',
    desc: '快捷键由 Rust 后端注册并检测冲突；应用需保持后台运行才能唤起浮层。',
  },
  data: {
    label: '导入/导出',
    desc: '搬运的是外部系统账号台账，不是保险库备份文件；含秘密导出需二次认证。',
  },
};

/** 顶栏一级项文案：账号中心取自页面元数据，系统管理是一级菜单自己的名字。 */
export const TOP_LABELS: Record<TopKey, string> = {
  accounts: PAGE_META.accounts.label,
  system: '系统管理',
};

/** 系统管理左栏五项（顺序即左栏顺序）。 */
export const ADMIN_ITEMS: NavItem<AdminPageKey>[] = [
  { key: 'users', ...PAGE_META.users, icon: 'users', requires: [PERM.SYS_USER_READ] },
  { key: 'roles', ...PAGE_META.roles, icon: 'shield', requires: [PERM.SYS_ROLE_MANAGE] },
  { key: 'menus', ...PAGE_META.menus, icon: 'listTree', requires: [PERM.SYS_ROLE_MANAGE] },
  { key: 'permissions', ...PAGE_META.permissions, icon: 'key', requires: [PERM.SYS_ROLE_MANAGE] },
  { key: 'audit', ...PAGE_META.audit, icon: 'scrollText', requires: [PERM.SYS_AUDIT_READ] },
];

/** 齿轮下拉第一组：四个独立设置页。 */
export const SETTINGS_ITEMS: NavItem<SettingsPageKey>[] = [
  { key: 'security', ...PAGE_META.security, icon: 'shield', requires: [PERM.SYS_SECURITY_CONFIG] },
  { key: 'appearance', ...PAGE_META.appearance, icon: 'palette', requires: [] },
  { key: 'backup', ...PAGE_META.backup, icon: 'database', requires: [PERM.SYS_BACKUP_MANAGE] },
  { key: 'update', ...PAGE_META.update, icon: 'refresh', requires: [PERM.SYS_UPDATE_CONFIG] },
];

/**
 * 齿轮下拉第二组：工具页。
 * 快速启动器页的写命令后端要求安全策略权限，所以入口同时要 menu.quick_launcher 与
 * system.security.config——否则点进去只会满屏 FORBIDDEN。
 */
export const UTILITY_ITEMS: NavItem<Extract<PageKey, 'launcher' | 'data'>>[] = [
  {
    key: 'launcher',
    ...PAGE_META.launcher,
    icon: 'zap',
    requires: [PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG],
  },
  { key: 'data', ...PAGE_META.data, icon: 'importTray', requires: [] },
];

export function adminItems(perms: ReadonlySet<string> | null | undefined): NavItem<AdminPageKey>[] {
  return ADMIN_ITEMS.filter((item) => allows(perms, item.requires));
}

export function settingsItems(perms: ReadonlySet<string> | null | undefined): NavItem<SettingsPageKey>[] {
  return SETTINGS_ITEMS.filter((item) => allows(perms, item.requires));
}

export function utilityItems(
  perms: ReadonlySet<string> | null | undefined,
): NavItem<Extract<PageKey, 'launcher' | 'data'>>[] {
  return UTILITY_ITEMS.filter((item) => allows(perms, item.requires));
}

/** 顶栏一级项。系统管理只在 menu.system 且至少一项二级页可用时出现。 */
export function topItems(perms: ReadonlySet<string> | null | undefined): TopKey[] {
  const out: TopKey[] = [];
  if (has(perms, PERM.MENU_ACCOUNTS)) out.push('accounts');
  if (has(perms, PERM.MENU_SYSTEM) && adminItems(perms).length > 0) out.push('system');
  return out;
}

const ADMIN_KEYS = new Set<string>(ADMIN_ITEMS.map((item) => item.key));

export function isAdminPage(page: PageKey): page is AdminPageKey {
  return ADMIN_KEYS.has(page);
}

export function isSettingsPage(page: PageKey): page is SettingsPageKey {
  return SETTINGS_ITEMS.some((item) => item.key === page);
}

/** 齿轮下拉覆盖的六个落点（四个设置页 + 两个工具页）。 */
export function isGearPage(page: PageKey): page is GearPageKey {
  return isSettingsPage(page) || page === 'launcher' || page === 'data';
}

/** 系统管理页同时要求 menu.system 与该项自己的操作权限。 */
export function isPageAllowed(page: PageKey, perms: ReadonlySet<string> | null | undefined): boolean {
  if (page === 'accounts') return has(perms, PERM.MENU_ACCOUNTS);
  if (isAdminPage(page)) {
    if (!has(perms, PERM.MENU_SYSTEM)) return false;
    const item = ADMIN_ITEMS.find((entry) => entry.key === page);
    return !!item && allows(perms, item.requires);
  }
  const item = [...SETTINGS_ITEMS, ...UTILITY_ITEMS].find((entry) => entry.key === page);
  return !!item && allows(perms, item.requires);
}

/** 点「系统管理」落点：上次访问的二级页仍可用就回去，否则落第一项可用页；一项都没有时返回 null。 */
export function resolveAdminLanding(
  perms: ReadonlySet<string> | null | undefined,
  lastAdminPage: AdminPageKey | null,
): AdminPageKey | null {
  if (!has(perms, PERM.MENU_SYSTEM)) return null;
  const items = adminItems(perms);
  if (items.length === 0) return null;
  if (lastAdminPage && items.some((item) => item.key === lastAdminPage)) return lastAdminPage;
  return items[0].key;
}

/** 账号中心 → 系统管理首页 → 设置页 → 工具页 → data 兜底。 */
export function firstAllowedPage(perms: ReadonlySet<string> | null | undefined): PageKey {
  if (has(perms, PERM.MENU_ACCOUNTS)) return 'accounts';
  const adminLanding = resolveAdminLanding(perms, null);
  if (adminLanding) return adminLanding;
  const setting = settingsItems(perms)[0];
  if (setting) return setting.key;
  return utilityItems(perms)[0]?.key ?? 'data';
}

/**
 * 二级页 → 所需权限的只读对照表。由 ADMIN_ITEMS/SETTINGS_ITEMS/UTILITY_ITEMS 推导，
 * 不在页面里手抄名单；菜单管理页直接渲染它。
 */
export function pagePermissionMap(): Array<{ page: PageKey; label: string; requires: string[] }> {
  return [...ADMIN_ITEMS, ...SETTINGS_ITEMS, ...UTILITY_ITEMS].map((item) => ({
    page: item.key,
    label: item.label,
    requires: item.requires,
  }));
}
