import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { pointerTap } from '../test/pointer';
import { PAGE_META, TOP_LABELS } from '../lib/pageMeta';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/queryClient';
import { useSession } from '../state/session';
import { useTheme } from '../state/theme';
import { useLauncherNav } from '../state/launcherNav';

const mocks = vi.hoisted(() => ({
  myPermissions: vi.fn(),
  launcherVisibility: vi.fn(),
  events: { name: '', handler: null as null | ((payload: unknown) => void) },
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, myPermissions: mocks.myPermissions, launcherVisibility: mocks.launcherVisibility } };
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
vi.mock('../pages/DataPage', async () => {
  const { createElement } = await import('react');
  return { DataPage: () => createElement('div', null, 'DATA_PAGE') };
});

const FULL = Object.values(PERM);

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

describe('壳层：权限未落地前不渲染受保护的页', () => {
  it('权限还在读时只给读取态，不发任何页面请求', async () => {
    mocks.myPermissions.mockImplementation(() => new Promise(() => {}));
    renderShell();
    expect(screen.getByText('读取当前使用者的权限…')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: TOP_LABELS.system }));
    expect(await screen.findByText('ADMIN_PAGE:users')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '系统管理导航' })).toBeInTheDocument();
  });

  it('在同一组二级页之间切换时侧栏一直在；回到账号中心后再点系统管理，回到上次那一页', async () => {
    renderShell();
    fireEvent.click(await screen.findByRole('button', { name: TOP_LABELS.system }));
    await screen.findByText('ADMIN_PAGE:users');

    fireEvent.click(screen.getByRole('button', { name: PAGE_META.audit.label }));
    expect(await screen.findByText('ADMIN_PAGE:audit')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '系统管理导航' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: PAGE_META.accounts.label }));
    expect(await screen.findByText('ACCOUNTS_PAGE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: TOP_LABELS.system }));
    expect(await screen.findByText('ADMIN_PAGE:audit')).toBeInTheDocument();
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

describe('壳层：权限撤销后的重定向', () => {
  it('当前页被撤销时同步落到第一项可用页，左栏与顶栏一起收窄', async () => {
    const { qc } = renderShell();
    await screen.findByText('ACCOUNTS_PAGE');

    mocks.myPermissions.mockResolvedValue([PERM.MENU_SYSTEM, PERM.SYS_AUDIT_READ]);
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
    fireEvent.click(await screen.findByRole('button', { name: TOP_LABELS.system }));
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
