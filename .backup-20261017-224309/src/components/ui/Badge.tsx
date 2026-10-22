import type { ReactNode } from 'react';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'muted';

/** 状态不只靠颜色表达：badge 同时带前导点、边框与文字。 */
export function Badge({ tone = 'muted', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone} badge-status`}>{children}</span>;
}
