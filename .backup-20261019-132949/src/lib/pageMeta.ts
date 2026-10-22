import type { MenuEntry } from './types';

/**
 * 主窗口六个落点。
 * - accounts / settings 由后端业务菜单（menu.accounts / menu.system）授权；
 * - members / audit 与 settings 共用 menu.system 这一枚权限——原型把系统管理拆成三个入口，
 *   后端并没有三枚菜单键，所以这里是"一枚权限、三个界面分区"，不是前端凭空新增业务项；
 * - launcher / data 是次级设置页，从顶栏「设置」下拉进入。
 */
export type PageKey = 'accounts' | 'members' | 'audit' | 'settings' | 'launcher' | 'data';

/** 胶囊里除账号中心之外的三项：同受 menu.system 约束，顺序照原型。 */
const SYSTEM_PAGES: PageKey[] = ['members', 'audit', 'settings'];

/** 当前菜单集在顶部胶囊里渲染成哪几项（原型顺序）。菜单还没回来时不给任何项——宁缺不猜。 */
export function capsuleItems(menus: MenuEntry[] | undefined): PageKey[] {
  if (!menus) return [];
  const out: PageKey[] = [];
  if (menus.some((entry) => resolvePage(entry) === 'accounts')) out.push('accounts');
  if (menus.some((entry) => resolvePage(entry) === 'settings')) out.push(...SYSTEM_PAGES);
  return out;
}

/**
 * 顶栏「设置」下拉里的两个次级入口（原型那两项是 系统管理 + 快速启动器；
 * 系统管理已经是胶囊里的一项，所以这里换成原先住在侧栏、如今没有别处可去的两屏）。
 * 导入/导出不预判权限：后端按命令逐条校验，标准用户点进去由页面如实呈现拿不到的那部分。
 */
export function secondaryItems(menus: MenuEntry[] | undefined): Array<'launcher' | 'data'> {
  const out: Array<'launcher' | 'data'> = [];
  if (menus?.some((entry) => resolvePage(entry) === 'launcher')) out.push('launcher');
  out.push('data');
  return out;
}

/**
 * 后端菜单 key/label → 前端页面解析。未知项不猜测、不渲染为可点业务页。
 * 系统那一组只认到一个默认落点（settings）：成员管理与审计日志是同一权限下的另外两屏。
 */
export function resolvePage(entry: MenuEntry): PageKey | null {
  const k = entry.key.toLowerCase();
  const l = entry.label;
  if (k === 'accounts' || k.includes('account') || l.includes('账号管理')) return 'accounts';
  if (k === 'system' || k.includes('system') || l.includes('系统管理')) return 'settings';
  if (k === 'quick_launcher' || k.includes('launcher')) return 'launcher';
  return null;
}

export interface PageMeta {
  /** 胶囊项与「设置」下拉项的文案，取自原型（账号中心/成员管理/审计日志/系统配置）。 */
  label: string;
  /**
   * 页内副标题那一行：术语免责与操作口径这类必须常驻的话。
   * 页头不再是顶栏两行裁切，而是各页自己的副标题，所以这里可以比原先长，但仍按一句写。
   */
  desc: string;
}

export const PAGE_META: Record<PageKey, PageMeta> = {
  accounts: {
    label: '账号中心',
    desc: '管理外部系统的账号与密码台账——这里的用户名/密码不是本软件的登录凭据。',
  },
  members: {
    label: '成员管理',
    desc: '本软件的使用者、角色与权限矩阵；与账号台账里的外部系统账号完全分开。',
  },
  audit: {
    label: '审计日志',
    desc: '记录本机上谁在什么时候查看、复制、导出过什么；日志里不含任何秘密原文。',
  },
  settings: {
    label: '系统配置',
    desc: '安全策略、界面外观、备份与恢复、更新；这一组只改「蒙电信产助手」自身。',
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
