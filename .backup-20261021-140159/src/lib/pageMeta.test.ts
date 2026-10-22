import { describe, expect, it } from 'vitest';
import {
  ADMIN_ITEMS,
  PAGE_META,
  SETTINGS_ITEMS,
  UTILITY_ITEMS,
  adminItems,
  firstAllowedPage,
  isAdminPage,
  isGearPage,
  isPageAllowed,
  isSettingsPage,
  pagePermissionMap,
  resolveAdminLanding,
  settingsItems,
  topItems,
  utilityItems,
} from './pageMeta';
import { PERM } from './permissions';

/**
 * 导航的唯一真源。顶栏两项、系统管理左栏五项、齿轮下拉六项全部由这张表推导，
 * 后端 my_permissions 只负责给键；这里守的是"哪枚权限开哪个入口"的映射别写歪。
 */
const FULL = new Set<string>(Object.values(PERM));
const NONE = new Set<string>();

describe('十二个落点与页面文案', () => {
  it('PAGE_META 的键顺序就是信息架构的顺序（系统管理五页 + 四个设置页 + 两个工具页）', () => {
    expect(Object.keys(PAGE_META)).toEqual([
      'accounts',
      'users',
      'roles',
      'menus',
      'permissions',
      'audit',
      'security',
      'appearance',
      'backup',
      'update',
      'launcher',
      'data',
    ]);
  });

  it('每一页都有名字与一句说明，两处不能有一处空着', () => {
    const keys = Object.keys(PAGE_META) as Array<keyof typeof PAGE_META>;
    for (const key of keys) {
      expect(PAGE_META[key].label.length, `${key} 缺名字`).toBeGreaterThan(1);
      expect(PAGE_META[key].desc.length, `${key} 缺说明`).toBeGreaterThan(10);
    }
  });

  it('术语免责那句还在：账号台账≠本软件登录凭据', () => {
    expect(PAGE_META.accounts.desc).toContain('不是本软件的登录凭据');
  });

  it('菜单管理页如实写明"版本固定三枚、只决定入口"这条边界', () => {
    expect(PAGE_META.menus.desc).toContain('固定三枚一级菜单');
    expect(PAGE_META.menus.desc).toContain('真正的拒绝由后端按操作权限完成');
  });
});

describe('顶栏一级项', () => {
  it('权限还没回来时一项都不给，不先画两个再等权限', () => {
    expect(topItems(undefined)).toEqual([]);
    expect(topItems(NONE)).toEqual([]);
  });

  it('只给 menu.accounts 时只有账号中心', () => {
    expect(topItems(new Set([PERM.MENU_ACCOUNTS]))).toEqual(['accounts']);
  });

  it('只有 menu.system 而没有可用的二级页时不出现系统管理（点进去是空壳）', () => {
    expect(topItems(new Set([PERM.MENU_SYSTEM]))).toEqual([]);
  });

  it('menu.system + 任一二级权限才出现系统管理；全量权限下顺序为账号中心 → 系统管理', () => {
    expect(topItems(new Set([PERM.MENU_SYSTEM, PERM.SYS_AUDIT_READ]))).toEqual(['system']);
    expect(topItems(FULL)).toEqual(['accounts', 'system']);
  });
});

describe('系统管理左栏五项', () => {
  it('全量权限下顺序为 用户 / 角色 / 菜单 / 权限 / 审计', () => {
    expect(adminItems(FULL).map((item) => item.key)).toEqual(['users', 'roles', 'menus', 'permissions', 'audit']);
  });

  it('只读用户权限只开用户管理；角色/菜单/权限三页由 system.role.manage 开', () => {
    expect(adminItems(new Set([PERM.SYS_USER_READ])).map((item) => item.key)).toEqual(['users']);
    expect(adminItems(new Set([PERM.SYS_ROLE_MANAGE])).map((item) => item.key)).toEqual([
      'roles',
      'menus',
      'permissions',
    ]);
  });

  it('审计日志由 system.audit.read 单独开', () => {
    expect(adminItems(new Set([PERM.SYS_AUDIT_READ])).map((item) => item.key)).toEqual(['audit']);
  });

  it('每项都有图标，左栏渲染不做回落', () => {
    for (const item of ADMIN_ITEMS) expect(item.icon, `${item.key} 缺图标`).toBeTruthy();
  });
});

describe('齿轮下拉两组', () => {
  it('第一组是四个独立设置页，顺序照确认稿', () => {
    expect(settingsItems(FULL).map((item) => item.key)).toEqual(['security', 'appearance', 'backup', 'update']);
  });

  it('界面外观不需要任何权限，其余三页各要一枚', () => {
    expect(settingsItems(NONE).map((item) => item.key)).toEqual(['appearance']);
    expect(settingsItems(new Set([PERM.SYS_SECURITY_CONFIG, PERM.SYS_UPDATE_CONFIG])).map((item) => item.key)).toEqual([
      'security',
      'appearance',
      'update',
    ]);
  });

  it('第二组是快速启动器 + 导入/导出：后者恒在，前者要菜单与安全策略两枚', () => {
    expect(utilityItems(NONE).map((item) => item.key)).toEqual(['data']);
    expect(utilityItems(new Set([PERM.MENU_QUICK_LAUNCHER])).map((item) => item.key)).toEqual(['data']);
    expect(
      utilityItems(new Set([PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG])).map((item) => item.key),
    ).toEqual(['launcher', 'data']);
  });

  it('两组合起来的分组顺序就是下拉的渲染顺序', () => {
    expect([...settingsItems(FULL), ...utilityItems(FULL)].map((item) => item.key)).toEqual([
      'security',
      'appearance',
      'backup',
      'update',
      'launcher',
      'data',
    ]);
  });
});

