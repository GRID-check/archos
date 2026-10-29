import { localePath, type Locale, type RouteKey } from './paths';
import { t } from './ui';

/** A label and its target: header, footer and page actions share this shape. */
export interface NavLink {
  label: string;
  href: string;
}

/** Navigation of one locale: header, header buttons, footer columns and the legal row. */
export function navigation(locale: Locale) {
  const ui = t(locale);
  const link = (route: RouteKey, label: string): NavLink => ({ label, href: localePath(route, locale) });
  return {
    mainNav: [link('home', ui.navPlatform), link('security', ui.navSecurity), link('blog', ui.navBlog)],
    // Sign-in is AuthKit's hosted page: it shows exactly the methods switched on in WorkOS,
    // so the site keeps no list of its own. /sign-in resolves the app host at runtime.
    login: { label: ui.login, href: '/sign-in' },
    demo: link('demo', ui.demo),
    footerColumns: [
      { title: ui.footerProduct, links: [link('home', ui.navPlatform)] },
      { title: ui.footerKnowledge, links: [link('blog', ui.navBlog)] },
    ] satisfies { title: string; links: NavLink[] }[],
    legal: [link('imprint', ui.impressum), link('privacy', ui.datenschutz), link('contact', ui.kontakt)],
  };
}
