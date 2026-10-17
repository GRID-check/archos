/**
 * Removes secrets from the URL-shaped strings an analytics event carries.
 *
 * Imports nothing, so the browser client (`posthog.ts`, as `before_send`) and
 * any server capture path can share ONE definition of "what must never reach
 * PostHog" instead of two copies that drift.
 *
 * Why a scrubber and not "we never put those in a URL": the app does. A signed
 * document image carries its HMAC as `?sig=` (`lib/images/signed-image-url.ts`),
 * the OAuth callback lands on `/api/auth/callback?code=…&state=…`, and a
 * pre-prod link may carry a `token`. PostHog records `$current_url`,
 * `$referrer`, the autocaptured element's `href`/`src` and the script URLs in an
 * exception's stack, so any of those can be a secret on its way out.
 *
 * What it removes: the parameters named in {@link SENSITIVE_QUERY_KEYS}, plus
 * any `<something>_token|_secret|_key|-token|-secret|-key` and `signature`,
 * from a `?query` or a `#fragment` (an implicit OAuth flow returns its token in
 * the fragment). The rest of the URL survives, so the page is still
 * attributable.
 */

/** The query parameter names that are secrets or one-time grants, exactly as the owner listed them. */
export const SENSITIVE_QUERY_KEYS = ['sig', 'token', 'secret', 'key', 'code', 'state'] as const

const KEY_PATTERN =
  '(?:[\\w.-]*[_-])?(?:' + [...SENSITIVE_QUERY_KEYS, 'signature', 'apikey', 'password'].join('|') + ')'

// `next/image` rewrites `/api/documents/x/image?org=a&sig=b` into
// `/_next/image?url=%2Fapi%2Fdocuments%2Fx%2Fimage%3Forg%3Da%26sig%3Db&w=640`,
// so the separators and the `=` are matched in their percent-encoded form too.
const SEPARATOR = '(?:[?&#]|%26|%3F|%23)'
const EQUALS = '(?:=|%3D)'
const VALUE = '(?:(?!%26|%23)[^&#\\s"\'<>)\\]])*'

// A separator, a sensitive name, `=` and a value that runs to the next `&`, `#`,
// whitespace or a character that ends a URL inside prose, an attribute or a
// stack line.
const SENSITIVE_PARAM = new RegExp(`(${SEPARATOR})${KEY_PATTERN}${EQUALS}${VALUE}`, 'gi')

const OPENS_QUERY = /^(?:[?#]|%3F|%23)$/i
// What is left when the first parameter went and others follow: `?&a=b`.
const NOTHING_LEFT = /([?#]|%3F|%23)(?:&|%26)+/gi
const DANGLING = new RegExp(`${SEPARATOR}+(?=$|[\\s"'<>)\\]])`, 'gi')

/** `text` with the value of every sensitive parameter removed; other text is returned unchanged. */
export const scrubSensitiveQuery = (text: string): string => {
  if (!/=|%3D/i.test(text)) return text
  const removed = text.replace(SENSITIVE_PARAM, (_match, separator: string) =>
    OPENS_QUERY.test(separator) ? separator : ''
  )
  if (removed === text) return text
  return removed.replace(NOTHING_LEFT, '$1').replace(DANGLING, '')
}

const MAX_DEPTH = 8

/**
 * A copy of `value` with {@link scrubSensitiveQuery} applied to every string in
 * it, however deep. Used on whole event property bags rather than on a list of
 * property names, because the places a URL turns up (`$elements[].attr__href`,
 * `$elements_chain`, `$exception_list[].stacktrace.frames[].filename`, a
 * `$set_once.$initial_current_url`) are exactly the ones a list forgets.
 *
 * Returns the input object itself when nothing changed, so the common event
 * costs a walk and no allocation.
 */
export const scrubDeep = <T>(value: T, depth = 0): T => {
  if (typeof value === 'string') return scrubSensitiveQuery(value) as T
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const scrubbed = scrubDeep(item, depth + 1)
      if (scrubbed !== item) changed = true
      return scrubbed
    })
    return (changed ? next : value) as T
  }
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const scrubbed = scrubDeep(item, depth + 1)
    if (scrubbed !== item) changed = true
    next[key] = scrubbed
  }
  return (changed ? next : value) as T
}
