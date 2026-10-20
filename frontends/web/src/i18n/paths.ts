/**
 * The one table of URL segments the English mirror translates. German pages
 * keep their German URLs (they are what search engines know); the English
 * site spells the same first segment in English, so `/vergleich/chatgpt/` has
 * the twin `/en/comparisons/chatgpt/`. Everything that builds, reads or
 * redirects such a path goes through here: `useTranslatedPath`, the language
 * switch and hreflang (`BaseLayout`), `landingPath`, `llms.txt`, the sitemap
 * (`astro.config.mjs`) and the redirect for the old /en/<german> URLs
 * (`pages/en/[...path].astro`). The page files under `src/pages/en/` are named
 * by the right-hand column. Entry slugs below a section stay as they are.
 *
 * Pure and import-free on purpose: `astro.config.mjs` loads it too.
 */
export const EN_SEGMENT = {
  anwendungen: 'use-cases',
  baurecht: 'building-law',
  fuer: 'for',
  glossar: 'glossary',
  vergleich: 'comparisons',
  'warum-piloti': 'why-piloti',
  rechenweg: 'calculation',
  neu: 'whats-new',
  impressum: 'imprint',
  datenschutz: 'privacy',
} as const

export type GermanSegment = keyof typeof EN_SEGMENT

const DE_SEGMENT: Record<string, string> = Object.fromEntries(Object.entries(EN_SEGMENT).map(([de, en]) => [en, de]))

/** Swaps the first segment of `/a/b/` through `map`; every other path is returned as it came. */
function mapFirstSegment(path: string, map: Record<string, string>): string {
  const [, first = '', ...rest] = path.split('/')
  const swapped = Object.hasOwn(map, first) ? map[first] : first
  return ['', swapped, ...rest].join('/')
}

/** A German path (`/vergleich/x/`) as the English site spells it, without the `/en` prefix. */
export function germanToEnglishPath(path: string): string {
  return mapFirstSegment(path, EN_SEGMENT)
}

/** The inverse: an English path without its `/en` prefix (`/comparisons/x/`) as the German site spells it. */
export function englishToGermanPath(path: string): string {
  return mapFirstSegment(path, DE_SEGMENT)
}

/**
 * Where an old English URL that still carries a German segment
 * (`/en/anwendungen/x/`) lives now, or null when the path is not one. The
 * result keeps a trailing slash: the site is built with directory URLs.
 */
export function legacyEnglishPath(pathname: string): string | null {
  const m = /^\/en(\/.*)$/.exec(pathname)
  if (!m) return null
  const first = m[1].split('/')[1]
  if (!Object.hasOwn(EN_SEGMENT, first)) return null
  const moved = `/en${germanToEnglishPath(m[1])}`
  return moved.endsWith('/') ? moved : `${moved}/`
}
