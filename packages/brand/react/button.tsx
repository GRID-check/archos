import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** default secondary · primary (black fill) for the main action of an area: Demo anfragen in the header, the submit of a form, the CTA field */
  variant?: 'primary' | 'secondary' | 'text';
  /** sm 30px, 13px/420 (header only) · md 40px · lg 46px (forms) */
  size?: 'sm' | 'md' | 'lg';
  /** Appends → */
  arrow?: boolean;
  /** Renders an <a> instead of a <button> */
  href?: string;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  arrow = false,
  href,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = joinClasses('ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, className);
  const content = (
    <>
      {children}
      {arrow ? (
        <span className="ui-btn-arrow" aria-hidden="true">
          →
        </span>
      ) : null}
    </>
  );
  const attributes: ButtonHTMLAttributes<HTMLElement> = rest;
  if (href) {
    return (
      <a {...attributes} href={href} className={classes}>
        {content}
      </a>
    );
  }
  return (
    <button {...attributes} type={rest.type ?? 'button'} className={classes}>
      {content}
    </button>
  );
}
