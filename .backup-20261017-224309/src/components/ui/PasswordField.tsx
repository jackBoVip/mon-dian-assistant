import { useState, forwardRef, type InputHTMLAttributes } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import type { IconName } from './icons';

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
  error?: string;
  /** 输入框内左侧的语义图标，与 TextField 同一套落点。 */
  leadingIcon?: IconName;
}

/** 主密码/密码输入：带显示/隐藏切换，但绝不自动填充或记忆。 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  { label, hint, error, id, leadingIcon, className, ...rest },
  ref,
) {
  const [show, setShow] = useState(false);
  const inputId = id ?? `pw-${label}`;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="field-line">
        {leadingIcon ? (
          <span className="field-icon" aria-hidden>
            <Icon name={leadingIcon} size={18} />
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          type={show ? 'text' : 'password'}
          className={`input input-trailing ${leadingIcon ? 'input-icon ' : ''}${className ?? ''}`}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
          {...rest}
        />
        <span className="field-trailing">
          <Button
            variant="ghost"
            aria-label={show ? '隐藏密码' : '显示密码'}
            aria-pressed={show}
            onClick={() => setShow((s) => !s)}
          >
            <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
          </Button>
        </span>
      </div>
      {hint && !error ? (
        <span id={`${inputId}-hint`} className="text-xs text-ink-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${inputId}-err`} className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});
