import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { PAGE_META, type PageKey } from '../lib/pageMeta';
import { useSession } from '../state/session';
import { useNotify } from '../state/notify';
import { useTheme } from '../state/theme';
import type { AppStatus, MenuEntry } from '../lib/types';

/**
 * 顶栏（原型 .top-navbar）的测试基准：导航从左侧栏搬到顶栏胶囊之后，这一条上只剩四类东西——
 * 品牌、由后端 visible_menus 推导的胶囊、四颗工具钮（搜索 / 界面风格 / 设置 / 当前使用者）。
 * 页名与说明已经搬回各页页头，所以这里还要钉住"顶栏不再承载 h1"，
 * 否则任何一页偷偷把标题塞回顶栏都会让整屏出现两个一级标题。
 */
const mocks = vi.hoisted(() => ({
  menus: vi.fn(),
  launcherVisibility: vi.fn(),
  setTheme: vi.fn(),
  setReduceMotion: vi.fn(),
  updateOwnNickname: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const FULL_MENUS: MenuEntry[] = [
  { key: 'menu.accounts', label: '账号管理', order: 10 },
  { key: 'menu.system', label: '系统管理', order: 20 },
  { key: 'menu.quick_launcher', label: '快速启动器', order: 30 },
];

function status(nickname: string): AppStatus {
  return {
    nickname,
    appVersion: '0.9.0',
    platform: 'macos',
    arch: 'aarch64',
  } as unknown as AppStatus;
}

function renderTopBar(active: PageKey = 'accounts') {
  const onNavigate = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    onNavigate,
    ...render(
      <QueryClientProvider client={qc}>
        <TopBar active={active} onNavigate={onNavigate} />
      </QueryClientProvider>,
    ),
  };
}

/** 胶囊那一块：只按类名取，业务项的数量与顺序正是这一节的判据。 */
function capsule() {
  return screen.getByRole('navigation', { name: '主导航' });
}

/** 先等菜单落地再开下拉：设置/胶囊两块的项都来自 menus.data，抢在 pending 时点开只会少项。 */
async function renderReady(active: PageKey = 'accounts') {
  const view = renderTopBar(active);
  await within(capsule()).findAllByRole('button');
  return view;
}

function openMenu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  return screen.getByRole('menu', { name: label });
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.menus.mockResolvedValue(FULL_MENUS);
  mocks.launcherVisibility.mockResolvedValue(undefined);
  mocks.setTheme.mockResolvedValue(undefined);
  mocks.setReduceMotion.mockResolvedValue(undefined);
  useTheme.setState({ style: 'glass', reduceMotion: false, loaded: true });
  useSession.setState({ status: status('小林'), lock: vi.fn().mockResolvedValue(undefined) });
  useNotify.setState({ items: [] });
});

describe('胶囊导航只画后端给的项', () => {
  it('菜单还没回来时胶囊里一个业务项都没有（宁缺不猜，不先画四个再等权限）', async () => {
    mocks.menus.mockImplementation(() => new Promise(() => {}));
    renderTopBar();
    await waitFor(() => expect(mocks.menus).toHaveBeenCalledTimes(1));
    expect(within(capsule()).queryAllByRole('button')).toHaveLength(0);
  });

  it('menu.accounts + menu.system 铺成四项，顺序与文案照原型', async () => {
    renderTopBar();
    const items = await within(capsule()).findAllByRole('button');
    expect(items.map((el) => el.textContent)).toEqual([
      PAGE_META.accounts.label,
      PAGE_META.members.label,
      PAGE_META.audit.label,
      PAGE_META.settings.label,
    ]);
  });

  it('只给 accounts 权限时不出现成员/审计/配置三项（一枚菜单就是一枚菜单）', async () => {
    mocks.menus.mockResolvedValue([FULL_MENUS[0]]);
    renderTopBar();
    await waitFor(() => expect(within(capsule()).getAllByRole('button')).toHaveLength(1));
    expect(within(capsule()).queryByText(PAGE_META.members.label)).toBeNull();
  });

  it('当前页那颗带 aria-current=page，点另一项交给 onNavigate', async () => {
    const { onNavigate } = renderTopBar();
    await within(capsule()).findAllByRole('button');
    const current = within(capsule()).getByRole('button', { name: PAGE_META.accounts.label });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(within(capsule()).getByRole('button', { name: PAGE_META.audit.label })).not.toHaveAttribute('aria-current');

    fireEvent.click(within(capsule()).getByRole('button', { name: PAGE_META.audit.label }));
    expect(onNavigate).toHaveBeenCalledWith('audit');
  });

  it('顶栏没有一级标题：页名回到各页页头，整屏唯一 h1 不该由这里出', async () => {
    renderTopBar();
    await within(capsule()).findAllByRole('button');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // 品牌名还在，只是它不是标题
    expect(screen.getByText('蒙电信产助手')).toBeInTheDocument();
  });
});

