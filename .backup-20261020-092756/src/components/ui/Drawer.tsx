import type { ReactNode } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { Tone } from '../../lib/tone';
import { SheetCloseButton, SheetContent, SheetRoot } from './sheet';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** 头部带的情绪，只影响配色，不影响任何可访问性语义 */
  tone?: Tone;
  children: ReactNode;
}

/** 抽屉标题。只有这一处用到，不值得在 sheet 上再开一层导出。 */
function SheetTitle({ children }: { children: ReactNode }) {
  return <DialogPrimitive.Title className="drawer-title">{children}</DialogPrimitive.Title>;
}

/**
 * 右侧详情抽屉。Esc 关闭与遮罩点击关闭交给 Radix；
 * `tone` 仍以 data-tone 属性落在面板根节点上——那五条 `[data-tone='…'] .drawer-head`
 * 靠这个属性挂载，改成内联样式会让情绪头部静默失效。
 */
export function Drawer({ open, title, onClose, tone = 'neutral', children }: DrawerProps) {
  return (
    <SheetRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent tone={tone}>
        <div className="drawer-head">
          {/* 标题交给 Radix 的 Title：它才是 aria-labelledby 真正指向的那个节点，
           * 与原先手写的 aria-label={title} 语义等价，不再重复挂一次。 */}
          <SheetTitle>{title}</SheetTitle>
          <SheetCloseButton />
        </div>
        <div className="drawer-body flex-1 overflow-y-auto">{children}</div>
      </SheetContent>
    </SheetRoot>
  );
}
