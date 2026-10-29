import type { InputHTMLAttributes, ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  /** small, ink-muted; never pre-checked for consent */
  label: ReactNode;
}

export function Checkbox({ label, className, ...rest }: CheckboxProps) {
  return (
    <label className={joinClasses('ui-check small', className)}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}
