import type { CSSProperties, ReactNode } from 'react';
import { AITag } from './ai-tag';
import { joinClasses } from './join-classes';

export interface DuoItem {
  title: ReactNode;
  text?: ReactNode;
  media?: ReactNode;
  /** default: first light, second dark */
  theme?: 'light' | 'dark';
  /** Photo filling the whole card; keeps its width while the card widens on hover */
  photo?: string;
  alt?: string;
  photoStyle?: CSSProperties;
  /** Text in on-ink over a light photo */
  onPhoto?: boolean;
  /** Shows the AI tag */
  ai?: boolean;
}

export interface DuoCardsProps {
  /** Exactly two */
  items: DuoItem[];
  className?: string;
}

export function DuoCards({ items, className }: DuoCardsProps) {
  return (
    <div className={joinClasses('ui-duo', className)}>
      {items.slice(0, 2).map((item, i) => {
        const theme = item.theme || (i === 1 ? 'dark' : undefined);
        const cardStyle: CSSProperties | undefined = item.photo
          ? { background: theme === 'dark' ? 'var(--surface-raised)' : 'var(--surface-sunken)' }
          : undefined;
        return (
          <div
            key={i}
            className={joinClasses('ui-duo-card', item.photo && item.onPhoto && 'ui-duo-on-photo')}
            data-theme={theme}
            style={cardStyle}
          >
            {item.photo ? (
              <img className="ui-duo-photo" src={item.photo} alt={item.alt || ''} style={item.photoStyle} />
            ) : null}
            {item.ai ? <AITag ink={!item.onPhoto && theme !== 'dark'} /> : null}
            <div className="ui-duo-text">
              <h3 className="ui-duo-title heading-1">{item.title}</h3>
              {item.text ? (
                <p className="ui-duo-body body" style={item.photo ? { color: 'inherit' } : undefined}>
                  {item.text}
                </p>
              ) : null}
            </div>
            {!item.photo ? (
              <div className="ui-duo-media" data-theme={theme === 'dark' ? 'light' : undefined}>
                {item.media || null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
