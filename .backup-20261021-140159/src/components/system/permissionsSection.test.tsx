import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsSection } from './PermissionsSection';
import type { PermissionRow, RoleAdminSummary } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  listRolesAdmin: vi.fn(),
  listPermissions: vi.fn(),
  setRoleActionPermissions: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const ADMIN: RoleAdminSummary = {
  id: 'r1',
  code: 'system_admin',
  name: '系统管理员',
  description: '',
  status: 'active',
  builtin: true,
  userCount: 1,
  permissions: ['menu.accounts', 'accounts.read', 'accounts.create', 'system.audit.read', 'system.role.manage'],
};

const AUDITOR: RoleAdminSummary = {
  id: 'r2',
  code: 'auditor',
  name: '审计员',
  description: '',
  status: 'active',
  builtin: false,
  userCount: 0,
  permissions: ['menu.accounts', 'system.audit.read'],
};

const CATALOG: PermissionRow[] = [
  { key: 'menu.accounts', name: '账号中心菜单', type: 'menu', description: null },
  { key: 'accounts.read', name: '读取账号', type: 'action', description: '查看账号台账' },
  { key: 'accounts.create', name: '新建账号', type: 'action', description: null },
  { key: 'system.audit.read', name: '查看审计日志', type: 'action', description: null },
  { key: 'system.role.manage', name: '管理角色', type: 'action', description: null },
];

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <PermissionsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listRolesAdmin.mockResolvedValue([ADMIN, AUDITOR]);
  mocks.listPermissions.mockResolvedValue(CATALOG);
  mocks.setRoleActionPermissions.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
});

describe('权限管理矩阵', () => {
  it('只画 action 权限，菜单键不混进这张表', async () => {
    renderSection();
    expect(await screen.findByText('读取账号')).toBeInTheDocument();
    expect(screen.getByText('新建账号')).toBeInTheDocument();
    expect(screen.getByText('查看审计日志')).toBeInTheDocument();
    expect(screen.getByText('管理角色')).toBeInTheDocument();
    // 菜单权限只在菜单管理页维护
    expect(screen.queryByText('账号中心菜单')).toBeNull();
    expect(screen.queryByText('menu.accounts')).toBeNull();
  });

  it('按 accounts./system. 前缀分组，列头是角色', async () => {
    renderSection();
    await screen.findByText('读取账号');
    expect(screen.getByRole('columnheader', { name: '账号台账操作' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '系统管理操作' })).toBeInTheDocument();
    const 系统管理员 = screen.getByRole('columnheader', { name: /系统管理员/ });
    expect(系统管理员).toHaveAttribute('scope', 'col');
  });

  it('每个格子都有「角色名 · 权限名」的可及名，屏读能定位到具体组合', async () => {
    renderSection();
    const box = await screen.findByRole('checkbox', { name: '系统管理员 · 新建账号' });
    expect(box).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '审计员 · 新建账号' })).not.toBeChecked();
  });

  it('保存只提交 action 键：角色身上的 menu.* 不会被顺手写回去', async () => {
    renderSection();
    await screen.findByText('新建账号');
    fireEvent.click(screen.getByRole('checkbox', { name: '系统管理员 · 新建账号' }));

    const save = screen.getByRole('button', { name: '保存 系统管理员 的操作权限' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(mocks.setRoleActionPermissions).toHaveBeenCalledWith('r1', [
        'accounts.read',
        'system.audit.read',
        'system.role.manage',
      ]),
    );
    expect(mocks.setRoleActionPermissions.mock.calls[0][1]).not.toContain('menu.accounts');
  });

  it('还原把草稿丢掉、回到服务端值，按钮随之禁用', async () => {
    renderSection();
    await screen.findByText('新建账号');
    const box = screen.getByRole('checkbox', { name: '系统管理员 · 新建账号' });
    fireEvent.click(box);
    expect(box).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '还原 系统管理员 的操作权限' }));
    expect(box).toBeChecked();
    expect(screen.getByRole('button', { name: '保存 系统管理员 的操作权限' })).toBeDisabled();
  });

  it('没有改动时保存按钮是禁用的，不发空请求', async () => {
    renderSection();
    await screen.findByText('新建账号');
    expect(screen.getByRole('button', { name: '保存 系统管理员 的操作权限' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存 审计员 的操作权限' })).toBeDisabled();
  });

  it('每列独立：改一列不影响另一列的脏状态', async () => {
    renderSection();
    await screen.findByText('新建账号');
    fireEvent.click(screen.getByRole('checkbox', { name: '审计员 · 查看审计日志' }));
    expect(screen.getByRole('button', { name: '保存 审计员 的操作权限' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '保存 系统管理员 的操作权限' })).toBeDisabled();
    expect(within(screen.getByRole('table')).getAllByRole('checkbox')).toHaveLength(8);
  });
});
