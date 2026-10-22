/**
 * Server-side i18n helpers for use in Server Components, layouts, and route
 * handlers. The order the locale is resolved in, and why the cookie comes after
 * the saved preference for a signed-in request: `request-locale.ts`.
 */

import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { LOCALE_COOKIE, type Locale } from './config'
import { getDictionary } from './dictionaries'
import { pickRequestLocale } from './request-locale'
import { createTranslator, type Translator } from './translate'
import { findSavedLocale } from '@/lib/user-preferences/locale'
import { actingReaderIsAgent } from '@/lib/agent-api/acting-session'

/**
 * The locale of the person behind the request.
 *
 * Cached per render: the root layout, the page and its `generateMetadata` each
 * ask, and the saved preference is a database read.
 */
const requestLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore, saved] = await Promise.all([cookies(), headers(), findSavedLocale()])
  return pickRequestLocale({
    saved,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language'),
  })
})

/**
 * Resolve the active locale for the current request. An agent's call through
 * the MCP server (`lib/agent-api/dispatch.ts`) reads English, whatever the
 * person saved: a model reads the answer, and anything an agent reads is
 * English (AGENTS.md, "Industry standard first").
 */
export async function getLocale(): Promise<Locale> {
  if (actingReaderIsAgent()) return 'en'
  return requestLocale()
}

/**
 * Get a server-side translator, optionally scoped to a namespace.
 *
 * @example
 * const t = await getTranslations('errors')
 * t('notFound.title')
 */
export async function getTranslations(namespace?: string): Promise<Translator> {
  const locale = await getLocale()
  return createTranslator(getDictionary(locale), namespace)
}
