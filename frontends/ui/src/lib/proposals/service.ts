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
 * - **Deciding** (apply, dismiss) takes the read, plus write access to the
 *   project's documents (`project:documents:write`, or the older
 *   `project:edit`); a reader without it gets a 403. A closed project is
 *   read-only and refuses with its own 403.
 * - **After a decision** (committed, never awaited, never failing it) three
 *   things follow: the live channel `proposal:<id>` hears of it, so every open
 *   card re-reads (`lib/realtime/proposal-channel.ts`); the inbox is told
 *   nothing waits any more (`./attention`); and the decision is a score on the
 *   trace of the turn that proposed it (`lib/langfuse/decision-score.ts`).
 * - **Applying** runs each item through the document, folder and assignment
 *   services in the DECIDING person's session (`./executors`), so every check
 *   they make by hand is made again. It is a compare-and-swap on `proposed`:
 *   the claim is committed before the first item runs and the settle clears
 *   it, so a double click or a second tab is a 409.
 */

import 'server-only'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { DOCUMENT_WRITE_PERMISSIONS } from '@/lib/authz/folder-access-rule'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { recordDecisionScore, type Decision } from '@/lib/langfuse/decision-score'
import { onProposalCreated, onProposalDecided } from './attention'
import { applyFileOperations, operationLabel, REQUIRED_FIELDS } from './executors'
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
import {
  fileOperationPayloadSchema,
  type FileOperationPayload,
  type ProposedChangeKind,
  type ProposedChangeResult,
  type ProposedChangeView,
} from './types'

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
  payload: FileOperationPayload
  /** The turn's conversation, from the signed envelope; null for a turn outside one. */
  conversationId: string | null
  answerMessageId: string | null
}

/** Every item carries the fields its verb needs, or the proposal is refused (422). */
function requireItemFields(payload: FileOperationPayload): void {
  const required = REQUIRED_FIELDS[payload.operation]
  payload.operations.forEach((item, index) => {
    const missing = required.filter((field) => {
      const value = item[field]
      return typeof value !== 'string' || value.trim().length === 0
    })
    if (missing.length > 0) {
      throw new UnprocessableError(`Item ${index + 1} of a ${payload.operation} lacks ${missing.join(', ')}`, {
        reason: 'proposal-item-incomplete',
        index,
        missing,
      })
    }
  })
}

/**
 * File Piloti's proposal on behalf of `session`'s person, in a project they can
 * read. Proposing changes nothing, so reading is enough; deciding takes write.
 */
export async function createProposal(session: AuthorizedSession, input: CreateProposalInput): Promise<ProposedChangeRow> {
  await requireProjectAccess(session, input.projectId, 'project:view')
  const payload = fileOperationPayloadSchema.parse(input.payload)
  requireItemFields(payload)
  if (input.conversationId) {
    const conversation = await findConversationInOrg(input.conversationId, session.organizationId)
    if (!conversation) throw new NotFoundError('Conversation not found')
  }
  const row = await insertProposedChange({
    organizationId: session.organizationId,
    projectId: input.projectId,
    kind: input.kind,
    payload,
    proposedByKind: 'piloti',
    onBehalfOf: session.userId,
    originConversationId: input.conversationId,
    originMessageId: input.answerMessageId,
  })
  bestEffort('attention (created)', () =>
    onProposalCreated({
      organizationId: row.organizationId,
      projectId: row.projectId,
      proposalId: row.id,
      originConversationId: row.originConversationId,
      onBehalfOf: row.onBehalfOf,
      summary: summaryOf(payload),
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

/** How many names the inbox row lists before it counts the rest. */
const SUMMARY_NAMES = 2

/** One line naming what a proposal touches: the first names, then how many more. No verb, so it needs no language. */
function summaryOf(payload: FileOperationPayload): string {
  const names = payload.operations.map((item) => operationLabel(payload.operation, item)).filter(Boolean)
  const shown = names.slice(0, SUMMARY_NAMES).join(', ')
  return names.length > SUMMARY_NAMES ? `${shown} +${names.length - SUMMARY_NAMES}` : shown
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

/** Whether `session` may change the project's documents; a closed project or no grant is a no. */
async function mayDecide(session: AuthorizedSession, projectId: string): Promise<boolean> {
  try {
    await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS)
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/** Refuse a decision from a reader who may not write here: 403, or the closed project's own 403. */
async function requireDecider(session: AuthorizedSession, projectId: string): Promise<void> {
  try {
    await requireProjectAccess(session, projectId, DOCUMENT_WRITE_PERMISSIONS)
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ForbiddenError("Only someone who may change this project's documents can decide a proposal", {
        reason: 'proposal-decider-needs-write',
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
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    payload: fileOperationPayloadSchema.parse(row.payload),
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
    canDecide: undecided && (await mayDecide(session, row.projectId)),
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

/**
 * Apply the proposal as `session`'s person: claim it, run every item in order
 * through the services, record each result, settle. 409 when it is no longer
 * `proposed` or somebody is applying it right now.
 */
export async function applyProposal(
  session: AuthorizedSession,
  id: string,
  request: Request
): Promise<ProposedChangeView> {
  const row = await requireReadableProposal(session, id)
  if (row.status !== 'proposed') throw alreadyDecided(row)
  await requireDecider(session, row.projectId)
  const claim = await claimProposedChange(session.organizationId, id, session.userId, staleBefore())
  if (!claim) {
    const now = await findProposedChange(session.organizationId, id)
    throw now && now.status === 'proposed' ? beingApplied() : alreadyDecided(now ?? row)
  }
  let results: ProposedChangeResult[]
  try {
    const payload = fileOperationPayloadSchema.parse(claim.payload)
    results = await applyFileOperations(payload.operation, payload.operations, {
      session,
      projectId: claim.projectId,
      request,
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
  await requireDecider(session, row.projectId)
  const dismissed = await dismissProposedChange(session.organizationId, id, session.userId, staleBefore())
  if (!dismissed) {
    const now = await findProposedChange(session.organizationId, id)
    throw now && now.status === 'proposed' ? beingApplied() : alreadyDecided(now ?? row)
  }
  afterDecision(session, dismissed)
  return toView(session, dismissed)
}
