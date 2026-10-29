import type { ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface InfoListProps {
  items: { key: string; value: ReactNode }[];
  /** With a title: heading-2 left, rows right (Impressum, Datenschutz) */
  title?: string;
  className?: string;
}

export function InfoList({ items, title, className }: InfoListProps) {
  const list = (
    <ul className="ui-info body">
      {items.map((item, i) => (
        <li key={i}>
          <p className="ui-info-k">{item.key}</p>
          <p className="ui-info-v">{item.value}</p>
        </li>
      ))}
    </ul>
  );

  if (!title) return list;

  return (
    <div className={joinClasses('ui-rows', className)}>
      <h2 className="heading-2">{title}</h2>
      {list}
    </div>
  );
}
