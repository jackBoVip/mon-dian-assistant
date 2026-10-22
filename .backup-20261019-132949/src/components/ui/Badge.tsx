import type { ReactNode } from 'react';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'muted';

/** 状态不只靠颜色表达：badge 同时带前导点（.badge::before）、边框与文字。
 * S 轮起不再叠 .badge-status——那一枚现在是原型那颗"绿药丸 + 前导点"的状态徽标，
 * 自带底色与边框，叠在任何色调上都会把 success/warning/danger 那四档染成同一枚绿。 */
export function Badge({ tone = 'muted', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
