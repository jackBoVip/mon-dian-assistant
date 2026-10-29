import type { QuizMatchHit } from '../../lib/types';
import { qtypeLabel } from '../../lib/quiz';
import { Badge } from '../ui/Badge';

export interface QuizMatchHitsProps {
  hits: QuizMatchHit[];
  showOptions?: boolean;
  /** 没有命中时说什么。调用方知道是「识别不到文字」还是「题库里没有」。 */
  emptyHint?: string;
}

/**
 * 命中列表：题干、答案主显，选项可按设置隐藏。
 *
 * 置信度只作为百分比显示——0.62 这种门槛是后端的决定，界面不给使用者调阈值。
 */
export function QuizMatchHits({ hits, showOptions = true, emptyHint }: QuizMatchHitsProps) {
  if (hits.length === 0) {
    return <p className="empty-state">{emptyHint ?? '题库里没有足够接近的题目。'}</p>;
  }
  return (
    <ul aria-label="匹配结果" className="grid gap-2">
      {hits.map((hit) => (
        <li key={hit.questionId} className="rounded-md border border-line bg-sunken px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>{qtypeLabel(hit.qtype)}</Badge>
            <span className="text-xs text-ink-muted">
              {hit.libraryName} · 第 {hit.seq} 题
            </span>
            <span className="ml-auto text-xs tabular-nums text-ink-muted" title="与识别文本的相似度">
              {Math.round(hit.score * 100)}%
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-ink text-pretty" title={hit.stem}>
            {hit.stem}
          </p>
          <p className="mt-1 text-sm font-medium text-ink">
            <span className="text-xs font-normal text-ink-muted">答案 </span>
            {hit.answerDisplay || '—'}
          </p>
          {showOptions && hit.options.length > 0 ? (
            <ul className="mt-1 grid gap-0.5">
              {hit.options.map((option) => (
                <li key={option.key} className="text-xs leading-relaxed text-ink-body">
                  {option.key}. {option.text}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
