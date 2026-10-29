import type { CSSProperties, ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface TimelineStep {
  when: ReactNode;
  text?: ReactNode;
}

export interface TimelineProps {
  steps: TimelineStep[];
  /** Index of today's step, default 0 */
  current?: number;
  className?: string;
}

export function Timeline({ steps, current = 0, className }: TimelineProps) {
  const style = { '--ui-cols': steps.length || 3 } as CSSProperties;

  return (
    <ol className={joinClasses('ui-timeline', className)} style={style}>
      {steps.map((step, i) => (
        <li key={i} className="ui-timeline-step" aria-current={i === current ? 'step' : undefined}>
          <span className="ui-timeline-bar" aria-hidden="true" />
          <h3 className="ui-timeline-when heading-3">{step.when}</h3>
          {step.text ? <p className="ui-timeline-text body">{step.text}</p> : null}
        </li>
      ))}
    </ol>
  );
}
