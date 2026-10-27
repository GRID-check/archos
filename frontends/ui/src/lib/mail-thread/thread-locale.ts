import 'server-only'
/**
 * The locale a new E-Mail-Verlauf is rendered in, for its whole life
 * (`mail_threads.locale`, ADR-0137): the filer's own, else their office's
 * default (the chain the UI resolves them by, `user-preferences/locale.ts`),
 * else German, the language an office's mail to its projects is written in.
 *
 * One answer for every writer that opens a thread: the inbound filing job (as
 * the person who decided) and the archive import (as the person who started
 * it). A lookup that fails falls through to the next link rather than failing
 * the filing: a thread's words are no reason to refuse a mail.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { isLocale } from '@/i18n/config'
import { findOrganization } from '@/lib/organizations/repository'
import { findUserPreferences } from '@/lib/user-preferences/repository'
import type { MailThreadLocale } from './mail-thread-vocabulary'

export async function newThreadLocaleFor(session: AuthorizedSession): Promise<MailThreadLocale> {
  const preferences = await findUserPreferences(session.userId, session.organizationId).catch(() => null)
  if (isLocale(preferences?.locale)) return preferences.locale
  const organization = await findOrganization(session.organizationId).catch(() => null)
  return isLocale(organization?.defaultLocale) ? organization.defaultLocale : 'de'
}
