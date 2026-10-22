import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { AccountsPage } from './AccountsPage';
import type { PagedTargets, TargetFilter, TargetRow } from '../lib/types';

/**
 * 只替换取数入口：分页页码、筛选条件的传递全部由组件真实逻辑驱动。
 * 保留模块其余导出，queryClient.ts 还要用 ApiError 判定会话错误。
 */
const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  listGroups: vi.fn(),
  listTargetsPaged: vi.fn(),
  listDeletedItems: vi.fn(),
  listItemTags: vi.fn(),
  recentAccess: vi.fn(),
  targetDetail: vi.fn(),
  targetItems: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const TOTAL = 45;

function row(i: number): TargetRow {
  const iso = '2026-01-01T00:00:00Z';
  return {
    id: `t${i}`,
    targetType: 'web',
    displayName: `系统-${i}`,
    groupId: null,
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
    credentialCount: 1,
  }
}

/** 后端语义：先按条件过滤，再切片。total 恒为符合条件的总数。 */
function paged(_filter: TargetFilter, page: number, pageSize: number): PagedTargets {
  const start = (page - 1) * pageSize;
  return {
    rows: Array.from({ length: TOTAL }, (_, k) => row(k + 1)).slice(start, start + pageSize),
    total: TOTAL,
    page,
    pageSize,
  };
}

function lastCall(): [TargetFilter, number, number] {
  const calls = mocks.listTargetsPaged.mock.calls;
  return calls[calls.length - 1] as [TargetFilter, number, number];
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AccountsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.stats.mockResolvedValue({ targetCount: TOTAL, credentialCount: 60, favoriteCount: 3, byType: [] });
  mocks.listGroups.mockResolvedValue([]);
  mocks.listDeletedItems.mockResolvedValue([]);
  mocks.listTargetsPaged.mockImplementation((f: TargetFilter, p: number, s: number) => Promise.resolve(paged(f, p, s)));
  // 标签与最近访问的默认值：多数用例关心的是列表，不希望这两块带来额外 DOM
  mocks.listItemTags.mockResolvedValue([]);
  mocks.recentAccess.mockResolvedValue([]);
  mocks.targetItems.mockResolvedValue([]);
  mocks.targetDetail.mockImplementation((id: string) =>
    Promise.resolve({
      target: { ...row(3), id, displayName: `最近访问的目标-${id}` },
      meta: { url: '', allowedOrigin: '', host: '', port: '', databaseName: '', tenant: '', vendor: '', protocol: '', extra: {} },
      items: [],
      insecureProtocol: false,
      fillAvailable: false,
    }),
  );
});

describe('账号台账的后端分页（需求：≥10000 条不得整表渲染）', () => {
  it('首屏按第 1 页 / 每页 20 条取数，只渲染本页，"共 N 条"来自后端总数', async () => {
    renderPage();
    await screen.findByText('系统-1');

    expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1);
    const [filter, page, pageSize] = mocks.listTargetsPaged.mock.calls[0] as [TargetFilter, number, number];
    expect(page).toBe(1);
    expect(pageSize).toBe(20);
    expect(filter.itemType).toBeFalsy();

    expect(screen.getByText('系统-20')).toBeInTheDocument();
    expect(screen.queryByText('系统-21')).toBeNull();
    expect(screen.getByText(/共 45 条/)).toBeInTheDocument();
    expect(screen.getByText(/第 1 \/ 3 页/)).toBeInTheDocument();
  });

  it('下一页把 page=2 发给后端，条件保持不变', async () => {
    renderPage();
    await screen.findByText('系统-1');
    mocks.listTargetsPaged.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1));
    const [filter, page] = lastCall();
    expect(page).toBe(2);
    expect(filter.favoriteOnly).toBeFalsy();
    expect(await screen.findByText('系统-21')).toBeInTheDocument();
    expect(screen.queryByText('系统-1')).toBeNull();
  });

  it('最后一页禁用"下一页"，第一页禁用"上一页"', async () => {
    renderPage();
    await screen.findByText('系统-1');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() => expect(lastCall()[1]).toBe(3));
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('改每页条数会带上新的 pageSize 并回到第 1 页', async () => {
    renderPage();
    await screen.findByText('系统-1');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(lastCall()[1]).toBe(2));

    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } });
    await waitFor(() => expect(lastCall()[2]).toBe(50));
    expect(lastCall()[1]).toBe(1);
  });
});

