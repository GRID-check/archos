import 'server-only'
/**
 * How many mails wait for this reader in each of these projects: the number
 * on the projects home's cards (`ProjectMailWaiting`, ADR-0134). Counted only
 * in projects whose E-Mail-Eingang the reader may open
 * (`mailReviewerProjectIds`), so nobody sees a number of mail they cannot
 * read; absent where none waits. The same mails `inbound-mail-list?status=waiting`
 * lists, counted in one query, which is also how an agent reads the number.
 *
 * Its own module so the projects service can ask without importing the
 * E-Mail-Eingang's service and everything that comes with it.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { mailReviewerProjectIds } from './access'
import { countWaitingMailsByProject } from './repository'

export async function waitingMailCounts(session: AuthorizedSession, projectIds: readonly string[]): Promise<Record<string, number>> {
  const readable = await mailReviewerProjectIds(session, projectIds)
  return Object.fromEntries(await countWaitingMailsByProject(readable))
}
