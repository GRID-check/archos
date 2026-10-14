/**
 * Proposed changes — the rules (ADR-0105; `docs/architecture/proposed-changes.md`).
 *
 * Piloti proposes on behalf of the person whose turn it is; a person decides.
 *
 * - **Reading** takes `project:view` on the proposal's project AND `viewer` on
 *   the conversation it was made in. The card in that conversation is the
 *   proposal's surface, and its payload names files and folders; a reader who
 *   cannot see the conversation (a restricted folder's audience, a private
 *   chat) learns nothing from the id. Every refusal is a 404.
 * - **Deciding** (apply, dismiss) takes the read, plus the right the KIND
 *   writes with (`./kinds` `DECIDE_PERMISSIONS`): the project's documents
 *   (`project:documents:write`) for a file operation, its memory
 *   (`project:memory:write`) for a note or a profile change, `project:edit`
 *   for all three. A reader without it gets a 403. A closed project is
 *   read-only and refuses with its own 403.
 * - **After a decision** (committed, never awaited, never failing it) four
 *   things follow: the live channel `proposal:<id>` hears of it, so every open
 *   card re-reads (`lib/realtime/proposal-channel.ts`); the inbox is told
 *   nothing waits any more (`./attention`); the organization's audit trail
 *   records who decided and how (`./audit`); and the decision is a score on
 *   the trace of the turn that proposed it (`lib/langfuse/decision-score.ts`).
 *   Filing a proposal is in the trail too, once per card.
 * - **Applying** runs the kind's applier in the DECIDING person's session:
 *   the document, folder and assignment services for a file operation
 *   (`./executors`), the memory and profile services for the other two
 *   (`./appliers`), so every check they make by hand is made again. It is a
 *   compare-and-swap on `proposed`: the claim is committed before the first
 *   item runs and the settle clears it, so a double click or a second tab is a
 *   409. An applier that throws (a refusal of the decider) gives the claim back.
 * - **Creating** is idempotent per card: with the answer's message id and the
 *   card's index, the same card twice returns the first proposal.
 */

import 'server-only'
import { defaultLocale, type Locale } from '@/i18n/config'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { recordDecisionScore, type Decision } from '@/lib/langfuse/decision-score'
import { onProposalCreated, onProposalDecided } from './attention'
import { auditProposalCreated, auditProposalDecided } from './audit'
import { applyKind, DECIDE_PERMISSIONS, noticeVariantOf, parseKindPayload, requireProposable, summaryOf } from './kinds'
import { publishProposalDecided } from './live'
import {
  claimProposedChange,
  dismissProposedChange,
  findProposedChange,
  insertProposedChange,
  releaseProposedChange,
  settleProposedChange,
  type ProposedChangeRow,
} from './repository'
import type { ApplyProposalRequest, ProposedChangeKind, ProposedChangeResult, ProposedChangeView } from './types'

/**
 * How long an apply may hold its claim before another decision may take over.
 * Twenty items of a few service calls each finish in seconds; a claim this old
 * belongs to a request that died.
 */
export const APPLY_CLAIM_TTL_MS = 5 * 60 * 1000

const staleBefore = (now = Date.now()) => new Date(now - APPLY_CLAIM_TTL_MS)

const claimIsLive = (row: ProposedChangeRow, now = Date.now()) =>
  row.applyingSince !== null && row.applyingSince.getTime() >= now - APPLY_CLAIM_TTL_MS

export interface CreateProposalInput {
  projectId: string
  kind: ProposedChangeKind
  /** The contract's payload for `kind`; parsed here. */
  payload: unknown
  /** The turn's conversation, from the signed envelope; null for a turn outside one. */
  conversationId: string | null
  answerMessageId: string | null
  /** Which card of that answer; with `answerMessageId` the create is idempotent. */
  originCardIndex?: number | null
}

/**
 * File Piloti's proposal on behalf of `session`'s person, in a project they can
 * read. Proposing changes nothing, so reading is enough; deciding takes the
 * kind's write. The same card of the same answer a second time returns the
 * first proposal as it stands, and tells nobody again.
 */
