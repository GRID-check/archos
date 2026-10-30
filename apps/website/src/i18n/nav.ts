import { localePath, type Locale, type RouteKey } from './paths';
import { t } from './ui';
import { linkedinUrl } from '../lib/social';

/** A label and its target: header, footer and page actions share this shape. */
export interface NavLink {
  label: string;
  href: string;
  /** Stable name of the target (a route key, or `login`), e.g. for analytics labels */
  key?: string;
}

/** Navigation of one locale: header, header buttons, footer columns and the legal row. */
export function navigation(locale: Locale) {
  const ui = t(locale);
  const link = (route: RouteKey, label: string): NavLink => ({ label, href: localePath(route, locale), key: route });
  return {
    mainNav: [link('home', ui.navPlatform), link('security', ui.navSecurity), link('blog', ui.navBlog)],
    // Sign-in is AuthKit's hosted page: it shows exactly the methods switched on in WorkOS,
    // so the site keeps no list of its own. /sign-in resolves the app host at runtime.
    login: { label: ui.login, href: '/sign-in', key: 'login' },
    demo: link('demo', ui.demo),
    footerColumns: [
      // The header stays Plattform · Datensicherheit · Blog (design system); the product pages are listed here.
      {
        title: ui.footerProduct,
        links: [
          link('home', ui.navPlatform),
          link('firms', ui.navFirms),
          link('buildingLaw', ui.navBuildingLaw),
          link('revisions', ui.navRevisions),
          link('security', ui.navSecurity),
          link('changelog', ui.changelog),
        ],
      },
      { title: ui.footerKnowledge, links: [link('blog', ui.navBlog)] },
      {
        title: ui.footerCompany,
        links: [
          ...(linkedinUrl ? [{ label: ui.linkedin, href: linkedinUrl, key: 'linkedin' }] : []),
          link('contact', ui.kontakt),
        ],
      },
    ] satisfies { title: string; links: NavLink[] }[],
    legal: [link('imprint', ui.impressum), link('privacy', ui.datenschutz)],
  };
}
