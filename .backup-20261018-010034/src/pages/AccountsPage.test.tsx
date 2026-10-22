import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { AccountsPage } from './AccountsPage';
import { useShellSearch } from '../state/shellSearch';
import type { PagedTargets, TargetFilter, TargetRow } from '../lib/types';

/**
 * 只替换取数入口：单次取数条数、筛选条件的传递全部由组件真实逻辑驱动。
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

// 后端 page_size 夹取 1..=200（src-tauri/src/commands/accounts.rs:126-127）
const LIST_LIMIT = 200;
// 故意取一个跨过上限的总数：撤掉分页后，第 201 条只能靠筛选收窄，界面必须如实说这件事
const TOTAL = 260;

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
  };
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
  // 顶栏搜索框是这一页关键字的唯一来源：每条用例都从未输入状态开始
  useShellSearch.setState({ keyword: '', debouncedKeyword: '' });
  mocks.stats.mockResolvedValue({ targetCount: TOTAL, credentialCount: 60, favoriteCount: 3, byType: [] });
  mocks.listGroups.mockResolvedValue([]);
  mocks.listDeletedItems.mockResolvedValue([]);
  mocks.listTargetsPaged.mockImplementation((f: TargetFilter, p: number, s: number) => Promise.resolve(paged(f, p, s)));
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

describe('账号台账的取数范围（需求：≥10000 条不得整表渲染；撤掉分页后单次 200 条）', () => {
  it('首屏按第 1 页 / 每页 200 条取数，只渲染这一批', async () => {
    renderPage();
    await screen.findByText('系统-1');

    expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1);
    const [filter, page, pageSize] = mocks.listTargetsPaged.mock.calls[0] as [TargetFilter, number, number];
    expect(page).toBe(1);
    expect(pageSize).toBe(LIST_LIMIT);
    expect(filter.itemType).toBeFalsy();

    expect(screen.getByText('系统-200')).toBeInTheDocument();
    expect(screen.queryByText('系统-201')).toBeNull();
  });

  it('分页、回收站、最近访问三块入口都不在本页（源文件保留，只是不再挂载）', async () => {
    renderPage();
    await screen.findByText('系统-1');

    expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
    expect(screen.queryByRole('button', { name: '上一页' })).toBeNull();
    expect(screen.queryByLabelText('每页条数')).toBeNull();
    expect(screen.queryByText('回收站')).toBeNull();
    expect(screen.queryByText('最近访问')).toBeNull();
    // 不只断言"看不到"：这两条命令本版本在这页一次都不该发出
    await waitFor(() => expect(mocks.listTargetsPaged).toHaveBeenCalled());
    expect(mocks.recentAccess).not.toHaveBeenCalled();
    expect(mocks.listDeletedItems).not.toHaveBeenCalled();
  });

  it('总数超过载入数时如实播报缺口，句中出现的是 260 与 200 这两个真数', async () => {
    renderPage();
    const note = await screen.findByText(/本次载入 200 条/);
    expect(note.textContent).toContain('260');
    expect(note.textContent).toContain(`${TOTAL - LIST_LIMIT} 条请用顶部搜索或类型标签收窄`);
    // 没有分页可翻页，就绝不能说这是"全部"
    expect(note.textContent).not.toContain('全部');
  });

  it('载入数已覆盖总数时不给那句缺口文案', async () => {
    mocks.listTargetsPaged.mockResolvedValue({ rows: [row(1)], total: 1, page: 1, pageSize: LIST_LIMIT });
    renderPage();
    await screen.findByText('系统-1');
    expect(screen.queryByText(/本次载入/)).toBeNull();
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

  it('类型标签与顶栏搜索框的关键字同样走后端条件', async () => {
    renderPage();
    await screen.findByText('系统-1');

    fireEvent.click(screen.getByRole('tab', { name: '数据库' }));
    await waitFor(() => expect(lastCall()[0].itemType).toBe('database'));

    mocks.listTargetsPaged.mockClear();
    // 防抖本身由 state/shellSearch.test.ts 验；这里只验"防抖后的值进了 filter.keyword"
    useShellSearch.setState({ keyword: 'OA 系统', debouncedKeyword: 'OA 系统' });
    await waitFor(() => expect(lastCall()[0].keyword).toBe('OA 系统'));
  });

  it('顶栏关键字清空后回到无条件查询', async () => {
    useShellSearch.setState({ keyword: 'OA', debouncedKeyword: 'OA' });
    renderPage();
    await screen.findByText('系统-1');
    expect(lastCall()[0].keyword).toBe('OA');

    mocks.listTargetsPaged.mockClear();
    useShellSearch.setState({ keyword: '', debouncedKeyword: '' });
    await waitFor(() => expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1));
    expect(lastCall()[0].keyword).toBeFalsy();
  });

  it('改条件后仍只重取第 1 页 200 条（没有页码会停在越界处）', async () => {
    renderPage();
    await screen.findByText('系统-1');
    mocks.listTargetsPaged.mockClear();

    fireEvent.click(screen.getByLabelText('仅收藏'));
    await waitFor(() => expect(mocks.listTargetsPaged).toHaveBeenCalledTimes(1));
    expect(lastCall()[1]).toBe(1);
    expect(lastCall()[2]).toBe(LIST_LIMIT);
    expect(lastCall()[0].favoriteOnly).toBe(true);
  });

  it('总数为 0 时只给空态，且指明入口在页头右侧', async () => {
    mocks.listTargetsPaged.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: LIST_LIMIT });
    renderPage();
    expect(await screen.findByText(/没有符合条件的目标/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增目标' })).toBeInTheDocument();
    expect(screen.queryByText(/本次载入/)).toBeNull();
  });

  it('后端出错就地报错，不假装有一页数据', async () => {
    mocks.listTargetsPaged.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderPage();
    await waitFor(() => expect(screen.getByText('错误 · DB_ERROR')).toBeInTheDocument());
    expect(screen.queryByText('系统-1')).toBeNull();
  });
});

describe('台账页的分组与标签筛选（需求 §2.2 的入口，最近访问改由底部「此刻」条承担）', () => {
  it('标签下拉的选项来自后端 list_item_tags，选中后 tag 进入查询', async () => {
    mocks.listItemTags.mockResolvedValue(['生产', '测试']);
    renderPage();
    await screen.findByText('系统-1');
    expect(await screen.findByRole('option', { name: '生产' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '全部标签' })).toBeInTheDocument();

    mocks.listTargetsPaged.mockClear();
    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '生产' } });
    await waitFor(() => expect(lastCall()[0].tag).toBe('生产'));
  });

  it('切回"全部标签"等于不过滤，并且仍是第 1 页 200 条', async () => {
    mocks.listItemTags.mockResolvedValue(['生产']);
    renderPage();
    await screen.findByText('系统-1');

    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '生产' } });
    await waitFor(() => expect(lastCall()[0].tag).toBe('生产'));

    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '' } });
    await waitFor(() => expect(lastCall()[0].tag).toBeFalsy());
    expect(lastCall()[1]).toBe(1);
    expect(lastCall()[2]).toBe(LIST_LIMIT);
  });

  it('分组下拉的选项来自后端 list_groups，选中后 groupId 进入查询', async () => {
    mocks.listGroups.mockResolvedValue([{ id: 'g-1', name: '生产环境', parentId: null, targetCount: 3 }]);
    renderPage();
    await screen.findByText('系统-1');
    expect(await screen.findByRole('option', { name: '生产环境' })).toBeInTheDocument();

    mocks.listTargetsPaged.mockClear();
    fireEvent.change(screen.getByLabelText('分组筛选'), { target: { value: 'g-1' } });
    await waitFor(() => expect(lastCall()[0].groupId).toBe('g-1'));
  });
});
