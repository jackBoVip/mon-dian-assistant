import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './queryClient';
import { allows, has, permissionSet, useMyPermissions } from './permissions';
import {
  PAGE_ICONS,
  PAGE_REQUIRES,
  isAdminPage,
  isTaskPage,
  type AdminPageKey,
  type PageKey,
  type TaskPageKey,
  type TopKey,
} from './pageMeta';
import type { IconName } from '../components/ui/icons';
import type { MenuNode } from './types';

/**
 * 导航的唯一推导层：menu_nodes 决定「有哪些入口、顺序与启停」，
 * my_permissions 决定「当前使用者能不能看见」，两者缺一不可。
 * 菜单节点停用只隐藏入口，不撤销权限；后端仍按权限拒绝。
 */
export interface NavEntry {
  id: string;
  page: PageKey;
  label: string;
  icon: IconName;
  requires: string[];
}

export interface TopNavEntry {
  id: string;
  key: TopKey;
  label: string;
}

/** 齿轮下拉里那一枚分组入口（今天只有「系统管理」）：名字跟 menu_nodes 的根节点走。 */
export interface NavGroupEntry {
  id: string;
  label: string;
}

export interface NavTree {
  top: TopNavEntry[];
  admin: NavEntry[];
  /**
   * 齿轮里那一枚「系统管理」。父级节点停用、或一项二级页都不可进时是 null——
   * 后者是"点进去是一屏空白"的那条红线（交付方 2026-11-02：五枚收成这一枚）。
   */
  adminEntry: NavGroupEntry | null;
  tasks: NavEntry[];
  settings: NavEntry[];
  utilities: NavEntry[];
  reachable: ReadonlySet<PageKey>;
}

const ROOT_ACCOUNTS = 'top.accounts';
const ROOT_QUIZ = 'top.quiz';
const ROOT_NOTES = 'top.notes';
/** 一级「工具」= 页面库。别与齿轮里的 ROOT_TOOLS（外部工具页）混名。 */
const ROOT_HTML = 'top.tools';
const ROOT_TASKS = 'top.tasks';
const ROOT_SYSTEM = 'top.system';
const ROOT_SETTINGS = 'gear.settings';
const ROOT_TOOLS = 'gear.tools';

function sortNodes(nodes: MenuNode[]): MenuNode[] {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.nodeKey.localeCompare(b.nodeKey));
}

