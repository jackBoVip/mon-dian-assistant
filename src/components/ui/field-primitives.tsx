import { Label as LabelPrimitive, Slot } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';
import { cn } from '../../lib/utils';

/**
 * shadcn/ui 的 Label / Input / Textarea。
 * 样式实体仍住在 `@layer mda` 的 `.field` / `.input` 上——`.input::placeholder`、
 * `.input[aria-invalid='true']`、`.field` 那条底线与聚焦时走满的 ::after、还有那几档
 * `-webkit-autofill` 都是伪类/伪元素规则，行内工具类表达不了。
 */

/** Radix Label 渲染的就是真 <label>，所以 `.field > label` 那条排版规则照样命中；
 *  它多出来的是 `asChild` 与"点标题时正确转发给控件"的默认行为。 */
export function Label({ className, ...rest }: ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn(className)} {...rest} />;
}

export interface InputProps extends ComponentPropsWithoutRef<'input'> {
  /** React 19：ref 是普通 prop，不再需要 forwardRef 包一层。 */
  ref?: Ref<HTMLInputElement>;
  /** 把元素本体换成唯一子节点（Radix Slot）。 */
  asChild?: boolean;
}

export function Input({ className, asChild = false, ...rest }: InputProps) {
  const Comp = asChild ? Slot.Root : 'input';
  return <Comp className={cn('input', className)} {...rest} />;
}

export interface TextareaProps extends ComponentPropsWithoutRef<'textarea'> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={cn('input', className)} {...rest} />;
}

/** 字段外壳：label 与控件永远绑定（缺 id 时由 useId 兜），这是无障碍底线，不是可选样式。
 *  报错与只读两档也在这枚外壳上——CSS 够不着父元素（本仓库不引 `:has()` 判定，同 .input-icon 那条口径），
 *  所以由组件写成 data 属性，样式住在 global.css 的 `.field[data-*]` 那几条。 */
export function FieldFrame({
  children,
  invalid,
  readonly,
}: {
  children: ReactNode;
  invalid?: boolean;
  readonly?: boolean;
}) {
  return (
    <div className="field" data-invalid={invalid ? 'true' : undefined} data-readonly={readonly ? 'true' : undefined}>
      {children}
    </div>
  );
}
