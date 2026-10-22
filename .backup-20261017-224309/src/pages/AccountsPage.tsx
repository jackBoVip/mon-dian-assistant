import { useEffect, useMemo, useState } from 'react';
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
import { StatsCards } from '../components/accounts/StatsCards';
import { Pagination } from '../components/accounts/Pagination';
import { RecentAccessPanel } from '../components/accounts/RecentAccessPanel';
import { TargetDetailDrawer } from '../components/accounts/TargetDetailDrawer';
import { DeletedItemsPanel } from '../components/accounts/DeletedItemsPanel';
import { CreateTargetDialog } from '../components/accounts/CreateTargetDialog';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { TextField, SelectField } from '../components/ui/Field';
import { Loading, ErrorState, EmptyState } from '../components/ui/StateBlocks';
import { formatTimestamp } from '../lib/format';

/** 账号管理：外部系统账号/密码台账（凭据保险库），不是本软件使用者的登录凭据。 */
export function AccountsPage() {
  const [type, setType] = useState<'all' | KnownTargetType>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [groupId, setGroupId] = useState('');
  const [tag, setTag] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [page, setPage] = useState(1);
  // 每页条数是本机界面偏好，不写 app_settings：后端的 update_setting 只允许管理员改全局设置
  const [pageSize, setPageSize] = useState(20);

  const [drawerTarget, setDrawerTarget] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  // 与 Rust TargetFilter 完全一致（deny_unknown_fields：只发这五个键）
  const filter = useMemo<TargetFilter>(
    () => ({
      itemType: type === 'all' ? undefined : type,
      keyword: debounced || undefined,
      groupId: groupId.trim() || undefined,
      tag: tag || undefined,
      favoriteOnly: favoriteOnly || undefined,
    }),
    [type, debounced, groupId, tag, favoriteOnly],
  );

  // 筛选条件一变就回到第 1 页：否则停在第 5 页时搜一个只剩两页的关键字会得到"空列表"，看起来像数据丢了
  useEffect(() => setPage(1), [filter]);

  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const targets = useQuery({
    queryKey: queryKeys.targetsPaged(filter, page, pageSize),
    queryFn: () => api.listTargetsPaged(filter, page, pageSize),
    // 翻页/改筛选时保留上一页内容：需求要求"切换页面应保持流畅"，不要出现整屏闪烁空白
    placeholderData: keepPreviousData,
  });
  const groups = useQuery({ queryKey: queryKeys.groups, queryFn: () => api.listGroups() });
  const itemTags = useQuery({ queryKey: queryKeys.itemTags, queryFn: () => api.listItemTags() });

  const rows = targets.data?.rows ?? [];
  const total = targets.data?.total ?? 0;

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        本菜单管理<strong>外部系统</strong>的账号/密码台账（凭据保险库）。这里的用户名/密码不是本软件的登录凭据。
      </p>

      <StatsCards />

      <RecentAccessPanel onOpenTarget={setDrawerTarget} />

      <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="类型筛选">
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

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <TextField
            label="搜索（按系统名称，后端 keyword 过滤）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入关键字…"
          />
        </div>
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
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} />
          仅收藏
        </label>
        <div className="pb-1">
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            新增目标
          </Button>
        </div>
      </div>

      <p className="mb-3 text-xs text-ink-muted">
        说明：分组筛选按目标所属分组匹配，未分组的目标不会出现在任何分组筛选结果中；标签筛选按目标下是否存在
        <strong>启用</strong>且带该标签的账号判定（大小写不敏感）；「仅收藏」按目标下是否存在
        <strong>启用且收藏</strong>的账号判定。列表由后端分页取数，「每页条数」只影响当前界面、不写入全局设置。
      </p>

      <div aria-live="polite">
        {targets.isLoading ? <Loading label="加载目标列表…" /> : null}
        {targets.isError ? <ErrorState raw={targets.error} onRetry={() => void targets.refetch()} /> : null}
        {targets.data ? (
          rows.length === 0 ? (
            <EmptyState>
              {total === 0
                ? '没有符合条件的目标。点击右上角「新增目标」创建，注意同一地址可保存多个账号。'
                : '当前页没有数据（总数有变化时请重新选择页码）。'}
            </EmptyState>
          ) : (
            <>
              <TargetTable rows={rows} onOpen={setDrawerTarget} />
              <Pagination
                total={total}
                page={page}
                pageSize={pageSize}
                onPage={setPage}
                onPageSize={changePageSize}
              />
            </>
          )
        ) : null}
      </div>

      {/* 回收站入口：后端判定无 accounts.delete 权限时该组件自行不渲染 */}
      <DeletedItemsPanel />

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
