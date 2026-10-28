/**
 * A person's decision on a mark Piloti proposed, in the organization's audit
 * trail (`piloti.mark.decided`; the catalog and the actor model are in
 * `lib/audit/schemas.mjs`).
 *
 * Piloti's own findings are born `proposed`, and a person on the canvas takes
 * one over (`open`, theirs from then on) or dismisses it: the per-mark buttons
 * and the live card's batch send the same PATCH, one mark each, so this is one
 * event per mark that left `proposed`. The actor is the person who decided;
 * `onBehalfOf` the person Piloti proposed it for. The mark's number and kind
 * only, never what it says.
 */

import 'server-only'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { AnnotationRecord } from './repository'

/** What the person did with the proposal. */
export type MarkDecision = 'taken_over' | 'dismissed'

/** The decision on a proposed mark, after the move committed. Never throws. */
export function auditMarkDecided(
  session: AuthorizedSession,
  doc: { id: string; projectId: string | null },
  mark: Pick<AnnotationRecord, 'id' | 'number' | 'kind' | 'createdBy'>,
  decision: MarkDecision
): void {
  recordAuditEventAfterCommit({
    action: 'piloti.mark.decided',
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'document_annotation',
    targetId: mark.id,
    alsoTargets: [
      { type: 'document', id: doc.id },
      { type: 'project', id: doc.projectId },
    ],
    metadata: { decision, markNumber: mark.number, markKind: mark.kind, onBehalfOf: mark.createdBy },
  })
}