describe('页面归属判定', () => {
  it('五个系统管理页归左栏，四个设置页与两个工具页归齿轮', () => {
    for (const key of ['users', 'roles', 'menus', 'permissions', 'audit'] as const) {
      expect(isAdminPage(key), key).toBe(true);
      expect(isSettingsPage(key), key).toBe(false);
      expect(isGearPage(key), key).toBe(false);
    }
    for (const key of ['security', 'appearance', 'backup', 'update'] as const) {
      expect(isSettingsPage(key), key).toBe(true);
      expect(isGearPage(key), key).toBe(true);
      expect(isAdminPage(key), key).toBe(false);
    }
    for (const key of ['launcher', 'data'] as const) {
      expect(isGearPage(key), key).toBe(true);
      expect(isAdminPage(key), key).toBe(false);
    }
    expect(isAdminPage('accounts')).toBe(false);
    expect(isGearPage('accounts')).toBe(false);
  });
});

describe('每一页自身的准入门槛', () => {
  it('账号中心要 menu.accounts', () => {
    expect(isPageAllowed('accounts', FULL)).toBe(true);
    expect(isPageAllowed('accounts', NONE)).toBe(false);
  });

  it('系统管理页要 menu.system 且要该项自己的操作权限（缺一不可）', () => {
    expect(isPageAllowed('users', new Set([PERM.SYS_USER_READ]))).toBe(false);
    expect(isPageAllowed('users', new Set([PERM.MENU_SYSTEM]))).toBe(false);
    expect(isPageAllowed('users', new Set([PERM.MENU_SYSTEM, PERM.SYS_USER_READ]))).toBe(true);
    expect(isPageAllowed('audit', new Set([PERM.MENU_SYSTEM, PERM.SYS_AUDIT_READ]))).toBe(true);
  });

  it('菜单可见性只决定顶栏入口；设置页与工具页不走 menu.system', () => {
    expect(isPageAllowed('security', new Set([PERM.SYS_SECURITY_CONFIG]))).toBe(true);
    expect(isPageAllowed('appearance', NONE)).toBe(true);
    expect(isPageAllowed('data', NONE)).toBe(true);
    expect(isPageAllowed('launcher', new Set([PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG]))).toBe(true);
    expect(isPageAllowed('launcher', new Set([PERM.MENU_QUICK_LAUNCHER]))).toBe(false);
  });
});

describe('点「系统管理」的落点', () => {
  it('没有 menu.system 或一项二级页都没有时返回 null', () => {
    expect(resolveAdminLanding(NONE, null)).toBeNull();
    expect(resolveAdminLanding(new Set([PERM.MENU_SYSTEM]), 'users')).toBeNull();
    expect(resolveAdminLanding(new Set([PERM.MENU_SYSTEM]), null)).toBeNull();
  });

  it('上次访问的二级页仍可用就回去', () => {
    expect(resolveAdminLanding(FULL, 'audit')).toBe('audit');
  });

  it('上次那页已被撤销就回退到第一项可用页', () => {
    const perms = new Set([PERM.MENU_SYSTEM, PERM.SYS_AUDIT_READ]);
    expect(resolveAdminLanding(perms, 'users')).toBe('audit');
    expect(resolveAdminLanding(perms, null)).toBe('audit');
  });
});

describe('权限被撤销后的兜底落点', () => {
  it('账号中心优先，其次系统管理首页', () => {
    expect(firstAllowedPage(FULL)).toBe('accounts');
    expect(firstAllowedPage(new Set([PERM.MENU_SYSTEM, PERM.SYS_AUDIT_READ]))).toBe('audit');
  });

  it('没有账号中心与系统管理时落到第一个可用设置页；界面外观无需权限，所以永远有落点', () => {
    expect(firstAllowedPage(new Set([PERM.SYS_BACKUP_MANAGE]))).toBe('appearance');
    expect(firstAllowedPage(new Set([PERM.SYS_SECURITY_CONFIG]))).toBe('security');
    expect(firstAllowedPage(NONE)).toBe('appearance');
  });
});

describe('二级页 → 所需权限的对照表', () => {
  it('由三张导航表推导，不手抄名单', () => {
    expect(pagePermissionMap().map((row) => row.page)).toEqual([
      ...ADMIN_ITEMS.map((item) => item.key),
      ...SETTINGS_ITEMS.map((item) => item.key),
      ...UTILITY_ITEMS.map((item) => item.key),
    ]);
    expect(pagePermissionMap()).toHaveLength(11);
  });

  it('每一行的门槛与它所在的那张表一致', () => {
    for (const row of pagePermissionMap()) {
      const source = [...ADMIN_ITEMS, ...SETTINGS_ITEMS, ...UTILITY_ITEMS].find((item) => item.key === row.page);
      expect(row.label).toBe(source?.label);
      expect(row.requires).toEqual(source?.requires);
    }
  });
});
