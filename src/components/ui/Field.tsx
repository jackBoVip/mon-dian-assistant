import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { FieldFrame, Input, Textarea } from './field-primitives';
import { Select } from './select';
import type { SelectOption } from './select';

/**
 * 三个带 label 的字段控件。外壳与输入本体分别住在 field-primitives（Radix Label/Slot 那层）
 * 与本文件（字段级的 id 绑定、hint/error 挂载）里。
 */

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** 输入框内左侧的语义图标。装饰性，不进无障碍树（含义已由 label 承担）。 */
  leadingIcon?: IconName;
  onChange?: InputHTMLAttributes<HTMLInputElement>['onChange'];
  ref?: Ref<HTMLInputElement>;
}

export function TextField({ label, hint, error, id, className, leadingIcon, ref, ...rest }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <FieldFrame invalid={!!error} readonly={rest.readOnly === true}>
      <label htmlFor={inputId}>{label}</label>
      <div className="field-line">
        {leadingIcon ? (
          <span className="field-icon" aria-hidden>
            <Icon name={leadingIcon} size={18} />
          </span>
        ) : null}
        <Input
          ref={ref}
          id={inputId}
          className={leadingIcon ? `input-icon ${className ?? ''}` : className}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
          {...rest}
        />
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
    </FieldFrame>
  );
}

export interface SelectFieldProps {
  label: string;
  hint?: ReactNode;
  value: string;
  /** 选项数据。原来是 <option> 子节点写法：Radix 的 Item 不是原生 option，
   *  没法既当 children 又保住 value 的翻译，所以改成显式的选项表。 */
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function SelectField({ label, hint, value, options, onValueChange, disabled, id, className }: SelectFieldProps) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <FieldFrame>
      <label htmlFor={selectId}>{label}</label>
      <div className="field-line">
        <Select value={value} options={options} onValueChange={onValueChange} disabled={disabled} id={selectId} className={className} />
      </div>
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </FieldFrame>
  );
}

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextAreaField({ label, hint, id, className, ref, ...rest }: TextAreaFieldProps) {
  const auto = useId();
  const areaId = id ?? auto;
  return (
    <FieldFrame>
      <label htmlFor={areaId}>{label}</label>
      <div className="field-line">
        <Textarea ref={ref} id={areaId} className={className} rows={3} {...rest} />
      </div>
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
    </FieldFrame>
  );
}
