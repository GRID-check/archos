/**
 * The change record — the rules (ADR-0109; `docs/architecture/document-annotations.md`).
 *
 * Every change Piloti APPLIES to an Anmerkung or a thread is one row with the
 * turn that made it. This module writes those rows for `lib/annotations/agent.ts`,
 * reads them back for a turn's card, and undoes one.
 *
 * - **Recording** happens right after the annotations service committed the
 *   change: that service runs its own transactions and offers its callers no
 *   hook into them, so the record cannot share one. A record that fails is
 *   logged, not thrown: the change itself landed, and failing the request
 *   would make the turn try it again. A turn without an answer id (an older
 *   agent) records nothing.
 * - **Reading** takes `viewer` on the conversation the turn ran in, and
 *   reading each change's document through the annotations read gate
 *   (`listAnnotations`, which reads the document through `getAccessibleDocument`):
 *   changes on a document the reader may not see are left out, silently.
 * - **Undo** is the same read, then a compare-and-swap against what Piloti left
 *   (`./undo`), then the inverse THROUGH THE ANNOTATIONS SERVICE as the person
 *   clicking, so every rule a person's own edit meets is met again. The undo
 *   is claimed on `undone_at IS NULL` before the inverse runs and given back if
 *   the inverse fails, so two undos at once leave one.
 */

import 'server-only'
import { ApiError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { createAnnotation, deleteAnnotation, deleteReply, listAnnotations, updateAnnotation } from '@/lib/annotations/service'
import type { AnnotationView } from '@/lib/annotations/types'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  claimUndo,
  findPilotiChange,
  insertPilotiChanges,
  listTurnChangeRows,
  releaseUndo,
  type NewPilotiChange,
  type PilotiChangeRow,
} from './repository'
import { auditAppliedChanges, auditUndoneChange } from './audit'
import { planUndo, type UndoPlan } from './undo'
import type { ChangeState, PilotiChangeObject, PilotiChangeOp, PilotiChangeView, UndoRefusal } from './types'

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** The turn a change was made in, from the verified envelope and the tool's body. */
export interface ChangeOrigin {
  organizationId: string
  documentId: string
  conversationId: string
  /** The answer message the turn writes; null from an agent older than the record. */
  answerMessageId: string | null
  /** The person the turn acted for. */
  onBehalfOf: string
  /** Their email, the name the audit trail shows for them. */
  onBehalfOfEmail?: string | null
  /** The document's project; null on the Büroablage. */
  projectId?: string | null
}

/** One change a call applied. */
export interface AppliedChange {
  objectKind: PilotiChangeObject
  objectId: string
  annotationId: string
  op: PilotiChangeOp
  before: ChangeState | null
  after: ChangeState | null
  /** The mark's running number, for the audit trail. */
  annotationNumber?: number | null
}

let warnedWithoutAnswer = false

/**
 * Record what one of Piloti's calls applied, after it committed: a
 * `piloti_changes` row each, then a `piloti.change.applied` audit event each
 * (`./audit`). Never throws: the change already stands.
 */
export async function recordPilotiChanges(origin: ChangeOrigin, changes: readonly AppliedChange[]): Promise<void> {
  if (changes.length === 0) return
  const rows = await insertLedgerRows(origin, changes)
  auditAppliedChanges(
    {
      organizationId: origin.organizationId,
      documentId: origin.documentId,
      projectId: origin.projectId ?? null,
      conversationId: origin.conversationId,
      answerMessageId: origin.answerMessageId,
      onBehalfOf: origin.onBehalfOf,
      onBehalfOfEmail: origin.onBehalfOfEmail ?? null,
    },
    changes.map((change) => ({
      objectKind: change.objectKind,
      op: change.op,
      annotationId: change.annotationId,
      annotationNumber: change.annotationNumber ?? null,
      before: change.before,
      after: change.after,
      // One call changes each object once, so the object names its row.
      changeId: rows.find((row) => row.objectId === change.objectId)?.id ?? null,
    }))
  )
}

/**
 * The ledger rows written; none from an agent older than
 * the record (no answer id), and none when the insert failed. The change was
 * applied either way, so the audit trail still hears of it.
 */