export async function createProposal(session: AuthorizedSession, input: CreateProposalInput): Promise<ProposedChangeRow> {
  await requireProjectAccess(session, input.projectId, 'project:view')
  const typed = parseKindPayload(input.kind, input.payload)
  requireProposable(typed)
  if (input.conversationId) {
    const conversation = await findConversationInOrg(input.conversationId, session.organizationId)
    if (!conversation) throw new NotFoundError('Conversation not found')
  }
  const { row, created } = await insertProposedChange({
    organizationId: session.organizationId,
    projectId: input.projectId,
    kind: typed.kind,
    payload: typed.payload,
    proposedByKind: 'piloti',
    onBehalfOf: session.userId,
    originConversationId: input.conversationId,
    originMessageId: input.answerMessageId,
    originCardIndex: input.answerMessageId ? (input.originCardIndex ?? null) : null,
  })
  if (!created) {
    // The card's key is (answer, card index), and the answer id comes from the
    // request: a repeat may only get back ITS OWN first proposal. One filed for
    // another project, conversation or kind is somebody else's, never returned.
    if (
      row.projectId !== input.projectId ||
      row.originConversationId !== input.conversationId ||
      row.kind !== typed.kind
    ) {
      throw new ConflictError('This card already names another proposal', { reason: 'proposal-card-taken' })
    }
    return row
  }
  auditProposalCreated(session, row, typed)
  bestEffort('attention (created)', () =>
    onProposalCreated({
      organizationId: row.organizationId,
      projectId: row.projectId,
      proposalId: row.id,
      originConversationId: row.originConversationId,
      onBehalfOf: row.onBehalfOf,
      summary: summaryOf(typed),
      variant: noticeVariantOf(typed),
    })
  )
  return row
}

/** Run a side effect of a write that has committed, and never let it reach the write: a failure is logged. */
function bestEffort(what: string, run: () => Promise<unknown>): void {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      console.warn(`[proposals] ${what} failed (non-fatal):`, error)
    })
}

/**
 * What follows a committed decision. A fully or partly applied proposal is
 * `accepted` and a dismissed one `dismissed`; one where nothing went through
 * (`failed`) was neither taken nor refused, so it is not scored.
 */
function afterDecision(session: AuthorizedSession, row: ProposedChangeRow): void {
  const status = row.status
  if (status === 'proposed') return
  bestEffort('live publish', () => publishProposalDecided(row.id, status))
  bestEffort('attention (decided)', () => onProposalDecided({ organizationId: row.organizationId, proposalId: row.id }))
  auditProposalDecided(session, row)
  const decision: Decision | null =
    status === 'dismissed' ? 'dismissed' : status === 'failed' ? null : 'accepted'
  if (!decision) return
  bestEffort('decision score', () =>
    recordDecisionScore({
      organizationId: row.organizationId,
      subject: 'proposal',
      subjectId: row.id,
      decision,
      decidedBy: session.userId,
      origin:
        row.originConversationId && row.originMessageId
          ? { conversationId: row.originConversationId, messageId: row.originMessageId }
          : null,
    })
  )
}

/** The proposal, if `session` may read it; a 404 for "missing" and "not yours" alike. */
export async function requireReadableProposal(session: AuthorizedSession, id: string): Promise<ProposedChangeRow> {
  const row = await findProposedChange(session.organizationId, id)
  if (!row) throw new NotFoundError()
  await requireProjectAccess(session, row.projectId, 'project:view')
  if (row.originConversationId) {
    await requireResourceAccess(session, 'conversation', row.originConversationId, 'viewer')
  }
  return row
}

