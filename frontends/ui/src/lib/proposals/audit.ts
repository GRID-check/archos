/**
 * Piloti's proposed changes in the organization's audit trail
 * (`piloti.proposal.created`, `piloti.proposal.decided`; the catalog and the
 * actor model are in `lib/audit/schemas.mjs`).
 *
 * The row is the system of record and the card reads it; the trail is what an
 * admin reads in the WorkOS viewer. The kind, the file verb, counts and the
 * memory scope only: no name, path, note or profile value of the payload.
 */

import 'server-only'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import { parseKindPayload, type KindPayload } from './kinds'
import type { ProposedChangeRow } from './repository'

const NO_FACTS = { operation: null, items: null, memoryScope: null }

/** What the payload may say in the trail: its shape, never its words. */
function payloadFacts(typed: KindPayload) {
  switch (typed.kind) {
    case 'file_operation':
      return {
        operation: typed.payload.operation,
        items: typed.payload.operations.length,
        memoryScope: null,
      }
    case 'memory':
      return { operation: null, items: 1, memoryScope: typed.payload.scope }
    case 'project_profile':
      return { operation: null, items: typed.payload.patch.length, memoryScope: null }
  }
}

/** The stored payload's facts; none when it no longer parses, which must not cost the decision its line. */
function storedFacts(row: ProposedChangeRow) {
  try {
    return payloadFacts(parseKindPayload(row.kind, row.payload))
  } catch {
    return NO_FACTS
  }
}

const proposalTargets = (row: ProposedChangeRow) => [
  { type: 'project', id: row.projectId },
  { type: 'conversation', id: row.originConversationId },
]

/** `piloti.proposal.created`, for a proposal this call filed (never for a repeated card). Never throws. */
export function auditProposalCreated(
  session: AuthorizedSession,
  row: ProposedChangeRow,
  typed: KindPayload
): void {
  const facts = payloadFacts(typed)
  recordAuditEventAfterCommit({
    action: 'piloti.proposal.created',
    organizationId: row.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'proposed_change',
    targetId: row.id,
    alsoTargets: proposalTargets(row),
    metadata: {
      kind: row.kind,
      operation: facts.operation,
      items: facts.items,
      memoryScope: facts.memoryScope,
      messageId: row.originMessageId,
    },
  })
}

/**
 * `piloti.proposal.decided`, for the decision this call committed. The scope
 * an applied note went into is the one its result records (the decider may
 * have kept an office note in the project); otherwise the one proposed.
 * Never throws.
 */
export function auditProposalDecided(session: AuthorizedSession, row: ProposedChangeRow): void {
  const facts = storedFacts(row)
  const results = row.results ?? []
  recordAuditEventAfterCommit({
    action: 'piloti.proposal.decided',
    organizationId: row.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'proposed_change',
    targetId: row.id,
    alsoTargets: proposalTargets(row),
    metadata: {
      kind: row.kind,
      decision: row.status,
      operation: facts.operation,
      items: facts.items,
      appliedItems: row.status === 'dismissed' ? 0 : results.filter((result) => result.ok).length,
      memoryScope: results.find((result) => result.scope)?.scope ?? facts.memoryScope,
      onBehalfOf: row.onBehalfOf,
      messageId: row.originMessageId,
    },
  })
}
