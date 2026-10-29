'use client';

import { useId } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { joinClasses } from './join-classes';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  /** Replaces the hint, sets aria-invalid */
  error?: string;
  /** Renders a <textarea> (Kontakt: Nachricht) */
  multiline?: boolean;
}

export function Input({ label, hint, error, multiline = false, className, id, ...rest }: InputProps) {
  const autoId = useId();
  const controlId = id || autoId;
  const hintId = `${controlId}-hint`;
  const describedBy = error || hint ? hintId : undefined;
  const invalid = error ? 'true' : undefined;

  return (
    <div className={joinClasses('ui-field', className)}>
      <label className="ui-field-label small" htmlFor={controlId}>
        {label}
      </label>
      {multiline ? (
        <textarea
          {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          rows={6}
          id={controlId}
          className="ui-input"
          aria-invalid={invalid}
          aria-describedby={describedBy}
        />
      ) : (
        <input
          type="text"
          {...rest}
          id={controlId}
          className="ui-input"
          aria-invalid={invalid}
          aria-describedby={describedBy}
        />
      )}
      {error ? (
        <p id={hintId} className="ui-field-error small">
          Fehler: {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="ui-field-hint small">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
