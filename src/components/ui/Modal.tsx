import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
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
  /** 宽弹窗（见 global.css 的 `.overlay-dialog--wide`）：内容是一行多列的复核表时才用。 */
  wide?: boolean;
  /**
   * 正文谁来管滚动。`auto`（默认）整块正文滚；`internal` 把正文收成一条定高列，
   * 由正文里的某一段自己滚——复核表那种「头部与分页固定、只有列表滚」的长表要用它，
   * 否则一滚就把分页条推出视野。
   *
   * 上限不是死值：面板自己最多长到 `inset` 那圈（上沿在 macOS 还要让出红绿灯那条
   * `--titlebar-inset`，Windows/Linux 是 0），所以正文得留出头 + 脚 + 那圈边的余量，
   * 否则窗口缩到 960×640 时正文会顶出面板。
   */
  bodyScroll?: 'auto' | 'internal';
}

/**
 * 受控模态。原先手写的三件事（Esc 监听、遮罩 mousedown、进入时 focus）全部交给 Radix，
 * 它同时补上了手写版没有的两条：焦点陷阱与关闭后把焦点**还给触发它的那个控件**。
 *
 * 版式一类不动：模态框仍是 `overlay-veil → overlay-panel → modal-head/body/foot` 那四段，
 * 具体落位由 `.overlay-dialog` 承担（见 global.css 里那条推导注释）。
 */
export function Modal({ open, title, onClose, children, headerActions, footer, labelledBy, wide, bodyScroll = 'auto' }: ModalProps) {
  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent aria-labelledby={labelledBy} className={wide ? 'overlay-dialog--wide' : undefined}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <div className="modal-head-actions">
              {headerActions}
              <DialogCloseButton />
            </div>
          </DialogHeader>
          <div
            className={cn(
              'modal-body',
              bodyScroll === 'internal'
                ? 'flex max-h-[min(78vh,calc(100vh_-_var(--titlebar-inset)_-_11rem))] min-h-0 flex-col overflow-hidden'
                : 'max-h-[70vh] overflow-y-auto',
            )}
          >
            {children}
          </div>
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
}
