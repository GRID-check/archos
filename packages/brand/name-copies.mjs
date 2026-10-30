/**
 * The files that must spell the product's name as a literal, because they run
 * where nothing can import `identity.json`: a service worker is one plain file,
 * and an icon's SVG <title> is markup. `sync.mjs` writes the name into each of
 * them from `identity.json` and `sync.mjs --check` fails when one drifted, so a
 * rename is still one edit to `identity.json` and one run of `sync.mjs`.
 * `tests/test_product_name_parity.py` holds every copy to the source and runs the
 * rename drill: a different name in a scratch copy reaches every surface.
 */

/** Repo-relative copies of `mark.svg`, written whole with the name in its <title>. */
export const MARK_COPIES = [
  'apps/workspace/app/icon.svg',
  'apps/website/public/favicon.svg',
]

/** `{ path, pattern }`: the pattern's two groups stay, the name goes between them. */
export const NAME_COPIES = [
  // The notification title when a push payload carries none.
  { path: 'apps/workspace/public/sw.js', pattern: /(\nvar GENERIC_TITLE = ')[^']*(')/ },
]

/** `text` with `name` between the pattern's two groups, or null when the pattern is not in it. */
export function withName(text, pattern, name) {
  if (!pattern.test(text)) return null
  return text.replace(pattern, (_, before, after) => `${before}${name}${after}`)
}

/** `text` safe as XML character data: the name goes into an SVG's <title>. */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The mark master, whose <title> holds the token `{productName}`, with the name put in. */
export function namedMark(master, name) {
  if (!master.includes('<title>{productName}</title>')) {
    throw new Error('mark.svg must keep <title>{productName}</title>; the name is filled in from identity.json')
  }
  return master.replace('<title>{productName}</title>', (title) => title.replace('{productName}', () => escapeXml(name)))
}
