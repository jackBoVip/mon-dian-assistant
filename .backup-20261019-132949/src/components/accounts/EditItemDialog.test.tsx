import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { EditItemDialog } from './EditItemDialog';
import type { ItemDetail, ItemView } from '../../lib/types';

/** 只 mock 网络入口：补丁内容由组件里的 lib/itemPatch 真实算出来，断言的就是实际发给后端的键。 */
const mocks = vi.hoisted(() => ({ updateItem: vi.fn(), itemDetail: vi.fn() }));
vi.mock('../../lib/api', () => ({
  api: {
    updateItem: (itemId: string, patch: unknown) => mocks.updateItem(itemId, patch),
    itemDetail: (itemId: string) => mocks.itemDetail(itemId),
  },
}));

const ITEM: ItemView = {
  id: 'item-1',
  targetId: 'target-1',
  accountAlias: '日常办公',
  itemType: 'web',
  status: 'active',
  favorite: false,
  tags: ['运维', '内网'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  version: 4,
  isDefaultForCurrentUser: true,
  usernameMasked: 'z***n',
  hasPassword: true,
  hasToken: false,
  hasPrivateKey: false,
  canReveal: true,
};

/** item_detail 的扁平返回：非秘密字段有原值，秘密永不回显。 */
const DETAIL: ItemDetail = {
  ...ITEM,
  username: 'zhangsan',
  note: '仅限运维时段',
  authMethod: 'password',
  browserHint: 'chrome',
  loginUrlOverride: '',
  confirmBeforeFill: true,
  canUpdate: true,
};

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EditItemDialog open item={ITEM} onClose={onClose} />
    </QueryClientProvider>,
  );
}

/** 表单只在拿到 item_detail 之后渲染：先等基准就绪，再操作字段。 */
async function renderLoaded(detail: ItemDetail = DETAIL) {
  mocks.itemDetail.mockResolvedValue(detail);
  const view = renderDialog();
  await screen.findByLabelText('账号别名');
  return view;
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /保存改动/ });
}

describe('EditItemDialog 只提交改动过的键', () => {
  beforeEach(() => {
    mocks.updateItem.mockReset();
    mocks.itemDetail.mockReset();
  });

  it('打开后不动任何字段：没有改动，保存按钮不可点（绝不整包覆盖）', async () => {
    await renderLoaded();
    expect(screen.getByText('没有改动。未列出的字段（含已存密码）一律保持后端原值，因此「保存改动」当前不可点。')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('明细加载期间不渲染半成品表单，也没有可用的保存按钮', () => {
    mocks.itemDetail.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    expect(screen.getByRole('status')).toHaveTextContent('加载账号原值…');
    expect(screen.queryByLabelText('账号别名')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存改动/ })).toBeNull();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('明细加载失败：呈现后端错误与重试，不给出可提交的表单', async () => {
    mocks.itemDetail.mockRejectedValue({ code: 'NOT_FOUND', message: '这条凭据对当前使用者不可见。' });
    renderDialog();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('NOT_FOUND');
    expect(alert).toHaveTextContent('这条凭据对当前使用者不可见。');
    expect(screen.queryByLabelText('账号别名')).toBeNull();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('按 item_detail 的回显预填非秘密字段（不再是空白）', async () => {
    await renderLoaded();
    expect(mocks.itemDetail).toHaveBeenCalledWith('item-1');
    expect(screen.getByLabelText('外部系统用户名')).toHaveValue('zhangsan');
    expect(screen.getByLabelText('认证方式')).toHaveValue('password');
    expect(screen.getByLabelText('浏览器提示')).toHaveValue('chrome');
    expect(screen.getByLabelText('登录地址覆盖')).toHaveValue('');
    expect(screen.getByLabelText('备注')).toHaveValue('仅限运维时段');
    expect(screen.getByLabelText('每次自动填充前需要确认')).toHaveValue('required');
    expect(screen.getByLabelText('账号别名')).toHaveValue('日常办公');
  });

  it('无查看秘密权限（username 为 null）：用户名不预填、不可编辑，补丁里永不出现 username', async () => {
    await renderLoaded({ ...DETAIL, username: null, canReveal: false, usernameMasked: 'z***n' });
    const usernameInput = screen.getByLabelText('外部系统用户名');
    expect(usernameInput).toHaveValue('');
    expect(usernameInput).toBeDisabled();
    expect(screen.getByLabelText('备注')).toHaveValue('仅限运维时段');

    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '仅限工作日' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { note: '仅限工作日' }));
    const patch = mocks.updateItem.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('username' in patch).toBe(false);
  });

  it('只改账号别名 → 补丁里只有 accountAlias', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('账号别名'), { target: { value: '只读账号' } });
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { accountAlias: '只读账号' }));
  });

  it('与回显原值相同的输入不算改动：补丁里只有真正改过的键', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'password' } });
    fireEvent.change(screen.getByLabelText('浏览器提示'), { target: { value: 'chrome' } });
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('浏览器提示'), { target: { value: 'edge' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { browserHint: 'edge' }));
  });

  it('输入新的外部系统密码才发 password', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('新的外部系统密码（留空不修改）'), { target: { value: 'New-p@ss' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { password: 'New-p@ss' }));
  });

  it('清空已存密码需要第二次确认，第一次只进入待确认态', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '清空已存密码' }));
    // 第一次点击：仍未产生任何改动
    expect(saveButton()).toBeDisabled();
    expect(mocks.updateItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认清空已存密码（不可恢复）' }));
    expect(screen.getByText(/清空已存密码（危险）/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { password: '' }));
  });

  it('确认后可以撤销：撤销清空则不发送 password', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '清空已存密码' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清空已存密码（不可恢复）' }));
    fireEvent.click(screen.getByRole('button', { name: '撤销清空' }));
    expect(saveButton()).toBeDisabled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('别名清空后不许提交（后端要求非空），不会发出空别名', async () => {
    await renderLoaded();
    fireEvent.click(saveButton());
    expect(mocks.updateItem).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('账号别名'), { target: { value: '   ' } });
    // 唯一改动变成"别名改为空白"→ 仍视为无有效改动，提交被校验拦下
    fireEvent.click(saveButton());
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('已回显字段要清空也得两次确认，确认后发空串', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '清空已存用户名' }));
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '确认清空已存用户名（不可恢复）' }));
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { username: '' }));
  });

  it('标签清空与填充前确认三态按改动发送', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('标签（逗号分隔）'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('每次自动填充前需要确认'), { target: { value: 'not_required' } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(mocks.updateItem).toHaveBeenCalledWith('item-1', { tags: [], confirmBeforeFill: false }),
    );
  });

  it('后端报告无写入权限：呈现只读标记，不提供保存按钮', async () => {
    await renderLoaded({ ...DETAIL, canUpdate: false });
    expect(screen.getByText('后端报告：无写入权限（只读）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存改动/ })).toBeNull();
    expect(screen.getByLabelText('账号别名')).toBeDisabled();
    expect(screen.getByLabelText('备注')).toBeDisabled();
    expect(screen.getByRole('button', { name: '清空已存密码' })).toBeDisabled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });
});
