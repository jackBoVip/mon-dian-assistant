import { Progress as ProgressPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, Ref } from 'react';
import { cn } from '../../lib/utils';

/**
 * shadcn/ui Progress（Radix）。
 *
 * 与替换掉的写法差一件事，而且是故意的：进度值不再写 `style={{width:'x%'}}`，
 * 而是满宽 + `translateX(-(100-x)%)`。这样进度条有 `role=progressbar` 与
 * `aria-valuenow/min/max`，读屏能报出百分比；原来那版只有下面一行 `aria-live` 文案。
 * 不加 transition——原实现没有动画，补一层就是改观感。
 */
export interface ProgressProps extends ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  ref?: Ref<HTMLDivElement>;
  indicatorClassName?: string;
}

export function Progress({ className, indicatorClassName, value, ...rest }: ProgressProps) {
  const percent = Math.max(0, Math.min(100, value ?? 0));
  return (
    <ProgressPrimitive.Root
      value={percent}
      className={cn('flex h-2 w-full items-center overflow-hidden rounded-full bg-sunken', className)}
      {...rest}
    >
      <ProgressPrimitive.Indicator
        className={cn('h-full flex-1 bg-primary', indicatorClassName)}
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
