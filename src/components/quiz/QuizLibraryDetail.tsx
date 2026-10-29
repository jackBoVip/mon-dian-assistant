import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/queryClient';
import { pageItems } from '../../lib/pageWindow';
import { issueLabel, qtypeLabel } from '../../lib/quiz';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNav } from '../ui/pagination';
import { ErrorState, Loading } from '../ui/StateBlocks';
import type { QuizLibraryRow } from '../../lib/types';

const PAGE_SIZE = 10;

export interface QuizLibraryDetailProps {
  library: QuizLibraryRow | null;
  onClose: () => void;
}

/** 题库详情：逐题只读展示题干、选项、答案与导入时的问题码；分页由后端做。 */
export function QuizLibraryDetail({ library, onClose }: QuizLibraryDetailProps) {
  const [page, setPage] = useState(1);

  // 换一份题库就回到第 1 页，否则会带着上一份的页码去取新库的越界偏移。
  useEffect(() => setPage(1), [library?.id]);

  const offset = (page - 1) * PAGE_SIZE;
  const questions = useQuery({
    queryKey: library ? queryKeys.quizLibrary(library.id, offset, PAGE_SIZE) : ['quizLibrary', 'none'],
    queryFn: () => api.quizLibraryQuestions(library!.id, offset, PAGE_SIZE),
    enabled: !!library,
    placeholderData: keepPreviousData,
  });

  const total = questions.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = questions.data?.items ?? [];

  return (
    <Modal
      open={!!library}
      title={library ? `${library.name} · ${library.questionCount} 题` : '题库详情'}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="min-w-0 text-xs text-ink-muted">
            来源 {library?.sourceFilename || '未知'} · 导入于 {library ? new Date(library.createdAt).toLocaleString() : '—'}
          </span>
          <Button className="shrink-0 whitespace-nowrap" onClick={onClose}>关闭</Button>
        </div>
      }
    >
      {questions.isLoading ? <Loading label="读取题目…" /> : null}
      {questions.isError ? <ErrorState raw={questions.error} onRetry={() => void questions.refetch()} /> : null}

      {questions.data && rows.length === 0 ? (
        <p className="empty-state">这份题库里没有题目。</p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <ul aria-label="题目列表">
            {rows.map((q) => (
              <li key={q.id} className="border-b border-line py-3 first:pt-0 last:border-b-0">
                <div className="flex items-start gap-3">
                  <span className="shrink-0 pt-0.5 text-xs tabular-nums text-ink-muted">#{q.seq}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-pretty text-ink">{q.stem}</p>
                    {q.options.length > 0 ? (
                      <ul className="mt-1 grid gap-0.5 text-xs text-ink-body">
                        {q.options.map((o) => (
                          <li key={o.key}>
                            <span className="font-medium text-ink-muted">{o.key}.</span> {o.text}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-xs border border-line px-2 py-0.5 text-ink">答案 {q.answerDisplay || '—'}</span>
                      <Badge>{qtypeLabel(q.qtype)}</Badge>
                      {q.tags.map((t) => (
                        <span key={t} className="text-ink-muted">
                          #{t}
                        </span>
                      ))}
                      {q.issues.map((code) => (
                        <Badge key={code} tone="warning">
                          {issueLabel(code)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className="page-info whitespace-nowrap" role="status">
              共 {total} 题 · 第 {page}/{totalPages} 页
            </span>
            <Pagination aria-label="题库题目分页" className="shrink-0">
              <PaginationContent className="page-controls">
                <PaginationItem>
                  <PaginationNav
                    label="上一页"
                    variant="bare"
                    className="page-btn whitespace-nowrap"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  />
                </PaginationItem>
                {pageItems(page, totalPages).map((item, idx) =>
                  item === 'gap' ? (
                    <PaginationItem key={`gap-${idx}`}>
                      <PaginationEllipsis className="page-btn">…</PaginationEllipsis>
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        className="page-num"
                        isActive={item === page}
                        aria-label={`第 ${item} 页`}
                        onClick={() => setPage(item)}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNav
                    label="下一页"
                    variant="bare"
                    className="page-btn whitespace-nowrap"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
