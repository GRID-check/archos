'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, TouchEvent } from 'react';
import { joinClasses } from './join-classes';

export interface GalleryItem {
  /** Topic in ink, e.g. "Suchen." */
  title: ReactNode;
  /** Continuation in ink-muted, same sentence */
  text?: ReactNode;
  /** Image or product screen filling the card */
  media?: ReactNode;
}

export interface GalleryProps {
  items: GalleryItem[];
  /** Accessible name of the carousel */
  label?: string;
  id?: string;
  className?: string;
}

export function Gallery({ items, label, id, className }: GalleryProps) {
  const n = items.length;
  const [cur, setCur] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const touchStart = useRef<[number, number] | null>(null);

  const go = (i: number) => setCur(((i % n) + n) % n);

  useEffect(() => {
    function place() {
      const el = track.current;
      if (!el) return;
      const slides = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
      const [first, second] = slides;
      if (!first) return;
      const step = second ? second.offsetLeft - first.offsetLeft : 0;
      el.style.transform = `translateX(${-cur * step}px)`;
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [cur, n]);

  function handleTouchEnd(e: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    if (!start) return;
    const end = e.changedTouches[0];
    const dx = end.clientX - start[0];
    const dy = end.clientY - start[1];
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(cur + (dx < 0 ? 1 : -1));
    touchStart.current = null;
  }

  return (
    <section
      className={joinClasses('ui-gallery', className)}
      id={id}
      aria-roledescription="Karussell"
      aria-label={label}
    >
      <div
        className="ui-gallery-track"
        ref={track}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          touchStart.current = [touch.clientX, touch.clientY];
        }}
        onTouchEnd={handleTouchEnd}
      >
        {items.map((item, i) => (
          <div
            key={i}
            className="ui-gallery-card"
            role="group"
            aria-roledescription="Folie"
            aria-label={`${i + 1} von ${n}`}
            aria-hidden={i === cur ? undefined : 'true'}
          >
            {item.media ? <div className="ui-gallery-media">{item.media}</div> : null}
            <p className="ui-gallery-text heading-2">
              {item.title}
              {item.text ? ' ' : null}
              {item.text ? <span>{item.text}</span> : null}
            </p>
          </div>
        ))}
      </div>
      {n > 1 ? (
        <div className="ui-gallery-ctl">
          <button type="button" className="ui-gallery-btn" aria-label="Vorherige Folie" onClick={() => go(cur - 1)}>
            ←
          </button>
          <div className="ui-gallery-dots">
            {items.map((_, i) => (
              <button
                key={i}
                type="button"
                className="ui-gallery-dot"
                aria-label={`Folie ${i + 1}`}
                aria-current={i === cur ? 'true' : 'false'}
                onClick={() => go(i)}
              >
                <span />
              </button>
            ))}
          </div>
          <button type="button" className="ui-gallery-btn" aria-label="Nächste Folie" onClick={() => go(cur + 1)}>
            →
          </button>
        </div>
      ) : null}
    </section>
  );
}
