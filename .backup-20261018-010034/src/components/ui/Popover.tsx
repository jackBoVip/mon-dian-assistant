import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import type { IconName } from './icons';

export interface PopoverProps {
  /** 触发钮与菜单共用同一个可及名，屏读从按钮走到菜单时不断链。 */
  label: string;
  icon: IconName;
  children: ReactNode;
  /** 菜单贴触发钮的哪一侧；顶栏右侧的按钮一律 right，免得溢出窗口右边。 */
  align?: 'left' | 'right';
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * 锚定下拉菜单：Esc 关闭并把焦点还给触发钮，点击菜单外任意处关闭，↑↓/Home/End 在项间移动。
 *
 * 与 Modal/Drawer 的差别是刻意的：没有遮罩、没有焦点陷阱。临时菜单不该挡住整页，
 * 也不该把人锁在几行选项里；`.overlay-veil` 那套 z-index 40/50 与 aria-modal 对一颗
 * 顶栏按钮来说过重。触发钮在 anchor 内部，所以外部点击判定不会和它自己的开合打架。
 *
 * 展开即把焦点交给第一项（菜单的常规做法），方向键的处理挂在菜单本体上而不是 document——
 * 焦点在菜单里才接管 ↑↓，否则会抢走整页的滚动键。
 */
export function Popover({ label, icon, children, align = 'right' }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const items = useCallback((root: HTMLElement) => {
    return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((el) => !el.hasAttribute('disabled'));
  }, []);

  useEffect(() => {
    if (!open) return;
    // 打开后把焦点交给第一项：没有这一步，鼠标点开的人只能用鼠标，键盘路径是断的。
    const first = items(panel.current as HTMLElement)[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Esc 关掉后焦点不能掉在 body 上：菜单已卸载，回到触发钮才是"从哪儿开的回哪儿去"。
      trigger.current?.focus();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, items]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // 关的时候焦点回触发钮：留在菜单里会随菜单一起被卸载，焦点掉到 body 上。
    if (!next) trigger.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const list = items(e.currentTarget);
    if (list.length === 0) return;
    e.preventDefault();
    const current = list.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % list.length;
    else next = current < 0 ? list.length - 1 : (current - 1 + list.length) % list.length;
    list[next]?.focus();
  }

  return (
    <div className="popover-anchor" ref={anchor}>
      <Button
        ref={trigger}
        variant="ghost"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        <Icon name={icon} />
      </Button>
      {open ? (
        <div
          id={panelId}
          ref={panel}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          // 带 data-menu-dismiss 的那一行是收尾动作（保存），点完收起；
          // 不带的那一行是选项本身，点了不收——挑主题要连着试几档，每点一次都要重开一次是折磨。
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('[data-menu-dismiss]')) setOpen(false);
          }}
          className={`surface-elevated surface-glass popover-panel popover-panel--${align}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
