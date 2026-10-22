import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { targetTypeLabel } from '../../lib/types';
import { Loading, ErrorState } from '../ui/StateBlocks';

/** 顶部统计：目标数 / 凭据数 / 收藏数 / 按类型分布，全部来自 api.stats()（后端 StatsView.byType 数组）。 */
export function StatsCards() {
  const stats = useQuery({ queryKey: queryKeys.stats, queryFn: () => api.stats() });

  if (stats.isLoading) return <Loading label="加载统计…" />;
  if (stats.isError) return <ErrorState raw={stats.error} onRetry={() => void stats.refetch()} />;
  if (!stats.data) return null;

  const byType = stats.data.byType.filter((x) => x.count > 0);

  return (
    <div className="stat-grid">
      <div className="stat-card">
        <div className="stat-label">目标 / 系统</div>
        <div className="stat-value">
          {stats.data.targetCount}
          <span className="stat-unit">个</span>
        </div>
      </div>
      <div className="stat-card stat-accent">
        <div className="stat-label">台账账号（外部凭据）</div>
        <div className="stat-value">
          {stats.data.credentialCount}
          <span className="stat-unit">条</span>
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">收藏</div>
        <div className="stat-value">
          {stats.data.favoriteCount}
          <span className="stat-unit">条</span>
        </div>
      </div>
      {byType.length > 0 ? (
        <div className="stat-types">
          {byType.map((x) => (
            <span key={x.typeKey} className="badge badge-muted">
              {targetTypeLabel(x.typeKey)} {x.count}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
