/**
 * Proposed changes repository — the SQL over `proposed_changes` (migration
 * 0137). No authorization here; `./service` owns it. Every statement is keyed
 * by the organization as well as the id, and runs in its tenant scope.
 *
 * Every transition is a compare-and-swap on `proposed`, so two people (or two
 * tabs) deciding at once cannot both win: the loser's update finds no row and
 * the service turns that into a 409.
 */

import 'server-only'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { proposedChanges, type ProposedChangeRow, type ProposerKind } from '@/lib/db/schema/proposed-changes'
import { withTenant } from '@/lib/db/tenant-context'
import type { FileOperationPayload, ProposedChangeKind, ProposedChangeResult, ProposedChangeStatus } from './types'

export type { ProposedChangeRow }

export interface NewProposedChange {
  organizationId: string
  projectId: string
  kind: ProposedChangeKind
  payload: FileOperationPayload
  proposedByKind: ProposerKind
  onBehalfOf: string
  originConversationId: string | null
  originMessageId: string | null
}

export async function insertProposedChange(input: NewProposedChange): Promise<ProposedChangeRow> {
  const db = getDb()
  const [row] = await withTenant({ organizationId: input.organizationId }, () =>
    db
      .insert(proposedChanges)
      .values({ ...input, status: 'proposed' })
      .returning()
  )
  return row
}

/** One proposed change of this organization, or null. */
export async function findProposedChange(organizationId: string, id: string): Promise<ProposedChangeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(proposedChanges)
      .where(and(eq(proposedChanges.organizationId, organizationId), eq(proposedChanges.id, id)))
      .limit(1)
  )
  return row ?? null
}

/** Still `proposed`, and nobody is applying it (a claim older than `staleBefore` no longer counts). */
const undecided = (organizationId: string, id: string, staleBefore: Date) =>
  and(
    eq(proposedChanges.organizationId, organizationId),
    eq(proposedChanges.id, id),
    eq(proposedChanges.status, 'proposed'),
    or(isNull(proposedChanges.applyingSince), lt(proposedChanges.applyingSince, staleBefore))
  )

/** The claim this apply holds: still `proposed`, and still claimed by the same person at the same moment. */
const heldClaim = (organizationId: string, id: string, by: string, since: Date) =>
  and(
    eq(proposedChanges.organizationId, organizationId),
    eq(proposedChanges.id, id),
    eq(proposedChanges.status, 'proposed'),
    eq(proposedChanges.applyingBy, by),
    eq(proposedChanges.applyingSince, since)
  )

/**
 * Claim the change for applying: set `applying_by` / `applying_since` when it
 * is still `proposed` and unclaimed. Null when somebody decided it, or is
 * applying it, first.
 */
export async function claimProposedChange(
  organizationId: string,
  id: string,
  userId: string,
  staleBefore: Date
): Promise<ProposedChangeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(proposedChanges)
      .set({ applyingBy: userId, applyingSince: new Date() })
      .where(undecided(organizationId, id, staleBefore))
      .returning()
  )
  return row ?? null
}

/**
 * Settle a claimed apply: the final status, the results, who decided and when,
 * and the claim cleared. Null when the claim is no longer this one (it went
 * stale and someone else decided it).
 */
export async function settleProposedChange(
  organizationId: string,
  claim: Pick<ProposedChangeRow, 'id' | 'applyingBy' | 'applyingSince'>,
  outcome: { status: Extract<ProposedChangeStatus, 'applied' | 'partially_applied' | 'failed'>; results: ProposedChangeResult[] }
): Promise<ProposedChangeRow | null> {
  const { applyingBy: by, applyingSince: since } = claim
  if (!by || !since) return null
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(proposedChanges)
      .set({
        status: outcome.status,
        results: outcome.results,
        decidedBy: by,
        decidedAt: new Date(),
        applyingBy: null,
        applyingSince: null,
      })
      .where(heldClaim(organizationId, claim.id, by, since))
      .returning()
  )
  return row ?? null
}

/** Give a claim back without deciding (the apply broke before it could record anything). */
export async function releaseProposedChange(
  organizationId: string,
  claim: Pick<ProposedChangeRow, 'id' | 'applyingBy' | 'applyingSince'>
): Promise<void> {
  const { applyingBy: by, applyingSince: since } = claim
  if (!by || !since) return
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(proposedChanges)
      .set({ applyingBy: null, applyingSince: null })
      .where(heldClaim(organizationId, claim.id, by, since))
  )
}

/** Dismiss it when still `proposed` and nobody is applying it; null when somebody decided or claimed it first. */
export async function dismissProposedChange(
  organizationId: string,
  id: string,
  userId: string,
  staleBefore: Date
): Promise<ProposedChangeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(proposedChanges)
      .set({ status: 'dismissed', decidedBy: userId, decidedAt: new Date(), applyingBy: null, applyingSince: null })
      .where(undecided(organizationId, id, staleBefore))
      .returning()
  )
  return row ?? null
}
