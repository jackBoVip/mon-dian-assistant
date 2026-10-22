import type { ReactNode } from 'react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { cn } from '../../lib/utils';
import { Icon } from './Icon';
import type { IconName } from './icons';

/**
 * shadcn/ui 的 DropdownMenu（Radix 原语）。替换掉手写的 ui/Popover。
 *
 * 手写版自己实现的六件事——↑↓/Home/End 移动、Esc 关闭、焦点还给触发钮、点外关闭、
 * 展开即聚焦首项、disabled 项跳过——Radix 全部自带，且多做对两件事：
 * 类型安全的高亮跟踪（typeahead）与 `data-highlighted` 状态（键盘与鼠标高亮同源，
 * 手写版靠 :hover 与 focus 两套机制并集，两者会打架）。
 *
 * 定位口径的迁移：原先 `.popover-panel` 用 `position:absolute; top:calc(100%+12px)` 加
 * `--right/--left` 修饰符；Radix 走 Popper 内联坐标，所以那三档换成 `sideOffset` 与 `align`
 * （数值一一对应：12px→默认 sideOffset，export-panel 那一档是 8px；right→end，left→start）。
 * 样式实体仍住在 `@layer mda` 的 `.dropdown-menu` / `.dropdown-item` 上。
 */

export interface MenuProps {
  /** 触发钮与菜单共用同一个可及名，屏读从按钮走到菜单时不断链。 */
  label: string;
  /** 触发钮里放一颗图标（与 triggerContent 二选一）。 */
  icon?: IconName;
  triggerContent?: ReactNode;
  /** 菜单贴触发钮的哪一侧；顶栏右侧的按钮一律 end，免得溢出窗口右边。 */
  align?: 'start' | 'end';
  /** 菜单与触发钮的间距。原先由 CSS 的 top 承担，Radix 改由这个 prop 给。 */
  sideOffset?: number;
  triggerClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}

export function Menu({
  label,
  icon,
  triggerContent,
  align = 'end',
  sideOffset = 12,
  triggerClassName,
  panelClassName,
  children,
}: MenuProps) {
  return (
    <div className="popover-anchor">
      {/* modal={false} 是刻意的，不是漏配：Radix 的 DropdownMenu 默认 modal=true，
       * 那会把背景整棵子树 aria-hidden（连触发钮自己一起），等于把整页锁在这几行选项里。
       * 这个组件被设计出来的理由就是"临时菜单不挡住整页、不做焦点陷阱"（与 Modal/Drawer 的分工），
       * 对应到 Radix 的开关就是 modal=false。点外关闭、Esc、焦点归还触发钮这些在 false 下照常工作。 */}
      <DropdownMenuPrimitive.Root modal={false}>
        <DropdownMenuPrimitive.Trigger asChild>
          <button type="button" className={triggerClassName ?? 'icon-btn'} aria-label={label} title={label}>
            {triggerContent ?? (icon ? <Icon name={icon} /> : null)}
          </button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content align={align} sideOffset={sideOffset} aria-label={label} className={cn('dropdown-menu popover-panel', panelClassName)}>
            {children}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </div>
  );
}

/** 菜单里的一行。默认点完收起（它是导航/开动作）；需要"连着挑几档"的那些走 keepOpen。 */
export function DropdownItem({
  icon,
  danger,
  title,
  keepOpen = false,
  onPick,
  children,
}: {
  icon?: IconName;
  danger?: boolean;
  /** 与文案不同的一层补充说明（例如「退出登录」实际是锁定保险库）。 */
  title?: string;
  keepOpen?: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.Item
      // Radix 的 Item 本身就是可聚焦的 role="menuitem"，不再套一层 <button>：
      // 嵌套可聚焦元素会让 ↑↓ 走过时高亮与 DOM 焦点分家。
      className={cn('dropdown-item', danger && 'danger')}
      title={title}
      onSelect={(e) => {
        // Radix 选中即关。主题那一档要"点了不收"好连着比几套，所以在这里拦住默认关闭。
        if (keepOpen) e.preventDefault();
        onPick();
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

/**
 * 单选组（主题风格那四行）。aria-checked 与"当前选中的是哪一档"由 RadioGroup 的 value 给，
 * 不再由调用点自己算 active 布尔。
 * "点了不收"这条要靠 DropdownRadioItem 里的 preventDefault 保住——见那里的注释。
 */
export function DropdownRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </DropdownMenuPrimitive.RadioGroup>
  );
}

export function DropdownRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenuPrimitive.RadioItem
      /* 实测：Radix 的 RadioItem 选中后默认同样会关菜单（"单选档不自动关"是我的臆测，不成立）。
       * 而"点一套接着比下一套、不用每次重开"是交付方点名的口径（见 ThemeMenu 的注释），
       * 所以这里用 Radix 自己给的口子拦住默认关闭——onSelect + preventDefault 就是它为此准备的 API，
       * 不是绕过它。Esc / 点外关闭 / 收尾动作那些 DropdownItem 的收起行为都不受影响。 */
      onSelect={(e) => e.preventDefault()}
      className="dropdown-item theme-option"
      value={value}
    >
      <span className="theme-option-left">{children}</span>
      {/* ItemIndicator 只在命中该档时渲染，等价于原先手写的 `active ? <Icon/> : null`，
       * 但 checked 状态由 Radix 的 aria-checked 给，不再靠调用点自己算。 */}
      <DropdownMenuPrimitive.ItemIndicator asChild>
        <span className="check-icon" aria-hidden>
          <Icon name="check" size={16} />
        </span>
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownDivider() {
  return <DropdownMenuPrimitive.Separator className="dropdown-divider" aria-orientation="horizontal" />;
}
