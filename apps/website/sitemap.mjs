/**
 * The sitemap's pairs and dates, for @astrojs/sitemap's `serialize` (astro.config.mjs).
 *
 * The plugin pairs a page with its other-locale twin only by the `/en` prefix, which is
 * wrong here: `/datensicherheit/` is `/en/security/`, and a post's twin has a slug of its
 * own. So each item gets its `xhtml:link` pair from the route table (src/i18n/paths.ts)
 * or from the post's `translationSlug`, and a `lastmod`:
 *   - a post: its `pubDate`;
 *   - a page in the route table: the last commit that touched its view or its copy, when
 *     git is there (a local or CI build); the image build has no git, and then the page
 *     carries no date rather than a wrong one.
 * No `priority`, no `changefreq`: search engines ignore both.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from './src/i18n/paths.ts'

const ROOT = fileURLToPath(new URL('./', import.meta.url))

/**
 * The files a page in the route table is made of, for its date. Keys are route keys;
 * a page not listed here gets no date. `blog` lists no file: its date is the newest post.
 */
const PAGE_SOURCES = {
  home: ['src/views/HomeView.astro', 'src/i18n/pages/home.ts'],
  firms: ['src/views/FirmsView.astro', 'src/i18n/pages/firms.ts'],
  buildingLaw: ['src/views/BuildingLawView.astro', 'src/i18n/pages/building-law.ts'],
  revisions: ['src/views/RevisionsView.astro', 'src/i18n/pages/revisions.ts'],
  security: ['src/views/SecurityView.astro', 'src/i18n/pages/security.ts'],
  contact: ['src/views/ContactView.astro', 'src/i18n/pages/contact.ts'],
  imprint: ['src/views/ImprintView.astro', 'src/i18n/pages/imprint.ts'],
  privacy: ['src/views/PrivacyView.astro', 'src/i18n/pages/privacy.ts'],
  demo: ['src/views/DemoView.astro', 'src/i18n/pages/demo.ts'],
}

/** The date of the last commit touching `files`, or undefined without git. */
function lastCommitDate(files) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...files], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

/** Each top-level `key: value` line of a frontmatter block, first occurrence wins, quotes dropped. */
function frontmatterFields(head) {
  const fields = new Map()
  for (const line of head.split('\n')) {
    const match = /^(\w+):\s*'?([^'\n]+)'?\s*$/.exec(line)
    if (match && !fields.has(match[1])) fields.set(match[1], match[2])
  }
  return fields
}

/** The frontmatter fields the sitemap needs, read from each post's MDX file. */
function posts() {
  const out = []
  for (const locale of ['de', 'en']) {
    const dir = `${ROOT}src/content/blog/${locale}`
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.mdx'))) {
      const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(`${dir}/${file}`, 'utf8'))?.[1] ?? ''
      const fields = frontmatterFields(head)
      const field = (name) => fields.get(name)
      // A draft is not built (outside preview builds), so nothing may pair with it.
      if (field('draft') === 'true' && process.env.PUBLIC_INCLUDE_DRAFTS !== '1') continue
      out.push({ locale, slug: file.replace(/\.mdx$/, ''), pubDate: field('pubDate'), translationSlug: field('translationSlug') })
    }
  }
  return out
}

const blogBase = { de: '/blog/', en: '/en/blog/' }

/** path -> { pair: { de, en } | undefined, lastmod: ISO string | undefined } */
function pageTable() {
  const table = new Map()
  const all = posts()
  const newestPost = all.map((p) => p.pubDate).filter(Boolean).sort().at(-1)
  for (const [key, route] of Object.entries(ROUTES)) {
    const lastmod = key === 'blog' ? newestPost && new Date(newestPost).toISOString() : PAGE_SOURCES[key] && lastCommitDate(PAGE_SOURCES[key])
    for (const locale of ['de', 'en']) table.set(route[locale], { pair: route, lastmod })
  }
  for (const post of all) {
    const other = post.locale === 'de' ? 'en' : 'de'
    const twin = post.translationSlug && all.find((p) => p.locale === other && p.slug === post.translationSlug)
    const own = `${blogBase[post.locale]}${post.slug}/`
    const pair = twin ? { [post.locale]: own, [other]: `${blogBase[other]}${twin.slug}/` } : undefined
    table.set(own, { pair, lastmod: post.pubDate && new Date(post.pubDate).toISOString() })
  }
  return table
}

let table

/** @astrojs/sitemap `serialize`: sets the locale pair and the date where they are known. */
export function serializeSitemapItem(item) {
  table ??= pageTable()
  const url = new URL(item.url)
  const row = table.get(url.pathname)
  if (!row) return item
  if (row.pair) {
    item.links = [
      { url: new URL(row.pair.de, url).href, lang: 'de' },
      { url: new URL(row.pair.en, url).href, lang: 'en' },
    ]
  } else {
    delete item.links
  }
  if (row.lastmod) item.lastmod = row.lastmod
  return item
}

/** @astrojs/sitemap `filter`: no error page, and nothing that only redirects. */
export function sitemapFilter(page) {
  return !/\/(404|sign-in)(\/|$)/.test(new URL(page).pathname)
}
