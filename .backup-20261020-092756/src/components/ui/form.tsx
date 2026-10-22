import { FormProvider, type UseFormReturn } from 'react-hook-form';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * shadcn/ui 的 Form 那一层（react-hook-form + zod）在本应用里的落点。
 *
 * 只保留两件东西：`Form`（就是 RHF 的 FormProvider，让子树里的字段能 register）与
 * `FormShell`（原生 <form> + 提交回调）。字段本体仍用我们自己的 TextField / PasswordField /
 * SelectField——它们的 label 关联、hint/error 挂载与 `.field-line` 几何是既有设计语言；
 * 校验失败的呈现也仍是提示条（交付方定的交互），所以 shadcn 那套 FormMessage 不接线。
 */

export function Form<T extends NonNullable<unknown>>({ form, children }: { form: UseFormReturn<T>; children: ReactNode }) {
  return <FormProvider {...form}>{children}</FormProvider>;
}

export interface FormShellProps extends Omit<ComponentPropsWithoutRef<'form'>, 'onSubmit'> {
  /** 提交入口。按钮可以在 <form> 之外——靠原生 form 属性关联，见 CreateItemDialog 的 footer。 */
  onSubmit: () => void;
}

export function FormShell({ onSubmit, children, ...rest }: FormShellProps) {
  return (
    <form
      {...rest}
      onSubmit={(e) => {
        // 原生 submit 已经带上了所有校验与值收集，这里只拦掉浏览器的跳转行为
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
