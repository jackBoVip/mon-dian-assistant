import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { SelectField } from '../ui/Field';
import { formatTimestamp } from '../../lib/format';

const RESULT_TONE: Record<string, BadgeTone> = { success: 'success', failure: 'danger', denied: 'warning' };
const RESULT_LABEL: Record<string, string> = { success: '成功', failure: '失败', denied: '拒绝' };

/** 审计日志：只读、追加式；仅呈现动作元数据，绝不含秘密。 */
export function AuditSection() {
  const [limit, setLimit] = useState(100);
  const audit = useQuery({ queryKey: queryKeys.audit(limit), queryFn: () => api.audit(limit) });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">审计日志为追加式记录，界面不提供修改/删除入口。字段仅含时间、操作人、动作、目标、结果与必要错误码。</p>
      <div className="w-48">
        <SelectField label="显示条数" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
          {[50, 100, 200, 500].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </SelectField>
      </div>

      {audit.isLoading ? <Loading label="加载审计日志…" /> : null}
      {audit.isError ? <ErrorState raw={audit.error} onRetry={() => void audit.refetch()} /> : null}
      {audit.data ? (
        audit.data.length === 0 ? (
          <EmptyState>暂无审计记录。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">操作人</th>
                  <th scope="col">动作</th>
                  <th scope="col">对象</th>
                  <th scope="col">结果</th>
                  <th scope="col">错误码</th>
                  <th scope="col">来源</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs">{formatTimestamp(e.ts)}</td>
                    <td className="text-xs">
                      {e.actorNickname ?? e.actorId ?? '系统'}
                      {e.actorNickname && e.actorId ? <span className="mono ml-1 text-ink-muted">{e.actorId}</span> : null}
                    </td>
                    <td>{e.action}</td>
                    <td className="text-xs">
                      {e.targetType ?? '—'}
                      {e.targetId ? ` · ${e.targetId}` : ''}
                    </td>
                    <td>
                      <Badge tone={RESULT_TONE[e.result] ?? 'muted'}>{RESULT_LABEL[e.result] ?? e.result}</Badge>
                    </td>
                    <td className="mono text-xs">{e.errorCode ?? '—'}</td>
                    <td className="text-xs text-ink-muted">{e.source ?? '—'}</td>
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
