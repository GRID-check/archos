/**
 * Proposed changes repository — the SQL over `proposed_changes` (migrations
 * 0140, 0143). No authorization here; `./service` owns it. Every statement is
 * keyed by the organization as well as the id, and runs in its tenant scope.
 *
 * Every transition is a compare-and-swap on `proposed`, so two people (or two
 * tabs) deciding at once cannot both win: the loser's update finds no row and
 * the service turns that into a 409.
 */

import 'server-only'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { conversationVisibleInProject } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { conversations } from '@/lib/db/schema'
import { proposedChanges, type ProposedChangeRow, type ProposerKind } from '@/lib/db/schema/proposed-changes'
import { withTenant } from '@/lib/db/tenant-context'
import type { ProposedChangeKind, ProposedChangeResult, ProposedChangeStatus } from './types'

export type { ProposedChangeRow }

export interface NewProposedChange {
  organizationId: string
  projectId: string
  kind: ProposedChangeKind
  /** The contract's payload for `kind`, parsed by the service before it gets here. */
  payload: unknown
  proposedByKind: ProposerKind
  onBehalfOf: string
  originConversationId: string | null
  originMessageId: string | null
  /** Which card of the origin answer made it; needs `originMessageId` (0143's CHECK). */
  originCardIndex?: number | null
}

/** What an insert came to: the row, and whether this call made it or found the card's earlier one. */
export interface InsertedProposedChange {
  row: ProposedChangeRow
  created: boolean
}

/**
 * Store a proposal. With a card index it is idempotent on
 * `uniq_proposed_changes_origin_card`: the same card of the same answer a
 * second time inserts nothing and returns the FIRST proposal, as it stands.
 */
export async function insertProposedChange(input: NewProposedChange): Promise<InsertedProposedChange> {
  const db = getDb()
  const { organizationId, originMessageId, originCardIndex } = input
  return withTenant({ organizationId }, async () => {
    const values = { ...input, originCardIndex: originCardIndex ?? null, status: 'proposed' as const }
    if (originCardIndex === null || originCardIndex === undefined || !originMessageId) {
      const [row] = await db.insert(proposedChanges).values(values).returning()
      return { row, created: true }
    }
    const [inserted] = await db
      .insert(proposedChanges)
      .values(values)
      .onConflictDoNothing({
        target: [proposedChanges.organizationId, proposedChanges.originMessageId, proposedChanges.originCardIndex],
        where: sql`${proposedChanges.originCardIndex} IS NOT NULL`,
      })
      .returning()
    if (inserted) return { row: inserted, created: true }
    const [existing] = await db
      .select()
      .from(proposedChanges)
      .where(
        and(
          eq(proposedChanges.organizationId, organizationId),
          eq(proposedChanges.originMessageId, originMessageId),
          eq(proposedChanges.originCardIndex, originCardIndex)
        )
      )
      .limit(1)
    // The conflict was on this card's row, so it is there: a miss is a bug, not a race.
    if (!existing) throw new Error('A proposal for this card conflicted and could not be read back')
    return { row: existing, created: false }
  })
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

/** Who is reading a project's proposals: their conversation rule decides which rows they get. */
export interface ProposalReader {
  organizationId: string
  projectId: string
  userId: string
}

/**
 * `requireReadableProposal`'s rule as SQL over `proposed_changes` LEFT JOIN
 * `conversations`: a proposal made outside any conversation needs only the
 * project (the caller proved `project:view`); one made in a conversation needs
 * that conversation, not deleted, in this project, and open to the reader by
 * the conversation list's rule (`conversationVisibleInProject`). A thread
 * locked by what it drew on is the caller's to drop after the query.
 */
function readableInProject(reader: ProposalReader): SQL {
  return or(
    isNull(proposedChanges.originConversationId),
    and(
      isNotNull(conversations.id),
      isNull(conversations.deletedAt),
      conversationVisibleInProject(reader.organizationId, reader.userId, reader.projectId)
    )
  ) as SQL
}

/** The project's proposals matching `where` that the reader may read, newest first by `order`, at most `limit`. */
async function listReadableProposals(
  reader: ProposalReader,
  where: SQL,
  order: SQL,
  limit: number
): Promise<ProposedChangeRow[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId: reader.organizationId }, () =>
    db
      .select({ row: proposedChanges })
      .from(proposedChanges)
      .leftJoin(
        conversations,
        and(
          eq(conversations.id, proposedChanges.originConversationId),
          eq(conversations.organizationId, proposedChanges.organizationId)
        )
      )
      .where(
        and(
          eq(proposedChanges.organizationId, reader.organizationId),
          eq(proposedChanges.projectId, reader.projectId),
          where,
          readableInProject(reader)
        )
      )
      .orderBy(order, desc(proposedChanges.id))
      .limit(limit)
  )
  return rows.map(({ row }) => row)
}

/**
 * The project's proposals nobody decided yet (`proposed`), any kind, that the
 * reader may read, newest first, at most `limit`. Scans
 * `idx_proposed_changes_project_created`.
 */
export function listOpenProposalsInProject(reader: ProposalReader, limit: number): Promise<ProposedChangeRow[]> {
  return listReadableProposals(reader, eq(proposedChanges.status, 'proposed'), desc(proposedChanges.createdAt), limit)
}

/** The decided statuses, every one but `proposed`. */
const DECIDED_STATUSES = ['applied', 'partially_applied', 'failed', 'dismissed'] as const

/**
 * The project's proposals decided at or after `since`, that the reader may
 * read, newest decision first, at most `limit`. Scans
 * `idx_proposed_changes_project_decided` (0144).
 */
export function listDecidedProposalsInProject(
  reader: ProposalReader,
  since: Date,
  limit: number
): Promise<ProposedChangeRow[]> {
  return listReadableProposals(
    reader,
    and(
      inArray(proposedChanges.status, [...DECIDED_STATUSES]),
      isNotNull(proposedChanges.decidedAt),
      gte(proposedChanges.decidedAt, since)
    ) as SQL,
    desc(proposedChanges.decidedAt),
    limit
  )
}
