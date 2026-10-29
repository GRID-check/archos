import type { HTMLAttributes } from 'react';
import identity from '../identity.json';
import { joinClasses } from './join-classes';

export interface WordmarkProps extends HTMLAttributes<HTMLElement> {
  /** 22px (Header) · 28px (Footer) · 48px, without ™ */
  size?: 'sm' | 'md' | 'lg';
  /** Renders a link, e.g. to the home page */
  href?: string;
}

export function Wordmark({ size = 'md', href, className, children: _children, ...rest }: WordmarkProps) {
  const classes = joinClasses('ui-wordmark', `ui-wordmark-${size}`, className);
  if (href) {
    return (
      <a {...rest} href={href} className={classes}>
        {identity.name}
      </a>
    );
  }
  return (
    <span {...rest} className={classes}>
      {identity.name}
    </span>
  );
}
