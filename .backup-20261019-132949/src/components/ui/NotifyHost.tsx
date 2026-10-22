import { useEffect } from 'react';
import { useNotify, type NotifyKind } from '../../state/notify';
import { Icon } from './Icon';
import type { IconName } from './icons';

const TONE: Record<NotifyKind, string> = {
  info: 'badge-muted',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
};

const KIND_ICON: Record<NotifyKind, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
};

/** 提示条容器：aria-live 播报后端回显的动作结果与错误说明。 */
export function NotifyHost() {
  const items = useNotify((s) => s.items);
  const dismiss = useNotify((s) => s.dismiss);

  useEffect(() => {
    if (items.length === 0) return;
    const timers = items.map((i) => window.setTimeout(() => dismiss(i.id), 6000));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [items, dismiss]);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((i) => (
        <div key={i.id} className={`toast pointer-events-auto ${TONE[i.kind]}`}>
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-start gap-2">
              <Icon name={KIND_ICON[i.kind]} className="mt-0.5 shrink-0" />
              {i.text}
            </span>
            <button
              className="toast-dismiss hover:opacity-100"
              aria-label="关闭提示"
              onClick={() => dismiss(i.id)}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
