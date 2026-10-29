import type { CSSProperties, ReactNode } from 'react';
import identity from '../identity.json';
import { joinClasses } from './join-classes';
import type { NavLink } from './nav-link';
import { Wordmark } from './wordmark';

export interface FooterColumn {
  title: string;
  links: NavLink[];
}

export interface FooterProps {
  columns?: FooterColumn[];
  legal?: NavLink[];
  note?: string;
  claim?: string;
  /** Funding note above the legal row */
  funding?: { text: string; logo?: ReactNode };
  theme?: 'dark' | 'light';
  homeHref?: string;
  className?: string;
}

export function Footer({
  columns = [],
  legal = [],
  note,
  claim,
  funding,
  theme = 'dark',
  homeHref,
  className,
}: FooterProps) {
  const topStyle = { '--ui-cols': columns.length || 1 } as CSSProperties;

  return (
    <footer className={joinClasses('ui-footer', className)} data-theme={theme}>
      <div className="ui-container">
        <div className="ui-footer-top" style={topStyle}>
          <div className="ui-footer-brand">
            <Wordmark size="md" href={homeHref || '/'} />
            <p className="ui-footer-claim body">{claim || identity.claim}</p>
          </div>
          {columns.map((column, i) => (
            <div key={i} className="ui-footer-col small">
              <h2>{column.title}</h2>
              <ul>
                {column.links.map((link, j) => (
                  <li key={j}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {funding ? (
          <div className="ui-footer-funding small">
            <p>{funding.text}</p>
            {funding.logo ? <div className="ui-footer-funding-logo">{funding.logo}</div> : null}
          </div>
        ) : null}
        <div className="ui-footer-bottom small">
          <span>{note || `© ${identity.name}`}</span>
          {legal.map((link, i) => (
            <a key={i} href={link.href}>
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
