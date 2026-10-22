import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { cn } from '../../lib/utils';
import { Icon } from './Icon';

/**
 * shadcn/ui Checkbox（Radix）。
 *
 * 换掉的是原生 `input[type=checkbox]`。尺寸按原生那两条规则逐档钉住：
 * `.checkbox-label input` 是 16px（本组件默认 `size-4`），裸 `input[type=checkbox]` 是 15px
 * （那几处调用点显式传 `size-[15px]`）。勾选的**画法**必然与系统渲染不同，
 * 这一条已按预期偏离写进交付文档；形状、颜色、字号都取自令牌，没有一枚字面色。
 *
 * 焦点不给 ring：全站 `:focus-visible` 已有 2px 轮廓，再叠一圈就成了两层环，
 * 反而看不清焦点在哪（与 `.input` 那档同一个理由）。
 */
export interface CheckboxProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  ref?: Ref<HTMLButtonElement>;
}

export function Checkbox({ className, ...rest }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'shrink-0 size-4 rounded-[4px] border border-input bg-elevated',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-ink-inverse',
        className,
      )}
      {...rest}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center leading-none">
        <Icon name="check" size={11} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
