import type { ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface SectionIntroProps {
  title: ReactNode;
  /** One statement sentence in ink (lead) */
  lead?: ReactNode;
  /** Grey explanation in body */
  text?: ReactNode;
  /** display (statement, may be centered) · heading = heading-1 */
  size?: 'display' | 'heading';
  align?: 'left' | 'center';
  as?: 'h1' | 'h2' | 'h3';
  className?: string;
  /** Buttons below */
  children?: ReactNode;
}

export function SectionIntro({
  title,
  lead,
  text,
  size = 'heading',
  align = 'left',
  as: Title = 'h2',
  className,
  children,
}: SectionIntroProps) {
  const titleClass = size === 'display' ? 'display' : 'heading-1';

  return (
    <div className={joinClasses('ui-intro', align === 'center' && 'ui-intro-center', className)}>
      <Title className={joinClasses('ui-intro-title', titleClass)}>{title}</Title>
      {lead ? <p className="ui-intro-lead lead">{lead}</p> : null}
      {text ? <p className="ui-intro-text body">{text}</p> : null}
      {children ? <div className="ui-intro-actions ui-row">{children}</div> : null}
    </div>
  );
}
