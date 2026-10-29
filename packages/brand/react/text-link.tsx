import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface TextLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  arrow?: boolean;
  children?: ReactNode;
}

export function TextLink({ arrow = false, className, children, ...rest }: TextLinkProps) {
  return (
    <a {...rest} className={joinClasses('ui-link', className)}>
      {children}
      {arrow ? ' →' : null}
    </a>
  );
}
