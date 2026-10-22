import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { cn } from '../../lib/utils';

/**
 * shadcn/ui RadioGroup（Radix）。
 *
 * 换掉的是 `<input type=radio>` 那一档。两件事必须跟着一起改，不是可选样式：
 * 1. 原生 `<label>` 包住控件就能拿到可及名，Radix 的档是 `<button role=radio>`——
 *    `<label>` 不给它命名，所以全部改成 `Label htmlFor` + 控件 `id`，
 *    否则 `getByRole('radio', {name})` 与读屏都拿不到名字。
 * 2. 尺寸按原生 `input[type=radio]` 的 15px 钉死；圆点 7px，与 macOS 那档观感对齐。
 *
 * 键盘：Radix 给的是 radiogroup 的标准方向键切换 + 首档 Tab 落位，与原生一致。
 */
export interface RadioGroupProps extends ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root> {
  ref?: Ref<HTMLDivElement>;
}

export function RadioGroup({ className, ...rest }: RadioGroupProps) {
  return <RadioGroupPrimitive.Root className={cn('flex flex-col gap-2', className)} {...rest} />;
}

export interface RadioGroupItemProps extends ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  ref?: Ref<HTMLButtonElement>;
}

export function RadioGroupItem({ className, ...rest }: RadioGroupItemProps) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'shrink-0 size-[15px] rounded-full border border-input bg-elevated',
        'data-[state=checked]:border-primary',
        className,
      )}
      {...rest}
    >
      <RadioGroupPrimitive.Indicator className="flex h-full w-full items-center justify-center">
        <span className="size-[7px] rounded-full bg-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
