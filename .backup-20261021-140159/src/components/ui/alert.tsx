import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/**
 * shadcn/ui Alert（cva 两档变体）。
 *
 * 底色一律 `bg-transparent`：这三处告警今天就没有底，`.badge` 那套"底保持透明"的理由在这里
 * 同样成立——各主题的 danger 是把对比度刚好顶到 4.5:1 调出来的，再压一层 tint 就掉下去了
 * （themeContrast.test.ts 逐主题验过的那对）。
 *
 * 只做 `Alert` 本体：`AlertTitle` / `AlertDescription` 这两个分件本仓库没有一处用得上
 * （三处告警的正文结构各不相同），留着一个没人调的导出就是死代码。
 */
const alertVariants = cva('relative flex w-full flex-col gap-1 rounded-md border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-line bg-transparent text-ink',
      /* 危险色只出现在这一档：报错、不可逆操作前的警告、被后端拒绝这三类语境
       * （需求 line 246「危险色只表达危险状态」，themeContrast.test.ts 逐处核这层语义）。 */
      destructive: 'border-danger bg-transparent text-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface AlertProps extends ComponentProps<'div'>, VariantProps<typeof alertVariants> {}

/** 外层就带 `role="alert"`：这三处都是"事情已经坏了"的即时反馈，不是可以稍后再读的说明。 */
export function Alert({ className, variant, ...rest }: AlertProps) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...rest} />;
}
