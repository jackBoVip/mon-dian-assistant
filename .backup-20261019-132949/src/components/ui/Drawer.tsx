import { useEffect, type ReactNode } from 'react';
import type { Tone } from '../../lib/tone';
import { Button } from './Button';
import { Icon } from './Icon';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** 头部带的情绪，只影响配色，不影响任何可访问性语义 */
  tone?: Tone;
  children: ReactNode;
}

/** 右侧详情抽屉。Esc 关闭，主体可滚动。 */
export function Drawer({ open, title, onClose, tone = 'neutral', children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="overlay-veil"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-tone={tone}
        className="surface-elevated overlay-panel overlay-panel--drawer flex flex-col"
      >
        <div className="drawer-head">
          <h2 className="drawer-title">{title}</h2>
          <Button variant="ghost" aria-label="关闭详情" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>
        <div className="drawer-body flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}
