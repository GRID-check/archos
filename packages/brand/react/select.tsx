'use client';

import { useId } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { joinClasses } from './join-classes';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  /** Plain option labels, e.g. ['1–5 Mitarbeitende', '6–20 Mitarbeitende'] */
  options: string[];
  /** First, empty option; default „Auswählen …“ */
  placeholder?: string;
}

export function Select({ label, options, placeholder, className, id, ...rest }: SelectProps) {
  const autoId = useId();
  const controlId = id || autoId;

  return (
    <div className={joinClasses('ui-field', className)}>
      <label className="ui-field-label small" htmlFor={controlId}>
        {label}
      </label>
      <div className="ui-select">
        <select {...rest} id={controlId} className="ui-input">
          <option value="">{placeholder || 'Auswählen …'}</option>
          {options.map((option, i) => (
            <option key={i}>{option}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
