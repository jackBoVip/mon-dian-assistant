import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { targetTypeLabel } from '../../lib/types';
import { formatTimestamp } from '../../lib/format';

/**
 * 台账首页的「最近访问」入口（需求 §2.2）。
 * 只显示后端给的非秘密摘要：目标名、凭据别名、类型、访问时刻。没有用户名/口令字段可显示。
 * 取不到数据就整块不渲染：本命令与列表同为 accounts.read 门槛，真无权限时列表会自己报错，
 * 这里再叠一条错误只会把"没有最近访问记录"和"读不到"混成一团。
 */
export function RecentAccessPanel({ onOpenTarget }: { onOpenTarget: (targetId: string) => void }) {
  const recent = useQuery({ queryKey: queryKeys.recentAccess, queryFn: () => api.recentAccess(8) });

  if (recent.isError || !recent.data || recent.data.length === 0) return null;

  return (
    <section className="panel mb-4 px-4 py-3" aria-labelledby="recent-access-title">
      <h3 id="recent-access-title" className="panel-title mb-2">
        最近访问
      </h3>
      <ul className="flex flex-wrap gap-2">
        {recent.data.map((r) => (
          <li key={r.itemId}>
            <button
              type="button"
              className="rounded-sm border border-line px-2.5 py-1 text-left text-xs text-ink"
              onClick={() => onOpenTarget(r.targetId)}
            >
              <span className="font-semibold">{r.targetName}</span>
              <span className="text-ink-muted">
                {' · '}
                {r.accountAlias}
                {' · '}
                {targetTypeLabel(r.itemType)}
                {' · '}
                {formatTimestamp(r.lastAccessedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-muted">点击任一条目打开对应目标的详情。这里不显示用户名、口令或备注。</p>
    </section>
  );
}
