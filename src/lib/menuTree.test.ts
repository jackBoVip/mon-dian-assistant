import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildNav,
  disableWouldLockOutMenusPage,
  firstReachablePage,
  resolveAdminLanding,
  resolveTasksLanding,
  type NavTree,
} from './menuTree';
import { PERM } from './permissions';
import { PAGE_ICONS, PAGE_META } from './pageMeta';
import type { MenuNode } from './types';
import { SEED_MENU_NODES, seedMenuNodes } from '../test/menuFixtures';

const NODE_PERMS = seedMenuNodes().map((node) => node.permKey);
const FULL = new Set<string>([...Object.values(PERM), ...NODE_PERMS]);
const NONE = new Set<string>();

function permOf(nodeKey: string): string {
  const node = seedMenuNodes().find((n) => n.nodeKey === nodeKey);
  if (!node) throw new Error(`夹具里没有 ${nodeKey}`);
  return node.permKey;
}

function navOf(
  nodes: MenuNode[],
  perms: ReadonlySet<string> = new Set([...FULL, ...nodes.map((node) => node.permKey)]),
): NavTree {
  return buildNav(nodes, perms);
}

function pageKeys(entries: NavTree['admin']): string[] {
  return entries.map((entry) => entry.page);
}

function patch(nodes: MenuNode[], id: string, changes: Partial<MenuNode>): MenuNode[] {
  return nodes.map((node) => (node.id === id ? { ...node, ...changes } : node));
}

describe('全量种子 + 全量权限：导航就是那张确认稿', () => {
  it('顶栏四枚胶囊、两个左栏各按 sort_order 排列，齿轮五 + 一 + 系统管理一枚', () => {
    const nav = navOf(seedMenuNodes());
    // 任务中心与系统管理都不占顶栏（交付方 2026-11-02）：前者只留 nav.tasks 给浮层落点，
    // 后者在齿轮里收成一枚，所以这里少两枚是预期结果，不是漏了推导。
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'quiz', 'notes', 'html']);
    expect(pageKeys(nav.admin)).toEqual(['users', 'roles', 'menus', 'permissions', 'audit']);
    expect(nav.adminEntry).toEqual({ id: 'mn-top-system', label: '系统管理' });
    expect(pageKeys(nav.tasks)).toEqual(['release']);
    expect(pageKeys(nav.settings)).toEqual(['security', 'appearance', 'backup', 'update', 'tools']);
    expect(pageKeys(nav.utilities)).toEqual(['launcher']);
  });

  /** 名单从 `PAGE_META` 推，不手写第二份：加一页时这里自动跟上，也不会"少列一页也算绿"。 */
  it('可达集合就是全部落点，一页不少', () => {
    const nav = navOf(seedMenuNodes());
    expect([...nav.reachable].sort()).toEqual(Object.keys(PAGE_META).sort());
  });

  it('图标与权限门槛都取自 pageMeta，不在本层重写', () => {
    const nav = navOf(seedMenuNodes());
    const users = nav.admin.find((entry) => entry.page === 'users');
    expect(users?.icon).toBe(PAGE_ICONS.users);
    expect(users?.requires).toEqual([PERM.SYS_USER_READ]);
    expect(nav.utilities.find((entry) => entry.page === 'launcher')?.icon).toBe(PAGE_ICONS.launcher);
    expect(nav.utilities.find((entry) => entry.page === 'launcher')?.requires).toEqual([
      PERM.MENU_QUICK_LAUNCHER,
      PERM.SYS_SECURITY_CONFIG,
    ]);
  });
});

