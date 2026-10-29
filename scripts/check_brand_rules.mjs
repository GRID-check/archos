#!/usr/bin/env bun
/**
 * The brand rules a machine can hold, checked over the public website.
 * The rules themselves are written in packages/brand/README.md ("Rules the checks hold");
 * this file is their enforcement, so a rule changes in both places at once.
 *
 *   bun scripts/check_brand_rules.mjs                   from the repo root
 *   bun scripts/check_brand_rules.mjs --require-build   also fail when no built pages exist
 *   bun run check                                       in apps/website (runs this after astro check)
 *
 * Copy: every string of the website's dictionaries (apps/website/src/i18n/ui.ts and
 * src/i18n/pages/*.ts), both locales. Bun runs it because the dictionaries are TypeScript.
 * CSS: the website's own CSS (src/styles/site.css, <style> blocks in .astro files) and the
 * design system's component CSS (packages/brand/css/components.css).
 * Media: the built pages in apps/website/dist/client, when a build exists, for the AI tag.
 *
 * The rule functions are pure and exported; check_brand_rules.test.mjs pins them.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEBSITE = join(REPO, 'apps/website')

// ---------------------------------------------------------------------------
// Copy rules (Markenbasis "Sprachregeln" and the design system's German copy rules)
// ---------------------------------------------------------------------------

/** Pictographs and emoji. Allowed typographic glyphs (→ ← · × © –) are outside these ranges. */
const EMOJI = /[\p{Emoji_Presentation}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}]/u

/**
 * Words the brand does not use, each with the reason a writer sees. Matched case-insensitively
 * on word boundaries. Sources: Markenbasis p.12 ("Feste Begriffe", "Nicht so") and p.2 (Antonyme).
 */
export const BANNED_TERMS = [
  { pattern: /\bcopilot\b/i, reason: 'ARCHOS is a Workspace or a Plattform, never a Copilot (Markenbasis, Feste Begriffe)' },
  { pattern: /\b(?:KI|AI)[- ]?(?:Workspace|Tool|Lösung|Solution)\b/i, reason: 'not "KI-Workspace"/"KI-Tool": AI is a property, not the product (Markenbasis, Feste Begriffe)' },
  { pattern: /\b(?:LLMs?|large language models?|reasoning[- ]?(?:modell|model)\w*|agentic)\b/i, reason: 'planning language, not AI jargon: say Modell, Planstand, Baurecht (Markenbasis, Planungssprache statt KI-Sprache)' },
  { pattern: /\b(?:revolution\w*|disrupt\w*|bahnbrechend\w*|game[- ]?changer\w*|next[- ]level|superkr(?:a|ä)ft\w*|superpower\w*)\b/i, reason: 'progress without utopia: no revolution or hype words (Markenbasis, Fortschritt ohne Utopie)' },
  { pattern: /\b(?:nahtlos\w*|seamless\w*|magisch\w*|magic(?:al)?)\b/i, reason: 'facts instead of promises: no empty marketing words (Markenbasis, Voice)' },
  { pattern: /\bgenerative[sn]? (?:Design|Entw(?:u|ü)rf\w*)\b|\bgenerative design\b/i, reason: 'ARCHOS generates no designs (Markenbasis, Antonyme)' },
  { pattern: /\balles ab\b/i, reason: 'precise, not absolute: "Wir übernehmen, was Planer:innen vom Planen abhält." (Markenbasis, Präzise statt absolut)' },
]

/** The product name is copy: write {name}, never type it (apps/website/AGENTS.md). archos.tech is a domain, not the name. */
const TYPED_NAME = /\barchos\b(?!\.tech)/i

/**
 * Findings for one copy string.
 * @param {string} text   the string as written in the dictionary (with {name} placeholders)
 * @param {'de' | 'en'} locale
 * @param {{ filled?: boolean }} options  filled: {name} is already replaced (ui.ts exposes only t()),
 *   so the typed-name rule cannot tell a typed name from a filled one and is skipped
 * @returns {string[]} one message per broken rule
 */
