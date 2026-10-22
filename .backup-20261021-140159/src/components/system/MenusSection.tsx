import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateRbac, queryKeys } from '../../lib/queryClient';
import { pagePermissionMap } from '../../lib/pageMeta';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/Badge';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { notify } from '../../state/notify';
import { toNormalisedError } from '../../lib/errors';

/**
 * 菜单管理：角色 × 三枚一级菜单的可见性矩阵。
 * 菜单项由版本固定，不能增删；本页只写 menu.* 权限，操作权限在权限管理页。
 */
export function MenusSection() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: queryKeys.rolesAdmin, queryFn: () => api.listRolesAdmin() });
  const catalog = useQuery({ queryKey: queryKeys.menuCatalog, queryFn: () => api.listMenuCatalog() });
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});

  // 服务端数据刷新后丢弃本地草稿：保存/还原/别处改动都应以最新权限为准。
  useEffect(() => {
    setDrafts({});
  }, [roles.data]);

  const save = useMutation({
    mutationFn: (v: { roleId: string; keys: string[] }) => api.setRoleMenuPermissions(v.roleId, v.keys),
    onSuccess: () => {
      notify('success', '菜单可见性已保存');
      invalidateRbac(qc);
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  const menus = catalog.data ?? [];
  const menuKeys = new Set(menus.map((m) => m.key));
  const roleList = roles.data ?? [];

  const loading = roles.isLoading || catalog.isLoading;
  const error = roles.error ?? catalog.error;

  function selectedOf(roleId: string, saved: string[]): string[] {
    return drafts[roleId] ?? saved;
  }

  function toggle(roleId: string, saved: string[], key: string, checked: boolean) {
    const base = selectedOf(roleId, saved);
    const next = checked ? [...new Set([...base, key])] : base.filter((k) => k !== key);
    setDrafts((prev) => ({ ...prev, [roleId]: next }));
  }

  return (
    <div className="flex flex-col gap-5">
      {loading ? <Loading label="加载角色与菜单…" /> : null}
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

      {roleList.length > 0 && menus.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">一级菜单</th>
                {roleList.map((role) => (
                  <th key={role.id} scope="col">
                    <span>{role.name}</span>
                    <span className="mono block text-xs text-ink-muted">{role.code}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {menus.map((menu) => (
                <tr key={menu.key}>
                  <th scope="row">
                    <span>{menu.label}</span>
                    <span className="mono block text-xs text-ink-muted">{menu.key}</span>
                  </th>
                  {roleList.map((role) => {
                    const saved = role.permissions.filter((k) => menuKeys.has(k));
                    const selected = selectedOf(role.id, saved);
                    return (
                      <td key={role.id}>
                        <Checkbox
                          aria-label={`${role.name} · ${menu.label}`}
                          checked={selected.includes(menu.key)}
                          onCheckedChange={(v) => toggle(role.id, saved, menu.key, v === true)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">操作</th>
                {roleList.map((role) => {
                  const saved = role.permissions.filter((k) => menuKeys.has(k));
                  const selected = selectedOf(role.id, saved);
                  const dirty = selected.length !== saved.length || selected.some((k) => !saved.includes(k));
                  return (
                    <td key={role.id}>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          aria-label={`保存 ${role.name} 的菜单权限`}
                          disabled={save.isPending || !dirty}
                          onClick={() => save.mutate({ roleId: role.id, keys: selected.filter((k) => menuKeys.has(k)) })}
                        >
                          保存
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`还原 ${role.name} 的菜单权限`}
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

      <div className="surface p-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="panel-title">二级页 → 所需权限</h3>
          <Badge tone="muted">只读对照</Badge>
        </div>
        <p className="mb-3 text-xs text-ink-muted">
          本表由导航定义推导，不手工维护；菜单勾选只决定入口，页面内的读写操作仍按这里列出的权限逐条校验。
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">页面</th>
                <th scope="col">所需权限</th>
              </tr>
            </thead>
            <tbody>
              {pagePermissionMap().map((entry) => (
                <tr key={entry.page}>
                  <td>{entry.label}</td>
                  <td className="mono text-xs">
                    {entry.requires.length === 0 ? '无需额外权限' : entry.requires.join(' 且 ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
