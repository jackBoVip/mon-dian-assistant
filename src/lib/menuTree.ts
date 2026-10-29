import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './queryClient';
import { allows, has, permissionSet, useMyPermissions } from './permissions';
import {
  PAGE_ICONS,
  PAGE_REQUIRES,
  isAdminPage,
  type AdminPageKey,
  type PageKey,
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

export interface NavTree {
  top: TopNavEntry[];
  admin: NavEntry[];
  settings: NavEntry[];
  utilities: NavEntry[];
  reachable: ReadonlySet<PageKey>;
}

const ROOT_ACCOUNTS = 'top.accounts';
const ROOT_QUIZ = 'top.quiz';
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
    if (!has(perms, node.permKey)) return null;
    const page = node.pageKey;
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

  const systemRoot = rootOf(ROOT_SYSTEM);
  const systemVisible = systemRoot !== null && has(perms, systemRoot.permKey);
  // 二级入口各有自己的菜单键；父级不可见时整棵子树都不出现。
  const admin = systemVisible
    ? entriesOf(childrenOf(systemRoot), (page) => isAdminPage(page))
    : [];

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
  const roots = sortNodes(
    nodes.filter(
      (node) =>
        !node.parentId &&
        (node.nodeKey === ROOT_ACCOUNTS || node.nodeKey === ROOT_QUIZ || node.nodeKey === ROOT_SYSTEM),
    ),
  );
  for (const root of roots) {
    if (root.nodeKey === ROOT_ACCOUNTS && accountsVisible) {
      top.push({ id: root.id, key: 'accounts', label: root.label });
    }
    if (root.nodeKey === ROOT_QUIZ && quizVisible) {
      top.push({ id: root.id, key: 'quiz', label: root.label });
    }
    if (root.nodeKey === ROOT_SYSTEM && systemVisible && admin.length > 0) {
      top.push({ id: root.id, key: 'system', label: root.label });
    }
  }

  const reachable = new Set<PageKey>();
  if (accountsVisible) reachable.add('accounts');
  if (quizVisible) reachable.add('quiz');
  for (const entry of [...admin, ...settings, ...utilities]) reachable.add(entry.page);

  return { top, admin, settings, utilities, reachable };
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

/** 当前页不可达时的兜底：账号中心 → 题库 → 系统管理首项 → 设置页首项 → 工具页首项。 */
export function firstReachablePage(nav: NavTree): PageKey | null {
  if (nav.reachable.has('accounts')) return 'accounts';
  if (nav.reachable.has('quiz')) return 'quiz';
  return nav.admin[0]?.page ?? nav.settings[0]?.page ?? nav.utilities[0]?.page ?? null;
}

/** 点「系统管理」的落点：上次访问的二级页仍可达就回去，否则取左栏首项。 */
export function resolveAdminLanding(nav: NavTree, last: AdminPageKey | null): AdminPageKey | null {
  if (last && nav.admin.some((entry) => entry.page === last)) return last;
  const first = nav.admin.find((entry) => isAdminPage(entry.page));
  return first ? (first.page as AdminPageKey) : null;
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