describe('节点停用：入口消失，权限不受影响', () => {
  it('停用 top.system 后齿轮那枚「系统管理」与左栏一起消失，顶栏不受影响', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-system', { status: 'disabled' }));
    expect(nav.admin).toEqual([]);
    expect(nav.adminEntry).toBeNull();
    expect(nav.reachable.has('users')).toBe(false);
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'quiz', 'notes', 'html']);
  });

  it('五项二级页全不可进时那一枚也不出（点进去是一屏空壳）', () => {
    const ids = ['mn-system-users', 'mn-system-roles', 'mn-system-menus', 'mn-system-permissions', 'mn-system-audit'];
    const nav = navOf(seedMenuNodes().map((node) =>
      ids.includes(node.id) ? { ...node, status: 'disabled' as const } : node,
    ));
    expect(nav.admin).toEqual([]);
    expect(nav.adminEntry).toBeNull();
  });

  it('停用 top.tasks 后微服务发布既不在浮层落点里也不可达（顶栏本来就没它）', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-tasks', { status: 'disabled' }));
    expect(nav.tasks).toEqual([]);
    expect(nav.reachable.has('release')).toBe(false);
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'quiz', 'notes', 'html']);
  });

  it('停用 system.menus 后左栏少一项，可达集合也不含 menus，那一枚仍在', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-system-menus', { status: 'disabled' }));
    expect(pageKeys(nav.admin)).toEqual(['users', 'roles', 'permissions', 'audit']);
    expect(nav.reachable.has('menus')).toBe(false);
    expect(nav.adminEntry).not.toBeNull();
  });

  it('停用 top.accounts 后账号中心整项不出现', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-accounts', { status: 'disabled' }));
    expect(nav.top.map((entry) => entry.key)).toEqual(['quiz', 'notes', 'html']);
    expect(nav.reachable.has('accounts')).toBe(false);
  });

  it('停用 top.quiz 后题库整项不出现，可达集合也不含 quiz', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-quiz', { status: 'disabled' }));
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'notes', 'html']);
    expect(nav.reachable.has('quiz')).toBe(false);
  });

  it('停用 top.notes 后笔记整项不出现，可达集合也不含 notes', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-notes', { status: 'disabled' }));
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'quiz', 'html']);
    expect(nav.reachable.has('notes')).toBe(false);
  });

  it('停用 gear.settings 后四个设置页一起消失，工具组不受影响', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-gear-settings', { status: 'disabled' }));
    expect(nav.settings).toEqual([]);
    expect(pageKeys(nav.utilities)).toEqual(['launcher']);
  });
});

