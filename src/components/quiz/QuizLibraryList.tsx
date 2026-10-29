import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { EmptyState, ErrorState, Loading } from '../ui/StateBlocks'
import { formatTimestamp } from '../../lib/format'
import { formatLabel } from '../../lib/quiz'
import type { QuizLibraryRow } from '../../lib/types'

export interface QuizLibraryListProps {
  rows: QuizLibraryRow[]
  loading: boolean
  error: unknown
  onRetry: () => void
  /** quiz.library.manage：重命名与删除。查看只要 quiz.library.read（本页入口已按它把关）。 */
  canManage: boolean
  pending: boolean
  onView: (library: QuizLibraryRow) => void
  onRename: (library: QuizLibraryRow) => void
  onDelete: (library: QuizLibraryRow) => void
}

/**
 * 已导入题库表。列宽写死在表头与行两处必须同一条字符串，否则两边各排各的会整列错位；
 * 因此列宽常量只留一份。
 */
const COLUMNS = 'grid-cols-[minmax(0,2.6fr)_88px_84px_minmax(0,1.1fr)_132px]'

export function QuizLibraryList({
  rows,
  loading,
  error,
  onRetry,
  canManage,
  pending,
  onView,
  onRename,
  onDelete,
}: QuizLibraryListProps) {
  return (
    <section className="surface flex flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">已导入题库</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-body">
            同一份资料按版本反复导入是常态，题库允许重名；答题助手默认在这份清单的全部题库里检索。
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-muted">共 {rows.length} 份</span>
      </header>

      {loading ? <Loading label="读取题库列表…" /> : null}
      {error ? <ErrorState raw={error} onRetry={onRetry} /> : null}

      {!loading && !error && rows.length === 0 ? (
        <EmptyState>
          <Icon name="database" size={26} />
          <span className="text-sm font-medium text-ink">还没有导入题库</span>
          <span className="text-xs leading-relaxed">
            点页头「导入题库」这枚图标，把 DOC / DOCX、XLS / XLSX、TXT / CSV 文件拖进弹窗即可开始复核。
          </span>
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <div role="table" aria-label="已导入题库">
          <div
            role="row"
            className={`grid ${COLUMNS} items-center gap-3 border-b border-line bg-sunken px-4 py-2.5 text-xs font-semibold text-ink-muted`}
          >
            <div role="columnheader">题库名称</div>
            <div role="columnheader" className="text-center">
              格式
            </div>
            <div role="columnheader" className="text-center">
              题数
            </div>
            <div role="columnheader" className="text-center">
              最近更新
            </div>
            <div role="columnheader" className="text-right">
              操作
            </div>
          </div>
          <div role="rowgroup">
            {rows.map((lib) => (
              <div
                role="row"
                key={lib.id}
                className={`grid ${COLUMNS} items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-row-hover`}
              >
                <div role="cell" className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink" title={lib.name}>
                    {lib.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted" title={lib.sourceFilename}>
                    {lib.sourceFilename || '来源文件未知'}
                  </span>
                </div>
                <div role="cell" className="text-center">
                  <Badge>{formatLabel(lib.sourceFormat)}</Badge>
                </div>
                <div role="cell" className="text-center text-sm tabular-nums text-ink">
                  {lib.questionCount}
                </div>
                <div role="cell" className="text-center text-xs text-ink-body">
                  {formatTimestamp(lib.updatedAt)}
                </div>
                <div role="cell" className="flex items-center justify-end gap-2">
                  <Button
                    variant="bare"
                    className="btn-mini"
                    aria-label={`查看 ${lib.name} 的题目`}
                    title="查看题目"
                    onClick={() => onView(lib)}
                  >
                    <Icon name="eye" size={13} />
                  </Button>
                  {canManage ? (
                    <>
                      <Button
                        variant="bare"
                        className="btn-mini"
                        aria-label={`重命名 ${lib.name}`}
                        title="重命名"
                        disabled={pending}
                        onClick={() => onRename(lib)}
                      >
                        <Icon name="edit" size={13} />
                      </Button>
                      <Button
                        variant="bare"
                        className="btn-mini"
                        aria-label={`删除 ${lib.name}`}
                        title="删除题库（含全部题目）"
                        disabled={pending}
                        onClick={() => onDelete(lib)}
                      >
                        <Icon name="trash" size={13} />
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
