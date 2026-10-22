import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { SideMenu } from './SideMenu';
import { useShell } from '../state/shell';
import type { MenuEntry } from '../lib/types';

const mocks = vi.hoisted(() => ({ menus: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, menus: mocks.menus } };
});

const MENUS: MenuEntry[] = [
  { key: 'accounts', label: '账号管理', order: 10 },
  { key: 'system', label: '系统管理', order: 20 },
  { key: 'audit_report', label: '审计报表', order: 30 },
];

function renderMenu(active: 'accounts' | 'system' | 'launcher' | 'data' | null = 'accounts', onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SideMenu active={active} onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
  return onNavigate;
}

beforeEach(() => {
  mocks.menus.mockReset();
  mocks.menus.mockResolvedValue(MENUS);
  useShell.setState({ collapsed: false });
});

describe('左侧菜单（高级 dashboard 口径）', () => {
  it('分两组：业务项来自后端，次级入口标「设置」', async () => {
    renderMenu();
    expect(await screen.findByRole('button', { name: '账号管理' })).toBeTruthy();
    expect(screen.getByText('业务')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByRole('button', { name: '快速启动器' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导入/导出' })).toBeTruthy();
  });

  it('当前页靠 aria-current 表达，而不是靠"看起来像"的颜色', async () => {
    renderMenu('accounts');
    await screen.findByRole('button', { name: '账号管理' });
    expect(screen.getByRole('button', { name: '账号管理' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '系统管理' }).getAttribute('aria-current')).toBeNull();
  });

  it('点业务项把后端 key 解析出的页面交回上层', async () => {
    const onNavigate = renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: '系统管理' }));
    expect(onNavigate).toHaveBeenCalledWith('system');
  });

  it('后端有菜单但本版本没有界面时，明说不做假按钮', async () => {
    renderMenu();
    const muted = (await screen.findByText(/审计报表/)).textContent;
    expect(muted).toContain('本版本未提供界面');
    expect(screen.queryByRole('button', { name: /审计报表/ })).toBeNull();
  });

  it('收起态：标签文字仍在 DOM 里，可及名与 title 都不掉', async () => {
    useShell.setState({ collapsed: true });
    renderMenu();
    const item = await screen.findByRole('button', { name: '账号管理' });
    expect(item.querySelector('.nav-text')?.textContent).toBe('账号管理');
    expect(item.getAttribute('title')).toBe('账号管理');
    expect(screen.getByRole('button', { name: '导入/导出' }).getAttribute('title')).toBe('导入/导出');
  });

  it('展开态不给按钮挂 title（有文字就不需要重复提示）', async () => {
    renderMenu();
    expect((await screen.findByRole('button', { name: '账号管理' })).getAttribute('title')).toBeNull();
  });

  it('导航面有名字，收起开关才能用 aria-controls 指向它', async () => {
    renderMenu();
    expect(await screen.findByRole('navigation', { name: '主导航' })).toBeTruthy();
    expect(document.getElementById('app-sidebar')).not.toBeNull();
  });
});
