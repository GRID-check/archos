/**
 * Store-side translator.
 *
 * Zustand stores and other non-React modules cannot call the `useTranslations`
 * hook, but they still surface user-facing copy (e.g. toast notifications when
 * a background job fails to cancel). This helper resolves the active locale
 * from the same cookie the {@link I18nProvider} mirrors it into, then builds a
 * one-off translator over the namespace it is handed.
 *
 * It is intentionally NOT reactive: it reads the locale at call time, which is
 * exactly right for imperative, fire-and-forget messages. React components must
 * keep using `useTranslations` so they re-render on a language switch.
 */

import { translatorFor, type Namespace } from './namespace'
import type { Translator } from './translate'
import { LOCALE_COOKIE, defaultLocale, isLocale, resolveLocale, type Locale } from './config'

/**
 * Read the active locale: the page's `lang`, else the mirror cookie, else the default.
 *
 * Exported for imperative, non-React callers (e.g. a store action that sends
 * the UI language to a backend generation endpoint). Not reactive — it reads
 * the cookie at call time, which is exactly right for fire-and-forget work.
 */
export function getActiveLocale(): Locale {
  if (typeof document === 'undefined') return defaultLocale
  // The page's own language first: the server renders `<html lang>` and
  // `I18nProvider` keeps it current. The cookie can be missing while the page
  // is German (Safari drops a script-written cookie after seven days, and a
  // render that read the saved preference writes none), and a missing cookie
  // read as English.
  const pageLang = document.documentElement.lang
  if (isLocale(pageLang)) return pageLang
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`),
  )
  return resolveLocale(match ? decodeURIComponent(match[1]) : undefined)
}

/**
 * Build a translator bound to the active locale over one namespace, optionally
 * narrowed to a scope inside it. Call this at the point of use (not module
 * load) so it always reflects the current language.
 */
export function getStoreTranslator(namespace: Namespace, scope?: string): Translator {
  return translatorFor(namespace, getActiveLocale(), scope)
}
