import identity from '../identity.json';
import { Button } from './button';
import type { NavLink } from './nav-link';
import { joinClasses } from './join-classes';
import { Wordmark } from './wordmark';

export interface HeaderProps {
  /** Plattform · Datensicherheit · Blog */
  links?: NavLink[];
  /** href of the active page */
  current?: string;
  /** Small secondary button, e.g. Login */
  login?: NavLink;
  /** Small primary button, e.g. Demo anfragen — the page's one primary */
  cta?: NavLink;
  homeHref?: string;
  /** default true: stays on top with the glass background */
  sticky?: boolean;
  className?: string;
}

export function Header({ links = [], current, login, cta, homeHref, sticky = true, className }: HeaderProps) {
  const hasMenu = links.length > 0 || Boolean(login);

  return (
    <header className={joinClasses('ui-header', !sticky && 'ui-header-static', className)}>
      <div className="ui-wide ui-header-inner">
        <Wordmark href={homeHref || '/'} size="sm" aria-label={`${identity.name} – Startseite`} />
        {links.length ? (
          <nav className="ui-nav" aria-label="Hauptnavigation">
            <ul>
              {links.map((link, i) => (
                <li key={i}>
                  <a
                    className="ui-nav-link"
                    href={link.href}
                    aria-current={link.href === current ? 'page' : undefined}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <span />
        )}
        <div className="ui-header-actions">
          {login ? (
            <Button href={login.href} variant="secondary" size="sm">
              {login.label}
            </Button>
          ) : null}
          {cta ? (
            <Button href={cta.href} variant="primary" size="sm">
              {cta.label}
            </Button>
          ) : null}
          {hasMenu ? (
            <details className="ui-mnav">
              <summary className="ui-btn ui-btn-secondary ui-btn-sm" aria-label="Menü">
                <span className="ui-mnav-o">Menü</span>
                <span className="ui-mnav-x">Schließen</span>
              </summary>
              <nav className="ui-mnav-panel" aria-label="Menü">
                <ul>
                  {links.map((link, i) => (
                    <li key={i}>
                      <a href={link.href} aria-current={link.href === current ? 'page' : undefined}>
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
                <div className="ui-mnav-act">
                  {login ? (
                    <Button href={login.href} variant="secondary" size="lg">
                      {login.label}
                    </Button>
                  ) : null}
                  {cta ? (
                    <Button href={cta.href} variant="primary" size="lg">
                      {cta.label}
                    </Button>
                  ) : null}
                </div>
              </nav>
            </details>
          ) : null}
        </div>
      </div>
    </header>
  );
}