export function copyFindings(text, locale, { filled = false } = {}) {
  const out = []
  if (locale === 'de' && text.includes('!')) out.push('exclamation mark in German copy (Satzzeichen: keine Ausrufezeichen)')
  if (EMOJI.test(text)) out.push('emoji or pictograph (only the glyphs → ← · × are allowed)')
  if (/™|\(TM\)/.test(text)) out.push('™ in copy: the brand name is written without it')
  if (!filled && TYPED_NAME.test(text)) out.push('brand name typed into copy: write {name} (filled from identity.json, set in capitals)')
  for (const { pattern, reason } of BANNED_TERMS) if (pattern.test(text)) out.push(`"${text.match(pattern)[0]}": ${reason}`)
  return out
}

/**
 * Statement headings end with a full stop (or a question mark), German and English alike:
 * "Kontakt.", "Ihre Daten bleiben Ihre.". A statement heading is the title of a section,
 * a key `title` or `heading` inside a section object. Not counted, as in the reference site:
 * the page's own name (a top-level `title`, used for the document title and navigation),
 * `meta`, and the titles of items in a list or grid (`features.0.title`, set as heading-3
 * labels: "Hosting in Wien").
 * @param {string[]} path  the dictionary path of the string
 */
export function headingFinding(path, text) {
  if (!/^(?:title|heading)$/.test(path.at(-1)) || path.length < 2) return null
  if (path[0] === 'meta' || /^\d+$/.test(path.at(-2))) return null
  return /[.?]$/.test(text.trim()) ? null : 'statement heading without a closing full stop (Überschriften enden mit Punkt)'
}

/** Every string leaf of a dictionary, with its dotted path. */
export function stringLeaves(value, path = []) {
  if (typeof value === 'string') return [{ path, text: value }]
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, [...path, String(i)]))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, [...path, k]))
  return []
}

// ---------------------------------------------------------------------------
// CSS rules (design system: colours only through tokens, app-only tokens stay in the app)
// ---------------------------------------------------------------------------

/** Token families that exist only in the workspace's layer (tokens.json "scope": "app"). */
const APP_ONLY = /var\(--(?:shadow-(?:raised|floating|modal)|radius-(?:inline|control|surface|overlay|bubble|full|sm|lg|xl))\b/

/**
 * Findings for one stylesheet (or the CSS of one .astro file).
 * @param {string} css
 * @param {Set<string>} defined  custom properties the website's token copy defines
 */
export function cssFindings(css, defined) {
  const out = []
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) out.push(`colour literal "${m[0]}": use a colour token`)
  for (const m of code.matchAll(/box-shadow\s*:(?!\s*(?:var\(--focus-ring\)|none\b))[^;}]+/g)) out.push(`"${m[0].trim()}": the website has no shadows; the focus ring is the only one`)
  const app = code.match(APP_ONLY)
  if (app) out.push(`"${app[0]})": an app-only token on the website (tokens.json scope "app")`)
  for (const m of code.matchAll(/var\(--((?:radius|shadow|space|duration|ease|stroke|text|font)-[a-z0-9-]+)\)/g)) {
    if (!defined.has(m[1])) out.push(`var(--${m[1]}) is not a token the website receives`)
  }
  return out
}

/** Custom properties declared in a generated tokens.css. */
export function definedProperties(tokensCss) {
  return new Set([...tokensCss.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]))
}

// ---------------------------------------------------------------------------
// Media rule: AI-generated images carry the AITag
// ---------------------------------------------------------------------------

/**
 * The website's AI-generated images. The design system requires the AITag on each
 * (bottom right, in the same frame as the image). TODO(owner): confirm whether
 * demo-panel-background.webp and the sign-in photo are AI-generated; add them here if so.
 */
export const AI_GENERATED_MEDIA = ['/media/planner-design-photo.webp', '/media/ai-search-compare-photo.webp']

const VOID = new Set(['img', 'br', 'hr', 'input', 'source', 'meta', 'link', 'track', 'wbr', 'area', 'base', 'col', 'embed', 'path', 'rect', 'circle', 'line'])
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g

