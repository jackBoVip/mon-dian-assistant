import { describe, expect, it } from 'vitest';
import {
  buildNav,
  disableWouldLockOutMenusPage,
  firstReachablePage,
  resolveAdminLanding,
  type NavTree,
} from './menuTree';
import { PERM } from './permissions';
import { PAGE_ICONS, PAGE_META } from './pageMeta';
import type { MenuNode } from './types';
import { seedMenuNodes } from '../test/menuFixtures';

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
  it('顶栏两项、左栏五项、齿轮四 + 一，顺序照 sort_order', () => {
    const nav = navOf(seedMenuNodes());
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts', 'system']);
    expect(pageKeys(nav.admin)).toEqual(['users', 'roles', 'menus', 'permissions', 'audit']);
    expect(pageKeys(nav.settings)).toEqual(['security', 'appearance', 'backup', 'update']);
    expect(pageKeys(nav.utilities)).toEqual(['launcher']);
  });

  it('可达集合由实际入口推导，十一页一个不少', () => {
    const nav = navOf(seedMenuNodes());
    expect([...nav.reachable].sort()).toEqual(
      [
        'accounts',
        'audit',
        'appearance',
        'backup',
        'launcher',
        'menus',
        'permissions',
        'roles',
        'security',
        'update',
        'users',
      ].sort(),
    );
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
  it('停用 top.system 后顶栏没有系统管理，左栏清空', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-system', { status: 'disabled' }));
    expect(nav.top.map((entry) => entry.key)).toEqual(['accounts']);
    expect(nav.admin).toEqual([]);
  });

  it('停用 system.menus 后左栏少一项，可达集合也不含 menus', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-system-menus', { status: 'disabled' }));
    expect(pageKeys(nav.admin)).toEqual(['users', 'roles', 'permissions', 'audit']);
    expect(nav.reachable.has('menus')).toBe(false);
  });

  it('停用 top.accounts 后账号中心整项不出现', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-accounts', { status: 'disabled' }));
    expect(nav.top.map((entry) => entry.key)).toEqual(['system']);
    expect(nav.reachable.has('accounts')).toBe(false);
  });

  it('停用 gear.settings 后四个设置页一起消失，工具组不受影响', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-gear-settings', { status: 'disabled' }));
    expect(nav.settings).toEqual([]);
    expect(pageKeys(nav.utilities)).toEqual(['launcher']);
  });
});

describe('权限裁剪：菜单节点只是第一道门', () => {
  it('没有 menu.accounts 就没有账号中心', () => {
    const nav = navOf(
      seedMenuNodes(),
      new Set([PERM.MENU_SYSTEM, permOf('system.audit'), PERM.SYS_AUDIT_READ]),
    );
    expect(nav.top.map((entry) => entry.key)).toEqual(['system']);
    expect(nav.reachable.has('accounts')).toBe(false);
  });

  it('没有 menu.system 时系统管理连根带叶一起不出现，二级键单独有也没用', () => {
    const nav = navOf(
      seedMenuNodes(),
      new Set([PERM.SYS_USER_READ, PERM.SYS_AUDIT_READ, permOf('system.users'), permOf('system.audit')]),
    );
    expect(nav.top.map((entry) => entry.key)).toEqual([]);
    expect(nav.admin).toEqual([]);
  });

  it('menu.system 有但一项二级权限都没有：系统管理不出现在胶囊', () => {
    const nav = navOf(seedMenuNodes(), new Set([PERM.MENU_SYSTEM]));
    expect(nav.top.map((entry) => entry.key)).toEqual([]);
    expect(nav.admin).toEqual([]);
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

  it('改名只改导航显示名：顶栏读节点 label，页头仍读 PAGE_META', () => {
    const nodes = patch(seedMenuNodes(), 'mn-top-system', { label: '后台' });
    const nav = navOf(nodes);
    expect(nav.top.find((entry) => entry.key === 'system')?.label).toBe('后台');
    expect(PAGE_META.users.label).toBe('用户管理');
  });

  it('同一页面两条入口并存，可达集合按页去重', () => {
    const nodes = seedMenuNodes();
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
    // 可达集合是按页去重的：两条入口也只代表 users 这一页可进
    expect(nav.reachable.size).toBe(11);
  });
});

describe('兜底落点', () => {
  it('账号中心优先，其次系统管理首项、设置首项、工具首项', () => {
    expect(firstReachablePage(navOf(seedMenuNodes()))).toBe('accounts');

    const noAccounts = navOf(patch(seedMenuNodes(), 'mn-top-accounts', { status: 'disabled' }));
    expect(firstReachablePage(noAccounts)).toBe('users');

    const onlySettings = navOf(
      patch(seedMenuNodes(), 'mn-top-accounts', { status: 'disabled' }),
      new Set([permOf('gear.settings'), permOf('settings.appearance')]),
    );
    expect(firstReachablePage(onlySettings)).toBe('appearance');

    const onlyTools = navOf(
      patch(
        patch(
          patch(seedMenuNodes(), 'mn-top-accounts', { status: 'disabled' }),
          'mn-top-system',
          { status: 'disabled' },
        ),
        'mn-gear-settings',
        { status: 'disabled' },
      ),
    );
    expect(firstReachablePage(onlyTools)).toBe('launcher');
  });

  it('所有入口都停用时返回 null，交给空状态', () => {
    const nodes = seedMenuNodes().map((node) => ({ ...node, status: 'disabled' as const }));
    expect(firstReachablePage(navOf(nodes))).toBeNull();
  });
});

describe('点系统管理的落点', () => {
  it('上次那页仍可达就回去', () => {
    expect(resolveAdminLanding(navOf(seedMenuNodes()), 'audit')).toBe('audit');
  });

  it('上次那页被停用就回左栏首项', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-system-users', { status: 'disabled' }));
    expect(resolveAdminLanding(nav, 'users')).toBe('roles');
    expect(resolveAdminLanding(nav, null)).toBe('roles');
  });

  it('左栏为空时返回 null，不给出会白屏的落点', () => {
    const nav = navOf(patch(seedMenuNodes(), 'mn-top-system', { status: 'disabled' }));
    expect(resolveAdminLanding(nav, 'users')).toBeNull();
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
