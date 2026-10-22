import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import type { AppUserSummary, RoleSummary } from '../../lib/types';
import { Button } from '../ui/Button';
import { TextField, SelectField } from '../ui/Field';
import { PasswordField } from '../ui/PasswordField';
import { Badge } from '../ui/Badge';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';
import { formatTimestamp } from '../../lib/format';

/** 系统管理 > 用户与角色：管理本软件自身的使用者（不是外部系统账号）。 */
export function UsersSection() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.users, queryFn: () => api.listUsers() });
  const roles = useQuery({ queryKey: queryKeys.roles, queryFn: () => api.listRoles() });

  const roleList: RoleSummary[] = roles.data ?? [];

  const [nickname, setNickname] = useState('');
  const [pwd, setPwd] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState('');

  function invalidateUsers() {
    void qc.invalidateQueries({ queryKey: queryKeys.users });
  }
  const onError = (raw: unknown) => notify('danger', toNormalisedError(raw).message);

  const create = useMutation({
    mutationFn: () => api.createUser(nickname.trim(), pwd, roleKey),
    onSuccess: (u) => {
      notify('success', `已创建本软件使用者：${u.nickname}（内部标识 ${u.generatedAccountCode}）`);
      setNickname('');
      setPwd('');
      setRoleKey('');
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

  function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!nickname.trim() || !pwd || !roleKey) {
      notify('warning', '昵称、初始主密码、角色均必填。');
      return;
    }
    create.mutate();
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-ink-muted">
        这里的「使用者」是本软件本地保险库的使用者，用昵称+主密码解锁；内部账号标识由后端自动生成、只读展示，任何流程都不要求手工输入。
        创建/停用/改角色/重置主密码等敏感操作由后端要求近期二次认证，过期会先弹出重新认证。
      </p>

      <form onSubmit={onCreate} className="panel flex flex-col gap-3 p-4">
        <h3 className="panel-title">新增本软件使用者</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <TextField label="昵称" value={nickname} onChange={(e) => setNickname(e.target.value)} required />
          <PasswordField label="初始主密码" value={pwd} onChange={(e) => setPwd(e.target.value)} required />
          {roles.isLoading ? (
            <Loading label="加载角色…" />
          ) : roles.isError ? (
            <ErrorState raw={roles.error} onRetry={() => void roles.refetch()} />
          ) : (
            <SelectField
              label="角色"
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
              hint="角色列表来自后端 list_roles"
            >
              <option value="">请选择角色</option>
              {roleList.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}（{r.code}）
                </option>
              ))}
            </SelectField>
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
      </form>

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
              <select
                aria-label={`为 ${user.nickname} 选择角色`}
                className="select"
                style={{ width: 'auto' }}
                value={pendingRole}
                onChange={(e) => setPendingRole(e.target.value)}
              >
                <option value="">改角色…</option>
                {roles.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
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
