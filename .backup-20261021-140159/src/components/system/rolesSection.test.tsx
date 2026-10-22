import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RolesSection } from './RolesSection';
import type { RoleAdminSummary } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  listRolesAdmin: vi.fn(),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const BUILTIN: RoleAdminSummary = {
  id: 'r1',
  code: 'system_admin',
  name: '系统管理员',
  description: '完整系统管理',
  status: 'active',
  builtin: true,
  userCount: 1,
  permissions: ['menu.accounts', 'menu.system'],
};

const BOUND_CUSTOM: RoleAdminSummary = {
  id: 'r2',
  code: 'auditor',
  name: '审计员',
  description: '只读审计',
  status: 'active',
  builtin: false,
  userCount: 2,
  permissions: ['menu.accounts', 'system.audit.read'],
};

const FREE_CUSTOM: RoleAdminSummary = {
  id: 'r3',
  code: 'helpdesk',
  name: '服务台',
  description: '',
  status: 'disabled',
  builtin: false,
  userCount: 0,
  permissions: ['menu.accounts'],
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RolesSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listRolesAdmin.mockResolvedValue([BUILTIN, BOUND_CUSTOM, FREE_CUSTOM]);
  mocks.createRole.mockResolvedValue('r4');
  mocks.updateRole.mockResolvedValue(undefined);
  mocks.deleteRole.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
});

describe('角色管理', () => {
  it('角色表列出名称、标识、状态、内置标记与绑定人数', async () => {
    renderSection();
    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    expect(screen.getByText('auditor')).toBeInTheDocument();
    expect(screen.getByText('内置', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText('停用', { selector: '.badge' })).toBeInTheDocument();
    // 内置 1 人 + 自定义 2 人
    expect(screen.getByRole('row', { name: /系统管理员/ }).textContent).toContain('1');
    expect(screen.getByRole('row', { name: /审计员/ }).textContent).toContain('2');
  });

  it('内置角色不能删除；仍有绑定的自定义角色也不能删除，并写明先解绑', async () => {
    renderSection();
    await screen.findByText('系统管理员');
    const builtinDelete = screen.getByRole('button', { name: '删除角色 系统管理员' });
    const boundDelete = screen.getByRole('button', { name: '删除角色 审计员' });
    const freeDelete = screen.getByRole('button', { name: '删除角色 服务台' });
    expect(builtinDelete).toBeDisabled();
    expect(builtinDelete).toHaveAttribute('title', '内置角色不能删除');
    expect(boundDelete).toBeDisabled();
    expect(boundDelete).toHaveAttribute('title', '该角色仍有使用者绑定，请先解除绑定');
    expect(freeDelete).toBeEnabled();
  });

  it('新建入口是图标按钮：可及名保留、屏上无文字', async () => {
    renderSection();
    const add = await screen.findByRole('button', { name: '新建角色' });
    expect(add.textContent).toBe('');
    expect(add.querySelector('svg')).not.toBeNull();
    expect(add).toHaveAttribute('title', '新建角色');
  });

  it('新建角色：弹窗三段输入去空白后提交，成功后关闭', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '新建角色' }));
    const dialog = await screen.findByRole('dialog', { name: '新建角色' });
    fireEvent.change(within(dialog).getByLabelText('角色标识'), { target: { value: '  ops_1  ' } });
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '  运维  ' } });
    fireEvent.change(within(dialog).getByLabelText('说明'), { target: { value: '  值班运维  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建角色' }));

    await waitFor(() => expect(mocks.createRole).toHaveBeenCalledWith('ops_1', '运维', '值班运维'));
    const items = useNotify.getState().items;
    expect(items[items.length - 1]?.text).toContain('角色已创建');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建角色' })).toBeNull());
  });

  it('标识或名称为空时不发请求，只报一条提示', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '新建角色' }));
    const dialog = await screen.findByRole('dialog', { name: '新建角色' });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建角色' }));
    await waitFor(() => expect(useNotify.getState().items).toHaveLength(1));
    expect(useNotify.getState().items[0].kind).toBe('warning');
    expect(mocks.createRole).not.toHaveBeenCalled();
  });

  it('编辑自定义角色：弹窗内名称/说明可改，保存提交 id 与原状态', async () => {
    renderSection();
    await screen.findByText('服务台');
    fireEvent.click(screen.getByRole('button', { name: '编辑角色 服务台' }));

    const dialog = await screen.findByRole('dialog', { name: '编辑角色' });
    const nameInput = within(dialog).getByLabelText('名称') as HTMLInputElement;
    expect(nameInput.value).toBe('服务台');
    expect(nameInput).toBeEnabled();
    fireEvent.change(nameInput, { target: { value: '支持台' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存角色' }));

    await waitFor(() => expect(mocks.updateRole).toHaveBeenCalledWith('r3', '支持台', '', 'disabled'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑角色' })).toBeNull());
  });

  it('内置角色可打开弹窗查看，但字段与保存都锁定，并写明原因', async () => {
    renderSection();
    await screen.findByText('系统管理员');
    fireEvent.click(screen.getByRole('button', { name: '编辑角色 系统管理员' }));

    const dialog = await screen.findByRole('dialog', { name: '编辑角色' });
    expect(within(dialog).getByText(/内置角色：名称、说明与状态不可修改/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('名称')).toBeDisabled();
    expect(within(dialog).getByLabelText('状态')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '保存角色' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '保存角色' })).toHaveAttribute('title', '内置角色的元数据不可修改');
  });

  it('删除无绑定的自定义角色要二次确认，确认后才发请求', async () => {
    renderSection();
    await screen.findByText('服务台');
    fireEvent.click(screen.getByRole('button', { name: '删除角色 服务台' }));

    const dialog = await screen.findByRole('dialog', { name: '删除角色' });
    expect(dialog.textContent).toContain('服务台');
    expect(mocks.deleteRole).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mocks.deleteRole).toHaveBeenCalledWith('r3'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除角色' })).toBeNull());
  });

  it('后端拒绝时如实报错，不假装成功', async () => {
    mocks.deleteRole.mockRejectedValue({ code: 'ROLE_IN_USE', message: '该角色仍有使用者绑定' });
    renderSection();
    await screen.findByText('服务台');
    fireEvent.click(screen.getByRole('button', { name: '删除角色 服务台' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '删除角色' })).getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      const items = useNotify.getState().items;
      expect(items[items.length - 1]?.text).toContain('仍有使用者绑定');
    });
    const items = useNotify.getState().items;
    expect(items[items.length - 1]?.kind).toBe('danger');
    expect(screen.getByRole('dialog', { name: '删除角色' })).toBeInTheDocument();
  });
});
