import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MenusSection } from './MenusSection';
import { ADMIN_ITEMS, pagePermissionMap } from '../../lib/pageMeta';
import type { MenuEntry, RoleAdminSummary } from '../../lib/types';
import { useNotify } from '../../state/notify';

const mocks = vi.hoisted(() => ({
  listRolesAdmin: vi.fn(),
  listMenuCatalog: vi.fn(),
  setRoleMenuPermissions: vi.fn(),
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
  permissions: ['menu.accounts', 'menu.system', 'system.role.manage'],
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

const CATALOG: MenuEntry[] = [
  { key: 'menu.accounts', label: '账号中心', order: 1 },
  { key: 'menu.system', label: '系统管理', order: 2 },
  { key: 'menu.quick_launcher', label: '快速启动器', order: 3 },
];

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MenusSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listRolesAdmin.mockResolvedValue([ADMIN, AUDITOR]);
  mocks.listMenuCatalog.mockResolvedValue(CATALOG);
  mocks.setRoleMenuPermissions.mockResolvedValue(undefined);
  useNotify.setState({ items: [] });
});

describe('菜单管理矩阵', () => {
  it('三枚一级菜单 × 角色，勾选状态取各角色已有的 menu.* 权限', async () => {
    renderSection();
    const systemAdminSystem = await screen.findByRole('checkbox', { name: '系统管理员 · 系统管理' });
    expect(systemAdminSystem).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '审计员 · 系统管理' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '审计员 · 账号中心' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '系统管理员 · 快速启动器' })).not.toBeChecked();
  });

  it('保存只提交 menu.*：角色身上的 system.* 操作权限不会被覆盖', async () => {
    renderSection();
    await screen.findByRole('checkbox', { name: '系统管理员 · 账号中心' });
    fireEvent.click(screen.getByRole('checkbox', { name: '系统管理员 · 账号中心' }));

    fireEvent.click(screen.getByRole('button', { name: '保存 系统管理员 的菜单权限' }));
    await waitFor(() =>
      expect(mocks.setRoleMenuPermissions).toHaveBeenCalledWith('r1', ['menu.system']),
    );
    expect(mocks.setRoleMenuPermissions.mock.calls[0][1]).not.toContain('system.role.manage');
  });

  it('新增一枚菜单可见性时把已有 menu 键一起提交，动作键仍不出现', async () => {
    renderSection();
    await screen.findByRole('checkbox', { name: '审计员 · 快速启动器' });
    fireEvent.click(screen.getByRole('checkbox', { name: '审计员 · 快速启动器' }));

    fireEvent.click(screen.getByRole('button', { name: '保存 审计员 的菜单权限' }));
    await waitFor(() =>
      expect(mocks.setRoleMenuPermissions).toHaveBeenCalledWith('r2', ['menu.accounts', 'menu.quick_launcher']),
    );
  });

  it('还原丢掉草稿，回到服务端值', async () => {
    renderSection();
    const box = await screen.findByRole('checkbox', { name: '审计员 · 系统管理' });
    fireEvent.click(box);
    expect(box).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '还原 审计员 的菜单权限' }));
    expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: '保存 审计员 的菜单权限' })).toBeDisabled();
  });

  it('二级页对照表由导航定义推导：每一页都在，快速启动器写明两枚门槛', async () => {
    renderSection();
    await screen.findByText('二级页 → 所需权限');

    for (const item of ADMIN_ITEMS) {
      expect(screen.getByRole('cell', { name: item.label }), `${item.label} 不在对照表里`).toBeInTheDocument();
    }
    for (const perm of ['system.user.read', 'system.audit.read', 'system.role.manage']) {
      expect(screen.getAllByText(perm).length, `${perm} 不在对照表里`).toBeGreaterThan(0);
    }
    expect(
      screen.getByRole('cell', { name: 'menu.quick_launcher 且 system.security.config' }),
    ).toBeInTheDocument();
    // 行数与导航定义同源，不手抄
    expect(screen.getByText('二级页 → 所需权限').closest('.surface')?.querySelectorAll('tbody tr')).toHaveLength(
      pagePermissionMap().length,
    );
  });
});
