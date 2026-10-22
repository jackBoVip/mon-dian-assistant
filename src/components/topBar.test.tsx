import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { pointerTap } from '../test/pointer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { PAGE_META, type AdminPageKey, type PageKey } from '../lib/pageMeta';
import { PERM } from '../lib/permissions';
import { buildNav, type NavTree } from '../lib/menuTree';
import { seedMenuNodes } from '../test/menuFixtures';
import { useSession } from '../state/session';
import { useNotify } from '../state/notify';
import { useTheme } from '../state/theme';
import type { AppStatus } from '../lib/types';

/**
 * 顶栏的测试基准：一级胶囊只有「账号中心 / 系统管理」两项，齿轮下拉分两组。
 * 顺序与启停来自 menu_nodes，可见性来自 my_permissions——两者在 lib/menuTree 合并后
 * 以 NavTree 传进来。这里守的是顶栏如何消费这棵树，以及设置页激活时齿轮的激活态。
 */
const mocks = vi.hoisted(() => ({
  launcherVisibility: vi.fn(),
  setTheme: vi.fn(),
  setReduceMotion: vi.fn(),
  updateOwnNickname: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const FULL_PERMS = new Set<string>([
  ...Object.values(PERM),
  ...seedMenuNodes().map((node) => node.permKey),
]);
const SYSTEM_LABEL = '系统管理';

function permOf(nodeKey: string): string {
  const node = seedMenuNodes().find((n) => n.nodeKey === nodeKey);
  if (!node) throw new Error(`夹具里没有 ${nodeKey}`);
  return node.permKey;
}

function navFor(perms: ReadonlySet<string> = FULL_PERMS, nodes = seedMenuNodes()): NavTree {
  return buildNav(nodes, perms);
}

function status(nickname: string): AppStatus {
  return {
    nickname,
    appVersion: '0.9.0',
    platform: 'macos',
    arch: 'aarch64',
  } as unknown as AppStatus;
}

function renderTopBar(
  active: PageKey = 'accounts',
  lastAdminPage: AdminPageKey | null = null,
  nav: NavTree | null = navFor(),
) {
  const onNavigate = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    onNavigate,
    ...render(
      <QueryClientProvider client={qc}>
        <TopBar active={active} lastAdminPage={lastAdminPage} nav={nav} onNavigate={onNavigate} />
      </QueryClientProvider>,
    ),
  };
}

/** 胶囊那一块：只按类名取，业务项的数量与顺序正是这一节的判据。 */
function capsule() {
  return screen.getByRole('navigation', { name: '主导航' });
}

function openMenu(label: string) {
  pointerTap(screen.getByRole('button', { name: label }));
  return screen.getByRole('menu', { name: label });
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.launcherVisibility.mockResolvedValue(undefined);
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setReduceMotion.mockResolvedValue(undefined);
  useTheme.setState({ style: 'glass', reduceMotion: false, loaded: true });
  useSession.setState({ status: status('小林'), lock: vi.fn().mockResolvedValue(undefined) });
  useNotify.setState({ items: [] });
});

describe('一级胶囊只有账号中心与系统管理', () => {
  it('导航树还没就绪时胶囊里一个业务项都没有（宁缺不猜）', () => {
    renderTopBar('accounts', null, null);
    expect(within(capsule()).queryAllByRole('button')).toHaveLength(0);
  });

  it('全量权限下是两项，顺序为账号中心 → 系统管理', () => {
    renderTopBar();
    expect(within(capsule()).getAllByRole('button').map((el) => el.textContent)).toEqual([
      PAGE_META.accounts.label,
      SYSTEM_LABEL,
    ]);
  });

  it('只给 menu.accounts 时只有账号中心', () => {
    renderTopBar('accounts', null, navFor(new Set([PERM.MENU_ACCOUNTS])));
    expect(within(capsule()).getAllByRole('button').map((el) => el.textContent)).toEqual([
      PAGE_META.accounts.label,
    ]);
  });

  it('只有 menu.system 而没有可用二级页时系统管理不出现（点进去是空壳）', () => {
    renderTopBar('accounts', null, navFor(new Set([PERM.MENU_SYSTEM])));
    expect(within(capsule()).queryByText(SYSTEM_LABEL)).toBeNull();
  });

  it('停用 top.system 后系统管理从胶囊消失；自定义别名按节点名字上屏', () => {
    const disabled = seedMenuNodes().map((node) =>
      node.id === 'mn-top-system' ? { ...node, status: 'disabled' as const } : node,
    );
    const first = renderTopBar('accounts', null, navFor(FULL_PERMS, disabled));
    expect(within(capsule()).queryByText(SYSTEM_LABEL)).toBeNull();
    first.unmount();

    const renamed = seedMenuNodes().map((node) =>
      node.id === 'mn-top-system' ? { ...node, label: '后台' } : node,
    );
    renderTopBar('accounts', null, navFor(FULL_PERMS, renamed));
    expect(within(capsule()).getByRole('button', { name: '后台' })).toBeInTheDocument();
  });

  it('当前页那颗带 aria-current=page；系统管理在任一二级页都算当前', () => {
    renderTopBar();
    expect(within(capsule()).getByRole('button', { name: PAGE_META.accounts.label })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(capsule()).getByRole('button', { name: SYSTEM_LABEL })).not.toHaveAttribute('aria-current');
  });

  it('停在系统管理任一页时，系统管理那颗带 aria-current=page', () => {
    renderTopBar('audit');
    expect(within(capsule()).getByRole('button', { name: SYSTEM_LABEL })).toHaveAttribute('aria-current', 'page');
    expect(within(capsule()).getByRole('button', { name: PAGE_META.accounts.label })).not.toHaveAttribute('aria-current');
  });

  it('点系统管理回到上次访问的二级页；没有记录时落第一项可用页', () => {
    const first = renderTopBar('accounts', 'audit');
    fireEvent.click(within(capsule()).getByRole('button', { name: SYSTEM_LABEL }));
    expect(first.onNavigate).toHaveBeenCalledWith('audit');
    first.unmount();

    const second = renderTopBar('accounts');
    fireEvent.click(within(capsule()).getByRole('button', { name: SYSTEM_LABEL }));
    expect(second.onNavigate).toHaveBeenCalledWith('users');
  });

  it('顶栏没有一级标题：页名回到各页页头，整屏唯一 h1 不该由这里出', () => {
    renderTopBar();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByText('蒙电信产助手')).toBeInTheDocument();
  });
});

