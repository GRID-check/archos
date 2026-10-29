/**
 * Route fates: where every public address of the old site lives now.
 *
 * Each old address gets one fate (owner decision D7, plan in
 * docs/product/website-conversion-and-seo.md, "Route fates"):
 *   - 301 to the closest page that exists now, in one hop to its final target;
 *   - 410 Gone when nothing here answers what the old page did;
 *   - served: the same address lives on (no row here).
 *
 * Two consumers read this file:
 *   - astro.config.mjs passes `redirects` to Astro, which answers each row with a
 *     301 in dev and in production (with and without the trailing slash);
 *   - src/pages/404.astro calls `fateOf()` for an address no page claimed: a
 *     410 row answers 410 with the not-found view, and the old site's aliases
 *     (`/de/<path>`, `/en/<German segment>/<rest>`) that are not spelled out
 *     below still resolve in one hop.
 * Astro's `redirects` cannot send 410, which is why the Gone table is read at
 * request time instead.
 *
 * An old address keeps the spelling it was published under, product names
 * included, because links and search results out in the world still use it.
 * That is why the brand-name checks skip this file (scripts/check_brand_names.py
 * EXCLUDED, scripts/check_brand_prose.py HISTORY_PATHS); new routes never carry
 * a brand. `redirects.test.mjs` holds every row to a page that exists, and
 * `scripts/check-route-fates.mjs` asks the built server for each one.
 */

/** Pages of this site that old addresses land on, per locale. */
const FIRMS = { de: '/ki-fuer-architekturbueros/', en: '/en/ai-for-architecture-firms/' }
const BUILDING_LAW = { de: '/baurecht/', en: '/en/building-law/' }
const HOME = { de: '/', en: '/en/' }
// The changelog: product data rendered by src/views/ChangelogView.astro.
const CHANGELOG = { de: '/changelog/', en: '/en/changelog/' }
/** Fate: nothing relevant here any more. */
const GONE = 'gone'

/**
 * The old site's top-level pages that moved or went. `de` and `en` are the old
 * addresses; `to` is a target per locale or GONE.
 */
const PAGES = [
  { de: '/neu', en: '/en/whats-new', to: CHANGELOG },
  { de: '/warum-piloti', en: '/en/why-piloti', to: FIRMS },
  // A value calculator built on assumed, unmeasured numbers (Belegpflicht): no successor.
  { de: '/rechenweg', en: '/en/calculation', to: GONE },
  { de: '/llms-full.txt', en: null, to: { de: '/llms.txt', en: '/llms.txt' } },
]

/**
 * The old site's sections with detail pages. `hub` is the fate of the section's
 * own index (null: the address is a page again), `slugs` the fate of each entry.
 */
const SECTIONS = [
  {
    de: 'vergleich',
    en: 'comparisons',
    hub: FIRMS,
    // Comparisons named other products; the brand names none (P3). The distinction lives on the firms page.
    slugs: {
      chatgpt: FIRMS,
      'microsoft-copilot': FIRMS,
      notebooklm: FIRMS,
      perplexity: FIRMS,
      'ris-und-google': BUILDING_LAW,
      'reiner-ai': FIRMS,
      'weka-bau-ai': FIRMS,
      bauki: FIRMS,
      k24ai: FIRMS,
      baurechtgpt: FIRMS,
    },
  },
  {
    de: 'anwendungen',
    en: 'use-cases',
    hub: HOME,
    slugs: {
      gebaeudeklasse: BUILDING_LAW,
      brandschutz: BUILDING_LAW,
      einreichcheck: BUILDING_LAW,
      bestand: BUILDING_LAW,
      bebauung: BUILDING_LAW,
      waermeschutz: BUILDING_LAW,
      barrierefreiheit: BUILDING_LAW,
      aufenthaltsraum: BUILDING_LAW,
      // Project knowledge has no page of its own yet (wave 2); home carries "Das Wissen Ihres Büros".
      'pruefbericht-aktenvermerk': HOME,
      bueroarchiv: HOME,
    },
  },
  {
    de: 'fuer',
    en: 'for',
    hub: FIRMS,
    slugs: {
      architekturbueros: FIRMS,
      'ziviltechniker-ingenieurbueros': FIRMS,
      // Not an audience of the product (Markenbasis antonym: no platform for the whole construction trade).
      'baumeister-bautraeger': GONE,
    },
  },
  {
    de: 'baurecht',
    en: 'building-law',
    hub: null,
    // One page per Austrian state went stale with every edition; the building law page states the scope.
    slugs: Object.fromEntries(
      ['wien', 'niederoesterreich', 'oberoesterreich', 'steiermark', 'kaernten', 'salzburg', 'tirol', 'vorarlberg', 'burgenland'].map(
        (slug) => [slug, BUILDING_LAW],
      ),
    ),
  },
  {
    de: 'glossar',
    en: 'glossary',
    hub: BUILDING_LAW,
    slugs: Object.fromEntries(
      [
        'gebaeudeklasse',
        'fluchtniveau',
        'oberirdisches-geschoss',
        'oib-richtlinien',
        'ris',
        'bebauungsplan',
        'einreichplan',
        'aufenthaltsraum',
        'brandabschnitt',
        'reihenhaus',
      ].map((slug) => [slug, BUILDING_LAW]),
    ),
  },
]

