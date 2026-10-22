import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { cn } from '../../lib/utils';

/**
 * shadcn/ui Switch（Radix）。
 *
 * 目前只有一个调用点：菜单管理「状态」列。它替掉的是原来那枚「停用/启用」图标按钮 + 状态徽标——
 * 交付方要的是"一眼看出当前是开还是关、拨一下就生效"，徽标 + 按钮那一对做不到（徽标不表达可点，
 * 按钮不表达当前状态）。
 *
 * 全部尺寸与取色走工具类，不新增 `global.css` 规则：轨道用 `bg-sunken` + `border-input`，
 * 打开态整条换成 `bg-primary` / `border-primary`，滑块是 `bg-elevated` 的实心圆。
 * 焦点不给 ring：全站 `:focus-visible` 已有 2px 轮廓（与 checkbox 同一口径）。
 */
export interface SwitchProps extends ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  ref?: Ref<HTMLButtonElement>;
}

export function Switch({ className, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
        'border border-input bg-sunken transition-colors',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60',
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-3.5 translate-x-[3px] rounded-full bg-elevated shadow-sm',
          'transition-transform data-[state=checked]:translate-x-[19px]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
