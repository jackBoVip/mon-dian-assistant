import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { DeletedItemsPanel } from './DeletedItemsPanel';
import type { DeletedItemRow } from '../../lib/types';

/** 只 mock 网络入口：组件的权限判定仍然来自后端错误码。 */
const mocks = vi.hoisted(() => ({ listDeletedItems: vi.fn(), restoreItem: vi.fn() }));
vi.mock('../../lib/api', () => ({
  api: {
    listDeletedItems: (limit?: number) => mocks.listDeletedItems(limit),
    restoreItem: (itemId: string) => mocks.restoreItem(itemId),
  },
}));

const ROW: DeletedItemRow = {
  item: {
    id: 'item-1',
    targetId: 'target-1',
    accountAlias: '日常办公',
    itemType: 'web',
    status: 'active',
    favorite: false,
    tags: ['运维'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 3,
    isDefaultForCurrentUser: false,
  },
  targetName: '内部门户',
  deletedAt: '2026-02-02T03:04:05Z',
};

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DeletedItemsPanel />
    </QueryClientProvider>,
  );
}

describe('DeletedItemsPanel 的权限门禁', () => {
  beforeEach(() => {
    mocks.listDeletedItems.mockReset();
    mocks.restoreItem.mockReset();
  });

  it('后端回 FORBIDDEN（无 accounts.delete）时整个入口不渲染，也不报"故障"', async () => {
    mocks.listDeletedItems.mockRejectedValue({ code: 'FORBIDDEN', message: '未授权：当前使用者无权执行该操作' });
    const { container } = renderPanel();
    await waitFor(() => expect(mocks.listDeletedItems).toHaveBeenCalledWith(200));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/回收站/)).toBeNull();
  });

  it('会话锁定类错误同样不渲染入口（由全局会话面板呈现）', async () => {
    mocks.listDeletedItems.mockRejectedValue({ code: 'SESSION_LOCKED', message: '会话已锁定，请重新解锁' });
    const { container } = renderPanel();
    await waitFor(() => expect(mocks.listDeletedItems).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('其他后端错误就地展示错误码，而不是藏起来', async () => {
    mocks.listDeletedItems.mockRejectedValue({ code: 'DB_ERROR', message: '数据库访问失败' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('错误 · DB_ERROR')).toBeInTheDocument());
  });
});

describe('DeletedItemsPanel 的恢复动作', () => {
  beforeEach(() => {
    mocks.listDeletedItems.mockReset();
    mocks.restoreItem.mockReset();
  });

  it('展开列表 → 恢复：按 itemId 调用后端，并重取回收站与该目标的账号列表', async () => {
    mocks.listDeletedItems.mockResolvedValue([ROW]);
    mocks.restoreItem.mockResolvedValue(undefined);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '展开回收站' }));
    expect(screen.getByText('内部门户')).toBeInTheDocument();
    expect(screen.getByText('日常办公')).toBeInTheDocument();
    // ItemRow 没有用户名：表格不得编造用户名/密码列
    expect(screen.getByText('类型')).toBeInTheDocument();
    expect(screen.queryAllByText('用户名')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mocks.restoreItem).toHaveBeenCalledWith('item-1'));
    await waitFor(() => expect(mocks.listDeletedItems).toHaveBeenCalledTimes(2));
  });

  it('恢复失败只报后端错误，绝不假装成功', async () => {
    mocks.listDeletedItems.mockResolvedValue([ROW]);
    mocks.restoreItem.mockRejectedValue({ code: 'FORBIDDEN', message: '未授权：当前使用者无权执行该操作' });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '展开回收站' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mocks.restoreItem).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/已恢复账号/)).toBeNull();
  });

  it('空回收站给出明确空态', async () => {
    mocks.listDeletedItems.mockResolvedValue([]);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '展开回收站' }));
    expect(await screen.findByText('没有已删除的凭据')).toBeInTheDocument();
  });
});
