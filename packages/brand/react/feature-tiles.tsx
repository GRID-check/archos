import type { CSSProperties, ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface FeatureItem {
  title: ReactNode;
  text?: ReactNode;
}

export interface FeatureTilesProps {
  items: FeatureItem[];
  columns?: 2 | 3 | 4;
  className?: string;
}

export function FeatureTiles({ items, columns, className }: FeatureTilesProps) {
  const cols = columns || Math.min(items.length, 4) || 3;
  const style = { '--ui-cols': cols } as CSSProperties;

  return (
    <ol className={joinClasses('ui-features', className)} style={style}>
      {items.map((item, i) => (
        <li key={i} className="ui-feature">
          <h3 className="ui-feature-title heading-3">{item.title}</h3>
          {item.text ? <p className="ui-feature-text body">{item.text}</p> : null}
        </li>
      ))}
    </ol>
  );
}
