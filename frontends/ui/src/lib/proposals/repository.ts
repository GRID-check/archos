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
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { proposedChanges, type ProposedChangeRow, type ProposerKind } from '@/lib/db/schema/proposed-changes'
import { withTenant } from '@/lib/db/tenant-context'
import type { ProposalScope, ProposedChangeKind, ProposedChangeResult, ProposedChangeStatus } from './types'

export type { ProposedChangeRow }

export interface NewProposedChange {
  organizationId: string
  /** Null for a Büroablage proposal (0146); `scope` says which shelf. */
  projectId: string | null
  scope: ProposalScope
  kind: ProposedChangeKind
  /** The contract's payload for `kind`, parsed by the service before it gets here. */
  payload: unknown
  proposedByKind: ProposerKind
  onBehalfOf: string
  originConversationId: string | null
  originMessageId: string | null
  /** Which card of the origin answer made it; needs `originMessageId` (0143's CHECK). */
  originCardIndex?: number | null
  /** The Langfuse trace of the judgement that proposed it, for a proposal no turn made (0146). */
  originTraceId?: string | null
}

/** What an insert came to: the row, and whether this call made it or found the card's earlier one. */
export interface InsertedProposedChange {
  row: ProposedChangeRow
  created: boolean
}

/** What names one call of an operation: which, and with what input. */
export interface OperationCall {
  operation: string
  input: unknown
}

/**
 * The still-`proposed` operation proposal of this conversation for this call,
 * made for this person, or null (0176, 0178). `payload->'input'` is compared as
 * jsonb, which has one spelling per value, so key order and white space do not
 * tell two calls apart; this is the predicate of
 * `uniq_proposed_changes_open_operation`. The person is part of it: in a
 * conversation two people ask in, B's call is B's card, never A's.
 */
const openOperationCall = (organizationId: string, conversationId: string, onBehalfOf: string, call: OperationCall) =>
  and(
    eq(proposedChanges.organizationId, organizationId),
    eq(proposedChanges.originConversationId, conversationId),
    eq(proposedChanges.onBehalfOf, onBehalfOf),
    eq(proposedChanges.kind, 'operation'),
    eq(proposedChanges.status, 'proposed'),
    sql`${proposedChanges.payload}->>'operation' = ${call.operation}`,
    sql`${proposedChanges.payload}->'input' = ${JSON.stringify(call.input ?? {})}::jsonb`
  )

export async function findOpenOperationProposal(
  organizationId: string,
  conversationId: string,
  onBehalfOf: string,
  call: OperationCall
): Promise<ProposedChangeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(proposedChanges)
      .where(openOperationCall(organizationId, conversationId, onBehalfOf, call))
      .orderBy(proposedChanges.createdAt)
      .limit(1)
  )
  return row ?? null
}

/** The call an operation proposal's payload names, when it is one with a conversation to dedupe in (and no card: that key is its own). */
function dedupedCall(input: NewProposedChange): OperationCall | null {
  if (input.kind !== 'operation' || !input.originConversationId || input.originCardIndex != null) return null
  const payload = input.payload as Partial<OperationCall> | null
  return typeof payload?.operation === 'string' ? { operation: payload.operation, input: payload.input } : null
}

/**
 * Store a proposal. With a card index it is idempotent on
 * `uniq_proposed_changes_origin_card`: the same card of the same answer a
 * second time inserts nothing and returns the FIRST proposal, as it stands.
 * An operation proposal in a conversation is idempotent on
 * `uniq_proposed_changes_open_operation` (0176): a second identical call
 * while the first is still `proposed` returns the first, so two calls running
 * at once still make one.
 */
export async function insertProposedChange(input: NewProposedChange): Promise<InsertedProposedChange> {
  const db = getDb()
  const { organizationId, originMessageId, originCardIndex } = input
  return withTenant({ organizationId }, async () => {
    const values = { ...input, originCardIndex: originCardIndex ?? null, status: 'proposed' as const }
    const call = dedupedCall(input)
    if (call && input.originConversationId) {
      const [made] = await db.insert(proposedChanges).values(values).onConflictDoNothing().returning()
      if (made) return { row: made, created: true }
      const [open] = await db
        .select()
        .from(proposedChanges)
        .where(openOperationCall(organizationId, input.originConversationId, input.onBehalfOf, call))
        .orderBy(proposedChanges.createdAt)
        .limit(1)
      // The conflict was on this call's open row, so it is there: a miss is a bug, not a race.
      if (!open) throw new Error('A proposal for this call conflicted and could not be read back')
      return { row: open, created: false }
    }
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

/** A shelf's proposals: a project's, the Büroablage's, or the organization's (the last two have no project). */
export type ProposalShelf = { scope: 'project'; projectId: string } | { scope: 'office_shelf' | 'organization' }

const onShelf = (organizationId: string, shelf: ProposalShelf) =>
  and(
    eq(proposedChanges.organizationId, organizationId),
    eq(proposedChanges.scope, shelf.scope),
    shelf.scope === 'project' ? eq(proposedChanges.projectId, shelf.projectId) : isNull(proposedChanges.projectId)
  )

/**
 * A shelf's proposals in the given statuses, newest first, at most `limit`
 * (bounded here: a caller's number is clamped to {@link MAX_SHELF_PROPOSALS}).
 * Optionally one kind, and optionally only those no conversation made (the
 * filing suggestions, `lib/filing`).
 */
export const MAX_SHELF_PROPOSALS = 500

export async function listShelfProposals(
  organizationId: string,
  shelf: ProposalShelf,
  options: {
    statuses: readonly ProposedChangeStatus[]
    kind?: ProposedChangeKind
    withoutConversation?: boolean
    limit: number
  }
): Promise<ProposedChangeRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), MAX_SHELF_PROPOSALS)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(proposedChanges)
      .where(
        and(
          onShelf(organizationId, shelf),
          inArray(proposedChanges.status, [...options.statuses]),
          options.kind ? eq(proposedChanges.kind, options.kind) : undefined,
          options.withoutConversation ? isNull(proposedChanges.originConversationId) : undefined
        )
      )
      .orderBy(desc(proposedChanges.createdAt))
      .limit(limit)
  )
}

/** Most proposals one conversation's list returns: the WORKSPACE block names the newest few. */
export const MAX_CONVERSATION_PROPOSALS = 20

/**
 * The proposals made in one conversation, every status, newest first, bounded
 * by `limit` (at most {@link MAX_CONVERSATION_PROPOSALS}). Read for the turn
 * context of that same conversation, whose readers saw every one of them as a
 * card, so no audience is narrowed here (ADR-0123).
 */
export async function listConversationProposals(
  organizationId: string,
  conversationId: string,
  limit: number
): Promise<ProposedChangeRow[]> {
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_CONVERSATION_PROPOSALS)
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(proposedChanges)
      .where(
        and(
          eq(proposedChanges.organizationId, organizationId),
          eq(proposedChanges.originConversationId, conversationId)
        )
      )
      .orderBy(desc(proposedChanges.createdAt), desc(proposedChanges.id))
      .limit(bounded)
  )
}

/**
 * Take back a proposal nobody has decided: delete it while it is still
 * `proposed` and nobody is applying it. Piloti withdraws its own filing
 * suggestion this way when a later reading no longer supports it; a decided
 * proposal is a record and is never deleted. Whether a row went.
 */
export async function deleteUndecidedProposedChange(
  organizationId: string,
  id: string,
  staleBefore: Date
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db.delete(proposedChanges).where(undecided(organizationId, id, staleBefore)).returning({ id: proposedChanges.id })
  )
  return rows.length > 0
}
