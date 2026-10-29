import { useEffect, useState } from 'react';
import { useBackendEventPayload } from '../lib/vaultEvents';
import { useTheme } from '../state/theme';
import { qtypeLabel } from '../lib/quiz';
import type { QuizMatchHit } from '../lib/types';

/** 与 `quiz::tip::TipPayload` 逐字对应（serde camelCase）。 */
interface TipPayload {
  visible: boolean;
  hit: QuizMatchHit | null;
  showOptions: boolean;
  at: number;
}

const EVENT_TIP = 'quiz://tip';

/**
 * 答题浮层：一扇固定尺寸、点击穿透的置顶小窗。
 *
 * 它只做一件事——把 Rust 侧算好的那一条命中显示出来，不在前端做任何匹配或排序：
 * 阈值、范围、换题确认全在悬停线程里，浮层显示什么就是后端的结论。
 * 窗口的显隐与位置由 Rust 控制（必须避开取景带），所以这里不调任何窗口 API。
 */
export function QuizTipApp() {
  const [payload, setPayload] = useState<TipPayload | null>(null);

  useBackendEventPayload<TipPayload>(EVENT_TIP, setPayload);

  useEffect(() => {
    // 浮层是隐藏而非销毁：主题跟着当前设置走，换皮不必重开窗口。
    useTheme.getState().apply();
    void useTheme.getState().load();
  }, []);

  const hit = payload?.visible ? payload.hit : null;
  if (!hit) {
    return null;
  }
  const options = payload?.showOptions ? hit.options : [];

  return (
    <div className="quiztip-card" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="quiztip-tag">{qtypeLabel(hit.qtype)}</span>
        <span className="quiztip-meta">
          {hit.libraryName} · 第 {hit.seq} 题
        </span>
        <span className="quiztip-score" title="与识别文本的相似度">
          {Math.round(hit.score * 100)}%
        </span>
      </div>

      <p className="quiztip-stem" title={hit.stem}>
        {hit.stem}
      </p>

      <p className="quiztip-answer">
        <span className="quiztip-answer-label">答案</span>
        {hit.answerDisplay || '—'}
      </p>

      {options.length > 0 ? (
        <ul className="quiztip-options">
          {options.map((o) => (
            <li key={o.key}>
              <span className="quiztip-option-key">{o.key}</span>
              <span title={o.text}>{o.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
