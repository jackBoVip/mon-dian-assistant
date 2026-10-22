import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Loading, ErrorState, EmptyState } from '../ui/StateBlocks';
import { Select } from '../ui/select';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNav,
} from '../ui/pagination';
import { pageItems } from '../../lib/pageWindow';
import { auditActionLabel, auditEntityLabel, isOpaqueAuditId } from '../../lib/auditLabels';
import { formatTimestamp } from '../../lib/format';

const RESULT_TONE: Record<string, BadgeTone> = { success: 'success', failure: 'danger', denied: 'warning' };
const RESULT_LABEL: Record<string, string> = { success: '成功', failure: '失败', denied: '拒绝' };

/**
 * 后端 `list_audit_events` 把 limit 夹在 1..=1000（commands/system.rs），没有 offset/total。
 * 所以一次取满后端上限，翻页只在前端切窗口，不改 IPC 契约；取满时页脚必须说明"更早的没载入"。
 */
const FETCH_LIMIT = 1000;
const PAGE_SIZES = [20, 50, 100] as const;

/** 审计日志：只读、追加式；仅呈现动作元数据，绝不含秘密。 */
export function AuditSection() {
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(1);
  const audit = useQuery({ queryKey: queryKeys.audit(FETCH_LIMIT), queryFn: () => api.audit(FETCH_LIMIT) });

  const rows = audit.data ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  /* 页码从状态里派生再夹取：取数变短或每页条数变大时落到末页，不会停在越界的空表上 */
  const current = Math.min(page, totalPages);
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);

  /* 翻页后回到表体顶部：卡片里自滚，不重置的话新一页会停在上一次的滚动位置，
   * 读起来像"这一页只有半截"。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [current, pageSize]);

  return (
    <div className="audit-section">
      {audit.isLoading ? <Loading label="加载审计日志…" /> : null}
      {audit.isError ? <ErrorState raw={audit.error} onRetry={() => void audit.refetch()} /> : null}
      {audit.data ? (
        rows.length === 0 ? (
          <EmptyState>暂无审计记录。</EmptyState>
        ) : (
          <div className="table-wrap audit-table">
            <div className="audit-table-scroll" ref={scrollRef}>
              <table className="table table-sticky-head table-center">
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
                  {pageRows.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-xs">{formatTimestamp(e.ts)}</td>
                      {/* 只上昵称：内部标识（UUID）在表里每一行都一样，占掉两行宽度却读不出任何信息。
                          后端没给昵称（历史行、系统写的事件）时才回落显示 actorId，不然这一格会空着。 */}
                      <td className="text-xs">{e.actorNickname ?? e.actorId ?? '系统'}</td>
                      <td title={e.action}>{auditActionLabel(e.action)}</td>
                      <td className="text-xs" title={e.targetId ? `${e.targetType ?? ''} ${e.targetId}`.trim() : undefined}>
                        {e.targetType ? auditEntityLabel(e.targetType) : '—'}
                        {/* UUID 主键不上屏（交付方点名），但可读标识留着：导出文件名、菜单节点键这类
                            才是"这一条到底动了哪个东西"的唯一凭据。id 仍在这格的 title 里可查。 */}
                        {e.targetId && !isOpaqueAuditId(e.targetId) ? (
                          <span className="mono ml-1 text-ink-muted">{e.targetId}</span>
                        ) : null}
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

            <div className="table-pagination">
              <div className="page-info" role="status">
                共 {rows.length} 条记录
                {rows.length >= FETCH_LIMIT ? `（仅加载最近 ${FETCH_LIMIT} 条）` : ''}
              </div>
              <Pagination className="contents" aria-label="审计日志分页">
                <PaginationContent className="page-controls">
                  <PaginationItem>
                    <Select
                      aria-label="每页条数"
                      className="select-auto page-size-select"
                      value={String(pageSize)}
                      onValueChange={(v) => {
                        setPageSize(Number(v));
                        setPage(1);
                      }}
                      options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} 条/页` }))}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNav
                      variant="bare"
                      className="page-btn"
                      label="上一页"
                      disabled={current <= 1}
                      onClick={() => setPage(current - 1)}
                    />
                  </PaginationItem>
                  {pageItems(current, totalPages).map((n, i) =>
                    n === 'gap' ? (
                      <PaginationItem key={`gap-${i}`}>
                        <PaginationEllipsis className="page-num">…</PaginationEllipsis>
                      </PaginationItem>
                    ) : (
                      <PaginationItem key={n}>
                        <PaginationLink className="page-num" isActive={n === current} onClick={() => setPage(n)}>
                          {n}
                        </PaginationLink>
                      </PaginationItem>
                    ),
                  )}
                  <PaginationItem>
                    <PaginationNav
                      variant="bare"
                      className="page-btn"
                      label="下一页"
                      disabled={current >= totalPages}
                      onClick={() => setPage(current + 1)}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
