import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'muted';

const badgeVariants = cva('badge', {
  variants: {
    tone: {
      success: 'badge-success',
      warning: 'badge-warning',
      danger: 'badge-danger',
      muted: 'badge-muted',
    },
  },
  defaultVariants: { tone: 'muted' },
});

export interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}

/**
 * 状态不只靠颜色表达：badge 同时带前导点（.badge::before）、边框与文字。
 * S 轮起不再叠 .badge-status——那一枚现在是原型那颗"绿药丸 + 前导点"的状态徽标，
 * 自带底色与边框，叠在任何色调上都会把 success/warning/danger 那四档染成同一枚绿。
 *
 * 前导点是真::before 伪元素，只能待在样式表里；所以这里同 Button 一个口径：
 * cva 选类，样式实体在 `@layer mda`。
 */
export function Badge({ tone = 'muted', className, children }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}