/** Blog posts whose slug carried the old product name (owner decision D13). */
const RENAMED_POSTS = [
  { from: '/blog/willkommen-bei-piloti', to: '/blog/willkommen/' },
  { from: '/blog/wie-piloti-funktioniert', to: '/blog/so-arbeitet-der-workspace/' },
  { from: '/en/blog/welcome-to-piloti', to: '/en/blog/welcome/' },
  { from: '/en/blog/how-piloti-works', to: '/en/blog/how-the-workspace-works/' },
]

/**
 * Old addresses answered 410 for themselves and everything below them: the
 * unlisted press page of the old brand art and its ZIP downloads.
 */
const GONE_PREFIXES = ['/bildmaterial', '/en/bildmaterial']

/** The English segments of the old site, which also answered under their German spelling below /en/. */
const OLD_EN_SEGMENT = {
  ...Object.fromEntries(SECTIONS.map((s) => [s.de, s.en])),
  'warum-piloti': 'why-piloti',
  rechenweg: 'calculation',
  neu: 'whats-new',
  impressum: 'imprint',
  datenschutz: 'privacy',
}

/** `/a/b/` and `/a/b` are one address here. */
const trim = (path) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** Every primary row: old address -> target path, or GONE. Built once from the tables above. */
function primaryRows() {
  const rows = new Map()
  for (const page of PAGES) {
    rows.set(page.de, page.to === GONE ? GONE : page.to.de)
    if (page.en) rows.set(page.en, page.to === GONE ? GONE : page.to.en)
  }
  for (const section of SECTIONS) {
    if (section.hub) {
      rows.set(`/${section.de}`, section.hub.de)
      rows.set(`/en/${section.en}`, section.hub.en)
    }
    for (const [slug, to] of Object.entries(section.slugs)) {
      rows.set(`/${section.de}/${slug}`, to === GONE ? GONE : to.de)
      rows.set(`/en/${section.en}/${slug}`, to === GONE ? GONE : to.en)
    }
  }
  for (const post of RENAMED_POSTS) rows.set(post.from, post.to)
  return rows
}

const PRIMARY = primaryRows()

/**
 * The aliases of every primary row, resolved to the same final target:
 * `/de<path>` for each German address, and `/en/<German segment>/<rest>` for each
 * English address whose first segment the old site also answered in German.
 */
function aliasRows() {
  const rows = new Map()
  for (const [path, to] of PRIMARY) {
    if (path.startsWith('/en/')) {
      const [, , first, ...rest] = path.split('/')
      const german = Object.keys(OLD_EN_SEGMENT).find((de) => OLD_EN_SEGMENT[de] === first)
      if (german) rows.set(['', 'en', german, ...rest].join('/'), to)
    } else {
      rows.set(`/de${path}`, to)
    }
  }
  // Served pages under their old aliases: the page itself, one hop.
  const served = [
    ['/de', '/'],
    ['/de/impressum', '/impressum/'],
    ['/de/datenschutz', '/datenschutz/'],
    ['/de/blog', '/blog/'],
    ['/de/baurecht', '/baurecht/'],
    ['/de/changelog', CHANGELOG.de],
    ['/en/impressum', '/en/imprint/'],
    ['/en/datenschutz', '/en/privacy/'],
    ['/en/baurecht', BUILDING_LAW.en],
  ]
  for (const [from, to] of served) rows.set(from, to)
  return rows
}

/** Every row, old address (no trailing slash) -> target path or GONE. */
export const ROUTE_FATES = new Map([...PRIMARY, ...aliasRows()])

/** Targets other work adds; the tests accept them until they exist. None are pending now. */
export const PENDING_TARGETS = new Set()

/** Astro's `redirects`: every 301 row, plus the login pages. Status 301 (Astro's default is 308). */
export const redirects = {
  // The old login pages forward to AuthKit's sign-in, which lists the enabled methods itself.
  '/login': { status: 301, destination: '/sign-in' },
  '/en/login': { status: 301, destination: '/sign-in' },
  ...Object.fromEntries(
    [...ROUTE_FATES].filter(([, to]) => to !== GONE).map(([from, to]) => [from, { status: 301, destination: to }]),
  ),
}

/**
 * The fate of an address no page claimed, or null for a plain 404:
 * `{ status: 410 }` or `{ status: 301, location }`. Reads the rows, the Gone
 * prefixes, then the old aliases for anything the rows do not spell out
 * (`/de/<path>` -> `<path>`, `/en/<German segment>/` -> its English segment).
 * @param {string} pathname
 * @returns {{ status: 410 } | { status: 301, location: string } | null}
 */
export function fateOf(pathname) {
  const path = trim(pathname)
  const row = ROUTE_FATES.get(path)
  if (row === GONE) return { status: 410 }
  if (row) return { status: 301, location: row }
  for (const prefix of GONE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`/de${prefix}/`) || path === `/de${prefix}`) {
      return { status: 410 }
    }
  }
  const de = /^\/de(\/.*)?$/.exec(path)
  if (de) {
    const rest = de[1] ?? '/'
    const inner = fateOf(rest)
    if (inner) return inner
    return { status: 301, location: rest.endsWith('/') ? rest : `${rest}/` }
  }
  const en = /^\/en\/([^/]+)(\/.*)?$/.exec(path)
  if (en && Object.hasOwn(OLD_EN_SEGMENT, en[1])) {
    const moved = `/en/${OLD_EN_SEGMENT[en[1]]}${en[2] ?? ''}`
    return fateOf(moved) ?? { status: 301, location: `${moved}/` }
  }
  return null
}
