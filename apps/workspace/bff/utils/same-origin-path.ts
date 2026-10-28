/**
 * Paths a link or a notification may send a person to: on this origin, never
 * another site. Shared by the server (a push notification's destination) and
 * the browser (where a review returns to), so the two cannot disagree.
 */

/** Only a path on this origin: a leading `/`, and neither `//` nor a backslash, which a browser reads as another host. */
export function isSameOriginPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
}

/** The longest return path a link carries; a page's own URL with its filters is far shorter. */
export const MAX_RETURN_PATH_LENGTH = 1000

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0)
  return code < 0x20 || code === 0x7f
}

/** A base no real URL has, so a path that resolves anywhere else is caught. */
const PROBE_ORIGIN = 'https://return-path.invalid'

/**
 * A path inside the app (`/app/…`) to return to, as the URL parser reads it,
 * or null: never a scheme, another origin, a protocol-relative `//`, a
 * backslash, a control character or a path outside the app. The parser
 * decides rather than a pattern, so a tab or an encoded slash cannot smuggle
 * another host past it.
 */
export function appReturnPath(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_RETURN_PATH_LENGTH) return null
  if (!isSameOriginPath(value) || [...value].some(isControl)) return null
  let url: URL
  try {
    url = new URL(value, PROBE_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== PROBE_ORIGIN || !url.pathname.startsWith('/app/')) return null
  return `${url.pathname}${url.search}${url.hash}`
}