/** The HTML of the element that directly contains position `at` (its parent's open tag to its close tag). */
function enclosingElement(html, at) {
  const stack = []
  TAG.lastIndex = 0
  for (let m = TAG.exec(html); m && m.index < at; m = TAG.exec(html)) {
    const [, closing, name, selfClosing] = m
    const tag = name.toLowerCase()
    if (closing) {
      const i = stack.findLastIndex((e) => e.tag === tag)
      if (i !== -1) stack.length = i
    } else if (!selfClosing && !VOID.has(tag)) stack.push({ tag, start: m.index })
  }
  const parent = stack.at(-1)
  if (!parent) return html
  let depth = 0
  TAG.lastIndex = parent.start
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (m[2].toLowerCase() !== parent.tag || m[3]) continue
    depth += m[1] ? -1 : 1
    if (depth === 0) return html.slice(parent.start, m.index)
  }
  return html.slice(parent.start)
}

/**
 * Findings for one built page: every <img> of an AI-generated file must share its
 * parent element (the frame the tag is positioned in) with a .ui-ai-tag.
 */
export function aiTagFindings(html) {
  const out = []
  for (const src of AI_GENERATED_MEDIA) {
    for (let at = html.indexOf(`src="${src}"`); at !== -1; at = html.indexOf(`src="${src}"`, at + 1)) {
      if (!enclosingElement(html, at).includes('ui-ai-tag')) out.push(`${src} is AI-generated and has no AITag in its frame`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function filesUnder(dir, suffix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'brand' ? [] : filesUnder(path, suffix)
    return path.endsWith(suffix) ? [path] : []
  })
}

async function dictionaries() {
  const pages = readdirSync(join(WEBSITE, 'src/i18n/pages')).filter((f) => f.endsWith('.ts'))
  const out = []
  for (const file of pages) {
    const mod = await import(join(WEBSITE, 'src/i18n/pages', file))
    out.push({ file: `src/i18n/pages/${file}`, copy: mod.default, filled: false })
  }
  const ui = await import(join(WEBSITE, 'src/i18n/ui.ts'))
  out.push({ file: 'src/i18n/ui.ts', copy: { de: ui.t('de'), en: ui.t('en') }, filled: true })
  return out
}

async function main() {
  const problems = []
  const report = (where, message) => problems.push(`${where}: ${message}`)

  for (const { file, copy, filled } of await dictionaries()) {
    for (const locale of ['de', 'en']) {
      for (const { path, text } of stringLeaves(copy[locale])) {
        const where = `apps/website/${file} ${locale}.${path.join('.')}`
        for (const message of copyFindings(text, locale, { filled })) report(where, message)
        const heading = headingFinding(path, text)
        if (heading) report(where, heading)
      }
    }
  }

  const defined = definedProperties(readFileSync(join(WEBSITE, 'src/styles/brand/tokens.css'), 'utf8'))
  const sheets = [
    join(REPO, 'packages/brand/css/components.css'),
    ...filesUnder(join(WEBSITE, 'src/styles'), '.css'),
  ]
  for (const path of sheets) {
    for (const message of cssFindings(readFileSync(path, 'utf8'), defined)) report(relative(REPO, path), message)
  }
  for (const path of filesUnder(join(WEBSITE, 'src'), '.astro')) {
    const source = readFileSync(path, 'utf8')
    const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), ...source.matchAll(/\bstyle="([^"]*)"/g)].map((m) => m[1]).join('\n')
    for (const message of cssFindings(css, defined)) report(relative(REPO, path), message)
  }

  const built = join(WEBSITE, 'dist/client')
  const pages = filesUnder(built, '.html')
  if (process.argv.includes('--require-build') && pages.length === 0) {
    report('apps/website/dist/client', 'no built pages: run `bun run build` first (--require-build)')
  }
  for (const path of pages) {
    for (const message of aiTagFindings(readFileSync(path, 'utf8'))) report(relative(REPO, path), message)
  }

  if (problems.length > 0) {
    console.error(`brand rules: ${problems.length} problem(s) (rules: packages/brand/README.md, "Rules the checks hold")`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`brand rules hold (copy in both locales, ${sheets.length} stylesheets + .astro styles, ${pages.length} built pages for the AI tag)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
