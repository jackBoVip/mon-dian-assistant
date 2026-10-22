import { useId, useMemo, useState } from 'react';
import { useController, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateRbac, queryKeys } from '../../lib/queryClient';
import { useMyPermissions, permissionSet, has, PERM } from '../../lib/permissions';
import { useSession } from '../../state/session';
import type { AppUserSummary, RoleSummary } from '../../lib/types';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { FormShell } from '../ui/form';
import { TextField, SelectField } from '../ui/Field';
import { PasswordField } from '../ui/PasswordField';
import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { Checkbox } from '../ui/checkbox';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { formatTimestamp } from '../../lib/format';

/** 三栏必填的合并提示：重构前后一字不差，所以只写一处给 schema 与失败分支共用。 */
const CREATE_MSG = '昵称、初始主密码、角色均必填。';

const createSchema = z.object({
  nickname: z.string().min(1, CREATE_MSG),
  pwd: z.string().min(1, CREATE_MSG),
  roleKey: z.string().min(1, CREATE_MSG),
});

type CreateFormValues = z.input<typeof createSchema>;

/** 系统管理 > 用户管理：管理本软件自身的使用者（不是外部系统账号）。 */
export function UsersSection() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: () => api.listUsers() });
  const roles = useQuery({ queryKey: queryKeys.roles, queryFn: () => api.listRoles() });
  const permsQuery = useMyPermissions();
  const perms = useMemo(() => permissionSet(permsQuery.data), [permsQuery.data]);
  const canManageUsers = has(perms, PERM.SYS_USER_MANAGE);
  const canManageRoles = has(perms, PERM.SYS_ROLE_MANAGE);
  const selfId = useSession((s) => s.status?.appUserId);

  const roleList: RoleSummary[] = roles.data ?? [];
  const activeRoles = roleList.filter((role) => role.status === 'active');

  /* 三栏必填这条闸门交给 zod，文案与重构前逐字相同（一条合并提示，不是三行字段错误）。
   * 角色那一栏是 Radix Select，不能用 register 的 value/onChange，走 Controller。 */
  const createForm = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { nickname: '', pwd: '', roleKey: '' },
  });
  const { field: roleField } = useController({ name: 'roleKey', control: createForm.control });
  const formId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AppUserSummary | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [roleTarget, setRoleTarget] = useState<AppUserSummary | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);

  const create = useMutation({
    mutationFn: (v: CreateFormValues) => api.createUser(v.nickname.trim(), v.pwd, v.roleKey),
    onSuccess: (u) => {
      notify('success', `已创建本软件使用者：${u.nickname}（内部标识 ${u.generatedAccountCode}）`);
      createForm.reset();
      setCreateOpen(false);
      invalidateRbac(qc);
    },
    onError,
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'disabled' }) => api.setUserStatus(v.id, v.status),
    onSuccess: (_r, v) => {
      notify('success', v.status === 'disabled' ? '已停用该使用者（其会话已由后端终止）' : '已启用该使用者');
      invalidateRbac(qc);
    },
    onError,
  });

  const setRoles = useMutation({
    mutationFn: (v: { id: string; codes: string[] }) => api.setUserRoles(v.id, v.codes),
    onSuccess: () => {
      notify('success', '角色已更新');
      setRoleTarget(null);
      invalidateRbac(qc);
    },
    onError,
  });

  const reset = useMutation({
    mutationFn: (v: { id: string; pwd: string }) => api.adminResetPassword(v.id, v.pwd),
    onSuccess: () => {
      notify('success', '已重置该使用者的主密码（旧会话按后端策略终止）');
      setResetTarget(null);
      setResetPwd('');
      invalidateRbac(qc);
    },
    onError,
  });

  const onCreate = createForm.handleSubmit(
    (v) => create.mutate(v),
    () => notify('warning', CREATE_MSG),
  );

  function openCreate() {
    createForm.reset();
    setCreateOpen(true);
  }

  function closeCreate() {
    if (!create.isPending) setCreateOpen(false);
  }

  function openRoleModal(user: AppUserSummary) {
    setRoleTarget(user);
    setSelectedRoles(user.roles);
  }

  function toggleRole(code: string, checked: boolean) {
    setSelectedRoles((prev) => (checked ? [...new Set([...prev, code])] : prev.filter((c) => c !== code)));
  }

  return (
    <div className="flex flex-col gap-5">
      {!canManageUsers ? (
        <p className="text-xs text-ink-muted">
          当前角色没有 system.user.manage 权限：新增、停用与重置主密码的控件已隐藏；后端同样会拒绝这些操作。
        </p>
      ) : null}
      {!canManageRoles ? (
        <p className="text-xs text-ink-muted">
          当前角色没有 system.role.manage 权限：角色只读展示，调整角色入口已隐藏。
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {users.data ? <p className="text-xs text-ink-muted">共 {users.data.length} 位使用者</p> : null}
        {canManageUsers ? (
          <button
            type="button"
            className="btn-icon-primary"
            aria-label="新增使用者"
            title={activeRoles.length === 0 ? '没有启用中的角色，暂时无法创建使用者' : '新增使用者'}
            onClick={openCreate}
            disabled={activeRoles.length === 0}
          >
            <Icon name="plus" size={20} />
          </button>
        ) : null}
      </div>

      {roles.isError ? <ErrorState raw={roles.error} onRetry={() => void roles.refetch()} /> : null}

      <div>
        {users.isLoading ? <Loading label="加载使用者…" /> : null}
        {users.isError ? <ErrorState raw={users.error} onRetry={() => void users.refetch()} /> : null}
        {users.data ? (
          users.data.length === 0 ? (
            <EmptyState>暂无使用者数据。</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table-center">
                <thead>
                  <tr>
                    <th scope="col">昵称</th>
                    <th scope="col">内部标识</th>
                    <th scope="col">角色</th>
                    <th scope="col">状态</th>
                    <th scope="col">最近登录</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.map((u) => (
                    <UserRow
                      key={u.id}
                      user={u}
                      roles={roleList}
                      isSelf={u.id === selfId}
                      canManageUsers={canManageUsers}
                      canManageRoles={canManageRoles}
                      busy={setStatus.isPending || setRoles.isPending}
                      onToggleStatus={() =>
                        setStatus.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })
                      }
                      onManageRoles={() => openRoleModal(u)}
                      onResetOpen={() => {
                        setResetTarget(u);
                        setResetPwd('');
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </div>

      <Modal
        open={createOpen}
        title="新增本软件使用者"
        onClose={closeCreate}
        footer={
          <>
            <Button variant="ghost" disabled={create.isPending} onClick={closeCreate}>
              取消
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={create.isPending || activeRoles.length === 0}
            >
              {create.isPending ? '创建中…' : '创建使用者'}
            </Button>
          </>
        }
      >
        <FormShell id={formId} onSubmit={() => void onCreate()} className="flex flex-col gap-5 pt-1" noValidate>
          <TextField label="昵称" required {...createForm.register('nickname')} />
          <PasswordField label="初始主密码" required {...createForm.register('pwd')} />
          {roles.isLoading ? (
            <Loading label="加载角色…" />
          ) : roles.isError ? (
            <ErrorState raw={roles.error} onRetry={() => void roles.refetch()} />
          ) : (
            <SelectField
              label="角色"
              value={roleField.value}
              onValueChange={roleField.onChange}
              hint="仅启用角色可作为初始角色"
              options={[
                { value: '', label: '请选择角色' },
                ...activeRoles.map((r) => ({ value: r.code, label: `${r.name}（${r.code}）` })),
              ]}
            />
          )}
          {roles.data && activeRoles.length === 0 ? (
            <p className="text-xs text-ink-muted">没有启用中的角色，暂时无法创建使用者。</p>
          ) : null}
        </FormShell>
      </Modal>

      <Modal
        open={resetTarget !== null}
        title="重置主密码"
        onClose={() => {
          if (!reset.isPending) setResetTarget(null);
        }}
        footer={
          <>
            <Button variant="ghost" disabled={reset.isPending} onClick={() => setResetTarget(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={reset.isPending || !resetPwd}
              onClick={() => resetTarget && reset.mutate({ id: resetTarget.id, pwd: resetPwd })}
            >
              {reset.isPending ? '提交中…' : '确认重置'}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-ink-muted">
          为「{resetTarget?.nickname}」设置新的主密码；旧会话将按后端策略终止。
        </p>
        <PasswordField
          label="新的主密码"
          value={resetPwd}
          onChange={(e) => setResetPwd(e.target.value)}
        />
      </Modal>

      <Modal
        open={roleTarget !== null}
        title="调整角色"
        onClose={() => setRoleTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRoleTarget(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={setRoles.isPending || selectedRoles.length === 0}
              onClick={() => roleTarget && setRoles.mutate({ id: roleTarget.id, codes: selectedRoles })}
            >
              {setRoles.isPending ? '提交中…' : '保存角色'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {/* 目标条：这一屏调的是谁、保存的语义是什么。名字下方带内部标识，
              重名使用者在用户表里本来就要靠它区分；说明从原来那两行长句收进角色卡本身。 */}
          <div className="flex items-center gap-3 rounded-md bg-sunken p-3">
            {/* 头像沿用顶栏那一枚 .user-avatar 的几何与字重，只把沉底换成抬升底：
                它落在同样沉底的条上，同色圆会消失。 */}
            <span className="user-avatar role-picker-avatar" aria-hidden="true">
              {Array.from(roleTarget?.nickname ?? '')[0] ?? '?'}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{roleTarget?.nickname}</p>
              <p className="text-xs leading-[18px] text-ink-muted">
                内部标识 <span className="mono text-[11px]">{roleTarget?.generatedAccountCode}</span>
                <span aria-hidden="true"> · </span>
                保存后整体替换该使用者的全部角色
              </p>
            </div>
          </div>

          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-ink-body">角色</span>
            <span className="text-xs leading-[18px] text-ink-muted tabular-nums" aria-live="polite">
              已选 <b className="font-semibold text-ink">{selectedRoles.length}</b> / {roleList.length}
            </span>
          </div>

          {/* 整张卡是 label：勾选框仍是唯一状态源，卡片只是把命中区扩到整行。
              选中态写在 data-selected 上（本仓库不引 :has()，见 global.css .field 那条口径）。 */}
          <div className="flex flex-col gap-2" role="group" aria-label="角色">
            {roleList.map((role) => {
              const selected = selectedRoles.includes(role.code);
              return (
                <label
                  key={role.code}
                  className="role-option flex items-start gap-2.5 px-3 py-2.5"
                  data-selected={selected ? 'true' : 'false'}
                >
                  <Checkbox
                    aria-label={`${role.name}（${role.code}）`}
                    checked={selected}
                    onCheckedChange={(v) => toggleRole(role.code, v === true)}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-ink">{role.name}</span>
                      <span className="mono text-[11px] leading-4 text-ink-muted">{role.code}</span>
                      {role.status === 'active' ? null : (
                        <Badge tone="muted" className="ml-auto shrink-0">
                          停用 · 不授予权限
                        </Badge>
                      )}
                    </span>
                    {/* 说明是卡片里唯一成句的内容，用正文色而不是 muted：选中态的 8% 主色底会把
                        muted 压到 4:1 上下（12px 正文的门槛是 4.5:1），代码标识仍留 muted 作第三档。 */}
                    {role.description ? (
                      <span className="text-xs leading-[18px] text-ink-body">{role.description}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>

          {selectedRoles.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs leading-[18px] text-danger" role="alert">
              <Icon name="warning" size={14} />
              至少保留一个角色。
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

function UserRow({
  user,
  roles,
  isSelf,
  canManageUsers,
  canManageRoles,
  busy,
  onToggleStatus,
  onManageRoles,
  onResetOpen,
}: {
  user: AppUserSummary;
  roles: RoleSummary[];
  isSelf: boolean;
  canManageUsers: boolean;
  canManageRoles: boolean;
  busy: boolean;
  onToggleStatus: () => void;
  onManageRoles: () => void;
  onResetOpen: () => void;
}) {
  const roleByCode = new Map(roles.map((role) => [role.code, role]));
  const roleBadges = user.roles.length ? (
    user.roles.map((code) => {
      const role = roleByCode.get(code);
      const disabled = role?.status === 'disabled';
      return (
        <span key={code} title={disabled ? '停用角色不授予权限' : undefined}>
          <Badge tone={disabled ? 'muted' : undefined}>{role?.name ?? code}</Badge>
        </span>
      );
    })
  ) : (
    <span className="text-xs text-ink-muted">—</span>
  );
  return (
    <tr>
      <td>{user.nickname}</td>
      <td className="mono text-xs">{user.generatedAccountCode}</td>
      <td>
        {canManageRoles ? (
          <Button
            variant="bare"
            className="mx-auto flex cursor-pointer flex-wrap items-center justify-center gap-2 rounded-md transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={`调整 ${user.nickname} 的角色`}
            title="调整角色"
            disabled={busy}
            onClick={onManageRoles}
          >
            {roleBadges}
          </Button>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2">{roleBadges}</div>
        )}
      </td>
      <td>
        <Badge tone={user.status === 'active' ? 'success' : 'muted'}>{user.status === 'active' ? '启用' : '停用'}</Badge>
      </td>
      <td className="text-xs text-ink-muted">{formatTimestamp(user.lastLoginAt)}</td>
      <td>
        {canManageUsers ? (
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="ghost"
              disabled={busy || isSelf}
              title={isSelf ? '不能停用当前登录的使用者' : undefined}
              onClick={onToggleStatus}
            >
              {user.status === 'active' ? '停用' : '启用'}
            </Button>
            <Button variant="ghost" onClick={onResetOpen}>
              重置密码
            </Button>
          </div>
        ) : (
          <span className="text-xs text-ink-muted">只读</span>
        )}
      </td>
    </tr>
  );
}