describe('权限裁剪：菜单节点只是第一道门', () => {
  it('没有 menu.accounts 就没有账号中心：顶栏空，但审计页仍从齿轮可达', () => {
    const nav = navOf(
      seedMenuNodes(),
      new Set([PERM.MENU_SYSTEM, permOf('system.audit'), PERM.SYS_AUDIT_READ]),
    );
    expect(nav.top).toEqual([]);
    expect(pageKeys(nav.admin)).toEqual(['audit']);
    expect(nav.reachable.has('accounts')).toBe(false);
  });

  it('题库要菜单键与 quiz.library.read 两枚，缺一枚就不出入口', () => {
    const withBoth = navOf(
      seedMenuNodes(),
      new Set([permOf('top.quiz'), PERM.QUIZ_LIBRARY_READ]),
    );
    expect(withBoth.top.map((entry) => entry.key)).toEqual(['quiz']);
    expect(withBoth.reachable.has('quiz')).toBe(true);

    const noMenuKey = navOf(seedMenuNodes(), new Set([PERM.QUIZ_LIBRARY_READ]));
    expect(noMenuKey.top).toEqual([]);

    const noRead = navOf(seedMenuNodes(), new Set([permOf('top.quiz')]));
    expect(noRead.top).toEqual([]);
  });

  it('笔记要菜单键与 notes.read 两枚，缺一枚就不出入口', () => {
    const withBoth = navOf(
      seedMenuNodes(),
      new Set([permOf('top.notes'), PERM.NOTES_READ]),
    );
    expect(withBoth.top.map((entry) => entry.key)).toEqual(['notes']);
    expect(withBoth.reachable.has('notes')).toBe(true);

    const noMenuKey = navOf(seedMenuNodes(), new Set([PERM.NOTES_READ]));
    expect(noMenuKey.top).toEqual([]);

    const noRead = navOf(seedMenuNodes(), new Set([permOf('top.notes')]));
    expect(noRead.top).toEqual([]);
  });

  it('任务中心要父级菜单键、二级菜单键与 task.release.view 三枚，缺一枚就不出入口', () => {
    const withAll = navOf(
      seedMenuNodes(),
      new Set([permOf('top.tasks'), permOf('task.release'), PERM.TASK_RELEASE_VIEW]),
    );
    // 它的可达性只看 nav.tasks（浮层落点读的就是这一列）；顶栏不给它胶囊，所以 top 恒空。
    expect(withAll.top).toEqual([]);
    expect(pageKeys(withAll.tasks)).toEqual(['release']);
    expect(withAll.reachable.has('release')).toBe(true);

    const noRoot = navOf(
      seedMenuNodes(),
      new Set([permOf('task.release'), PERM.TASK_RELEASE_VIEW]),
    );
    expect(noRoot.tasks).toEqual([]);
    expect(noRoot.reachable.has('release')).toBe(false);

    const noNode = navOf(seedMenuNodes(), new Set([permOf('top.tasks'), PERM.TASK_RELEASE_VIEW]));
    expect(noNode.tasks).toEqual([]);

    const noView = navOf(
      seedMenuNodes(),
      new Set([permOf('top.tasks'), permOf('task.release')]),
    );
    expect(noView.tasks).toEqual([]);
  });

  it('没有 menu.system 时系统管理连根带叶一起不出现，二级键单独有也没用', () => {
    const nav = navOf(
      seedMenuNodes(),
      new Set([PERM.SYS_USER_READ, PERM.SYS_AUDIT_READ, permOf('system.users'), permOf('system.audit')]),
    );
    expect(nav.admin).toEqual([]);
    expect(nav.reachable.has('users')).toBe(false);
  });

  it('menu.system 有但一项二级权限都没有：齿轮里一枚系统管理页都不出', () => {
    const nav = navOf(seedMenuNodes(), new Set([PERM.MENU_SYSTEM]));
    expect(nav.admin).toEqual([]);
    expect(nav.reachable.has('users')).toBe(false);
  });

  it('二级页按各自的菜单键与操作权限逐项裁剪', () => {
    const nav = navOf(
      seedMenuNodes(),
      new Set([PERM.MENU_SYSTEM, PERM.SYS_USER_READ, permOf('system.users'), permOf('system.audit')]),
    );
    expect(pageKeys(nav.admin)).toEqual(['users']);
  });

  it('父级菜单键缺失时，二级键单独授予也不出现', () => {
    const nav = navOf(seedMenuNodes(), new Set([PERM.SYS_USER_READ, permOf('system.users')]));
    expect(nav.admin).toEqual([]);
  });

  it('设置页与工具页同样各要自己的菜单键，空权限什么都不出现', () => {
    const empty = navOf(seedMenuNodes(), NONE);
    expect(pageKeys(empty.settings)).toEqual([]);
    expect(pageKeys(empty.utilities)).toEqual([]);

    const withSettings = navOf(
      seedMenuNodes(),
      new Set([permOf('gear.settings'), permOf('settings.appearance')]),
    );
    expect(pageKeys(withSettings.settings)).toEqual(['appearance']);
    expect(pageKeys(withSettings.utilities)).toEqual([]);

    const withTools = navOf(
      seedMenuNodes(),
      new Set([
        permOf('gear.tools'),
        PERM.MENU_QUICK_LAUNCHER,
        PERM.SYS_SECURITY_CONFIG,
      ]),
    );
    expect(pageKeys(withTools.utilities)).toEqual(['launcher']);
    expect(pageKeys(withTools.settings)).toEqual([]);
  });

  it('快速启动器要菜单键与安全策略两枚，缺一枚就不出入口', () => {
    const withBoth = navOf(
      seedMenuNodes(),
      new Set([permOf('gear.tools'), PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG]),
    );
    expect(pageKeys(withBoth.utilities)).toEqual(['launcher']);

    const noSecurity = navOf(
      seedMenuNodes(),
      new Set([permOf('gear.tools'), PERM.MENU_QUICK_LAUNCHER]),
    );
    expect(pageKeys(noSecurity.utilities)).toEqual([]);

    const noMenuKey = navOf(
      seedMenuNodes(),
      new Set([permOf('gear.tools'), PERM.SYS_SECURITY_CONFIG]),
    );
    expect(pageKeys(noMenuKey.utilities)).toEqual([]);
  });
});

