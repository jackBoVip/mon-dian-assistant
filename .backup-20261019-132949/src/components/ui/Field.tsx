import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './icons';

/** 带 label 的输入：始终有关联 id，满足无障碍要求。 */
export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** 输入框内左侧的语义图标。装饰性，不进无障碍树（含义已由 label 承担）。 */
  leadingIcon?: IconName;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, hint, error, id, className, leadingIcon, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const input = (
    <input
      ref={ref}
      id={inputId}
      className={`input ${leadingIcon ? 'input-icon ' : ''}${className ?? ''}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
      {...rest}
    />
  );
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="field-line">
        {leadingIcon ? (
          <span className="field-icon" aria-hidden>
            <Icon name={leadingIcon} size={18} />
          </span>
        ) : null}
        {input}
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

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: ReactNode;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, id, className, children, ...rest },
  ref,
) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <div className="field">
      <label htmlFor={selectId}>{label}</label>
      <select ref={ref} id={selectId} className={`select ${className ?? ''}`} {...rest}>
        {children}
      </select>
      {hint ? (
        <span className="text-xs text-ink-muted">{hint}</span>
      ) : null}
    </div>
  );
});

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField(
  { label, hint, id, className, ...rest },
  ref,
) {
  const auto = useId();
  const areaId = id ?? auto;
  return (
    <div className="field">
      <label htmlFor={areaId}>{label}</label>
      <textarea ref={ref} id={areaId} className={`input ${className ?? ''}`} rows={3} {...rest} />
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </div>
  );
});
