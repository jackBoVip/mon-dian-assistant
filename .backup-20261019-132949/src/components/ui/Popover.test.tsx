import { fireEvent, render, screen } from '@testing-library/react';
import { Popover } from './Popover';

/**
 * 下拉菜单原语只验四件"它凭什么既不是 Modal、也不是一块面板"的事：
 * 没有遮罩与焦点陷阱（外部按下去就关）、Esc 关且把焦点还给触发钮、
 * 展开即把焦点交给第一项且 ↑↓/Home/End 能在项间移动、收尾动作那一项会收起菜单而选项那一项不会。
 */
function renderPopover() {
  return render(
    <div>
      <button type="button">页面上另一颗按钮</button>
      <Popover label="主题与外观" icon="sun">
        <button type="button" role="menuitemradio" aria-checked>
          浅色
        </button>
        <button type="button" role="menuitemradio" aria-checked={false}>
          深色
        </button>
        <button type="button" role="menuitem" data-menu-dismiss>
          保存外观
        </button>
      </Popover>
    </div>,
  );
}

const trigger = () => screen.getByRole('button', { name: '主题与外观' });
const items = () => screen.getAllByRole('menuitemradio').concat(screen.getAllByRole('menuitem'));

describe('下拉菜单（ui/Popover）', () => {
  it('初始收起：菜单不在文档里，aria-expanded=false 且不预留 aria-controls', () => {
    renderPopover();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-controls')).toBeNull();
  });

  it('点一下展开：菜单进文档、带同一个可及名，焦点立刻交给第一项', () => {
    renderPopover();
    fireEvent.click(trigger());
    const menu = screen.getByRole('menu', { name: '主题与外观' });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(menu.id);
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: '浅色' }));
  });

  it('↑↓ 在项间循环，Home/End 直达首末（键盘路径不靠鼠标）', () => {
    renderPopover();
    fireEvent.click(trigger());
    const menu = screen.getByRole('menu', { name: '主题与外观' });
    const light = screen.getByRole('menuitemradio', { name: '浅色' });
    const dark = screen.getByRole('menuitemradio', { name: '深色' });
    const save = screen.getByRole('menuitem', { name: '保存外观' });

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(save);
    // 最后一项再往下回到第一项：循环，不是撞死在末尾
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(light);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(light);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(save);
  });

  it('点收尾动作收起菜单；点选项不收（挑主题要连着试几档）', () => {
    renderPopover();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: '深色' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '保存外观' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Esc 关闭并把焦点还给触发钮', () => {
    renderPopover();
    trigger().focus();
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('点菜单外任意处关闭；点菜单内部与触发钮自己不关', () => {
    renderPopover();
    fireEvent.click(trigger());
    const outside = screen.getByRole('button', { name: '页面上另一颗按钮' });

    fireEvent.mouseDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.mouseDown(outside);
    expect(screen.queryByRole('menu')).toBeNull();
    // 再开一次：点触发钮自己不能"关完立刻又开"
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(items().length).toBe(3);
  });
});
