import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { Loading, ErrorState } from '../ui/StateBlocks';

/**
 * 统计条：目标 / 台账账号 / 收藏三格，仍走 api.stats() 那一条查询。
 * 取代原来的统计卡（StatsCards）——去掉了卡片面与「按类型分布」那一排徽标，
 * 三个主数改由一条下细线与筛选区分隔，与壳层的贴边形态一致。
 */
export function StatsStrip() {
  const stats = useQuery({ queryKey: queryKeys.stats, queryFn: () => api.stats() });

  if (stats.isLoading) return <Loading label="加载统计…" />;
  if (stats.isError) return <ErrorState raw={stats.error} onRetry={() => void stats.refetch()} />;
  if (!stats.data) return null;

  const items: Array<{ label: string; value: number; unit: string }> = [
    { label: '目标 / 系统', value: stats.data.targetCount, unit: '个' },
    { label: '台账账号', value: stats.data.credentialCount, unit: '条' },
    { label: '收藏', value: stats.data.favoriteCount, unit: '条' },
  ];

  return (
    <div className="stats-strip">
      {items.map((it) => (
        <div key={it.label} className="stats-item">
          <div className="stats-label">{it.label}</div>
          <div className="stats-value">
            {it.value}
            <span className="stats-unit">{it.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