describe('顶栏就是这扇 Overlay 窗的拖拽区（交付方：桌面用户无法拖拽整个应用移动）', () => {
  it('拖拽区挂在条上，用 deep 语义；条里那些可点元素一枚都不挂', () => {
    const { container } = renderTopBar();
    const bar = container.querySelector('header.top-navbar');
    expect(bar, '顶栏没挂 data-tauri-drag-region ⇒ 主窗（titleBarStyle Overlay）没有任何地方能发起 start_dragging').not.toBeNull();
    // deep = 子树里点空白也能拖；裸值只有直接点中挂属性的那个元素才拖，而顶栏的可见面积几乎全被子元素占满。
    expect(bar).toHaveAttribute('data-tauri-drag-region', 'deep');
    // drag.js 遇到 button/a/input/select/[role=button|tab|switch…] 会放弃拖拽，所以可点元素一枚都不该挂属性。
    for (const b of within(bar as HTMLElement).getAllByRole('button')) {
      expect(b).not.toHaveAttribute('data-tauri-drag-region');
    }
  });
});

describe('四颗工具钮各自做的事', () => {
  it('全局搜索那颗开的是快速查找浮层，与全局快捷键同一个入口', async () => {
    renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: '全局搜索' }));
    await waitFor(() => expect(mocks.launcherVisibility).toHaveBeenCalledWith(true));
  });

  it('浮层打不开时如实报错，不静默：这句得进 aria-live 队列', async () => {
    mocks.launcherVisibility.mockRejectedValue({ code: 'COMMAND_NOT_FOUND', message: '快捷键未注册' });
    renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: '全局搜索' }));
    await waitFor(() => expect(useNotify.getState().items).toHaveLength(1));
    expect(useNotify.getState().items[0].kind).toBe('danger');
    expect(useNotify.getState().items[0].text).toContain('快捷键未注册');
  });

  it('界面风格下拉恰好四套原型主题，当前那套 aria-checked', () => {
    renderTopBar();
    const menu = openMenu('切换界面风格');
    const options = within(menu).getAllByRole('menuitemradio');
    expect(options.map((el) => el.textContent)).toEqual(['极光液态', '极简纯白', '曜石暗夜', '赛博霓虹']);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(options[2]);
    expect(useTheme.getState().style).toBe('obsidian');
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian');
  });
});

