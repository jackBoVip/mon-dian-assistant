import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { RecentAccessPanel } from './RecentAccessPanel';
import { formatTimestamp } from '../../lib/format';
import type { RecentAccessRow } from '../../lib/types';

const mocks = vi.hoisted(() => ({ recentAccess: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const row: RecentAccessRow = {
  itemId: 'i-1',
  targetId: 't-7',
  targetName: 'OA办公系统',
  itemType: 'web',
  accountAlias: '个人账号',
  lastAccessedAt: '2026-01-05T08:30:00Z',
};

function renderPanel(onOpenTarget = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <RecentAccessPanel onOpenTarget={onOpenTarget} />
    </QueryClientProvider>,
  );
  return { view, onOpenTarget };
}

beforeEach(() => {
  mocks.recentAccess.mockReset();
  mocks.recentAccess.mockResolvedValue([row]);
});

describe('最近访问入口（需求 §2.2 台账首页）', () => {
  it('只渲染后端的四个非秘密字段，逐字拼成条目文本', async () => {
    const { onOpenTarget } = renderPanel();
    const item = await screen.findByRole('button');
    /**
     * 精确匹配挂 textContent 而不是 findByRole 的 name：条目文本由「名称 span + 摘要 span」
     * 两段构成，jsdom 30 算 accname 时在两段之间不补空格（得到 "OA办公系统· 个人账号…"），
     * 而按 W3C accname 规范与真机 WebKit 是会补空格的——即计算名称在这个环境里不是可靠代理。
     * textContent 与渲染出的可见文字一一对应，且同样"多一个字段就失败"。
     */
    expect(item.textContent).toBe(`OA办公系统 · 个人账号 · 网页 · ${formatTimestamp(row.lastAccessedAt)}`);
    expect(item).toBeInTheDocument();
    expect(screen.getByText('最近访问')).toBeInTheDocument();
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('取数带上条数上限，点击把对应的 targetId 交给页面打开详情', async () => {
    const { onOpenTarget } = renderPanel();
    const item = await screen.findByRole('button', { name: /OA办公系统/ });
    expect(mocks.recentAccess).toHaveBeenCalledWith(8);

    fireEvent.click(item);
    await waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith('t-7'));
  });

  it('没有记录时整块不渲染，不留下空标题', async () => {
    mocks.recentAccess.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(mocks.recentAccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('最近访问')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('取不到数据时不渲染也不在此处报错——列表区会就地把同一权限失败报出来', async () => {
    mocks.recentAccess.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderPanel();
    await waitFor(() => expect(mocks.recentAccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('最近访问')).toBeNull();
    expect(screen.queryByText(/DB_ERROR/)).toBeNull();
  });

  it('多条记录各归各的目标：点第二条打开第二条的 targetId', async () => {
    mocks.recentAccess.mockResolvedValue([
      row,
      { ...row, itemId: 'i-2', targetId: 't-8', targetName: '生产数据库', itemType: 'database', accountAlias: '运维账号' },
    ]);
    const { onOpenTarget } = renderPanel();
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /生产数据库/ }));
    await waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith('t-8'));
    expect(screen.getByRole('button', { name: /OA办公系统/ })).toBeInTheDocument();
  });
});
