import { Button } from '../ui/Button';
import { SelectField } from '../ui/Field';

/** 需求 §6：列表必须分页，且切换页面保持流畅；这里只渲染页码，不渲染行。 */
const PAGE_SIZES = [10, 20, 50, 100] as const;

export interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

/** 页码窗口：总页数少就全列，多就固定两端 + 中间窗口，中间用省略号占位（与原型一致）。 */
export function pageItems(current: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) return range(1, totalPages);
  if (current <= 4) return [...range(1, 5), 'gap', totalPages];
  if (current >= totalPages - 3) return [1, 'gap', ...range(totalPages - 4, totalPages)];
  return [1, 'gap', current - 1, current, current + 1, 'gap', totalPages];
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export function Pagination({ total, page, pageSize, onPage, onPageSize }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = pageItems(page, totalPages);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <p className="num flex-1 text-xs text-ink-muted" role="status">
        共 {total} 条 · 第 {page} / {totalPages} 页
      </p>
      <div className="w-32">
        <SelectField label="每页条数" value={String(pageSize)} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </SelectField>
      </div>
      <nav className="flex items-center gap-1" aria-label="分页">
        <Button variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </Button>
        {items.map((it, i) =>
          it === 'gap' ? (
            <span key={`gap-${i}`} className="px-2 text-sm text-ink-muted" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={it}
              type="button"
              className="num rounded-sm border border-line px-2.5 py-1 text-sm"
              onClick={() => onPage(it)}
              aria-current={it === page ? 'page' : undefined}
            >
              {it}
            </button>
          ),
        )}
        <Button variant="ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          下一页
        </Button>
      </nav>
    </div>
  );
}
