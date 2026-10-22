import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateRbac, queryKeys } from '../../lib/queryClient';
import type { PermissionRow } from '../../lib/types';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/checkbox';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

function groups(rows: PermissionRow[]): Array<{ label: string; rows: PermissionRow[] }> {
  const actions = rows.filter((row) => row.type === 'action');
  const accounts = actions.filter((row) => row.key.startsWith('accounts.'));
  const system = actions.filter((row) => row.key.startsWith('system.'));
  const other = actions.filter(
    (row) => !row.key.startsWith('accounts.') && !row.key.startsWith('system.'),
  );
  return [
    { label: '账号台账操作', rows: accounts },
    { label: '系统管理操作', rows: system },
    { label: '其他操作', rows: other },
  ].filter((group) => group.rows.length > 0);
}

/** 权限管理：角色 × 操作权限矩阵。权限项由版本定义，本页只改角色与权限的绑定。 */
export function PermissionsSection() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: queryKeys.rolesAdmin, queryFn: () => api.listRolesAdmin() });
  const catalog = useQuery({ queryKey: queryKeys.permissionsCatalog, queryFn: () => api.listPermissions() });
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setDrafts({});
  }, [roles.data]);

  const save = useMutation({
    mutationFn: (v: { roleId: string; keys: string[] }) => api.setRoleActionPermissions(v.roleId, v.keys),
    onSuccess: () => {
      notify('success', '操作权限已保存');
      invalidateRbac(qc);
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const roleList = roles.data ?? [];
  const actionKeys = new Set(
    (catalog.data ?? []).filter((row) => row.type === 'action').map((row) => row.key),
  );
  const grouped = groups(catalog.data ?? []);

  function selectedOf(roleId: string, saved: string[]): string[] {
    return drafts[roleId] ?? saved;
  }

  function toggle(roleId: string, saved: string[], key: string, checked: boolean) {
    const base = selectedOf(roleId, saved);
    const next = checked ? [...new Set([...base, key])] : base.filter((k) => k !== key);
    setDrafts((prev) => ({ ...prev, [roleId]: next }));
  }

  const loading = roles.isLoading || catalog.isLoading;
  const error = roles.error ?? catalog.error;

  return (
    <div className="flex flex-col gap-5">
      {loading ? <Loading label="加载角色与权限目录…" /> : null}
      {error ? (
        <ErrorState
          raw={error}
          onRetry={() => {
            void roles.refetch();
            void catalog.refetch();
          }}
        />
      ) : null}
      {roleList.length === 0 && !loading && !error ? <EmptyState>尚未定义任何角色。</EmptyState> : null}

      {roleList.length > 0 && grouped.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">操作权限</th>
                {roleList.map((role) => (
                  <th key={role.id} scope="col">
                    <span>{role.name}</span>
                    <span className="mono block text-xs text-ink-muted">{role.code}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => (
                <Fragment key={group.label}>
                  <tr>
                    <th scope="colgroup" colSpan={roleList.length + 1}>
                      {group.label}
                    </th>
                  </tr>
                  {group.rows.map((perm) => (
                    <tr key={perm.key}>
                      <th scope="row" title={perm.description ?? undefined}>
                        <span>{perm.name}</span>
                        <span className="mono block text-xs text-ink-muted">{perm.key}</span>
                      </th>
                      {roleList.map((role) => {
                        const saved = role.permissions.filter((k) => actionKeys.has(k));
                        const selected = selectedOf(role.id, saved);
                        return (
                          <td key={role.id}>
                            <Checkbox
                              aria-label={`${role.name} · ${perm.name}`}
                              checked={selected.includes(perm.key)}
                              onCheckedChange={(v) => toggle(role.id, saved, perm.key, v === true)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">操作</th>
                {roleList.map((role) => {
                  const saved = role.permissions.filter((k) => actionKeys.has(k));
                  const selected = selectedOf(role.id, saved);
                  const dirty = selected.length !== saved.length || selected.some((k) => !saved.includes(k));
                  return (
                    <td key={role.id}>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          aria-label={`保存 ${role.name} 的操作权限`}
                          disabled={save.isPending || !dirty}
                          onClick={() => save.mutate({ roleId: role.id, keys: selected.filter((k) => actionKeys.has(k)) })}
                        >
                          保存
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`还原 ${role.name} 的操作权限`}
                          disabled={save.isPending || !dirty}
                          onClick={() => setDrafts((prev) => ({ ...prev, [role.id]: saved }))}
                        >
                          还原
                        </Button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </div>
  );
}