describe('筛选条件必须真的到达后端（此前"仅收藏"是死控件）', () => {
  it('勾选"仅收藏"后 favoriteOnly=true 被发出', async () => {
    renderPage();
    await screen.findByText('系统-1');
    mocks.listTargetsPaged.mockClear();

    fireEvent.click(screen.getByLabelText('仅收藏'));
    await waitFor(() => expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1));
    expect(lastCall()[0].favoriteOnly).toBe(true);
  });

  it('类型标签与关键字同样走后端条件；关键字经过 debounce', async () => {
    vi.useFakeTimers();
    renderPage();
    vi.runAllTimers();
    vi.useRealTimers();
    await screen.findByText('系统-1');

    fireEvent.click(screen.getByRole('tab', { name: '数据库' }));
    await waitFor(() => expect(lastCall()[0].itemType).toBe('database'));

    mocks.listTargetsPaged.mockClear();
    fireEvent.change(screen.getByLabelText(/搜索/), { target: { value: 'OA 系统' } });
    expect(mocks.listTargetsPaged).not.toHaveBeenCalled();
    await waitFor(
      () => expect(lastCall()[0].keyword).toBe('OA 系统'),
      { timeout: 1000, interval: 50 },
    );
  });

  it('筛选变化时页码归 1：第 3 页改条件不会停在越界页', async () => {
    renderPage();
    await screen.findByText('系统-1');
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() => expect(lastCall()[1]).toBe(3));

    fireEvent.click(screen.getByLabelText('仅收藏'));
    await waitFor(() => expect(lastCall()[1]).toBe(1));
    expect(lastCall()[0].favoriteOnly).toBe(true);
  });

  it('总数为 0 时只给空态，不渲染分页条', async () => {
    mocks.listTargetsPaged.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20 });
    renderPage();
    expect(await screen.findByText(/没有符合条件的目标/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '分页' })).toBeNull();
  });

  it('后端出错就地报错，不假装有一页数据', async () => {
    mocks.listTargetsPaged.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderPage();
    await waitFor(() => expect(screen.getByText('错误 · DB_ERROR')).toBeInTheDocument());
    expect(screen.queryByText('系统-1')).toBeNull();
  });
});

describe('台账首页的标签筛选与最近访问（需求 §2.2 要求"分组、标签、收藏、最近访问"入口）', () => {
  it('标签下拉的选项来自后端 list_item_tags，选中后 tag 进入分页查询', async () => {
    mocks.listItemTags.mockResolvedValue(['生产', '测试']);
    renderPage();
    await screen.findByText('系统-1');
    expect(await screen.findByRole('option', { name: '生产' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '全部标签' })).toBeInTheDocument();

    mocks.listTargetsPaged.mockClear();
    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '生产' } });
    await waitFor(() => expect(lastCall()[0].tag).toBe('生产'));
  });

  it('切回"全部标签"等于不过滤；换标签时页码回到第 1 页', async () => {
    mocks.listItemTags.mockResolvedValue(['生产']);
    renderPage();
    await screen.findByText('系统-1');

    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '生产' } });
    await waitFor(() => expect(lastCall()[0].tag).toBe('生产'));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(lastCall()[1]).toBe(2));

    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '' } });
    await waitFor(() => expect(lastCall()[1]).toBe(1));
    expect(lastCall()[0].tag).toBeFalsy();
  });

  it('首页展示后端给出的最近访问条目，点击打开对应目标的详情', async () => {
    mocks.recentAccess.mockResolvedValue([
      {
        itemId: 'i-1',
        targetId: 't-3',
        targetName: 'OA办公系统',
        itemType: 'web',
        accountAlias: '个人账号',
        lastAccessedAt: '2026-01-05T08:30:00Z',
      },
    ]);
    renderPage();
    const entry = await screen.findByRole('button', { name: /OA办公系统 · 个人账号/ });
    expect(screen.getByText('最近访问')).toBeInTheDocument();

    fireEvent.click(entry);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('最近访问的目标-t-3')).toBeInTheDocument();
    expect(mocks.targetDetail).toHaveBeenCalledWith('t-3');
  });

  it('后端没有最近访问记录时首页不出现该区块', async () => {
    renderPage();
    await screen.findByText('系统-1');
    await waitFor(() => expect(mocks.recentAccess).toHaveBeenCalled());
    expect(screen.queryByText('最近访问')).toBeNull();
  });
});
