import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropdownDivider, DropdownItem, DropdownRadioGroup, DropdownRadioItem, Menu } from './dropdown-menu';

/**
 * 下拉菜单原语（替换手写版 ui/Popover）只验四件"它凭什么既不是 Modal、也不是一块面板"的事：
 * 没有遮罩与焦点陷阱（外部按下去就关）、Esc 关且把焦点还给触发钮、
 * 键盘能走到每一项（端点停住、Home/End 直达首末）、收尾动作那一项会收起菜单而单选档那一项不会。
 *
 * 交互一律走 user-event，不用 fireEvent.click：实测过，Radix 的 Trigger 挂在 **pointerdown** 上，
 * `fireEvent.click` / `fireEvent.mouseDown` 都打不开菜单（只有派发 pointerdown 才行）。
 * fireEvent 直接对着元素派发、不看事件序列也不看 pointer-events，用它测 Radix 会得到
 * "点了没反应"的假阴性；而 user-event 派发的是 pointerover→pointerdown→mouseup→click 全套，
 * 与真实浏览器一致。
 *
 * 与手写版判定口径的三处差别，都是**按 Radix 实测语义重写**的，不是照着文档印象写的：
 * 1) 焦点模型：Radix 把 DOM 焦点留在 role=menu 本体，用 data-highlighted 表示选择位，
 *    键盘与鼠标共用这一个状态；手写版是 focus() 与 :hover 两套机制并集，两者会打架。
 * 2) 打开时是否预选首项：鼠标打开不预选（防手滑直接激活），键盘 Enter 打开才落到首项。
 * 3) ↑↓ 到端点**不循环**（手写版用 % 循环）；键盘可达性靠 Home/End 保住。
 * 另：「单选档点了不收」在 Radix 下并不是默认行为（实测它默认也关），
 * 由 DropdownRadioItem 里 onSelect + preventDefault 保住——那是交付方点名的口径。
 */
function renderMenu() {
  return render(
    <div>
      <button type="button">页面上另一颗按钮</button>
      <Menu label="主题与外观" icon="sun">
        <DropdownRadioGroup value="light" onValueChange={() => {}}>
          <DropdownRadioItem value="light">浅色</DropdownRadioItem>
          <DropdownRadioItem value="dark">深色</DropdownRadioItem>
        </DropdownRadioGroup>
        <DropdownDivider />
        <DropdownItem onPick={() => {}}>保存外观</DropdownItem>
      </Menu>
    </div>,
  );
}

const trigger = () => screen.getByRole('button', { name: '主题与外观' });
const menu = () => screen.getByRole('menu', { name: '主题与外观' });
const highlighted = () => document.querySelector('[data-highlighted]');
const radios = () => screen.getAllByRole('menuitemradio');

describe('下拉菜单（ui/dropdown-menu）', () => {
  it('初始收起：菜单不在文档里，触发钮 aria-expanded=false 且 aria-haspopup=menu', () => {
    renderMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('鼠标点开：菜单进文档、带同一个可及名，但不预选任何一项', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    // aria-controls 由 Radix 在展开时才挂上，收起时不预留悬空引用
    expect(trigger()).toHaveAttribute('aria-controls', menu().id);
    /* 实测：鼠标打开时 Radix 故意不高亮任何一项（打开了就选中首项会让手滑直接激活它）。
     * 第一项仍然可达——按一次 ↓ 就落在它上面，这条在下一个用例里验。 */
    expect(highlighted()).toBeNull();
    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(radios()[0]);
  });

  it('键盘点开（Enter）：焦点直接交给第一项，不用再按一下方向键', async () => {
    const user = userEvent.setup();
    renderMenu();
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(highlighted()).toBe(radios()[0]);
  });

  it('↑↓ 能在项间走完整列，到端点停住；Home/End 直达首末', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    const [light, dark] = radios();
    const save = screen.getByRole('menuitem', { name: '保存外观' });

    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(light);
    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(dark);
    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(save);
    /* 实测：Radix 的 ↑↓ 到端点**不循环**（末项再按 ↓ 仍是它自己）。手写版那条 % 循环在这里没了。
     * 我不打算在 Content 上再挂一层 keydown 去重造循环——那是在与库的内部焦点状态抢方向盘。
     * 键盘可达性没受损：末项按 Home 一步回首项，下面两条把它钉住。这条差异记进交付文档。 */
    await user.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(save);
    await user.keyboard('{Home}');
    expect(highlighted()).toBe(light);
    await user.keyboard('{ArrowUp}');
    expect(highlighted()).toBe(light); // 首项再往上不越界
    await user.keyboard('{End}');
    expect(highlighted()).toBe(save);
  });

  it('收尾动作收起菜单；单选档点了不收（挑主题要连着试几档）', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.click(radios()[1]);
    // 单选档：Radix 默认也会关，靠 DropdownRadioItem 里的 preventDefault 拦住（交付方口径）
    expect(screen.getByRole('menu')).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: '保存外观' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点分隔符不触发任何动作', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <Menu label="测试" icon="sun">
        <DropdownItem onPick={onPick}>唯一一项</DropdownItem>
        <DropdownDivider />
      </Menu>,
    );
    await user.click(screen.getByRole('button', { name: '测试' }));
    await user.click(screen.getByRole('separator'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Esc 关闭并把焦点还给触发钮', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('点菜单外任意处关闭；点菜单内部与触发钮自己不关', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());

    await user.click(menu());
    expect(screen.getByRole('menu')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '页面上另一颗按钮' }));
    expect(screen.queryByRole('menu')).toBeNull();
    // 再开一次：点触发钮自己不能"关完立刻又开"
    await user.click(trigger());
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(radios().length + screen.getAllByRole('menuitem').length).toBe(3);
  });
});
