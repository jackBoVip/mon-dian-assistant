import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { invalidateTargetLists, queryKeys } from '../../lib/queryClient';
import { hidesTrashEntryCode, toNormalisedError } from '../../lib/errors';
import { targetTypeLabel, type DeletedItemRow } from '../../lib/types';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ErrorState, EmptyState } from '../ui/StateBlocks';
import { formatTimestamp } from '../../lib/format';
import { notify } from '../../state/notify';

/** 与后端 list_deleted_items 的默认值一致（后端再按 1..1000 夹取）。 */
const TRASH_LIMIT = 200;

/**
 * 回收站：列出被软删除的外部系统凭据，并逐条恢复。
 *
 * 权限完全交给后端判定——list_deleted_items 与 restore_item 都要求 accounts.delete：
 * 后端回 FORBIDDEN 时整个入口不渲染（不按角色在前端猜权限，也不做成"点开后报错"的假按钮）；
 * 会话类错误由全局会话面板呈现，此时入口同样不出现。
 */
export function DeletedItemsPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const trash = useQuery({
    queryKey: queryKeys.deletedItems,
    queryFn: () => api.listDeletedItems(TRASH_LIMIT),
  });

  const restore = useMutation({
    mutationFn: (row: DeletedItemRow) => api.restoreItem(row.item.id),
    // restore_item 只返回单元值：以调用参数（这一行回收站记录）决定还要重取哪些列表
    onSuccess: (_void, row) => {
      notify('success', `已恢复账号：${row.item.accountAlias}（系统「${row.targetName}」），凭据内容未改动`);
      void qc.invalidateQueries({ queryKey: queryKeys.deletedItems });
      void qc.invalidateQueries({ queryKey: queryKeys.targetItems(row.item.targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.targetDetail(row.item.targetId) });
      invalidateTargetLists(qc);
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
    },
    onError: (raw) => notify('danger', toNormalisedError(raw).message),
  });

  // 无权限（FORBIDDEN）/ 会话不可用 / 后端还没答复：入口不出现
  const code = trash.error ? toNormalisedError(trash.error).code : null;
  if (hidesTrashEntryCode(code) || trash.isLoading) return null;

  const rows: DeletedItemRow[] = trash.data ?? [];

  return (
    <section className="mt-6" aria-label="回收站 / 已删除凭据">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">回收站 / 已删除凭据（{rows.length} 条）</h3>
        <Button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '收起回收站' : '展开回收站'}
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        软删除的账号不出现在目标列表里，只能在此逐条恢复；恢复后回到原目标下，凭据内容不变。
        后端只回显系统名 / 账号别名 / 类型 / 删除时间——用户名与密码都不回显，因此本表不设用户名列。
      </p>

      {trash.isError ? <ErrorState raw={trash.error} onRetry={() => void trash.refetch()} /> : null}

      {open && !trash.isError ? (
        <div className="mt-2" aria-live="polite">
          {rows.length === 0 ? (
            <EmptyState>没有已删除的凭据</EmptyState>
          ) : (
            <div className="table-wrap">
                          <table className="table">
                            <thead>
                              <tr>
                                <th scope="col">系统名</th>
                                <th scope="col">账号别名</th>
                                <th scope="col">类型</th>
                                <th scope="col">删除时间</th>
                                <th scope="col">操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((row) => (
                                <tr key={row.item.id}>
                                  <td>{row.targetName}</td>
                                  <td>
                                    <span className="font-medium">{row.item.accountAlias}</span>
                                    {row.item.status === 'disabled' ? <Badge tone="warning">已停用</Badge> : null}
                                    {row.item.tags.length > 0 ? (
                                      <span className="ml-2 text-xs text-ink-muted">
                                        {row.item.tags.map((t) => `#${t}`).join(' ')}
                                      </span>
                                    ) : null}
                                  </td>
                                  <td>{targetTypeLabel(row.item.itemType)}</td>
                                  <td className="text-xs text-ink-muted">{formatTimestamp(row.deletedAt)}</td>
                                  <td>
                                    <Button variant="primary" disabled={restore.isPending} onClick={() => restore.mutate(row)}>
                                      恢复
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
