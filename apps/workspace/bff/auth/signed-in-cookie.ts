/**
 * The `signed_in` cookie: tells the public website that this browser has a
 * session in the app, so its header offers "Open app" instead of "Login".
 *
 * The website runs on the parent domain (`LANDING_URL`), the app on a
 * subdomain. AuthKit's session cookie is host-only and HttpOnly, so the
 * website can neither see nor read it, and must not: it is the session. This
 * cookie is the one bit the website needs and nothing more. Its value is
 * always `1`; it carries no user, organization or session id, and the website
 * only reads it in the browser to pick a button label. A wrong value costs
 * nothing: the website's button goes to the app's own entry point, which signs
 * in a visitor without a session.
 *
 * The proxy writes it only when the state changes: set when a request arrives
 * with a session AuthKit kept, cleared (with the same Domain and Path, or the
 * browser keeps the original) when a request arrives without one, when AuthKit
 * clears the session, or when AuthKit sends the request to sign in. Sign-out
 * returns to the app's `/`, which is such a request.
 */

export const SIGNED_IN_COOKIE_NAME = 'signed_in'

/** AuthKit's own default lifetime for the session cookie (`cookie.js`): 400 days, Chrome's maximum. */
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 400

export interface SignedInCookieScope {
  /** `undefined` means host-only: the website and the app share a host (local development). */
  domain: string | undefined
  secure: boolean
  maxAgeSeconds: number
}

interface ScopeSettings {
  /** The app's public callback URL (`WORKOS_REDIRECT_URI`): its host is the app's public host. */
  redirectUri: string | undefined
  /** The website's base URL (`LANDING_URL`). */
  landingUrl: string | undefined
  /** `WORKOS_COOKIE_MAX_AGE`, so the cookie lives as long as the session cookie. */
  sessionMaxAge: string | undefined
}

const hostOf = (url: string | undefined): URL | null => {
  if (!url) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Where the cookie can live so that both the app and the website see it, or
 * `null` when there is no such place: the website is not on the app's parent
 * domain (or either address is unknown), and then the website keeps "Login".
 */
export function signedInCookieScope(settings: ScopeSettings): SignedInCookieScope | null {
  const app = hostOf(settings.redirectUri)
  const site = hostOf(settings.landingUrl)
  if (!app || !site) return null

  const sameHost = app.hostname === site.hostname
  if (!sameHost && !app.hostname.endsWith(`.${site.hostname}`)) return null

  const parsedMaxAge = Number.parseInt(settings.sessionMaxAge ?? '', 10)
  return {
    domain: sameHost ? undefined : site.hostname,
    secure: app.protocol === 'https:',
    maxAgeSeconds: Number.isFinite(parsedMaxAge) && parsedMaxAge > 0 ? parsedMaxAge : DEFAULT_MAX_AGE_SECONDS,
  }
}

/** The scope this deployment's environment gives, read per call so a spec can set it. */
export function signedInCookieScopeFromEnv(): SignedInCookieScope | null {
  return signedInCookieScope({
    redirectUri: process.env.WORKOS_REDIRECT_URI ?? process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    landingUrl: process.env.LANDING_URL,
    sessionMaxAge: process.env.WORKOS_COOKIE_MAX_AGE,
  })
}

/** A raw `Set-Cookie` value. Not HttpOnly: the website reads it in the browser. */
export function serializeSignedInCookie(scope: SignedInCookieScope, signedIn: boolean): string {
  const parts = [
    `${SIGNED_IN_COOKIE_NAME}=${signedIn ? '1' : ''}`,
    'Path=/',
    `Max-Age=${signedIn ? scope.maxAgeSeconds : 0}`,
    'SameSite=Lax',
  ]
  if (!signedIn) parts.push(`Expires=${new Date(0).toUTCString()}`)
  if (scope.domain) parts.push(`Domain=${scope.domain}`)
  if (scope.secure) parts.push('Secure')
  return parts.join('; ')
}