export function buildNav(
  nodes: MenuNode[],
  perms: ReadonlySet<string> | null | undefined,
): NavTree {
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const children = new Map<string, MenuNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }

  const rootOf = (key: string): MenuNode | null => {
    const node = byKey.get(key);
    return node && node.status === 'active' ? node : null;
  };
  const childrenOf = (root: MenuNode | null): MenuNode[] => (root ? sortNodes(children.get(root.id) ?? []) : []);

  const pageEntry = (node: MenuNode): NavEntry | null => {
    if (node.status !== 'active' || node.kind !== 'page' || !node.pageKey) return null;
    const page = node.pageKey;
    // 菜单表可能比界面新（节点已种下、这一页还没接）：未知落点按无入口处理，
    // 不能让整棵导航因此抛错，更不能凭一个没登记的名字渲染出空白页。
    if (!(page in PAGE_REQUIRES)) return null;
    if (!has(perms, node.permKey)) return null;
    if (!allows(perms, PAGE_REQUIRES[page])) return null;
    return {
      id: node.id,
      page,
      label: node.label,
      icon: PAGE_ICONS[page],
      requires: PAGE_REQUIRES[page],
    };
  };

  const entriesOf = (source: MenuNode[], keep: (page: PageKey) => boolean): NavEntry[] =>
    source
      .map((node) => (node.pageKey && keep(node.pageKey) ? pageEntry(node) : null))
      .filter((entry): entry is NavEntry => entry !== null);

  const accountsRoot = rootOf(ROOT_ACCOUNTS);
  const accountsVisible =
    accountsRoot !== null &&
    accountsRoot.pageKey === 'accounts' &&
    has(perms, accountsRoot.permKey) &&
    allows(perms, PAGE_REQUIRES.accounts);

  const quizRoot = rootOf(ROOT_QUIZ);
  const quizVisible =
    quizRoot !== null &&
    quizRoot.pageKey === 'quiz' &&
    has(perms, quizRoot.permKey) &&
    allows(perms, PAGE_REQUIRES.quiz);

  const notesRoot = rootOf(ROOT_NOTES);
  const notesVisible =
    notesRoot !== null &&
    notesRoot.pageKey === 'notes' &&
    has(perms, notesRoot.permKey) &&
    allows(perms, PAGE_REQUIRES.notes);

  const htmlRoot = rootOf(ROOT_HTML);
  const htmlVisible =
    htmlRoot !== null &&
    htmlRoot.pageKey === 'html' &&
    has(perms, htmlRoot.permKey) &&
    allows(perms, PAGE_REQUIRES.html);

  const systemRoot = rootOf(ROOT_SYSTEM);
  const systemVisible = systemRoot !== null && has(perms, systemRoot.permKey);
  // 二级入口各有自己的菜单键；父级不可见时整棵子树都不出现。
  const admin = systemVisible
    ? entriesOf(childrenOf(systemRoot), (page) => isAdminPage(page))
    : [];
  // 齿轮里那一枚「系统管理」：一组里没有一枚二级页可进时整枚不出（点进去是空壳）。
  const adminEntry =
    systemRoot !== null && admin.length > 0 ? { id: systemRoot.id, label: systemRoot.label } : null;

  const tasksRoot = rootOf(ROOT_TASKS);
  const tasksVisible = tasksRoot !== null && has(perms, tasksRoot.permKey);
  // 「任务中心」与系统管理同构：父级不可见或一项子页都不可进时整组不出现。
  const tasks = tasksVisible ? entriesOf(childrenOf(tasksRoot), (page) => isTaskPage(page)) : [];

  const settingsRoot = rootOf(ROOT_SETTINGS);
  const settings =
    settingsRoot !== null && has(perms, settingsRoot.permKey)
      ? entriesOf(childrenOf(settingsRoot), (page) => !isAdminPage(page) && page !== 'launcher')
      : [];

  const toolsRoot = rootOf(ROOT_TOOLS);
  const utilities =
    toolsRoot !== null && has(perms, toolsRoot.permKey)
      ? entriesOf(childrenOf(toolsRoot), (page) => page === 'launcher')
      : [];

  const top: TopNavEntry[] = [];
  // 顶栏只留四枚一级页胶囊（交付方 2026-11-02）：
  // - 系统管理的二级页并进右上角齿轮那一组；
  // - 任务中心从顶栏隐藏，页面仍由快速启动浮层的落点进入（`nav.tasks` 照旧推导，
  //   权限与启停判定一分不动，撤掉的只是入口）。
  const capsule = new Map<string, TopKey | null>([
    [ROOT_ACCOUNTS, accountsVisible ? 'accounts' : null],
    [ROOT_QUIZ, quizVisible ? 'quiz' : null],
    [ROOT_NOTES, notesVisible ? 'notes' : null],
    [ROOT_HTML, htmlVisible ? 'html' : null],
  ]);
  const roots = sortNodes(
    nodes.filter((node) => !node.parentId && capsule.has(node.nodeKey)),
  );
  for (const root of roots) {
    const key = capsule.get(root.nodeKey) ?? null;
    if (key) top.push({ id: root.id, key, label: root.label });
  }

  const reachable = new Set<PageKey>();
  if (accountsVisible) reachable.add('accounts');
  if (quizVisible) reachable.add('quiz');
  if (notesVisible) reachable.add('notes');
  if (htmlVisible) reachable.add('html');
  for (const entry of [...tasks, ...admin, ...settings, ...utilities]) reachable.add(entry.page);

  return { top, admin, adminEntry, tasks, settings, utilities, reachable };
}

