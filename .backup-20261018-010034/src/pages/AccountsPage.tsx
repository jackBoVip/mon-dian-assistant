import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryClient';
import {
  targetTypeLabel,
  TYPE_FILTERS,
  type KnownTargetType,
  type TargetFilter,
  type TargetRow,
} from '../lib/types';
import { StatsStrip } from '../components/accounts/StatsStrip';
import { TargetDetailDrawer } from '../components/accounts/TargetDetailDrawer';
import { CreateTargetDialog } from '../components/accounts/CreateTargetDialog';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { SelectField } from '../components/ui/Field';
import { Loading, ErrorState, EmptyState } from '../components/ui/StateBlocks';
import { formatTimestamp } from '../lib/format';
import { useShellSearch } from '../state/shellSearch';

// 单次取数上限：后端 page_size 夹取 1..=200（src-tauri/src/commands/accounts.rs:126-127），
// 界面撤掉分页后这就是可达范围，超出部分必须靠筛选收窄，界面上不能谎称"全部"。
const LIST_LIMIT = 200;

/** 账号管理：外部系统账号/密码台账（凭据保险库），不是本软件使用者的登录凭据。 */
export function AccountsPage() {
  const [type, setType] = useState<'all' | KnownTargetType>('all');
  const [groupId, setGroupId] = useState('');
  const [tag, setTag] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  // 关键字来自顶栏那颗展开式搜索框（全局唯一搜索入口），防抖收在 store 里
  const debouncedKeyword = useShellSearch((s) => s.debouncedKeyword);

  const [drawerTarget, setDrawerTarget] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // 与 Rust TargetFilter 完全一致（deny_unknown_fields：只发这五个键）
  const filter = useMemo<TargetFilter>(
    () => ({
      itemType: type === 'all' ? undefined : type,
      keyword: debouncedKeyword || undefined,
      groupId: groupId.trim() || undefined,
      tag: tag || undefined,
      favoriteOnly: favoriteOnly || undefined,
    }),
    [type, debouncedKeyword, groupId, tag, favoriteOnly],
  );

  const targets = useQuery({
    queryKey: queryKeys.targetsPaged(filter, 1, LIST_LIMIT),
    queryFn: () => api.listTargetsPaged(filter, 1, LIST_LIMIT),
    // 改筛选时保留上一批内容：需求要求"切换页面应保持流畅"，不要出现整屏闪烁空白
    placeholderData: keepPreviousData,
  });
  const groups = useQuery({ queryKey: queryKeys.groups, queryFn: () => api.listGroups() });
  const itemTags = useQuery({ queryKey: queryKeys.itemTags, queryFn: () => api.listItemTags() });

  const rows = targets.data?.rows ?? [];
  const total = targets.data?.total ?? 0;

  return (
    <div>
      <PageHeader
        title="账号管理"
        desc={
          <>
            管理<strong>外部系统</strong>的账号/密码台账（凭据保险库）。这里的用户名/密码不是本软件的登录凭据。
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            新增目标
          </Button>
        }
      />

      <StatsStrip />

      <div className="action-bar">
        <div className="tabs" role="tablist" aria-label="类型筛选">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={type === f.key}
              type="button"
              onClick={() => setType(f.key)}
              className="chip-toggle"
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="filters">
          <div className="w-48">
            <SelectField label="分组筛选" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">全部分组</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="w-48">
            <SelectField label="标签筛选" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">全部标签</option>
              {(itemTags.data ?? []).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </SelectField>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} />
            仅收藏
          </label>
        </div>
      </div>

      <div className="main-panel">
        <p className="panel-notice">
          说明：分组筛选按目标所属分组匹配，未分组的目标不会出现在任何分组筛选结果中；标签筛选按目标下是否存在
          <strong>启用</strong>且带该标签的账号判定（大小写不敏感）；「仅收藏」按目标下是否存在
          <strong>启用且收藏</strong>的账号判定。关键字取自顶栏搜索框，收窄条件后列表即时重取。
        </p>

        <div aria-live="polite">
          {targets.isLoading ? <Loading label="加载目标列表…" /> : null}
          {targets.isError ? <ErrorState raw={targets.error} onRetry={() => void targets.refetch()} /> : null}
          {targets.data ? (
            rows.length === 0 ? (
              <EmptyState>
                {total === 0
                  ? '没有符合条件的目标。点击页头右侧「新增目标」创建，注意同一地址可保存多个账号。'
                  : `后端报告有 ${total} 条符合条件的目标，本次却没取回任何行；请重新加载或收窄筛选。`}
              </EmptyState>
            ) : (
              <TargetTable rows={rows} onOpen={setDrawerTarget} />
            )
          ) : null}
        </div>

        {targets.data && total > rows.length ? (
          <p className="list-note">
            本次载入 {rows.length} 条，后端符合筛选的总数是 {total} 条；列表单次最多取 {LIST_LIMIT} 条（后端上限），其余{' '}
            {total - rows.length} 条请用顶部搜索或类型标签收窄后再看。
          </p>
        ) : null}
      </div>

      <TargetDetailDrawer targetId={drawerTarget} onClose={() => setDrawerTarget(null)} />
      <CreateTargetDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          setDrawerTarget(id);
        }}
      />
    </div>
  );
}

function TargetTable({ rows, onOpen }: { rows: TargetRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">目标 / 系统</th>
            <th scope="col">类型</th>
            <th scope="col">账号数</th>
            <th scope="col">状态</th>
            <th scope="col">更新</th>
            <th scope="col" className="col-action">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-medium">{r.displayName}</td>
              <td className="text-ink-muted">{targetTypeLabel(r.targetType)}</td>
              <td>
                <span className="badge badge-muted">{r.credentialCount} 个账号</span>
              </td>
              <td>
                <Badge tone={r.status === 'active' ? 'success' : 'warning'}>
                  {r.status === 'active' ? '启用' : '停用'}
                </Badge>
              </td>
              <td className="text-xs text-ink-muted">{formatTimestamp(r.updatedAt)}</td>
              <td className="col-action">
                <Button variant="ghost" onClick={() => onOpen(r.id)}>
                  查看详情
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
