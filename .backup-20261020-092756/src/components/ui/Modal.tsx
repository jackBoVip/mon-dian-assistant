import type { ReactNode } from 'react';
import { DialogContent, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogCloseButton } from './dialog';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 标题与关闭那颗 X 之间的动作（个人信息页那支铅笔）。原型 `.modal-header-actions` 那一档。 */
  headerActions?: ReactNode;
  footer?: ReactNode;
  /** 用外部已有的元素当标题（Radix 默认指向 DialogTitle）。 */
  labelledBy?: string;
}

/**
 * 受控模态。原先手写的三件事（Esc 监听、遮罩 mousedown、进入时 focus）全部交给 Radix，
 * 它同时补上了手写版没有的两条：焦点陷阱与关闭后把焦点**还给触发它的那个控件**。
 *
 * 版式一类不动：模态框仍是 `overlay-veil → overlay-panel → modal-head/body/foot` 那四段，
 * 具体落位由 `.overlay-dialog` 承担（见 global.css 里那条推导注释）。
 */
export function Modal({ open, title, onClose, children, headerActions, footer, labelledBy }: ModalProps) {
  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent aria-labelledby={labelledBy}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <div className="modal-head-actions">
              {headerActions}
              <DialogCloseButton />
            </div>
          </DialogHeader>
          <div className="modal-body max-h-[70vh] overflow-y-auto">{children}</div>
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
}
