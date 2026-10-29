import type { CSSProperties } from 'react';
import { joinClasses } from './join-classes';

export interface LogoRowProps {
  /** Grey SVGs (fill line-strong), height in px per logo to balance optical size */
  logos: { src: string; alt: string; height?: number }[];
  columns?: number;
  label?: string;
  className?: string;
}

export function LogoRow({ logos, columns, label, className }: LogoRowProps) {
  const style = { '--ui-cols': columns || logos.length || 4 } as CSSProperties;

  return (
    <div className={joinClasses('ui-logos', className)} style={style} aria-label={label || 'Pilotbüros'}>
      {logos.map((logo, i) => (
        <div key={i} className="ui-logo">
          <img src={logo.src} alt={logo.alt} style={{ height: `${logo.height || 48}px` }} />
        </div>
      ))}
    </div>
  );
}
