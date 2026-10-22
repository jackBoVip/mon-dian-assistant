import { Accordion as AccordionPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { Icon } from './Icon';

/**
 * shadcn/ui Accordion（Radix），换掉原生 `<details>/<summary>`。
 *
 * 三处刻意的取舍，都为了"布局与语义不动"：
 * 1. **不加开合动画**。Radix 的 height 过渡要先量 `--radix-accordion-content-height`，
 *    量完才动——原生 details 是瞬间开合，补一层动画就是改观感，这一条不做。
 * 2. `Header` 走 `asChild` 落在 trigger 上。Radix 默认把 Header 渲染成 `<h3>`，
 *    那会往文档大纲里插一层标题；弹窗里这几栏本来就是并列关系，不该多出个三级标题。
 * 3. 折叠时子节点**不在 DOM 里**（原生 details 是留在 DOM 只隐藏）。
 *    数据不丢是因为 RHF 默认 `shouldUnregister: false`，字段卸载后值仍存在表单 store 里，
 *    所以"折叠与否都不丢提交值"这句话照样成立——但它现在靠的是表单层，不是 DOM。
 *
 * `AccordionProps` 用 `ComponentProps<typeof Root>` 而不是 `ComponentPropsWithoutRef`：
 * Root 的 props 本身是 single｜multiple 两个分支的联合，接口没法 extends 一个联合类型。
 */
export type AccordionProps = ComponentProps<typeof AccordionPrimitive.Root>;

export function Accordion({ className, ...rest }: AccordionProps) {
  return <AccordionPrimitive.Root className={cn('w-full', className)} {...rest} />;
}

export type AccordionItemProps = ComponentProps<typeof AccordionPrimitive.Item>;

export function AccordionItem({ className, ...rest }: AccordionItemProps) {
  return <AccordionPrimitive.Item className={cn('border border-line', className)} {...rest} />;
}

export type AccordionTriggerProps = ComponentProps<typeof AccordionPrimitive.Trigger>;

export function AccordionTrigger({ className, children, ...rest }: AccordionTriggerProps) {
  return (
    <AccordionPrimitive.Header asChild>
      <AccordionPrimitive.Trigger
        className={cn(
          'flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm',
          /* data-state 只落在 trigger 这颗按钮上，所以箭头那半圈得用后代选择器从这儿带出去。
           * 位移不用管减少动态：lib/theme.ts 在 reduce-motion 那一档给所有元素注了
           * `transition: none !important`，这条 utility 自动失效。 */
          '[&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-(--motion-duration-press)',
          'data-[state=open]:[&_svg]:rotate-90',
          className,
        )}
        {...rest}
      >
        {children}
        <Icon name="chevronNext" size={14} />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export type AccordionContentProps = ComponentProps<typeof AccordionPrimitive.Content>;

export function AccordionContent({ className, children, ...rest }: AccordionContentProps) {
  return (
    <AccordionPrimitive.Content className={cn('overflow-hidden', className)} {...rest}>
      {children}
    </AccordionPrimitive.Content>
  );
}