describe('自定义节点：别名入口', () => {
  it('自定义项出现在页面推导出的分组里，并用自己的名字上屏', () => {
    const nodes = seedMenuNodes();
    nodes.push({
      id: 'mn-custom-audit',
      nodeKey: 'custom.audit-alias',
      parentId: 'mn-top-system',
      label: '合规检查',
      pageKey: 'audit',
      kind: 'page',
      builtin: false,
      status: 'active',
      sortOrder: 60,
      permKey: 'menu.node.custom.audit-alias',
    });
    const nav = navOf(nodes);
    const tail = nav.admin[nav.admin.length - 1];
    expect(tail).toMatchObject({ page: 'audit', label: '合规检查' });
    expect(nav.reachable.has('audit')).toBe(true);
  });

  it('改名只改导航显示名：胶囊、齿轮那一枚与左栏都读节点 label，页头仍读 PAGE_META', () => {
    let nodes = patch(seedMenuNodes(), 'mn-top-accounts', { label: '使用者' });
    nodes = patch(nodes, 'mn-top-system', { label: '后台' });
    nodes = patch(nodes, 'mn-system-users', { label: '成员名单' });
    const nav = navOf(nodes);
    expect(nav.top.find((entry) => entry.key === 'accounts')?.label).toBe('使用者');
    // 齿轮里收成一枚之后，那一枚的名字取的是根节点的 label
    expect(nav.adminEntry?.label).toBe('后台');
    expect(nav.admin.find((entry) => entry.page === 'users')?.label).toBe('成员名单');
    expect(PAGE_META.users.label).toBe('用户管理');
  });

  it('菜单表比界面新时，未知落点不出现也不抛错', () => {
    const nodes = seedMenuNodes();
    nodes.push({
      id: 'mn-settings-unknown',
      nodeKey: 'settings.unknown',
      parentId: 'mn-gear-settings',
      label: '未来页',
      pageKey: 'unknown-page' as unknown as MenuNode['pageKey'],
      kind: 'page',
      builtin: false,
      status: 'active',
      sortOrder: 60,
      permKey: 'menu.node.settings.unknown',
    });
    expect(() => navOf(nodes)).not.toThrow();
    const nav = navOf(nodes);
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'quiz', 'notes', 'html']);
    expect([...nav.reachable].sort()).toEqual(Object.keys(PAGE_META).sort());
  });

  it('同一页面两条入口并存，可达集合按页去重', () => {    const nodes = seedMenuNodes();
    nodes.push({
      id: 'mn-custom-users',
      nodeKey: 'custom.users-alias',
      parentId: 'mn-top-system',
      label: '成员',
      pageKey: 'users',
      kind: 'page',
      builtin: false,
      status: 'active',
      sortOrder: 60,
      permKey: 'menu.node.custom.users-alias',
    });
    const nav = navOf(nodes);
    expect(nav.admin.filter((entry) => entry.page === 'users')).toHaveLength(2);
    expect(nav.admin).toHaveLength(6);
    // 可达集合是按页去重的：两条入口也只代表 users 这一页可进。
    // 枚数拿 PAGE_META 当尺，加一页时这里不必跟着人改一个数
    expect(nav.reachable.size).toBe(Object.keys(PAGE_META).length);
  });
});

