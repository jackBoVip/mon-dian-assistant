import { Slot } from 'radix-ui';
import { cva } from 'class-variance-authority';
import type { ButtonHTMLAttributes, Ref } from 'react';
import { cn } from '../../lib/utils';

type Variant = 'default' | 'primary' | 'danger' | 'ghost' | 'bare';

/**
 * 变体只决定挂哪几个**已有**的类，样式实体仍住在 global.css 的 `@layer mda` 里。
 * 这是刻意的：`.btn-primary:hover:not(:disabled)` 的渐变、`.btn:active` 的 --press-scale 按压、
 * 禁用态的降透明，全都是伪类/伪元素规则，改写成行内工具类反而表达不出来。
 * cva 在这里换来的是"变体是一张表、可校验、能被 className 覆盖"，不是"样式搬家"。
 */
const buttonVariants = cva(undefined, {
  variants: {
    variant: {
      default: 'btn',
      primary: 'btn btn-primary',
      danger: 'btn btn-danger',
      ghost: 'btn-ghost',
      /* bare：几何完全交给 className。顶栏的 .icon-btn、台账的 .btn-mini / .page-btn、
       * 导入导出的 .btn-download 是各自独立的一档尺度，
       * 与 .btn 不同源——把它们做成 size 变体会让同一个元素上落两条 padding/height 声明，
       * 谁赢取决于层内书写顺序，那就是在改布局。所以这里只去掉裸 <button>，不改它的外壳类。 */
      bare: '',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** 把样式与行为转交给唯一的子元素（Radix Slot）：链接当按钮用时用这个，不再套一层 <button>。 */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** 真实 <button>，键盘可达、焦点可见。禁用即真正禁用，不做"假按钮"。 */
export function Button({ variant = 'default', type = 'button', asChild = false, className, ref, children, ...rest }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      {...(asChild ? {} : { type })}
      className={cn(buttonVariants({ variant }), className)}
      {...rest}
    >
      {children}
    </Comp>
  );
}
