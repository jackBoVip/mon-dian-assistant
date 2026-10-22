import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { Button, type ButtonProps } from './Button';

/**
 * shadcn/ui Pagination 的**结构**（nav > ul > li > 按钮），样式实体仍归调用方的 `.page-*` 类。
 *
 * 为什么这一层不带外观工具类：本项目的分页条在 `global.css` 里是独立的一档尺度
 * （`.page-controls` gap 6px、`.page-btn` 12.5px 带边框、`.page-num` 28×28 网格居中），
 * 与 `.btn` 不同源——这正是 `Button` 要设 `variant:'bare'` 的同一个理由。
 * 组件里再写一份 padding/height 就成了"同一元素两条声明"，谁赢取决于层内书写顺序，
 * 那就等于在改布局（审查 F16 的合并就是照着这条做的）。
 *
 * 链接体是 `<button>` 而不是 `<a href>`：本应用没有路由，页码换了只是重新取一次数据，
 * 做成链接等于摆一个点开了会跳走的假链接。
 */

export function Pagination({ className, ...rest }: ComponentProps<'nav'>) {
  return <nav className={cn(className)} {...rest} />;
}

export function PaginationContent({ className, ...rest }: ComponentProps<'ul'>) {
  return <ul className={cn(className)} {...rest} />;
}

export function PaginationItem({ className, ...rest }: ComponentProps<'li'>) {
  return <li className={cn(className)} {...rest} />;
}

export interface PaginationLinkProps extends ComponentProps<'button'> {
  /** 当前页：只写 `aria-current='page'`，反色底由 `.page-num[aria-current='page']` 那条规则带出。 */
  isActive?: boolean;
}

export function PaginationLink({ className, isActive, ...rest }: PaginationLinkProps) {
  return <button type="button" aria-current={isActive ? 'page' : undefined} className={cn(className)} {...rest} />;
}

export interface PaginationNavProps extends ComponentProps<'button'> {
  label: string;
  /** 与页码条同一颗 `Button`，档位由调用方给（默认 ghost）。 */
  variant?: ButtonProps['variant'];
}

/** 上一页 / 下一页。 */
export function PaginationNav({ className, label, variant = 'ghost', ...rest }: PaginationNavProps) {
  return (
    <Button variant={variant} className={cn(className)} {...rest}>
      {label}
    </Button>
  );
}

/** 省略号档：纯装饰，"第几页"由旁边的 `role="status"` 那句承担。 */
export function PaginationEllipsis({ className, ...rest }: ComponentProps<'span'>) {
  return <span aria-hidden className={cn(className)} {...rest} />;
}
