import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { pointerTap } from '../test/pointer';
import { PAGE_META } from '../lib/pageMeta';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/queryClient';
import { useSession } from '../state/session';
import { useTheme } from '../state/theme';
import { useLauncherNav } from '../state/launcherNav';
import { seedMenuNodes } from '../test/menuFixtures';
import type { MenuNode } from '../lib/types';

const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  listMenuNodes: vi.fn(),
  launcherVisibility: vi.fn(),
  events: { name: '', handler: null as null | ((payload: unknown) => void) },
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      myPermissions: mocks.myPermissions,
      listMenuNodes: mocks.listMenuNodes,
      launcherVisibility: mocks.launcherVisibility,
    },
  };
});

vi.mock('../lib/vaultEvents', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/vaultEvents')>();
  return {
    ...mod,
    useBackendEventPayload: (name: string, handler: (payload: unknown) => void) => {
      mocks.events.name = name;
      mocks.events.handler = handler;
    },
  };
});

vi.mock('../pages/AccountsPage', async () => {
  const { createElement } = await import('react');
  return { AccountsPage: () => createElement('div', null, 'ACCOUNTS_PAGE') };
});
vi.mock('../pages/AdminPage', async () => {
  const { createElement } = await import('react');
  return { AdminPage: ({ section }: { section: string }) => createElement('div', null, `ADMIN_PAGE:${section}`) };
});
vi.mock('../pages/SettingsPage', async () => {
  const { createElement } = await import('react');
  return { SettingsPage: ({ section }: { section: string }) => createElement('div', null, `SETTINGS_PAGE:${section}`) };
});
vi.mock('../pages/LauncherSettingsPage', async () => {
  const { createElement } = await import('react');
  return { LauncherSettingsPage: () => createElement('div', null, 'LAUNCHER_PAGE') };
});
vi.mock('../pages/QuizPage', async () => {
  const { createElement } = await import('react');
  return { QuizPage: () => createElement('div', null, 'QUIZ_PAGE') };
});

const FULL = [...Object.values(PERM), ...seedMenuNodes().map((node) => node.permKey)];

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <AppShell />
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  });
  mocks.events.name = '';
  mocks.events.handler = null;
  mocks.myPermissions.mockResolvedValue(FULL);
  mocks.listMenuNodes.mockResolvedValue(seedMenuNodes());
  mocks.launcherVisibility.mockResolvedValue(undefined);
  useTheme.setState({ style: 'glass', reduceMotion: false, loaded: true });
  useSession.setState({
    status: {
      initialized: true,
      unlocked: true,
      userCount: 1,
      appUserId: 'u1',
      nickname: '小林',
      schemaVersion: 6,
      appVersion: '0.9.0',
      platform: 'macos',
      arch: 'aarch64',
    },
    lock: vi.fn().mockResolvedValue(undefined),
  });
  useLauncherNav.setState({ pending: null });
});

describe('壳层：菜单树与权限都就绪前不渲染受保护的页', () => {
  it('权限还在读时只给读取态，不发任何页面请求', async () => {
    mocks.myPermissions.mockImplementation(() => new Promise(() => {}));
    renderShell();
    expect(screen.getByText('读取导航与权限…')).toBeInTheDocument();
    expect(screen.queryByText('ACCOUNTS_PAGE')).toBeNull();
  });

  it('权限已回、菜单树未回时同样是读取态：胶囊也不先画两项', async () => {
    mocks.listMenuNodes.mockImplementation(() => new Promise(() => {}));
    renderShell();
    expect(await screen.findByText('读取导航与权限…')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '主导航' })).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText('ACCOUNTS_PAGE')).toBeNull();
  });

  it('读取失败给错误态与重试；重试成功后进入兜底页', async () => {
    mocks.myPermissions.mockRejectedValueOnce({ code: 'DB_ERROR', message: '数据库暂时不可用' });
    renderShell();
    expect(await screen.findByText(/数据库暂时不可用/)).toBeInTheDocument();

    mocks.myPermissions.mockResolvedValue(FULL);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('ACCOUNTS_PAGE')).toBeInTheDocument();
  });
});