describe('齿轮下拉：四个设置页 + 一个工具页', () => {
  it('全量权限下五项按「设置页 → 分隔线 → 工具页」排列', () => {
    renderTopBar();
    const menu = openMenu('设置');
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      PAGE_META.security.label,
      PAGE_META.appearance.label,
      PAGE_META.backup.label,
      PAGE_META.update.label,
      PAGE_META.launcher.label,
    ]);
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('按权限裁剪：没有备份/更新权限时只剩安全策略、界面外观与快速启动器', () => {
    renderTopBar(
      'accounts',
      null,
      navFor(
        new Set([
          PERM.MENU_ACCOUNTS,
          PERM.SYS_SECURITY_CONFIG,
          permOf('gear.settings'),
          permOf('settings.security'),
          permOf('settings.appearance'),
          permOf('gear.tools'),
          PERM.MENU_QUICK_LAUNCHER,
        ]),
      ),
    );
    const menu = openMenu('设置');
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      PAGE_META.security.label,
      PAGE_META.appearance.label,
      PAGE_META.launcher.label,
    ]);
    // 两组都还有内容，分隔线保留；少的只是设置页里的备份/更新
    expect(within(menu).getAllByRole('separator')).toHaveLength(1);
  });

  it('停用某个二级节点后下拉里那一项消失，其余顺序不变', () => {
    const nodes = seedMenuNodes().map((node) =>
      node.id === 'mn-settings-backup' ? { ...node, status: 'disabled' as const } : node,
    );
    renderTopBar('accounts', null, navFor(FULL_PERMS, nodes));
    const menu = openMenu('设置');
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      PAGE_META.security.label,
      PAGE_META.appearance.label,
      PAGE_META.update.label,
      PAGE_META.launcher.label,
    ]);
  });

  it('快速启动器要菜单与安全策略两枚权限；后一枚缺了就不出入口', () => {
    const first = renderTopBar(
      'accounts',
      null,
      navFor(new Set([PERM.MENU_QUICK_LAUNCHER, PERM.SYS_SECURITY_CONFIG, permOf('gear.tools')])),
    );
    const menu = openMenu('设置');
    expect(within(menu).getByRole('menuitem', { name: PAGE_META.launcher.label })).toBeInTheDocument();
    first.unmount();

    renderTopBar(
      'accounts',
      null,
      navFor(new Set([PERM.MENU_QUICK_LAUNCHER, permOf('gear.tools'), permOf('gear.settings')])),
    );
    const second = openMenu('设置');
    expect(within(second).queryByRole('menuitem', { name: PAGE_META.launcher.label })).toBeNull();
  });

  it('点下拉项交给 onNavigate', () => {
    const { onNavigate } = renderTopBar();
    const menu = openMenu('设置');
    pointerTap(within(menu).getByRole('menuitem', { name: PAGE_META.launcher.label }));
    expect(onNavigate).toHaveBeenCalledWith('launcher');
  });

  it('停在任一设置页/工具页时齿轮带激活态，其余页不带', () => {
    const gear = renderTopBar('security');
    const trigger = screen.getByRole('button', { name: '设置' });
    expect(trigger).toHaveClass('icon-btn', 'is-active');
    gear.unmount();

    renderTopBar('accounts');
    expect(screen.getByRole('button', { name: '设置' })).not.toHaveClass('is-active');
  });
});

