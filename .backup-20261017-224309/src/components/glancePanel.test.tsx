import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { GlancePanel } from './GlancePanel';
import { useGlance } from '../state/glance';
import type { KeystoreDiagnostics, RecentAccessRow } from '../lib/types';

const mocks = vi.hoisted(() => ({
  recentAccess: vi.fn(),
  keystoreDiagnostics: vi.fn(),
  openTarget: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, recentAccess: mocks.recentAccess, keystoreDiagnostics: mocks.keystoreDiagnostics } };
});

// 面板上的每一颗 chip 都会走这条真实动作；测试里只断言它被正确地调用
vi.mock('../lib/actions', () => ({ openTarget: mocks.openTarget }));

const KS: KeystoreDiagnostics = {
  dbKeyStore: 'local-file-0600',
  legacyBackend: 'macos-keychain',
  deviceKeyConsent: 'consented',
  note: '数据库主密钥保存在本机 0600 权限文件',
};

const ROWS: RecentAccessRow[] = [
  { itemId: 'i-1', targetId: 't-7', targetName: 'OA办公系统', itemType: 'web', accountAlias: '个人账号', lastAccessedAt: '2026-10-16T02:00:00Z' },
  { itemId: 'i-2', targetId: 't-8', targetName: '计费数据库', itemType: 'database', accountAlias: '只读账号', lastAccessedAt: '2026-10-16T01:00:00Z' },
];

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GlancePanel />
    </QueryClientProvider>,
  );
}

const panel = () => screen.getByRole('complementary', { name: '此刻' });

beforeEach(() => {
  mocks.recentAccess.mockReset();
  mocks.keystoreDiagnostics.mockReset();
  mocks.openTarget.mockReset();
  mocks.recentAccess.mockResolvedValue(ROWS);
  mocks.keystoreDiagnostics.mockResolvedValue(KS);
  useGlance.setState({ collapsed: true });
});

describe('「此刻」面板（超出需求的界面新增）', () => {
  it('默认收起：头部带显示安全存储状态，但不发起 recent_access', async () => {
    renderPanel();
    await waitFor(() => expect(panel().textContent).toContain('在本机 0600 文件'));
    expect(mocks.recentAccess).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /OA办公系统/ })).toBeNull();
  });

  it('展开后才取最近访问，并按 DESIGN.md 的 chip 形态列出目标名与账号别名', async () => {
    renderPanel();
    await waitFor(() => expect(panel().textContent).toContain('在本机 0600 文件'));
    fireEvent.click(screen.getByRole('button', { name: /此刻/ }));
    await waitFor(() => expect(mocks.recentAccess).toHaveBeenCalledWith(5));
    const chip = await screen.findByRole('button', { name: 'OA办公系统 · 个人账号' });
    expect(chip.textContent).toBe('OA办公系统 · 个人账号');
    expect(screen.getByRole('button', { name: '计费数据库 · 只读账号' })).toBeTruthy();
  });

  it('情绪由后端诊断决定：有同意记录=ok，没有同意记录=warn', async () => {
    renderPanel();
    await waitFor(() => expect(panel().getAttribute('data-tone')).toBe('ok'));

    mocks.keystoreDiagnostics.mockResolvedValue({ ...KS, deviceKeyConsent: 'legacy-file' });
    const second = renderPanel();
    await waitFor(() => expect(second.container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('warn'));
    expect(second.container.textContent).toContain('本机 0600 文件');
  });

  it('存放位置确认不了时换成 bad，并把后端 note 原样读出来（不粉饰）', async () => {
    mocks.keystoreDiagnostics.mockResolvedValue({
      ...KS,
      dbKeyStore: 'unknown',
      deviceKeyConsent: 'none',
      note: '读不到本机密钥文件的存放标记',
    });
    renderPanel();
    await waitFor(() => expect(panel().getAttribute('data-tone')).toBe('bad'));
    expect(panel().textContent).toContain('读不到本机密钥文件的存放标记');
  });

  it('点 chip 走真实动作：以该行的 targetId 调用打开目标', async () => {
    renderPanel();
    await waitFor(() => expect(panel().textContent).toContain('在本机 0600 文件'));
    fireEvent.click(screen.getByRole('button', { name: /此刻/ }));
    const chip = await screen.findByRole('button', { name: 'OA办公系统 · 个人账号' });
    fireEvent.click(chip);
    expect(mocks.openTarget).toHaveBeenCalledWith('t-7');
  });

  it('没有访问记录时给出空态文案，不显示假数据', async () => {
    mocks.recentAccess.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(panel().textContent).toContain('在本机 0600 文件'));
    fireEvent.click(screen.getByRole('button', { name: /此刻/ }));
    await waitFor(() => expect(mocks.recentAccess).toHaveBeenCalled());
    await waitFor(() => expect(panel().textContent).toContain('还没有访问记录'));
  });

  it('折叠状态存在 store 里：展开后再点一次回到收起，收起时 body 不留在文档中', async () => {
    renderPanel();
    await waitFor(() => expect(panel().textContent).toContain('在本机 0600 文件'));
    const toggle = screen.getByRole('button', { name: /此刻/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('button', { name: 'OA办公系统 · 个人账号' })).toBeTruthy());
    expect(useGlance.getState().collapsed).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /此刻/ }));
    await waitFor(() => expect(useGlance.getState().collapsed).toBe(true));
    expect(document.getElementById('glance-body')).toBeNull();
  });
});
