import type { ComponentProps, ReactNode } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Button } from './Button';
import { Icon } from './Icon';

/**
 * shadcn/ui 的 Sheet（侧边面板）。Radix 的 Sheet 本质就是换了落位的 Dialog，
 * 这里同 shadcn 的做法一致，直接复用 Dialog 原语，不引入第二套关闭/焦点逻辑。
 *
 * 与 dialog.tsx 的分工只在两件事：遮罩不再居中（.overlay-veil 不带 --center，
 * z-index 停在 40 那一档），以及面板落位走 .overlay-dialog--drawer。
 */

export function SheetRoot({ open, onOpenChange, children }: ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </DialogPrimitive.Root>
  );
}

export function SheetContent({
  children,
  labelledBy,
  tone,
  className,
}: {
  children: ReactNode;
  labelledBy?: string;
  /** 头部带的情绪。写成 data-tone 属性而不是内联样式——那五条 `[data-tone='…'] .drawer-head` 规则靠它挂载。 */
  tone?: string;
  className?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="overlay-veil" />
      <DialogPrimitive.Content
        asChild
        aria-describedby={undefined}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      >
        <aside data-tone={tone} className={`surface-elevated overlay-panel overlay-panel--drawer overlay-dialog--drawer flex flex-col ${className ?? ''}`}>
          {children}
        </aside>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetCloseButton({ label = '关闭详情' }: { label?: string }) {
  return (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" aria-label={label}>
        <Icon name="close" />
      </Button>
    </DialogPrimitive.Close>
  );
}