describe('当前使用者下拉', () => {
  it('胶囊上只有头像与箭头：昵称不在顶栏，只在下拉第一行', () => {
    renderTopBar();
    const trigger = screen.getByRole('button', { name: '当前使用者 小林' });
    // 头像那颗取昵称首字，是视觉件：得对读屏静音，不然可及名会变成「小小林」
    expect(trigger.querySelector('.user-avatar')?.textContent).toBe('小');
    expect(trigger.querySelector('.user-avatar')?.getAttribute('aria-hidden')).toBe('true');
    // 昵称仍然在可及名里（上面那条 button 的 name 就是它），但界面上不再上屏
    expect(trigger.querySelector('.user-profile-name')).toBeNull();
    expect(trigger.textContent).toBe('小');
    expect(document.body.textContent).not.toContain('本软件用户');

    const menu = openMenu('当前使用者 小林');
    const name = within(menu).getByText('小林');
    expect(name).toHaveClass('user-menu-name');
    // 名字行是只读展示，不是菜单项：它不进 role="menuitem"，也就不会被键盘当成可点的一行
    expect(within(menu).queryByRole('menuitem', { name: '小林' })).toBeNull();
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      '个人信息',
      '修改密码',
      '退出登录',
    ]);
  });

  it('退出登录那颗说的是锁定保险库：danger 样式 + title 说明真实行为', async () => {
    renderTopBar();
    const menu = openMenu('当前使用者 小林');
    const quit = within(menu).getByRole('menuitem', { name: '退出登录' });
    expect(quit).toHaveClass('danger');
    expect(quit.getAttribute('title')).toContain('锁定保险库');

    fireEvent.click(quit);
    await waitFor(() => expect(useSession.getState().lock).toHaveBeenCalledTimes(1));
  });

  it('个人信息弹窗照原型：只有昵称一行，默认只读、右上角一支铅笔', async () => {
    renderTopBar();
    fireEvent.click(within(openMenu('当前使用者 小林')).getByRole('menuitem', { name: '个人信息' }));

    const dialog = await screen.findByRole('dialog', { name: '个人信息' });
    expect(within(dialog).getByRole('textbox', { name: '昵称' })).toHaveAttribute('readonly');
    expect(within(dialog).getByRole('button', { name: '编辑昵称' })).toBeInTheDocument();
    // 原型这一屏只有昵称：应用版本/运行平台回到系统管理页，不在这里重复占一行
    expect(within(dialog).queryByRole('textbox', { name: '应用版本' })).toBeNull();
    expect(within(dialog).queryByRole('textbox', { name: '运行平台' })).toBeNull();
    // 那句"改不了"的实话跟着能力一起撤掉
    expect(within(dialog).queryByText(/本版本没有改名命令/)).toBeNull();
    // 头部只有关闭那颗 X：保存靠铅笔，底部不再有第二颗按钮
    expect(within(dialog).queryByRole('button', { name: '保存' })).toBeNull();
  });

  it('铅笔改成编辑态，保存后新昵称进下拉第一行、头像首字跟着换', async () => {
    mocks.updateOwnNickname.mockResolvedValue(status('小小林'));
    renderTopBar();
    fireEvent.click(within(openMenu('当前使用者 小林')).getByRole('menuitem', { name: '个人信息' }));
    const dialog = await screen.findByRole('dialog', { name: '个人信息' });

    fireEvent.click(within(dialog).getByRole('button', { name: '编辑昵称' }));
    const input = within(dialog).getByRole('textbox', { name: '昵称' });
    expect(input).not.toHaveAttribute('readonly');
    // 进入编辑态时那支铅笔自己变成保存勾：同一颗按钮、两个名字
    expect(within(dialog).getByRole('button', { name: '保存昵称' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '小小林' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存昵称' }));

    await waitFor(() => expect(mocks.updateOwnNickname).toHaveBeenCalledWith('小小林'));
    await waitFor(() => expect(useSession.getState().status?.nickname).toBe('小小林'));
    // 弹窗不自动关（保存只 notify），而模态开着的时候背景是**真的点不到**：
    // Radix 会把背景整棵子树 aria-hidden + pointer-events:none。
    // 旧版手写模态没有这一层，fireEvent.click 又绕过命中测试，于是这里曾经能直接点到顶栏——
    // 那条路径在浏览器里并不存在（遮罩 fixed inset 0 盖着）。按真实流程先关掉弹窗。
    fireEvent.click(within(screen.getByRole('dialog', { name: '个人信息' })).getByRole('button', { name: '关闭' }));
    // 顶栏头像与下拉第一行读的是同一份会话状态
    await waitFor(() => expect(screen.getByRole('button', { name: '当前使用者 小小林' })).toBeInTheDocument());
    pointerTap(screen.getByRole('button', { name: '当前使用者 小小林' }));
    const menu = screen.getByRole('menu', { name: '当前使用者 小小林' });
    expect(within(menu).getByText('小小林')).toHaveClass('user-menu-name');
    const trigger = screen.getByRole('button', { name: '当前使用者 小小林' });
    expect(trigger.querySelector('.user-avatar')?.textContent).toBe('小');
  });

  it('清空昵称不会把请求发出去：保存那一步先在本机拦下', async () => {
    renderTopBar();
    fireEvent.click(within(openMenu('当前使用者 小林')).getByRole('menuitem', { name: '个人信息' }));
    const dialog = await screen.findByRole('dialog', { name: '个人信息' });
    fireEvent.click(within(dialog).getByRole('button', { name: '编辑昵称' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: '昵称' }), { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存昵称' }));

    await waitFor(() => expect(useNotify.getState().items.length).toBeGreaterThan(0));
    expect(mocks.updateOwnNickname).not.toHaveBeenCalled();
    expect(useSession.getState().status?.nickname).toBe('小林');
  });

  it('后端拒绝时如实报错，昵称与下拉都停在原值、且不弹回只读', async () => {
    mocks.updateOwnNickname.mockRejectedValue({ code: 'NICKNAME_TOO_LONG', message: '昵称太长，最多 40 个字' });
    renderTopBar();
    fireEvent.click(within(openMenu('当前使用者 小林')).getByRole('menuitem', { name: '个人信息' }));
    const dialog = await screen.findByRole('dialog', { name: '个人信息' });
    fireEvent.click(within(dialog).getByRole('button', { name: '编辑昵称' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: '昵称' }), { target: { value: '很长的名字' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存昵称' }));

    await waitFor(() => expect(useNotify.getState().items.length).toBeGreaterThan(0));
    const last = useNotify.getState().items[useNotify.getState().items.length - 1];
    expect(last.kind).toBe('danger');
    expect(last.text).toContain('昵称太长');
    expect(useSession.getState().status?.nickname).toBe('小林');
    // 没存上就停在编辑态：让用户能改回去，而不是被弹回只读、以为已经保存了
    expect(within(dialog).getByRole('button', { name: '保存昵称' })).toBeInTheDocument();
  });

  it('修改密码弹窗的标题与三栏名字照原型，且不含任何位数要求', async () => {
    renderTopBar();
    fireEvent.click(within(openMenu('当前使用者 小林')).getByRole('menuitem', { name: '修改密码' }));

    const dialog = await screen.findByRole('dialog', { name: '修改密码' });
    expect(within(dialog).getByLabelText('当前密码')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('新密码')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('确认新密码')).toBeInTheDocument();
    // L 轮取消了主密码强度策略：原型那句"至少 8 位"在这版本里做不到，不写上屏
    expect(dialog.textContent).not.toMatch(/至少\s*8\s*位/);
    expect(within(dialog).getByRole('button', { name: '保存修改' })).toBeInTheDocument();
  });
});