describe('四颗工具钮各自做的事', () => {
  it('全局搜索那颗开的是快速查找浮层，与全局快捷键同一个入口', async () => {
    renderTopBar();
    fireEvent.click(await screen.findByRole('button', { name: '全局搜索' }));
    expect(mocks.launcherVisibility).toHaveBeenCalledWith(true);
  });

  it('浮层打不开时如实报错，不静默：这句得进 aria-live 队列', async () => {
    mocks.launcherVisibility.mockRejectedValue({ code: 'COMMAND_NOT_FOUND', message: '快捷键未注册' });
    renderTopBar();
    fireEvent.click(await screen.findByRole('button', { name: '全局搜索' }));
    await waitFor(() => expect(useNotify.getState().items).toHaveLength(1));
    expect(useNotify.getState().items[0].kind).toBe('danger');
    expect(useNotify.getState().items[0].text).toContain('快捷键未注册');
  });

  it('界面风格下拉恰好四套原型主题，当前那套 aria-checked', async () => {
    await renderReady();
    const menu = openMenu('切换界面风格');
    const options = within(menu).getAllByRole('menuitemradio');
    expect(options.map((el) => el.textContent)).toEqual([
      '极光液态玻璃',
      '极简纯白',
      '曜石暗夜',
      '赛博霓虹',
    ]);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(options[2]);
    expect(useTheme.getState().style).toBe('obsidian');
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian');
  });

  it('设置下拉进的是两个次级页，不是业务页', async () => {
    const { onNavigate } = await renderReady();
    const menu = openMenu('设置');
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      PAGE_META.launcher.label,
      PAGE_META.data.label,
    ]);

    fireEvent.click(within(menu).getByRole('menuitem', { name: PAGE_META.data.label }));
    expect(onNavigate).toHaveBeenCalledWith('data');
  });

  it('导入导出入口不预判权限：后端没给快速启动器菜单时它仍然在，只是少一项', async () => {
    mocks.menus.mockResolvedValue([FULL_MENUS[0], FULL_MENUS[1]]);
    const { onNavigate } = await renderReady();
    const menu = openMenu('设置');
    expect(within(menu).queryByText(PAGE_META.launcher.label)).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: PAGE_META.data.label }));
    expect(onNavigate).toHaveBeenCalledWith('data');
  });

  it('胶囊上只有头像与箭头：昵称不在顶栏，只在下拉第一行', async () => {
    renderTopBar();
    const trigger = await screen.findByRole('button', { name: '当前使用者 小林' });
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
    await renderReady();
    const menu = openMenu('当前使用者 小林');
    const quit = within(menu).getByRole('menuitem', { name: '退出登录' });
    expect(quit).toHaveClass('danger');
    expect(quit.getAttribute('title')).toContain('锁定保险库');

    fireEvent.click(quit);
    await waitFor(() => expect(useSession.getState().lock).toHaveBeenCalledTimes(1));
  });

  it('个人信息弹窗照原型：只有昵称一行，默认只读、右上角一支铅笔', async () => {
    await renderReady();
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
    await renderReady();
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
    // 顶栏头像与下拉第一行读的是同一份会话状态
    await waitFor(() => expect(screen.getByRole('button', { name: '当前使用者 小小林' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '当前使用者 小小林' }));
    const menu = screen.getByRole('menu', { name: '当前使用者 小小林' });
    expect(within(menu).getByText('小小林')).toHaveClass('user-menu-name');
    const trigger = screen.getByRole('button', { name: '当前使用者 小小林' });
    expect(trigger.querySelector('.user-avatar')?.textContent).toBe('小');
  });

  it('清空昵称不会把请求发出去：保存那一步先在本机拦下', async () => {
    await renderReady();
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
    await renderReady();
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
    await renderReady();
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
