import type { ComponentProps, ReactNode } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { Icon } from './Icon';

/**
 * shadcn/ui 的 Dialog（Radix 原语）。
 *
 * 口径与 Button/Badge 一致：Radix 负责行为（焦点陷阱、Esc、遮罩点击关闭、滚动锁、
 * aria-modal 与焦点归还），**样式实体仍然住在 global.css 的 `@layer mda` 里**——
 * 因为那几枚面板的入场动画、玻璃模糊、内高光都是伪类/关键帧规则，且 `.overlay-panel`
 * 的 transform 与定位必须各归各位（见 global.css 里 .overlay-dialog 那段推导）。
 *
 * 因此本文件里看不到 shadcn 默认的那套 `fixed left-[50%] translate-x-[-50%]` 工具类：
 * 那会同时踩掉 panel-in 的 transform 补间与红绿灯让位的那条 --titlebar-inset。
 */

export function DialogRoot({ open, onOpenChange, children }: ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </DialogPrimitive.Root>
  );
}

export function DialogPortal({ children }: { children: ReactNode }) {
  return <DialogPrimitive.Portal>{children}</DialogPrimitive.Portal>;
}

/** 遮罩：沿用 .overlay-veil 那一档（fixed inset 0 + --overlay-veil 染底 + --blur-overlay 模糊）。 */
export function DialogOverlay({ className }: { className?: string }) {
  return <DialogPrimitive.Overlay className={cn('overlay-veil overlay-veil--center', className)} />;
}

export interface DialogContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'children'> {
  children: ReactNode;
}

/**
 * 面板本体。`aria-describedby` 显式留空是刻意的：本应用的弹窗历来只有标题、没有描述文案，
 * Radix 缺省会去找 Description，找不到就在控制台告警；要么补一段不存在的文案，要么显式声明"没有"，
 * 这里选后者，不改可访问性语义（标题仍然通过 aria-labelledby 关联）。
 */
export function DialogContent({ className, children, 'aria-labelledby': labelledBy, ...rest }: DialogContentProps) {
  return (
    <DialogPrimitive.Content
      aria-describedby={undefined}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      className={cn('overlay-dialog overlay-panel surface-elevated surface-glass', className)}
      {...rest}
    >
      {children}
    </DialogPrimitive.Content>
  );
}

export function DialogHeader({ children }: { children: ReactNode }) {
  return <div className="modal-head">{children}</div>;
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <DialogPrimitive.Title className="modal-title">{children}</DialogPrimitive.Title>;
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="modal-foot">{children}</div>;
}

export function DialogCloseButton({ label = '关闭' }: { label?: string }) {
  /* 走既有的 Button/Icon：今天 Modal 那颗关闭钮就是 `btn-ghost + <Icon name="close">`，
   * 换成裸 <X> 会绕开图标唯一入口（icons.ts 头一条口径），也会丢掉 .btn-ghost 的按压与焦点环。 */
  return (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" aria-label={label}>
        <Icon name="close" />
      </Button>
    </DialogPrimitive.Close>
  );
}