/** Whether `session` holds the right this kind is decided with; a closed project or no grant is a no. */
async function mayDecide(session: AuthorizedSession, row: ProposedChangeRow): Promise<boolean> {
  try {
    await requireProjectAccess(session, row.projectId, DECIDE_PERMISSIONS[row.kind])
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/** Refuse a decision from a reader without the kind's right: 403, or the closed project's own 403. */
async function requireDecider(session: AuthorizedSession, row: ProposedChangeRow): Promise<void> {
  try {
    await requireProjectAccess(session, row.projectId, DECIDE_PERMISSIONS[row.kind])
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ForbiddenError('Only someone who may make this change in the project can decide this proposal', {
        reason: 'proposal-decider-needs-write',
        kind: row.kind,
      })
    }
    throw error
  }
}

const alreadyDecided = (row: ProposedChangeRow) =>
  new ConflictError('This proposal has already been decided', { reason: 'proposal-decided', status: row.status })

const beingApplied = () => new ConflictError('This proposal is being applied', { reason: 'proposal-applying' })

async function toView(session: AuthorizedSession, row: ProposedChangeRow): Promise<ProposedChangeView> {
  const directory = await loadOrganizationDirectory(session.organizationId)
  const nameOf = (userId: string | null) => (userId ? (directory.get(userId)?.name ?? null) : null)
  const undecided = row.status === 'proposed' && !claimIsLive(row)
  return {
    ...parseKindPayload(row.kind, row.payload),
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    proposedByKind: row.proposedByKind,
    onBehalfOf: row.onBehalfOf,
    onBehalfOfName: nameOf(row.onBehalfOf),
    originConversationId: row.originConversationId,
    originMessageId: row.originMessageId,
    createdAt: row.createdAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedByName: nameOf(row.decidedBy),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    results: row.results ?? null,
    canDecide: undecided && (await mayDecide(session, row)),
  }
}

export async function getProposal(session: AuthorizedSession, id: string): Promise<ProposedChangeView> {
  return toView(session, await requireReadableProposal(session, id))
}

const outcomeOf = (results: readonly ProposedChangeResult[]) => {
  const applied = results.filter((result) => result.ok).length
  if (applied === results.length) return 'applied' as const
  return applied === 0 ? ('failed' as const) : ('partially_applied' as const)
}

/** What the deciding person brings to an apply besides their session. */
export interface ApplyProposalOptions extends ApplyProposalRequest {
  /** Their language, for a refusal they read (the profile's confinement). */
  locale?: Locale
}

/**
 * Apply the proposal as `session`'s person: claim it, run the kind's applier,
 * record each result, settle. 409 when it is no longer `proposed` or somebody
 * is applying it right now. `memoryScope: 'project'` files an organization
 * note in the project instead; other kinds ignore it.
 */
export async function applyProposal(
  session: AuthorizedSession,
  id: string,
  request: Request,
  options: ApplyProposalOptions = {}
): Promise<ProposedChangeView> {
  const row = await requireReadableProposal(session, id)
  if (row.status !== 'proposed') throw alreadyDecided(row)
  await requireDecider(session, row)
  const claim = await claimProposedChange(session.organizationId, id, session.userId, staleBefore())
  if (!claim) {
    const now = await findProposedChange(session.organizationId, id)
    throw now && now.status === 'proposed' ? beingApplied() : alreadyDecided(now ?? row)
  }
  let results: ProposedChangeResult[]
  try {
    results = await applyKind(parseKindPayload(claim.kind, claim.payload), {
      session,
      projectId: claim.projectId,
      request,
      originConversationId: claim.originConversationId,
      locale: options.locale ?? defaultLocale,
      memoryScope: options.memoryScope,
    })
  } catch (error) {
    await releaseProposedChange(session.organizationId, claim)
    throw error
  }
  const settled = await settleProposedChange(session.organizationId, claim, { status: outcomeOf(results), results })
  // Only reachable when this apply outlived its claim and somebody else decided
  // in the meantime: the items ran, and the record belongs to the other decision.
  if (!settled) throw new ConflictError('This proposal was decided while it was being applied', { reason: 'proposal-decided' })
  afterDecision(session, settled)
  return toView(session, settled)
}

/** Dismiss the proposal as `session`'s person. 409 when it is no longer `proposed` or is being applied. */
export async function dismissProposal(session: AuthorizedSession, id: string): Promise<ProposedChangeView> {
  const row = await requireReadableProposal(session, id)
  if (row.status !== 'proposed') throw alreadyDecided(row)
  await requireDecider(session, row)
  const dismissed = await dismissProposedChange(session.organizationId, id, session.userId, staleBefore())
  if (!dismissed) {
    const now = await findProposedChange(session.organizationId, id)
    throw now && now.status === 'proposed' ? beingApplied() : alreadyDecided(now ?? row)
  }
  afterDecision(session, dismissed)
  return toView(session, dismissed)
}
