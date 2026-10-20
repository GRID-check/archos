/**
 * The requester's saved language, read on the server (`i18n/server.ts`).
 *
 * The person's own choice wins; without one, their office's default, but only
 * a default an admin chose (`organizations.default_locale` is null until then,
 * migration 0156). Never throws: anything it cannot read makes the answer
 * `{ known: false }`, and the request falls back to the mirror cookie.
 *
 * `withAuth` rather than `getGridSession`: this runs inside every server
 * render, and needs the user and organization ids only, not the membership
 * lookups or the tenant slot `getGridSession` publishes.
 */

import 'server-only'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { isLocale } from '@/i18n/config'
import type { SavedLocale } from '@/i18n/request-locale'
import { findOrganization } from '@/lib/organizations/repository'
import { findUserPreferences } from './repository'

const UNKNOWN: SavedLocale = { known: false }

export async function findSavedLocale(): Promise<SavedLocale> {
  try {
    const auth = await withAuth()
    const userId = auth.user?.id
    const organizationId = auth.organizationId
    if (!userId || !organizationId) return UNKNOWN

    const prefs = await findUserPreferences(userId, organizationId)
    if (isLocale(prefs?.locale)) return { known: true, locale: prefs.locale }

    const organization = await findOrganization(organizationId)
    return { known: true, locale: isLocale(organization?.defaultLocale) ? organization.defaultLocale : null }
  } catch {
    // Outside the AuthKit proxy (an internal route), or the database is down.
    return UNKNOWN
  }
}
