/**
 * The decided `proposed_changes` of a project, for the PROPOSAL_DECISIONS block
 * (`./proposal-decisions.ts`): what people decided about Piloti's proposals,
 * read from the SERVER's record rather than from a browser's (ADR-0105).
 *
 * No authorization here, and not for a person: the block it feeds rides every
 * member's chat, so the exclusions are the ones the message query makes
 * (`listRecentMessagesWithCardDecisions`), from the same predicate.
 *
 * - A row is read through the conversation it was made in. That conversation
 *   must still exist (a deleted one takes its decisions with it, as it takes
 *   its card decisions), and must not have drawn on a restricted folder or on
 *   another project still restricting its readers.
 * - A row with NO origin conversation is left out. Restricted use is recorded
 *   per conversation (`conversation_restricted_folders`), so a turn with no
 *   conversation leaves nothing to check the row against, and a payload names
 *   files and folders. Failing closed costs the block a decision from a run
 *   that had no conversation; failing open could tell the office what a
 *   restricted folder holds.
 * - `proposed` is not a decision, and `failed` is left out: nothing went
 *   through, the reader did not say no, and the prompt knows two verdicts only
 *   (`angenommen` / `abgelehnt`). Piloti may propose it again.
 */

import 'server-only'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { conversations, proposedChanges } from '@/lib/db/schema'
import { conversationOpenToProjectReaders } from '@/lib/conversations/repository'

/** The statuses that are a decision the block can state. */
export const DECIDED_PROPOSAL_STATUSES = ['applied', 'partially_applied', 'dismissed'] as const
export type DecidedProposalStatus = (typeof DECIDED_PROPOSAL_STATUSES)[number]

export interface DecidedProposalRow {
  id: string
  kind: string
  status: DecidedProposalStatus
  /** Unvalidated jsonb: the consumer reads it defensively. */
  payload: unknown
  decidedAt: Date
}

const isDecidedStatus = (status: string): status is DecidedProposalStatus =>
  (DECIDED_PROPOSAL_STATUSES as readonly string[]).includes(status)

/**
 * The most recent decided proposals of one project, newest decision first,
 * bounded by `limit`. The caller is in the organization's tenant scope; the
 * organization is in the WHERE as well.
 */
export async function listRecentDecidedProposals(
  projectId: string,
  organizationId: string,
  limit: number,
  db: DbExecutor = getDb(),
): Promise<DecidedProposalRow[]> {
  const rows = await db
    .select({
      id: proposedChanges.id,
      kind: proposedChanges.kind,
      status: proposedChanges.status,
      payload: proposedChanges.payload,
      decidedAt: proposedChanges.decidedAt,
    })
    .from(proposedChanges)
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, proposedChanges.originConversationId),
        eq(conversations.organizationId, proposedChanges.organizationId),
      ),
    )
    .where(
      and(
        eq(proposedChanges.organizationId, organizationId),
        eq(proposedChanges.projectId, projectId),
        // The status is a closed set in the schema; the statement says which of
        // it counts, so a status added later is not read as a decision unasked.
        inArray(proposedChanges.status, [...DECIDED_PROPOSAL_STATUSES]),
        isNull(conversations.deletedAt),
        conversationOpenToProjectReaders(),
      ),
    )
    .orderBy(desc(proposedChanges.decidedAt), desc(proposedChanges.id))
    .limit(limit)
  // Raw column values are not runtime-validated — coerce at the boundary.
  return rows.flatMap((row) =>
    isDecidedStatus(row.status) && row.decidedAt
      ? [
          {
            id: String(row.id),
            kind: String(row.kind),
            status: row.status,
            payload: row.payload,
            decidedAt: new Date(row.decidedAt),
          },
        ]
      : [],
  )
}
