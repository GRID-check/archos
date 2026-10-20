/**
 * Which language a server render (or a route handler) answers in.
 *
 * Pure: `server.ts` reads the request and the saved preference, this decides.
 *
 * For a signed-in request the SAVED facts decide: the person's own choice
 * (`user_preferences.prefs.locale`), else their office's chosen default
 * (`organizations.default_locale`, null until an admin picks one). The
 * `grid-locale` cookie only mirrors those facts, so it stands in for them only
 * when they cannot be read: signed out, auth disabled, the database down.
 *
 * Why the cookie does not win for a signed-in request: it was written in the
 * browser, after mount, by a reconciliation that used to apply the schema's
 * `'en'` org default as if an office had chosen it. A German office's members
 * kept that stale `en` cookie, and every full page load (the redirect after
 * creating a project, the server-rendered setup page) painted English. Safari
 * also caps a script-written cookie at seven days, after which the server fell
 * back to `Accept-Language` and the client flipped the page again after mount.
 */

import { defaultLocale, isLocale, resolveLocale, type Locale } from './config'

/** What the server knows of the requester's saved language. */
export type SavedLocale =
  /** No session could be read, or the saved facts could not: the cookie stands in. */
  | { known: false }
  /** Signed in; `locale` is the saved choice (personal, else the office's), null when neither exists. */
  | { known: true; locale: Locale | null }

export interface RequestLocaleInput {
  saved: SavedLocale
  cookie: string | null | undefined
  acceptLanguage: string | null | undefined
}

/** The primary supported language of an `Accept-Language` header, in the header's order. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag) continue
    // resolveLocale never returns null; only accept a real header match.
    if (isLocale(tag) || isLocale(tag.split('-')[0]?.toLowerCase())) return resolveLocale(tag)
  }
  return null
}

export function pickRequestLocale({ saved, cookie, acceptLanguage }: RequestLocaleInput): Locale {
  if (saved.known) {
    return saved.locale ?? localeFromAcceptLanguage(acceptLanguage) ?? defaultLocale
  }
  if (isLocale(cookie)) return cookie
  return localeFromAcceptLanguage(acceptLanguage) ?? defaultLocale
}
