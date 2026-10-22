import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';

/** 权限矩阵 / 可见菜单：完全展示后端 RBAC 计算结果，前端不做权限判定。 */
export function PermissionsSection() {
  const menus = useQuery({ queryKey: queryKeys.menus, queryFn: () => api.menus() });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">
        下表为后端针对当前使用者计算的可见菜单。任何未在此出现的菜单都不会渲染；即便直接调用命令，后端仍会二次鉴权。
      </p>
      {menus.isLoading ? <Loading label="加载可见菜单…" /> : null}
      {menus.isError ? <ErrorState raw={menus.error} onRetry={() => void menus.refetch()} /> : null}
      {menus.data ? (
        menus.data.length === 0 ? (
          <EmptyState>当前使用者没有可见菜单。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">菜单标识</th>
                  <th scope="col">名称</th>
                  <th scope="col">排序</th>
                </tr>
              </thead>
              <tbody>
                {[...menus.data].sort((a, b) => a.order - b.order).map((m) => (
                  <tr key={m.key}>
                    <td className="mono text-xs">{m.key}</td>
                    <td>{m.label}</td>
                    <td>{m.order}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}