async function insertLedgerRows(origin: ChangeOrigin, changes: readonly AppliedChange[]): Promise<PilotiChangeRow[]> {
  if (!origin.answerMessageId) {
    if (!warnedWithoutAnswer) {
      warnedWithoutAnswer = true
      console.warn('[changes] a write op arrived without answerMessageId; an agent older than ADR-0109 records nothing')
    }
    return []
  }
  const rows: NewPilotiChange[] = changes.map((change) => ({
    organizationId: origin.organizationId,
    documentId: origin.documentId,
    annotationId: change.annotationId,
    objectKind: change.objectKind,
    objectId: change.objectId,
    op: change.op,
    before: change.before,
    after: change.after,
    originConversationId: origin.conversationId,
    originMessageId: origin.answerMessageId as string,
    onBehalfOf: origin.onBehalfOf,
  }))
  try {
    return await insertPilotiChanges(origin.organizationId, rows)
  } catch (error) {
    console.error('[changes] could not record what the turn applied', origin.answerMessageId, error)
    return []
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A document's marks as this reader sees them, or null when the reader may not see the document. */
interface DocumentMarks {
  marks: ReadonlyMap<string, AnnotationView>
  /** The reader may set a mark here (what re-setting a deleted one takes). */
  canAnnotate: boolean
}

async function readDocumentMarks(session: AuthorizedSession, documentId: string): Promise<DocumentMarks | null> {
  try {
    const { annotations, canAnnotate } = await listAnnotations(session, documentId)
    return { marks: new Map(annotations.map((mark) => [mark.id, mark])), canAnnotate }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null
    throw error
  }
}

type Names = ReadonlyMap<string, { name: string }>

const nameOf = (names: Names, userId: string | null) => (userId ? (names.get(userId)?.name ?? null) : null)

/** Whether this reader could run the plan: the service would refuse them otherwise. */
function mayRun(plan: UndoPlan, marks: DocumentMarks, current: AnnotationView | undefined, userId: string): boolean {
  switch (plan.kind) {
    case 'recreate':
      return marks.canAnnotate
    case 'delete':
      return Boolean(current?.canDelete)
    case 'delete-reply':
      // A reply goes only for the person it was posted for (`deleteReply`).
      return Boolean(current?.canEdit && current.replies.some((r) => r.id === plan.replyId && r.createdBy === userId))
    default:
      return Boolean(current?.canEdit)
  }
}

function toView(row: PilotiChangeRow, marks: DocumentMarks, names: Names, userId: string): PilotiChangeView {
  const current = marks.marks.get(row.annotationId)
  const outcome = row.undoneAt ? null : planUndo(row, current)
  return {
    id: row.id,
    documentId: row.documentId,
    annotationId: row.annotationId,
    annotationNumber: current?.number ?? null,
    objectKind: row.objectKind,
    objectId: row.objectId,
    op: row.op,
    before: row.before ?? null,
    after: row.after ?? null,
    onBehalfOf: row.onBehalfOf,
    onBehalfOfName: nameOf(names, row.onBehalfOf),
    createdAt: row.createdAt.toISOString(),
    undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
    undoneBy: row.undoneBy,
    undoneByName: nameOf(names, row.undoneBy),
    canUndo: outcome !== null && 'plan' in outcome && mayRun(outcome.plan, marks, current, userId),
  }
}

/** The rows as this reader sees them, oldest first; rows on documents they may not see are left out. */
async function viewsFor(session: AuthorizedSession, rows: readonly PilotiChangeRow[]): Promise<PilotiChangeView[]> {
  const documents = new Map<string, DocumentMarks | null>()
  for (const documentId of new Set(rows.map((row) => row.documentId))) {
    documents.set(documentId, await readDocumentMarks(session, documentId))
  }
  const names: Names = await loadOrganizationDirectory(session.organizationId).catch(() => new Map())
  return rows.flatMap((row) => {
    const marks = documents.get(row.documentId)
    return marks ? [toView(row, marks, names, session.userId)] : []
  })
}

/** What the turn behind answer `messageId` in `conversationId` changed, as it stands now, for this reader. */
export async function listTurnChanges(
  session: AuthorizedSession,
  conversationId: string,
  messageId: string
): Promise<PilotiChangeView[]> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
  const rows = await listTurnChangeRows(session.organizationId, conversationId, messageId)
  return viewsFor(session, rows)
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

const REFUSAL_MESSAGES: Record<UndoRefusal, string> = {
  'moved-on': 'This is no longer as Piloti left it, so undoing it would undo somebody else’s change.',
  'already-undone': 'Somebody undid this already.',
}

/** 409 with the refusal the card names (`moved-on`, `already-undone`); the route puts it on the wire. */
export class UndoRefusedError extends ConflictError {
  constructor(
    readonly refusal: UndoRefusal,
    message = REFUSAL_MESSAGES[refusal]
  ) {
    super(message, { reason: refusal })
  }
}

/** The change, if this reader may see it: its conversation and its document. A 404 for "missing" and "not yours" alike. */
async function loadReadable(
  session: AuthorizedSession,
  id: string
): Promise<{ row: PilotiChangeRow; marks: DocumentMarks }> {
  const row = await findPilotiChange(session.organizationId, id)
  if (!row) throw new NotFoundError()
  await requireResourceAccess(session, 'conversation', row.originConversationId, 'viewer')
  const marks = await readDocumentMarks(session, row.documentId)
  if (!marks) throw new NotFoundError()
  return { row, marks }
}

/** Run the inverse through the annotations service, as the person clicking. */
async function runPlan(session: AuthorizedSession, row: PilotiChangeRow, plan: UndoPlan): Promise<void> {
  switch (plan.kind) {
    case 'dismiss':
    case 'revert':
      await updateAnnotation(session, row.documentId, row.annotationId, plan.request)
      return
    case 'recreate': {
      const { annotation } = await createAnnotation(session, row.documentId, plan.mark)
      if (plan.status === 'resolved') {
        await updateAnnotation(session, row.documentId, annotation.id, { status: 'resolved', expectedStatus: 'open' })
      }
      return
    }
    case 'delete':
      await deleteAnnotation(session, row.documentId, row.annotationId)
      return
    case 'delete-reply':
      await deleteReply(session, row.documentId, row.annotationId, plan.replyId, { expectedBody: plan.expectedBody })
      return
  }
}

/** A failure of the inverse that means the object moved under it: a stale status, or a mark gone meanwhile. */
const movedUnderneath = (error: unknown) => error instanceof ConflictError || error instanceof NotFoundError

/**
 * Undo one change as `session`'s person, while the object is still as Piloti
 * left it. 409 `already-undone` / `moved-on` otherwise; 403 for a reader who
 * may not edit the mark.
 */
export async function undoChange(session: AuthorizedSession, id: string): Promise<PilotiChangeView> {
  const { row, marks } = await loadReadable(session, id)
  if (row.undoneAt) throw new UndoRefusedError('already-undone')
  const current = marks.marks.get(row.annotationId)
  const outcome = planUndo(row, current)
  if ('refused' in outcome) throw new UndoRefusedError('moved-on', outcome.message)
  if (!mayRun(outcome.plan, marks, current, session.userId)) throw new ForbiddenError('You may not change this Anmerkung.')

  const claim = await claimUndo(session.organizationId, row.id, session.userId)
  if (!claim) throw new UndoRefusedError('already-undone')
  try {
    await runPlan(session, row, outcome.plan)
  } catch (error) {
    await releaseUndo(session.organizationId, claim)
    if (movedUnderneath(error)) throw new UndoRefusedError('moved-on')
    throw error
  }
  auditUndoneChange(session, row, outcome.plan, current?.number ?? null)

  // One decision, one score. Dismissing a proposal is the annotations service's
  // own decision, and it scores `annotation dismissed` on the same trace; a
  // second `change undone` for it would count one decision twice.
  if (outcome.plan.kind !== 'dismiss') {
    await recordDecisionScore({
      organizationId: session.organizationId,
      subject: 'change',
      subjectId: row.id,
      decision: 'undone',
      decidedBy: session.userId,
      origin: { conversationId: row.originConversationId, messageId: row.originMessageId },
    }).catch((error: unknown) => console.warn('[changes] could not score the undo', row.id, error))
  }

  const [view] = await viewsFor(session, [claim])
  if (!view) throw new NotFoundError()
  return view
}
