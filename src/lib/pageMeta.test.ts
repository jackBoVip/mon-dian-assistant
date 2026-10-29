import { describe, expect, it } from 'vitest';
import {
  ADMIN_ITEMS,
  PAGE_ICONS,
  PAGE_META,
  PAGE_REQUIRES,
  SETTINGS_ITEMS,
  UTILITY_ITEMS,
  isAdminPage,
  isGearPage,
  isSettingsPage,
  type PageKey,
} from './pageMeta';
import { PERM } from './permissions';

/**
 * 页面元数据与权限门槛的唯一静态表。
 * 「入口出不出现」由 lib/menuTree 结合 menu_nodes 推导，这里只守静态映射别写歪。
 */
const PAGES: PageKey[] = [
  'accounts',
  'quiz',
  'users',
  'roles',
  'menus',
  'permissions',
  'audit',
  'security',
  'appearance',
  'backup',
  'update',
  'tools',
  'launcher',
];

describe('十三个落点与页面文案', () => {
  it('PAGE_META 的键顺序就是信息架构的顺序（系统管理五页 + 五个设置页 + 一个工具页）', () => {
    expect(Object.keys(PAGE_META)).toEqual(PAGES);
  });

  it('每一页都有名字与一句说明，两处不能有一处空着', () => {
    for (const key of PAGES) {
      expect(PAGE_META[key].label.length, `${key} 缺名字`).toBeGreaterThan(1);
      expect(PAGE_META[key].desc.length, `${key} 缺说明`).toBeGreaterThan(10);
    }
  });

  it('术语免责那句还在：账号台账≠本软件登录凭据', () => {
    expect(PAGE_META.accounts.desc).toContain('不是本软件的登录凭据');
  });

  it('菜单管理页如实写明新能力与边界：表格树、只绑现有页、不授权', () => {
    expect(PAGE_META.menus.desc).toContain('表格树');
    expect(PAGE_META.menus.desc).toContain('只能绑定现有页面');
    expect(PAGE_META.menus.desc).toContain('菜单只决定入口是否出现，不授予权限');
    expect(PAGE_META.menus.desc).toContain('真正的拒绝仍由后端按操作权限完成');
    // 旧口径必须删干净：三枚固定菜单已经不是这一版的实现
    expect(PAGE_META.menus.desc).not.toContain('固定三枚');
  });

  it('权限管理页写明菜单按级授权，并说明操作权限项不可增删', () => {
    expect(PAGE_META.permissions.desc).toContain('一级、二级入口各自授权');
    expect(PAGE_META.permissions.desc).toContain('菜单权限随菜单创建自动生成');
    expect(PAGE_META.permissions.desc).toContain('操作权限由版本定义，不能增删');
  });
});

describe('权限门槛与图标：十三页一页不缺', () => {
  it('PAGE_REQUIRES 覆盖全部落点，空数组只代表「无需额外权限」', () => {
    expect(Object.keys(PAGE_REQUIRES)).toEqual(PAGES);
    expect(PAGE_REQUIRES.appearance).toEqual([]);
    expect(PAGE_REQUIRES.accounts).toEqual([PERM.MENU_ACCOUNTS]);
    // 题库是一级入口：入口键由菜单节点下发，页面本身只要求读题库
    expect(PAGE_REQUIRES.quiz).toEqual([PERM.QUIZ_LIBRARY_READ]);
    expect(PAGE_REQUIRES.launcher).toEqual([PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG]);
    // 外部工具页的四条写命令都要 system.security.config，入口不给这枚权限就是满屏 FORBIDDEN
    expect(PAGE_REQUIRES.tools).toEqual([PERM.SYS_SECURITY_CONFIG]);
  });

  it('PAGE_ICONS 每页一枚，左栏与齿轮渲染不做回落', () => {
    expect(Object.keys(PAGE_ICONS)).toEqual(PAGES);
    for (const key of PAGES) expect(PAGE_ICONS[key], `${key} 缺图标`).toBeTruthy();
  });

  it('三张导航表各自的门槛就是 PAGE_REQUIRES 那一行，不手抄第二份', () => {
    for (const item of [...ADMIN_ITEMS, ...SETTINGS_ITEMS, ...UTILITY_ITEMS]) {
      expect(item.requires, item.key).toEqual(PAGE_REQUIRES[item.key]);
      expect(item.icon, item.key).toBe(PAGE_ICONS[item.key]);
      expect(item.label).toBe(PAGE_META[item.key].label);
    }
  });

  it('三张表合起来正好覆盖除账号中心与题库外的十一页，且没有重复', () => {
    const keys = [...ADMIN_ITEMS, ...SETTINGS_ITEMS, ...UTILITY_ITEMS].map((item) => item.key);
    expect(keys).toEqual(PAGES.filter((page) => page !== 'accounts' && page !== 'quiz'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  /** 文案许诺的每一条都要后端真做得到：留空=系统默认、失效=回退、本机共用=安装级。 */
  it('外部工具页把三条口径写进说明，且都与 external_tools::plan_launch 的三态对得上', () => {
    expect(PAGE_META.tools.label).toBe('外部工具');
    expect(PAGE_META.tools.desc).toContain('留空即用系统默认');
    expect(PAGE_META.tools.desc).toContain('本机所有使用者');
    expect(PAGE_META.tools.desc).toContain('回退系统默认');
  });
});

describe('页面归属判定', () => {
  it('五个系统管理页归左栏，五个设置页与一个工具页归齿轮', () => {
    for (const key of ['users', 'roles', 'menus', 'permissions', 'audit'] as const) {
      expect(isAdminPage(key), key).toBe(true);
      expect(isSettingsPage(key), key).toBe(false);
      expect(isGearPage(key), key).toBe(false);
    }
    for (const key of ['security', 'appearance', 'backup', 'update', 'tools'] as const) {
      expect(isSettingsPage(key), key).toBe(true);
      expect(isGearPage(key), key).toBe(true);
      expect(isAdminPage(key), key).toBe(false);
    }
    for (const key of ['launcher'] as const) {
      expect(isGearPage(key), key).toBe(true);
      expect(isSettingsPage(key), key).toBe(false);
      expect(isAdminPage(key), key).toBe(false);
    }
    expect(isAdminPage('accounts')).toBe(false);
    expect(isGearPage('accounts')).toBe(false);
    // 题库与账号中心同级：既不进系统管理左栏，也不进齿轮两组
    expect(isAdminPage('quiz')).toBe(false);
    expect(isSettingsPage('quiz')).toBe(false);
    expect(isGearPage('quiz')).toBe(false);
  });
});
