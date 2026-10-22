import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersSection } from './UsersSection';
import { PERM } from '../../lib/permissions';
import type { AppUserSummary, RoleSummary } from '../../lib/types';
import { useSession } from '../../state/session';
import { useNotify } from '../../state/notify';
import { selectOptions, chooseOption } from '../../test/select';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listRoles: vi.fn(),
  myPermissions: vi.fn(),
  setUserRoles: vi.fn(),
  setUserStatus: vi.fn(),
  adminResetPassword: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/api')>();
  return { ...mod, api: { ...mod.api, ...mocks } };
});

const ROLES: RoleSummary[] = [
  { code: 'system_admin', name: '系统管理员', description: '全部权限，含安全策略、更新与备份', builtin: true, status: 'active' },
  { code: 'auditor', name: '审计员', description: '审计日志与导出记录的查看', builtin: false, status: 'active' },
  { code: 'retired', name: '退休角色', description: '', builtin: false, status: 'disabled' },
];

const USERS: AppUserSummary[] = [
  {
    id: 'u1',
    nickname: '小林',
    status: 'active',
    roles: ['system_admin'],
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    generatedAccountCode: 'U-1',
  },
  {
    id: 'u2',
    nickname: '阿敏',
    status: 'active',
    roles: ['auditor', 'retired'],
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    generatedAccountCode: 'U-2',
  },
  {
    id: 'u3',
    nickname: '老周',
    status: 'disabled',
    roles: ['auditor'],
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    generatedAccountCode: 'U-3',
  },
];

const FULL = Object.values(PERM);

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsersSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.listUsers.mockResolvedValue(USERS);
  mocks.listRoles.mockResolvedValue(ROLES);
  mocks.myPermissions.mockResolvedValue(FULL);
  mocks.setUserRoles.mockResolvedValue(undefined);
  mocks.setUserStatus.mockResolvedValue(undefined);
  mocks.adminResetPassword.mockResolvedValue(undefined);
  mocks.createUser.mockResolvedValue({ ...USERS[2], nickname: '新人' });
  useSession.setState({
    status: {
      initialized: true,
      unlocked: true,
      userCount: 3,
      appUserId: 'u1',
      nickname: '小林',
      schemaVersion: 6,
      appVersion: '0.9.0',
      platform: 'macos',
      arch: 'aarch64',
    },
  });
  useNotify.setState({ items: [] });
});

describe('用户管理：按钮随权限收放', () => {
  it('没有 system.user.manage 时隐藏新增/停用/重置，并写明原因', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.SYS_USER_READ, PERM.SYS_ROLE_MANAGE]);
    renderSection();
    await screen.findByText('小林');
    expect(screen.queryByRole('button', { name: '新增使用者' })).toBeNull();
    expect(screen.queryByRole('button', { name: '创建使用者' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重置密码' })).toBeNull();
    expect(screen.getByText(/没有 system\.user\.manage 权限/)).toBeInTheDocument();
    // 角色仍可调
    expect(screen.getByRole('button', { name: '调整 小林 的角色' })).toBeInTheDocument();
  });

  it('没有 system.role.manage 时角色只读展示，调整入口消失', async () => {
    mocks.myPermissions.mockResolvedValue([PERM.SYS_USER_READ, PERM.SYS_USER_MANAGE]);
    renderSection();
    await screen.findByText('小林');
    expect(screen.queryByRole('button', { name: '调整 阿敏 的角色' })).toBeNull();
    expect(screen.getByText(/没有 system\.role\.manage 权限/)).toBeInTheDocument();
    // 角色名仍由 list_roles 映射，不是裸 code
    expect(screen.getByText('系统管理员')).toBeInTheDocument();
  });

  it('角色徽标把 code 映射成名称；停用角色标灰并注明不授予权限', async () => {
    renderSection();
    const row = (await screen.findByText('阿敏')).closest('tr') as HTMLElement;
    expect(within(row).getByText('审计员')).toBeInTheDocument();
    expect(within(row).getByTitle('停用角色不授予权限')).toHaveTextContent('退休角色');
  });

  it('自己那一行的停用按钮禁用并写明原因（后端也拒绝）', async () => {
    renderSection();
    const row = (await screen.findByText('小林')).closest('tr') as HTMLElement;
    const off = within(row).getByRole('button', { name: '停用' });
    expect(off).toBeDisabled();
    expect(off).toHaveAttribute('title', '不能停用当前登录的使用者');
  });

  it('新增入口是图标按钮：可及名保留、屏上无文字', async () => {
    renderSection();
    const add = await screen.findByRole('button', { name: '新增使用者' });
    expect(add.textContent).toBe('');
    expect(add.querySelector('svg')).not.toBeNull();
    expect(add).toHaveAttribute('title', '新增使用者');
  });

  it('创建弹窗只列启用中的角色', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '新增使用者' }));
    await screen.findByRole('dialog', { name: '新增本软件使用者' });
    expect(selectOptions('角色')).toEqual(['请选择角色', '系统管理员（system_admin）', '审计员（auditor）']);
  });

  it('在弹窗里提交新使用者，成功后关闭并刷新角色与使用者', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '新增使用者' }));
    const dialog = await screen.findByRole('dialog', { name: '新增本软件使用者' });

    fireEvent.change(within(dialog).getByLabelText('昵称'), { target: { value: '  新人  ' } });
    fireEvent.change(within(dialog).getByLabelText('初始主密码'), { target: { value: 'initial-pw' } });
    chooseOption('角色', '审计员（auditor）');
    fireEvent.click(within(dialog).getByRole('button', { name: '创建使用者' }));

    await waitFor(() => expect(mocks.createUser).toHaveBeenCalledWith('新人', 'initial-pw', 'auditor'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增本软件使用者' })).toBeNull());
  });

  it('重置主密码改为弹窗提交，成功后关闭', async () => {
    renderSection();
    const row = (await screen.findByText('阿敏')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '重置密码' }));
    const dialog = await screen.findByRole('dialog', { name: '重置主密码' });

    fireEvent.change(within(dialog).getByLabelText('新的主密码'), { target: { value: 'new-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认重置' }));

    await waitFor(() => expect(mocks.adminResetPassword).toHaveBeenCalledWith('u2', 'new-pw'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '重置主密码' })).toBeNull());
  });
});

