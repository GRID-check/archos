/**
 * The last lock on what the BFF sends to PostHog: strip secrets out of every
 * URL-shaped string in an event before it leaves the process (ADR-0099).
 *
 * Why a scrubber when the call sites send ids and counts: a property is not the
 * only way a URL gets into an event. An exception's message can quote the
 * request that failed, a caller one day passes `request.url` as context, and a
 * URL here can be a signed image link (`sig=` is its HMAC,
 * `lib/images/signed-image-url.ts`) or the OAuth callback (`code=` and `state=`
 * are the one-time grant). Each of those is a credential the moment it is in
 * somebody else's database. "Callers promise not to" is the layer that fails
 * when people are tired; a hook inside the client does not depend on them.
 *
 * Runs as posthog-node's `before_send`, so it sees every event the client sends,
 * `$exception` included, whatever the path that queued it. It walks the
 * properties and the person `$set`/`$set_once` bags and rewrites each string
 * that carries a query or a fragment.
 *
 * What it removes: the parameters whose NAME is one of {@link SENSITIVE_PARAMS}.
 * The rest of the URL, including other parameters, stays, so a `?page=3` still
 * explains the request. It matches names, not values: a secret under another
 * name is not caught, which is why the call sites send no URLs in the first
 * place.
 *
 * Pure and dependency-free so a spec can drive it without a client.
 */

/** Query/fragment parameter names that carry a credential. Compared case-insensitively. */
export const SENSITIVE_PARAMS = ['sig', 'token', 'secret', 'key', 'code', 'state'] as const

const SENSITIVE = new Set<string>(SENSITIVE_PARAMS)

/** A query string (`?a=1&b=2`) or a fragment holding parameters (`#a=1`) inside a longer string. */
const QUERY_PART = /\?[^\s"'<>#]*/g
const FRAGMENT_PART = /#[^\s"'<>]*=[^\s"'<>]*/g

const MAX_DEPTH = 8

const nameOf = (pair: string): string => {
  const raw = pair.split('=')[0] ?? ''
  try {
    return decodeURIComponent(raw).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

/** Punctuation that ends a sentence or closes a bracket around a URL, not part of it. */
const TRAILING_PUNCTUATION = /[)\]}.,;:!]+$/

/** `lead` + the pairs that survive, or '' when none do. Unchanged input comes back as is. */
const filterPairs = (matched: string, lead: '?' | '#'): string => {
  const trailing = TRAILING_PUNCTUATION.exec(matched)?.[0] ?? ''
  const part = trailing ? matched.slice(0, -trailing.length) : matched
  const pairs = part.slice(1).split('&')
  const kept = pairs.filter((pair) => !SENSITIVE.has(nameOf(pair)))
  if (kept.length === pairs.length) return matched
  return (kept.length === 0 ? '' : `${lead}${kept.join('&')}`) + trailing
}

/** The string with every sensitive query or fragment parameter removed. */
export const scrubUrlString = (value: string): string => {
  if (!value.includes('?') && !value.includes('#')) return value
  return value
    .replace(QUERY_PART, (part) => filterPairs(part, '?'))
    .replace(FRAGMENT_PART, (part) => filterPairs(part, '#'))
}

const scrubValue = (value: unknown, depth: number): unknown => {
  if (typeof value === 'string') return scrubUrlString(value)
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1))
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubValue(item, depth + 1)]),
  )
}

type Bag = Record<string, unknown>

/** The shape of `before_send`'s event that this module reads and writes. */
interface ScrubbableEvent {
  event?: string
  properties?: Bag
  $set?: Bag
  $set_once?: Bag
}

/**
 * posthog-node `before_send` hook. Never throws and never drops: a scrubber
 * that failed closed would cost the signal, and one that threw would be the
 * reason an event was lost. If rewriting fails, the properties are cleared
 * instead of sent as they were.
 */
export const scrubServerEvent = <T extends ScrubbableEvent | null>(event: T): T => {
  if (!event) return event
  try {
    const next: ScrubbableEvent = { ...event }
    if (event.properties) next.properties = scrubValue(event.properties, 0) as Bag
    if (event.$set) next.$set = scrubValue(event.$set, 0) as Bag
    if (event.$set_once) next.$set_once = scrubValue(event.$set_once, 0) as Bag
    return next as T
  } catch (error) {
    console.debug('[posthog] could not scrub event; sending it without properties', error)
    const emptied: ScrubbableEvent = { ...event, properties: {} }
    delete emptied.$set
    delete emptied.$set_once
    return emptied as T
  }
}
