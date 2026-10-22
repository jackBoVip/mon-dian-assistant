import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './Button';

/**
 * shadcn/ui Pagination 的形状，但**链接体仍是 `<button>`**：
 * 本应用没有路由，页码换了只是重新发一次查询，做成 `<a href>` 等于凭空造一个不能用的链接。
 *
 * 外壳类 `.num` 原样留在链接档上——`global.css` 的 `.num[aria-current='page']` 是选中态的
 * 唯一挂载点（底色翻转，不拿主色当文字，那条注释里写着理由），换组件不换挂载点，像素才不动。
 *
 * props 一律取 `ComponentProps<'标签'>`：React 19 的类型不再把 children 塞进 HTMLAttributes，
 * 而内在元素的 props 本来就带 children。
 */

export function Pagination({ className, ...rest }: ComponentProps<'nav'>) {
  return <nav className={cn('flex items-center gap-1', className)} {...rest} />;
}

export function PaginationContent({ className, ...rest }: ComponentProps<'ul'>) {
  return <ul className={cn('flex items-center gap-1', className)} {...rest} />;
}

export function PaginationItem({ className, ...rest }: ComponentProps<'li'>) {
  return <li className={cn(className)} {...rest} />;
}

export interface PaginationLinkProps extends ComponentProps<'button'> {
  /** 当前页：写 `aria-current='page'`，样式由 `.num[aria-current]` 那条规则带出反色底。 */
  isActive?: boolean;
}

export function PaginationLink({ className, isActive, ...rest }: PaginationLinkProps) {
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      className={cn('num rounded-sm border border-line px-2.5 py-1 text-sm', className)}
      {...rest}
    />
  );
}

export interface PaginationNavProps extends ComponentProps<'button'> {
  label: string;
}

/** 上一页 / 下一页：与页码档同一颗 ghost 按钮，只是文字不同。 */
export function PaginationNav({ className, label, ...rest }: PaginationNavProps) {
  return (
    <Button variant="ghost" className={cn(className)} {...rest}>
      {label}
    </Button>
  );
}

/** 省略号档：纯装饰，读屏由旁边那句「第 x / y 页」承担。 */
export function PaginationEllipsis({ className, ...rest }: ComponentProps<'span'>) {
  return (
    <span aria-hidden className={cn('px-2 text-sm text-ink-muted', className)} {...rest}>
      …
    </span>
  );
}