/**
 * 停用 `id` 这一枚之后，是否**再也没有路能回到菜单管理页**。
 * 与后端 `menu::menus_page_still_reachable` 同一口径（那边是最终裁决，这里只为把开关提前置灰并说明理由）：
 * 路径可用 = 该节点绑定 `menus` 页、自己启用、一路到根的每个祖先都启用。
 * 名单不写死节点键——树可改名、可加别名入口，写死的名单会随结构漂移成"还在跑但什么都不守"。
 */
export function disableWouldLockOutMenusPage(nodes: MenuNode[], id: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pathAlive = (node: MenuNode): boolean => {
    if (node.pageKey !== 'menus' || node.id === id || node.status !== 'active') return false;
    let current = node;
    // 断链或成环一律按不可达处理：宁可少放行，也不给"停用了回不来"开门
    for (let hop = 0; hop <= nodes.length; hop += 1) {
      if (!current.parentId) return true;
      const parent = byId.get(current.parentId);
      if (!parent || parent.id === id || parent.status !== 'active') return false;
      current = parent;
    }
    return false;
  };
  return !nodes.some(pathAlive);
}

/**
 * 当前页不可达时的兜底：一级页按胶囊顺序（账号中心 → 题库 → 笔记 → 工具）先挑，
 * 再退到分组首项（任务中心 → 系统管理 → 设置 → 快捷入口）。
 */
export function firstReachablePage(nav: NavTree): PageKey | null {
  if (nav.reachable.has('accounts')) return 'accounts';
  if (nav.reachable.has('quiz')) return 'quiz';
  if (nav.reachable.has('notes')) return 'notes';
  if (nav.reachable.has('html')) return 'html';
  return nav.tasks[0]?.page ?? nav.admin[0]?.page ?? nav.settings[0]?.page ?? nav.utilities[0]?.page ?? null;
}

/**
 * 点齿轮里那一枚「系统管理」的落点：上次访问的二级页仍可达就回去，否则取左栏首项。
 * 五枚二级页收成这一枚（交付方 2026-11-02），换页靠进去之后左侧那条竖排导航，
 * 所以"上一次看的是哪一页"必须由这里带，不能让每次点都跳回第一项。
 */
export function resolveAdminLanding(nav: NavTree, last: AdminPageKey | null): AdminPageKey | null {
  if (last && nav.admin.some((entry) => entry.page === last)) return last;
  const first = nav.admin.find((entry) => isAdminPage(entry.page));
  return first ? (first.page as AdminPageKey) : null;
}

/**
 * 快速启动浮层跳「任务中心」时的落点：取左栏首项。
 * 今天只有「微服务发布」一枚，不记"上次那一页"——只有一页时那份状态永远是首项。
 */
export function resolveTasksLanding(nav: NavTree): TaskPageKey | null {
  const first = nav.tasks.find((entry) => isTaskPage(entry.page));
  return first ? (first.page as TaskPageKey) : null;
}

export function useMenuNodes() {
  return useQuery({ queryKey: queryKeys.menuNodes, queryFn: () => api.listMenuNodes() });
}

export function useNavTree() {
  const permsQuery = useMyPermissions();
  const nodesQuery = useMenuNodes();
  const perms = useMemo(() => permissionSet(permsQuery.data), [permsQuery.data]);
  // 两份数据缺一律当作未就绪：权限错误被回收后 data 会变 undefined，
  // 这时若按空权限建树，壳层会渲染出一屏"只剩无需权限的那两页"的假状态。
  const nav = useMemo(
    () => (nodesQuery.data === undefined || permsQuery.data === undefined ? null : buildNav(nodesQuery.data, perms)),
    [nodesQuery.data, permsQuery.data, perms],
  );

  return {
    nav,
    perms,
    isLoading: permsQuery.isLoading || nodesQuery.isLoading,
    error: permsQuery.error ?? nodesQuery.error,
    refetch: () => Promise.all([permsQuery.refetch(), nodesQuery.refetch()]),
  };
}