describe('兜底落点', () => {
  /** 把 id 名单里的节点停用，其余照种子。链式兜底用例靠它把嵌套压平。 */
  function disabled(ids: string[]): MenuNode[] {
    return seedMenuNodes().map((node) =>
      ids.includes(node.id) ? { ...node, status: 'disabled' as const } : node,
    );
  }

  const TOP_CHAIN = ['mn-top-accounts', 'mn-top-quiz', 'mn-top-notes', 'mn-top-tools', 'mn-top-tasks', 'mn-top-system'];

  it('账号中心优先，其次题库、笔记、页面库、任务中心首项、系统管理首项、设置首项、工具首项', () => {
    expect(firstReachablePage(navOf(disabled([])))).toBe('accounts');
    expect(firstReachablePage(navOf(disabled(TOP_CHAIN.slice(0, 1))))).toBe('quiz');
    expect(firstReachablePage(navOf(disabled(TOP_CHAIN.slice(0, 2))))).toBe('notes');
    expect(firstReachablePage(navOf(disabled(TOP_CHAIN.slice(0, 3))))).toBe('html');
    expect(firstReachablePage(navOf(disabled(TOP_CHAIN.slice(0, 4))))).toBe('release');
    expect(firstReachablePage(navOf(disabled(TOP_CHAIN.slice(0, 5))))).toBe('users');

    const onlySettings = navOf(
      disabled(TOP_CHAIN.slice(0, 6)),
      new Set([permOf('gear.settings'), permOf('settings.appearance')]),
    );
    expect(firstReachablePage(onlySettings)).toBe('appearance');

    const onlyTools = navOf(disabled([...TOP_CHAIN, 'mn-gear-settings']));
    expect(firstReachablePage(onlyTools)).toBe('launcher');
  });

  it('所有入口都停用时返回 null，交给空状态', () => {
    const nodes = seedMenuNodes().map((node) => ({ ...node, status: 'disabled' as const }));
    expect(firstReachablePage(navOf(nodes))).toBeNull();
  });
});

describe('点齿轮里那一枚「系统管理」的落点', () => {
  it('上次那页仍可达就回去', () => {
    expect(resolveAdminLanding(navOf(seedMenuNodes()), 'audit')).toBe('audit');
  });

  it('上次那页被停用就回左栏首项；没进过任何一页时也落首项', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-system-users', { status: 'disabled' }));
    expect(resolveAdminLanding(nav, 'users')).toBe('roles');
    expect(resolveAdminLanding(nav, null)).toBe('roles');
  });

  it('左栏为空时返回 null，不给出会白屏的落点', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-system', { status: 'disabled' }));
    expect(resolveAdminLanding(nav, 'users')).toBeNull();
  });
});

describe('浮层跳任务中心的落点', () => {
  it('取左栏首项；一组里没有可进的二级页时返回 null', () => {
    expect(resolveTasksLanding(navOf(seedMenuNodes()))).toBe('release');
    const disabled = navOf(patch(seedMenuNodes(), 'mn-task-release', { status: 'disabled' }));
    expect(resolveTasksLanding(disabled)).toBeNull();
  });
});

const MENUS_ALIAS: MenuNode = {
  id: 'custom-menus-alias',
  nodeKey: 'custom.menus-alias',
  parentId: 'mn-top-system',
  label: '菜单备份',
  pageKey: 'menus',
  kind: 'page',
  builtin: false,
  status: 'active',
  sortOrder: 60,
  permKey: 'menu.node.custom.menus-alias',
};

