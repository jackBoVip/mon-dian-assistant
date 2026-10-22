import { Select as SelectPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Icon } from './Icon';

/**
 * shadcn/ui 的 Select（Radix Select）。
 *
 * 与原生 <select> 的分工：行为（键盘、typeahead、滚动、aria-expanded/activedescendant）
 * 归 Radix；外观仍走 `.select`（触发钮）与 `.dropdown-menu`/`.dropdown-item`（浮层）——
 * 本应用已经有一整套菜单词汇，没必要为 Select 再造一套颜色与间距。
 *
 * 已知观感差异（交付方点名要 Radix Select）：浮层由系统原生菜单变成自绘面板，
 * 字体/行高/勾选位/滚动条都跟着本应用的菜单语言走，不再跟着 macOS 的原生菜单。
 */

/** Radix 把 value='' 保留给"未选中"（placeholder 的显示条件），
 *  而本应用有三处真的需要空串选项（未分组 / 不设置 / 请选择角色）。
 *  所以对外仍用空串，内部换成这枚哨兵再翻译回来——调用点不必知道这个细节。 */
const EMPTY = '\u0000empty';

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  'aria-label'?: string;
  className?: string;
}

export function Select({ value, options, onValueChange, disabled, id, name, className, ...aria }: SelectProps) {
  return (
    <SelectPrimitive.Root
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onValueChange(v === EMPTY ? '' : v)}
      disabled={disabled}
      name={name}
    >
      <SelectPrimitive.Trigger id={id} className={cn('select select-trigger', className)} {...aria}>
        <SelectPrimitive.Value placeholder={options.find((o) => o.value === '')?.label ?? '请选择'} />
        <SelectPrimitive.Icon className="select-icon">
          <Icon name="chevronDown" size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      {/* ⚠ 未解决的无障碍缺陷（如实挂着，别当已修）：Radix 的 Select 与 Dialog 各自是 modal 层，
       *  Select 展开时它的 hideOthers 会把宿主弹窗整块写成 aria-hidden——实测：在弹窗里展开下拉，
       *  表单对读屏消失。@radix-ui/react-select 2.4.1 已移除 SelectProps.modal，没法从这一侧关掉。
       *  两条自助修法都实测不成立：container 指向 Dialog 的 portal 容器 → 浮层仍与面板同层为兄弟，
       *  照样被逐层 hideOthers 命中；container 指向面板本体 → 面板自己的子树被清空（更糟）。
       *  所以这里保持 Radix 默认的 body portal，等有正确解法（升级 Radix / 自建 layer 协调）再修。 */}
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="dropdown-menu popover-panel select-content">
          <SelectPrimitive.Viewport>{options.map((o) => <SelectItem key={o.value || EMPTY} value={o.value} label={o.label} />)}</SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SelectItem({ value, label }: { value: string; label: ReactNode }) {
  return (
    <SelectPrimitive.Item className="dropdown-item select-item" value={value === '' ? EMPTY : value}>
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
