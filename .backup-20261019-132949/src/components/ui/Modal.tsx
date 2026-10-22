import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 标题与关闭那颗 X 之间的动作（个人信息页那支铅笔）。原型 `.modal-header-actions` 那一档。 */
  headerActions?: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}

/** 受控模态：Esc 关闭、焦点进入对话框、遮罩点击关闭。 */
export function Modal({ open, title, onClose, children, headerActions, footer }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="overlay-veil overlay-veil--center"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="surface-elevated surface-glass overlay-panel w-full max-w-lg outline-none"
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <div className="modal-head-actions">
            {headerActions}
            <Button variant="ghost" aria-label="关闭" onClick={onClose}>
              <Icon name="close" />
            </Button>
          </div>
        </div>
        <div className="modal-body max-h-[70vh] overflow-y-auto">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
