import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { SideMenu } from './SideMenu';
import { useShell } from '../state/shell';
import type { PageKey } from '../lib/pageMeta';
import type { MenuEntry } from '../lib/types';

/**
 * S 轮把导航搬到顶栏胶囊后，这个组件已经从 AppShell 撤下（源文件按"停用要可逆"保留，随时能挂回去）。
 * 这一份测试因此不再是界面回归，而是那枚保留源件的语义底座：菜单→页面的解析、后端有菜单但没界面时
 * 不许做假按钮、收起态的可及名。顶栏那份真实界面的回归在 components/topBar.test.tsx。
 */
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

function renderMenu(active: PageKey | null = 'accounts', onNavigate = vi.fn()) {
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
    expect(onNavigate).toHaveBeenCalledWith('settings');
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

  it('品牌位：标识是一张静音图片，名字只由 brand-name 那行文字承担', async () => {
    renderMenu();
    await screen.findByRole('navigation', { name: '主导航' });
    const row = document.querySelector('.brand-row');
    const marks = row?.querySelectorAll('img[data-brand-logo="app-mark"]');
    expect(marks).toHaveLength(1);
    // 旧的 CSS 渐变块 +「电」字不得复活：占位区必须是标识图片本身
    expect(marks?.[0].tagName).toBe('IMG');
    expect(marks?.[0]).toHaveAttribute('alt', '');
    expect(marks?.[0].getAttribute('width')).toBe('28');
    expect(marks?.[0].getAttribute('height')).toBe('28');
    expect(screen.getByText('蒙电信产助手')).toBeTruthy();
  });
});
