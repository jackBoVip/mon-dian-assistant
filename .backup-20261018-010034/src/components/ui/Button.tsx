import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

const CLASS: Record<Variant, string> = {
  default: 'btn',
  primary: 'btn btn-primary',
  danger: 'btn btn-danger',
  ghost: 'btn-ghost',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

/** 真实 <button>，键盘可达、焦点可见。禁用即真正禁用，不做"假按钮"。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', type = 'button', className, ...rest },
  ref,
) {
  const base = CLASS[variant];
  return <button ref={ref} type={type} className={className ? `${base} ${className}` : base} {...rest} />;
});
