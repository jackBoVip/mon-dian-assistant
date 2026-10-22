import { useState } from 'react';
import { useController, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import type { AppUserSummary, RoleSummary } from '../../lib/types';
import { Button } from '../ui/Button';
import { FormShell } from '../ui/form';
import { TextField, SelectField } from '../ui/Field';
import { Select } from '../ui/select';
import { PasswordField } from '../ui/PasswordField';
import { Badge } from '../ui/Badge';
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

/** 系统管理 > 用户与角色：管理本软件自身的使用者（不是外部系统账号）。 */
export function UsersSection() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: () => api.listUsers() });
  const roles = useQuery({ queryKey: queryKeys.roles, queryFn: () => api.listRoles() });

  const roleList: RoleSummary[] = roles.data ?? [];

  /* 三栏必填这条闸门交给 zod，文案与重构前逐字相同（一条合并提示，不是三行字段错误）。
   * 角色那一栏是 Radix Select，不能用 register 的 value/onChange，走 Controller。 */
  const createForm = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { nickname: '', pwd: '', roleKey: '' },
  });
  const { field: roleField } = useController({ name: 'roleKey', control: createForm.control });
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState('');

  function invalidateUsers() {
    void qc.invalidateQueries({ queryKey: queryKeys.users });
  }
  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);

  const create = useMutation({
    mutationFn: (v: CreateFormValues) => api.createUser(v.nickname.trim(), v.pwd, v.roleKey),
    onSuccess: (u) => {
      notify('success', `已创建本软件使用者：${u.nickname}（内部标识 ${u.generatedAccountCode}）`);
      createForm.reset();
      invalidateUsers();
    },
    onError,
  });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'disabled' }) => api.setUserStatus(v.id, v.status),
    onSuccess: (_r, v) => {
      notify('success', v.status === 'disabled' ? '已停用该使用者（其会话已由后端终止）' : '已启用该使用者');
      invalidateUsers();
    },
    onError,
  });

  const assignRole = useMutation({
    mutationFn: (v: { id: string; roleCode: string }) => api.assignUserRole(v.id, v.roleCode),
    onSuccess: () => {
      notify('success', '角色已更新');
      invalidateUsers();
    },
    onError,
  });

  const reset = useMutation({
    mutationFn: () => api.adminResetPassword(resetTarget as string, resetPwd),
    onSuccess: () => {
      notify('success', '已重置该使用者的主密码（旧会话按后端策略终止）');
      setResetTarget(null);
      setResetPwd('');
      invalidateUsers();
    },
    onError,
  });

  const onCreate = createForm.handleSubmit(
    (v) => create.mutate(v),
    () => notify('warning', CREATE_MSG),
  );

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-ink-muted">
        这里的「使用者」是本软件本地保险库的使用者，用昵称+主密码解锁；内部账号标识由后端自动生成、只读展示，任何流程都不要求手工输入。
        创建/停用/改角色/重置主密码等敏感操作由后端要求近期二次认证，过期会先弹出重新认证。
      </p>

      <FormShell onSubmit={() => void onCreate()} className="panel flex flex-col gap-3 p-4" noValidate>
        <h3 className="panel-title">新增本软件使用者</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
              hint="角色列表来自后端 list_roles"
              options={[{ value: '', label: '请选择角色' }, ...roleList.map((r) => ({ value: r.code, label: `${r.name}（${r.code}）` }))]}
            />
          )}
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={create.isPending || roleList.length === 0}>
            {create.isPending ? '创建中…' : '创建使用者'}
          </Button>
          {roles.data && roles.data.length === 0 ? (
            <p className="mt-1 text-xs text-ink-muted">后端未返回任何角色，暂时无法创建使用者。</p>
          ) : null}
        </div>
      </FormShell>

      <div>
        {users.isLoading ? <Loading label="加载使用者…" /> : null}
        {users.isError ? <ErrorState raw={users.error} onRetry={() => void users.refetch()} /> : null}
        {users.data ? (
          users.data.length === 0 ? (
            <EmptyState>暂无使用者数据。</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
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
                      busy={setStatus.isPending || assignRole.isPending}
                      onToggleStatus={() =>
                        setStatus.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })
                      }
                      onAssignRole={(roleCode) => assignRole.mutate({ id: u.id, roleCode })}
                      onResetOpen={() => {
                        setResetTarget(u.id);
                        setResetPwd('');
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        {resetTarget ? (
          <div className="surface mt-3 flex items-end gap-2 p-4">
            <div className="flex-1">
              <PasswordField label="为该使用者设置的新主密码" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)} />
            </div>
            <Button variant="primary" disabled={reset.isPending || !resetPwd} onClick={() => reset.mutate()}>
              {reset.isPending ? '提交中…' : '确认重置'}
            </Button>
            <Button variant="ghost" onClick={() => setResetTarget(null)}>
              取消
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserRow({
  user,
  roles,
  busy,
  onToggleStatus,
  onAssignRole,
  onResetOpen,
}: {
  user: AppUserSummary;
  roles: RoleSummary[];
  busy: boolean;
  onToggleStatus: () => void;
  onAssignRole: (roleCode: string) => void;
  onResetOpen: () => void;
}) {
  const [pendingRole, setPendingRole] = useState('');
  return (
    <tr>
      <td>{user.nickname}</td>
      <td className="mono text-xs">{user.generatedAccountCode}</td>
      <td>
        <div className="flex flex-wrap items-center gap-2">
          {user.roles.length ? user.roles.map((r) => <Badge key={r}>{r}</Badge>) : '—'}
          {roles.length > 0 ? (
            <span className="flex items-center gap-1">
              <Select
                aria-label={`为 ${user.nickname} 选择角色`}
                className="select-auto"
                value={pendingRole}
                onValueChange={setPendingRole}
                options={[{ value: '', label: '改角色…' }, ...roles.map((r) => ({ value: r.code, label: r.name }))]}
              />
              <Button
                variant="ghost"
                disabled={busy || !pendingRole}
                onClick={() => {
                  onAssignRole(pendingRole);
                  setPendingRole('');
                }}
              >
                应用
              </Button>
            </span>
          ) : null}
        </div>
      </td>
      <td>
        <Badge tone={user.status === 'active' ? 'success' : 'muted'}>{user.status === 'active' ? '启用' : '停用'}</Badge>
      </td>
      <td className="text-xs text-ink-muted">{formatTimestamp(user.lastLoginAt)}</td>
      <td>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={onToggleStatus}>
            {user.status === 'active' ? '停用' : '启用'}
          </Button>
          <Button variant="ghost" onClick={onResetOpen}>
            重置主密码
          </Button>
        </div>
      </td>
    </tr>
  );
}