describe('用户管理：调整角色', () => {
  it('点击角色标签即打开调整弹窗，不再有独立的「调整角色」按钮', async () => {
    renderSection();
    const trigger = await screen.findByRole('button', { name: '调整 阿敏 的角色' });
    expect(screen.queryByText('调整角色')).toBeNull();
    expect(trigger).toHaveTextContent('审计员');
    expect(trigger).toHaveAttribute('title', '调整角色');
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: '调整角色' })).toBeInTheDocument();
  });

  it('弹窗按当前绑定勾选，保存时整体替换', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '调整 阿敏 的角色' }));
    const dialog = await screen.findByRole('dialog', { name: '调整角色' });

    expect(within(dialog).getByRole('checkbox', { name: '审计员（auditor）' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: '退休角色（retired）' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: '系统管理员（system_admin）' })).not.toBeChecked();

    // 目标条与角色卡：内部标识、说明、停用徽标、实时计数都上屏
    expect(within(dialog).getByText('阿敏')).toBeInTheDocument();
    expect(within(dialog).getByText('U-2')).toBeInTheDocument();
    expect(within(dialog).getByText('全部权限，含安全策略、更新与备份')).toBeInTheDocument();
    expect(within(dialog).getByText('停用 · 不授予权限')).toBeInTheDocument();
    expect(within(dialog).getByText(/已选/)).toHaveTextContent('已选 2 / 3');
    const auditorCard = within(dialog)
      .getByRole('checkbox', { name: '审计员（auditor）' })
      .closest('label') as HTMLElement;
    expect(auditorCard).toHaveAttribute('data-selected', 'true');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: '审计员（auditor）' }));
    expect(auditorCard).toHaveAttribute('data-selected', 'false');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '系统管理员（system_admin）' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存角色' }));

    await waitFor(() =>
      expect(mocks.setUserRoles).toHaveBeenCalledWith('u2', ['retired', 'system_admin']),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '调整角色' })).toBeNull());
  });

  it('至少保留一个角色：全取消时保存禁用并给出提示，不发空集合', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '调整 老周 的角色' }));
    const dialog = await screen.findByRole('dialog', { name: '调整角色' });

    const count = within(dialog).getByText(/已选/);
    expect(count).toHaveTextContent('已选 1 / 3');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '审计员（auditor）' }));
    expect(count).toHaveTextContent('已选 0 / 3');
    expect(within(dialog).getByText('至少保留一个角色。')).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: '保存角色' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mocks.setUserRoles).not.toHaveBeenCalled();
  });

  it('整张角色卡可点：点说明文字也能切换，勾选框仍是状态源', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '调整 老周 的角色' }));
    const dialog = await screen.findByRole('dialog', { name: '调整角色' });
    const checkbox = within(dialog).getByRole('checkbox', { name: '审计员（auditor）' });
    expect(checkbox).toBeChecked();

    fireEvent.click(within(dialog).getByText('审计日志与导出记录的查看'));
    expect(checkbox).not.toBeChecked();
    fireEvent.click(within(dialog).getByText('审计日志与导出记录的查看'));
    expect(checkbox).toBeChecked();
  });

  it('后端拒绝时如实报错，弹窗保持打开便于重试', async () => {
    mocks.setUserRoles.mockRejectedValue({ code: 'SELF_LOCKOUT', message: '该改动会让当前使用者失去系统管理权限' });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '调整 小林 的角色' }));
    const dialog = await screen.findByRole('dialog', { name: '调整角色' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '系统管理员（system_admin）' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '审计员（auditor）' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存角色' }));

    await waitFor(() => {
      const items = useNotify.getState().items;
      expect(items[items.length - 1]?.text).toContain('失去系统管理权限');
    });
    const items = useNotify.getState().items;
    expect(items[items.length - 1]?.kind).toBe('danger');
    expect(screen.getByRole('dialog', { name: '调整角色' })).toBeInTheDocument();
  });
});
