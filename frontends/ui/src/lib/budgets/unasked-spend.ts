/**
 * Whether Piloti may spend on something nobody asked for (ADR-0130): the
 * person's budget status, FAIL-CLOSED. A spent scope, or a budget that cannot
 * be read, says no. A turn a person types fails the other way; this one is the
 * unasked kind, so the doubt goes against the spend.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBudgetStatus } from './service'

export async function unaskedSpendAllowed(session: AuthorizedSession, projectId: string | null): Promise<boolean> {
  try {
    const status = await getBudgetStatus(session.organizationId, session.userId, projectId)
    return !status.blocked
  } catch (error) {
    console.warn('[budgets] the budget could not be read; not spending on unasked work', error)
    return false
  }
}
