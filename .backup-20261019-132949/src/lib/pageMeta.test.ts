import { describe, expect, it } from 'vitest';
import { PAGE_META, capsuleItems, resolvePage, secondaryItems } from './pageMeta';
import type { MenuEntry } from './types';

/**
 * 顶部胶囊导航的唯一真源。S 轮把导航从左侧栏搬到顶栏胶囊之后，
 * "哪些项能出现"完全由后端 visible_menus 决定（capsuleItems/secondaryItems），
 * 而"这一枚权限覆盖哪几屏"是前端的一张固定映射表（menu.system → 成员/审计/配置三屏）。
 * 这里守的就是这两件事别写歪。
 */
const FULL: MenuEntry[] = [
  { key: 'accounts', label: '账号台账', order: 10 },
  { key: 'system', label: '系统管理', order: 20 },
];

describe('胶囊项由后端菜单推导（前端不凭空加业务项）', () => {
  it('菜单还没回来时一项都不给，顶栏不出现四个还没权限的点', () => {
    expect(capsuleItems(undefined)).toEqual([]);
    expect(capsuleItems([])).toEqual([]);
  });

  it('只有 accounts 权限时胶囊只有一项', () => {
    expect(capsuleItems([FULL[0]])).toEqual(['accounts']);
  });

  it('menu.system 一枚权限展开成成员/审计/配置三屏，顺序照原型', () => {
    expect(capsuleItems([FULL[1]])).toEqual(['members', 'audit', 'settings']);
    expect(capsuleItems(FULL)).toEqual(['accounts', 'members', 'audit', 'settings']);
  });

  it('未知业务键不进胶囊，也不被顺手映射成某个已有页', () => {
    expect(capsuleItems([{ key: 'reports', label: '报表中心', order: 30 }])).toEqual([]);
    expect(resolvePage({ key: 'reports', label: '报表中心', order: 30 })).toBeNull();
  });
});

describe('后端菜单 key/label 的解析口径', () => {
  it('key 大小写与前后缀都能认（后端存的是 menu.accounts 这类点号键）', () => {
    expect(resolvePage({ key: 'MENU.Accounts', label: '随便', order: 1 })).toBe('accounts');
    expect(resolvePage({ key: 'menu.system', label: '随便', order: 1 })).toBe('settings');
    expect(resolvePage({ key: 'menu.quick_launcher', label: '随便', order: 1 })).toBe('launcher');
  });

  it('key 不认识时退回 label 的原型叫法', () => {
    expect(resolvePage({ key: 'x-1', label: '账号管理', order: 1 })).toBe('accounts');
    expect(resolvePage({ key: 'x-2', label: '系统管理', order: 1 })).toBe('settings');
  });

  it('成员管理与审计日志没有独立菜单键：它们由 settings 这一个落点代表', () => {
    // 界面上是三屏，但后端只给一枚 menu.system。这里钉住"不存在 members/audit 的解析分支"，
    // 免得将来有人补一个 if (k.includes('member'))，把那枚权限拆成前端凭空造的三枚。
    expect(resolvePage({ key: 'members', label: '成员管理', order: 1 })).toBeNull();
    expect(resolvePage({ key: 'audit', label: '审计日志', order: 1 })).toBeNull();
  });
});

describe('顶栏「设置」下拉里的两个次级入口', () => {
  it('快速启动器跟着后端菜单走：没给就不出现（快捷键确实没注册）', () => {
    expect(secondaryItems(undefined)).toEqual(['data']);
    expect(secondaryItems(FULL)).toEqual(['data']);
    expect(secondaryItems([...FULL, { key: 'quick_launcher', label: '快速启动器', order: 5 }])).toEqual([
      'launcher',
      'data',
    ]);
  });

  it('导入/导出恒在：这一页不预判权限，由后端逐条命令校验并在页内如实呈现拿不到的部分', () => {
    expect(secondaryItems([])).toContain('data');
    // 后端就算给了一枚同名的 data 菜单，也不会被当成业务页塞进胶囊
    expect(capsuleItems([{ key: 'data', label: '导入/导出', order: 5 }])).toEqual([]);
  });
});

describe('PAGE_META 是导航文案的单一真源', () => {
  it('六个落点都有名字与一句说明，两处不能有一处空着', () => {
    const keys = Object.keys(PAGE_META) as Array<keyof typeof PAGE_META>;
    expect(keys).toEqual(['accounts', 'members', 'audit', 'settings', 'launcher', 'data']);
    for (const key of keys) {
      expect(PAGE_META[key].label.length, `${key} 缺名字`).toBeGreaterThan(1);
      expect(PAGE_META[key].desc.length, `${key} 缺说明`).toBeGreaterThan(10);
    }
  });

  it('胶囊与下拉的每一项都取得到 label（顶栏渲染时不做回落，取不到就是空点）', () => {
    for (const page of [...capsuleItems(FULL), ...secondaryItems(FULL)]) {
      expect(PAGE_META[page].label).toBeTruthy();
    }
  });

  it('术语免责那句还在：账号台账≠本软件登录凭据只能写在页面里，顶栏已经不再承载它', () => {
    // P 轮时这句靠顶栏常驻；S 轮标题/说明搬回各页页头，所以这句现在钉在 PAGE_META.accounts.desc 上，
    // 由 AccountsPage 自己的副标题承担同样的告知义务。
    expect(PAGE_META.accounts.desc).toContain('不是本软件的登录凭据');
  });
});