describe('停用某枚菜单会不会把「菜单管理」页锁死', () => {
  it('种子树里只有系统管理组与菜单管理本身是必经之路', () => {
    const nodes = seedMenuNodes();
    expect(disableWouldLockOutMenusPage(nodes, 'mn-system-menus')).toBe(true);
    expect(disableWouldLockOutMenusPage(nodes, 'mn-top-system')).toBe(true);
    // 其余节点的停用与 menus 页无关，不能被误锁
    for (const id of [
      'mn-top-accounts',
      'mn-system-users',
      'mn-system-roles',
      'mn-gear-settings',
      'mn-tools-launcher',
    ]) {
      expect(disableWouldLockOutMenusPage(nodes, id)).toBe(false);
    }
  });

  it('认的是树上的路：多加一枚绑定 menus 的别名后，内置菜单管理就能停', () => {
    const withAlias = [...seedMenuNodes(), { ...MENUS_ALIAS }];
    expect(disableWouldLockOutMenusPage(withAlias, 'mn-system-menus')).toBe(false);
    // 两条并存时停哪一条都不锁死；只剩一条时才轮到它被锁
    expect(disableWouldLockOutMenusPage(withAlias, MENUS_ALIAS.id)).toBe(false);

    const builtinOff = withAlias.map((node) =>
      node.id === 'mn-system-menus' ? { ...node, status: 'disabled' as const } : node,
    );
    expect(disableWouldLockOutMenusPage(builtinOff, MENUS_ALIAS.id)).toBe(true);
  });

  it('别名自己停用后不再算活路', () => {
    const aliasOff = [...seedMenuNodes(), { ...MENUS_ALIAS, status: 'disabled' as const }];
    expect(disableWouldLockOutMenusPage(aliasOff, 'mn-system-menus')).toBe(true);
  });

  it('祖先停用或父节点缺失时，子树里的入口都不算活路', () => {
    const withAlias = [...seedMenuNodes(), { ...MENUS_ALIAS }];
    const parentOff = patch(withAlias, 'mn-top-system', { status: 'disabled' });
    expect(disableWouldLockOutMenusPage(parentOff, 'mn-system-users')).toBe(true);

    const orphan = withAlias.filter((node) => node.id !== 'mn-top-system');
    expect(disableWouldLockOutMenusPage(orphan, 'mn-system-users')).toBe(true);
  });
});

/**
 * 夹具与迁移种子同源（**名单从被检对象推导**）。
 *
 * `test/menuFixtures.ts` 那份 20 枚节点是手抄的，一旦迁移加了页而它没跟上，上面这一整组
 * 场景就全在演一份旧库——测试全绿，界面上却少一枚入口，而这条红线恰恰是交付方反复点过的
 * "菜单只决定入口是否出现"。这里直接扫迁移 SQL，把种子真正的 id / nodeKey / pageKey 抽出来对。
 */
describe('夹具必须等于迁移种子（扫 SQL，不靠人记）', () => {
  const ROOT = resolve(process.cwd());
  const read = (name: string) => readFileSync(resolve(ROOT, 'migrations', name), 'utf8');
  const ROW = /\('(mn-[^']+)', '([^']+)', (?:NULL|'[^']+'), '[^']*', (NULL|'[^']+'), '(page|group)'/g;

  /** 0009 建表并种 15 枚；0011 把 page_key='data' 的那一枚连同派生权限一起摘掉；0014/0015/0016/0017/0018 各加进一组入口。 */
  function seededRows(): Array<{ id: string; nodeKey: string; pageKey: string | null; kind: string }> {
    const rows = [...`${read('0009_menu_nodes.sql')}\n${read('0014_external_tools.sql')}\n${read('0015_quiz.sql')}\n${read('0016_task_center.sql')}\n${read('0017_notes.sql')}\n${read('0018_html_pages.sql')}`.matchAll(ROW)].map(
      (m) => ({
        id: m[1],
        nodeKey: m[2],
        pageKey: m[3] === 'NULL' ? null : m[3].replace(/'/g, ''),
        kind: m[4],
      })
    );
    expect(rows.length, '一行种子都没扫到，说明 INSERT 的写法变了，本条守卫要重写').toBeGreaterThanOrEqual(20);
    return rows.filter((row) => !read('0011_remove_data_page.sql').includes(`'${row.nodeKey}'`) && row.pageKey !== 'data');
  }

  it('夹具的 id 与 nodeKey 与种子逐条一致', () => {
    const seed = seededRows();
    expect(SEED_MENU_NODES.map((n) => n.id).sort()).toEqual(seed.map((r) => r.id).sort());
    expect(SEED_MENU_NODES.map((n) => n.nodeKey).sort()).toEqual(seed.map((r) => r.nodeKey).sort());
  });

  it('种子指向的落点全都在 pageMeta 里，pageMeta 里每一页也都有入口', () => {
    const pages = seededRows()
      .filter((row) => row.kind === 'page' && row.pageKey)
      .map((row) => row.pageKey as string)
      .sort();
    expect(pages).toEqual(Object.keys(PAGE_META).sort());
  });
});
