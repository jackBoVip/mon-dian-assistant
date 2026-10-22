import { fireEvent } from '@testing-library/react';

/**
 * 给 Radix 的元件派发一遍**真实的指针序列**。
 *
 * 为什么需要它：实测过两件事——
 * 1) DropdownMenu/Select 的触发钮挂在 `pointerdown` 上，`fireEvent.click` 只派发 click，
 *    打不开它（`fireEvent.mouseDown` 也不行，那是 mousedown 不是 pointerdown）。
 * 2) 菜单项是在 `pointerup` 上落选择的（这样"按下后拖出去松手"才不会误选），
 *    所以只派发 click 也选不中。
 *
 * 首选仍然是 @testing-library/user-event（它派发整套序列、还会尊重 pointer-events）。
 * 这个助手给的是**不必把整批同步测试改成 async** 的那条路：已经用 fireEvent 写了二十来处的
 * 测试文件，逐条转 async 的改动面比收益大。新写的测试请直接用 user-event。
 */
const POINTER_OPTS = { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1, pointerId: 1 };

export function pointerTap(target: HTMLElement): void {
  fireEvent(target, new PointerEvent('pointerdown', POINTER_OPTS));
  fireEvent(target, new MouseEvent('mousedown', POINTER_OPTS));
  fireEvent(target, new PointerEvent('pointerup', POINTER_OPTS));
  fireEvent(target, new MouseEvent('mouseup', POINTER_OPTS));
  fireEvent.click(target);
}
