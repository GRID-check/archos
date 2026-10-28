/**
 * User preferences API — opaque per-user preferences such as the active
 * project id. Thin handlers; all logic lives in
 * `@/lib/user-preferences/service`.
 */

import { cookies } from 'next/headers'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { LEGACY_LOCALE_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE_SECONDS, isLocale } from '@/i18n/config'
import { updatePreferencesSchema } from '@/lib/user-preferences/preferences-wire'
import { getUserPreferences, mergeUserPreferences } from '@/lib/user-preferences/service'

export const GET = apiRoute(async ({ session }) => ({ prefs: await getUserPreferences(session) }), {
  authz: { sessionOnly: true, why: 'the caller’s own preferences, keyed to session.userId' },
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const { prefs } = await parseJsonBody(request, updatePreferencesSchema)
    const merged = await mergeUserPreferences(session, prefs)
    // The language is mirrored by the server, not only by the page's script:
    // Safari keeps a cookie written by `document.cookie` for seven days at
    // most, one sent in a response for its max-age (`i18n/request-locale.ts`).
    if (isLocale(prefs.locale)) {
      const jar = await cookies()
      jar.set(LOCALE_COOKIE, prefs.locale, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
        sameSite: 'lax',
      })
      jar.delete(LEGACY_LOCALE_COOKIE)
    }
    return { prefs: merged }
  },
  { authz: { sessionOnly: true, why: 'the caller’s own preferences, keyed to session.userId' } }
)
