/**
 * The one table of routes. Every page path, the language switch, hreflang and
 * the navigation read it. A route is one row: the German path and the English
 * path. The English site spells its segments in English (`/en/security`), so
 * the rows are not a prefix rule.
 *
 * Pure and import-free on purpose: nothing here depends on Astro.
 */
export const LOCALES = ['de', 'en'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'de'

export const ROUTES = {
  home: { de: '/', en: '/en/' },
  security: { de: '/datensicherheit/', en: '/en/security/' },
  blog: { de: '/blog/', en: '/en/blog/' },
  contact: { de: '/kontakt/', en: '/en/contact/' },
  imprint: { de: '/impressum/', en: '/en/imprint/' },
  privacy: { de: '/datenschutz/', en: '/en/privacy/' },
  login: { de: '/login/', en: '/en/login/' },
  demo: { de: '/demo/', en: '/en/demo/' },
} as const satisfies Record<string, Record<Locale, string>>

export type RouteKey = keyof typeof ROUTES

/** `/blog/` and `/blog` are the same page: the site builds directory URLs. */
function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/$/, '') : path
}

/** The path of route `key` in `locale`, with its trailing slash as the table gives it. */
export function localePath(key: RouteKey, locale: Locale): string {
  return ROUTES[key][locale];
}

/**
 * The same page in the other locale. A path in the table maps through its
 * row. A path outside the table only gets the `/en` prefix added or removed,
 * which is right for pages that do not translate a segment (for example a
 * future `/blog/<slug>/`). A page that does translate a segment must have a row.
 */
export function alternateOf(pathname: string): string {
  const here = trimSlash(pathname);
  for (const route of Object.values(ROUTES)) {
    if (here === trimSlash(route.de)) return route.en;
    if (here === trimSlash(route.en)) return route.de;
  }
  if (here === '/en' || here.startsWith('/en/')) return pathname.slice(3) || '/';
  return `/en${pathname}`;
}

/** The locale a URL belongs to: `/en` and everything under it is English, the rest German. */
export function localeFromUrl(url: URL): Locale {
  const first = url.pathname.split('/')[1];
  return (LOCALES as readonly string[]).includes(first) ? (first as Locale) : DEFAULT_LOCALE;
}