describe('壳层：系统管理的左栏与落点', () => {
  it('账号中心不带侧栏；点系统管理才出现左栏并落到用户管理', async () => {
    renderShell();
    await screen.findByText('ACCOUNTS_PAGE');
    expect(screen.queryByRole('navigation', { name: '系统管理导航' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '系统管理' }));
    expect(await screen.findByText('ADMIN_PAGE:users')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '系统管理导航' })).toBeInTheDocument();
  });

  it('在同一组二级页之间切换时侧栏一直在；回到账号中心后再点系统管理，回到上次那一页', async () => {
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: '系统管理' }));
    await screen.findByText('ADMIN_PAGE:users');

    fireEvent.click(screen.getByRole('button', { name: PAGE_META.audit.label }));
    expect(await screen.findByText('ADMIN_PAGE:audit')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '系统管理导航' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: PAGE_META.accounts.label }));
    expect(await screen.findByText('ACCOUNTS_PAGE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '系统管理' }));
    expect(await screen.findByText('ADMIN_PAGE:audit')).toBeInTheDocument();
  });

  it('题库是一级页：点胶囊落到题库页，且不带系统管理侧栏', async () => {
    renderShell();
    await screen.findByText('ACCOUNTS_PAGE');

    fireEvent.click(screen.getByRole('button', { name: PAGE_META.quiz.label }));
    expect(await screen.findByText('QUIZ_PAGE')).toBeInTheDocument();
    expect(screen.queryByText('ACCOUNTS_PAGE')).toBeNull();
    expect(screen.queryByRole('navigation', { name: '系统管理导航' })).toBeNull();
  });

  it('设置页没有侧栏', async () => {
    renderShell();
    await screen.findByText('ACCOUNTS_PAGE');
    pointerTap(screen.getByRole('button', { name: '设置' }));
    const menu = await screen.findByRole('menu', { name: '设置' });
    pointerTap(within(menu).getByRole('menuitem', { name: PAGE_META.appearance.label }));

    expect(await screen.findByText('SETTINGS_PAGE:appearance')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '系统管理导航' })).toBeNull();
  });
});

describe('壳层：菜单节点即时收放导航', () => {
  it('停用某个二级节点后，左栏与齿轮下拉同时少一项', async () => {
    const nodes = seedMenuNodes().map((node) =>
      node.id === 'mn-system-menus' ? { ...node, status: 'disabled' as const } : node,
    );
    mocks.listMenuNodes.mockResolvedValue(nodes);
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: '系统管理' }));
    await screen.findByText('ADMIN_PAGE:users');

    const sidebar = screen.getByRole('navigation', { name: '系统管理导航' });
    expect(within(sidebar).queryByRole('button', { name: PAGE_META.menus.label })).toBeNull();
    expect(within(sidebar).getByRole('button', { name: PAGE_META.permissions.label })).toBeInTheDocument();
  });

  it('自定义别名出现在对应分组，点进去落到目标页', async () => {
    const alias: MenuNode = {
      id: 'mn-custom-appearance',
      nodeKey: 'custom.appearance-alias',
      parentId: 'mn-gear-settings',
      label: '换个样子',
      pageKey: 'appearance',
      kind: 'page',
      builtin: false,
      status: 'active',
      sortOrder: 50,
      permKey: 'menu.node.custom.appearance-alias',
    };
    mocks.myPermissions.mockResolvedValue([...FULL, alias.permKey]);
    mocks.listMenuNodes.mockResolvedValue([...seedMenuNodes(), alias]);
    renderShell();
    await screen.findByText('ACCOUNTS_PAGE');

    pointerTap(screen.getByRole('button', { name: '设置' }));
    const menu = await screen.findByRole('menu', { name: '设置' });
    pointerTap(within(menu).getByRole('menuitem', { name: '换个样子' }));

    expect(await screen.findByText('SETTINGS_PAGE:appearance')).toBeInTheDocument();
  });

  it('全部入口停用且没有账号中心时给空状态，而不是白屏', async () => {
    mocks.listMenuNodes.mockResolvedValue(seedMenuNodes().map((node) => ({ ...node, status: 'disabled' as const })));
    renderShell();
    expect(
      await screen.findByText('当前没有可进入的页面，请让管理员在菜单管理中启用入口。'),
    ).toBeInTheDocument();
    expect(screen.queryByText('ACCOUNTS_PAGE')).toBeNull();
  });
});

describe('壳层：权限撤销后的重定向', () => {
  it('当前页被撤销时同步落到第一项可用页，左栏与顶栏一起收窄', async () => {
    const { qc } = renderShell();
    await screen.findByText('ACCOUNTS_PAGE');

    mocks.myPermissions.mockResolvedValue([
      PERM.MENU_SYSTEM,
      PERM.SYS_AUDIT_READ,
      seedMenuNodes().find((node) => node.nodeKey === 'system.audit')!.permKey,
    ]);
    await act(async () => {
      await qc.refetchQueries({ queryKey: queryKeys.myPermissions });
    });

    expect(await screen.findByText('ADMIN_PAGE:audit')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '系统管理导航' }).textContent).toBe(PAGE_META.audit.label);
    expect(screen.queryByRole('button', { name: PAGE_META.accounts.label })).toBeNull();
  });
});

describe('壳层：浮层跳到主窗的那条事件', () => {
  it('订阅 launcher://open-detail，收到后落账号中心并写入待消费的记录', async () => {
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: '系统管理' }));
    await screen.findByText('ADMIN_PAGE:users');
    expect(mocks.events.name).toBe('launcher://open-detail');

    act(() => {
      mocks.events.handler?.({ targetId: 't1', itemId: 'i1', keyword: '生产库' });
    });

    expect(await screen.findByText('ACCOUNTS_PAGE')).toBeInTheDocument();
    await waitFor(() =>
      expect(useLauncherNav.getState().pending).toEqual({ targetId: 't1', itemId: 'i1', keyword: '生产库' }),
    );
  });
});
