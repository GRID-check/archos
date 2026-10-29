import type { ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface FAQProps {
  items: { q: string; a: ReactNode }[];
  /** With a title: heading-1 left over four columns, list right */
  title?: string;
  /** Index opened at start; default 0 */
  open?: number;
  className?: string;
}

export function FAQ({ items, title, open = 0, className }: FAQProps) {
  const list = (
    <div className="ui-faq body">
      {items.map((item, i) => (
        <details key={i} open={i === open ? true : undefined}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  );

  if (!title) return list;

  return (
    <div className={joinClasses('ui-rows', className)}>
      <h2 className="heading-1">{title}</h2>
      {list}
    </div>
  );
}
