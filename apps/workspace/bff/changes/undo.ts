/**
 * What undoing one recorded change would do, decided against the object as
 * it stands now (ADR-0109): a compare-and-swap, never a replay.
 *
 * First the compare: the object must still be as Piloti left it (`after`, on
 * the fields the change recorded), or, for a delete, still gone. Anything else
 * is `moved-on`, so a colleague's later change is never undone. Then the
 * inverse, expressed as a call a PERSON could make through the annotations
 * service, because undo runs as the person clicking:
 *
 * - a mark Piloti proposed (`create`, born `proposed`) is dismissed. Piloti's
 *   marks are dismissed, never deleted (`deleteAnnotation`);
 * - a mark Piloti set OPEN for the asker is deleted, which the person it was
 *   set for may do like their own mark (`deleteAnnotation`). Only while nobody
 *   but Piloti has written in its thread: a colleague's answer is theirs, and
 *   deleting the mark would take it along, so that is `moved-on`;
 * - a change (`update`) is reverted field by field with `expectedStatus` = the
 *   status Piloti left; a status that cannot move back (to `proposed`, or a
 *   move the state machine has no way for) has no inverse;
 * - a deleted mark is set again with what `before` recorded, and resolved
 *   again if it was. It comes back with a new number and without its thread;
 * - a reply is deleted (`deleteReply`) while it still says what Piloti wrote,
 *   by the person it was posted for.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import { transition } from '@/lib/annotations/service'
import {
  createAnnotationRequestSchema,
  updateAnnotationRequestSchema,
  type AnnotationView,
  type CreateAnnotationRequest,
  type UpdateAnnotationRequest,
} from '@/lib/annotations/types'
import type { AgentChangeRow } from './repository'
import { matchesState } from './state'
import { PRODUCT_NAME } from '@/lib/brand'

export type UndoPlan =
  /** Dismiss a proposal Piloti made. */
  | { kind: 'dismiss'; request: UpdateAnnotationRequest }
  /** Put the fields a change moved back as they were. */
  | { kind: 'revert'; request: UpdateAnnotationRequest }
  /** Set a deleted mark again, resolved again if it was. */
  | { kind: 'recreate'; mark: CreateAnnotationRequest; status: 'open' | 'resolved' }
  /** Delete a mark Piloti set open for the asker. */
  | { kind: 'delete' }
  /** Delete a reply Piloti posted, while it still says what Piloti wrote. */
  | { kind: 'delete-reply'; replyId: string; expectedBody: string }

export type UndoOutcome = { plan: UndoPlan } | { refused: 'moved-on'; message: string }

const movedOn = (message = 'This is no longer as ' + PRODUCT_NAME + ' left it.'): UndoOutcome => ({ refused: 'moved-on', message })
const noWayBack = (message: string): UndoOutcome => ({ refused: 'moved-on', message })

/** The fields a person's PATCH can put back. */
const REVERTIBLE = ['status', 'kind', 'body', 'basis', 'assigneeUserId', 'dueOn'] as const

/** Whether the state machine has a move from the mark's status now back to `to`. */
function canMoveBack(current: AnnotationView, to: unknown): to is 'open' | 'resolved' | 'dismissed' {
  if (to !== 'open' && to !== 'resolved' && to !== 'dismissed') return false
  try {
    transition(current.status, to, current, current.createdBy, new Date())
    return true
  } catch (error) {
    if (error instanceof ApiError) return false
    throw error
  }
}

function undoCreate(row: AgentChangeRow, current: AnnotationView | undefined): UndoOutcome {
  if (!current || !row.after || !matchesState(current, row.after)) return movedOn()
  if (current.status === 'proposed') {
    return { plan: { kind: 'dismiss', request: { status: 'dismissed', expectedStatus: 'proposed' } } }
  }
  if (current.status !== 'open') return movedOn()
  if (current.replies.some((reply) => reply.authorKind !== 'piloti')) {
    return noWayBack('Somebody has answered in this thread, so taking the mark back would delete their answer.')
  }
  return { plan: { kind: 'delete' } }
}

function undoReply(row: AgentChangeRow, current: AnnotationView | undefined): UndoOutcome {
  const body = row.after?.body
  if (row.op !== 'create' || typeof body !== 'string') return noWayBack('This answer cannot be taken back.')
  const reply = current?.replies.find((candidate) => candidate.id === row.objectId)
  if (!reply || reply.body !== body) return movedOn()
  return { plan: { kind: 'delete-reply', replyId: reply.id, expectedBody: body } }
}

function undoUpdate(row: AgentChangeRow, current: AnnotationView | undefined): UndoOutcome {
  if (!current || !row.before || !row.after || !matchesState(current, row.after)) return movedOn()
  const before = row.before
  if ('status' in before && !canMoveBack(current, before.status)) {
    return noWayBack('This status change has no way back.')
  }
  const fields = Object.fromEntries(REVERTIBLE.filter((field) => field in before).map((field) => [field, before[field]]))
  const parsed = updateAnnotationRequestSchema.safeParse({ ...fields, expectedStatus: current.status })
  if (!parsed.success) return noWayBack('This change cannot be undone.')
  return { plan: { kind: 'revert', request: parsed.data } }
}

function undoDelete(row: AgentChangeRow, current: AnnotationView | undefined): UndoOutcome {
  if (current) return movedOn()
  const before = row.before ?? {}
  const { status, ...place } = before
  const mark = createAnnotationRequestSchema.safeParse(place)
  if (!mark.success || (status !== 'open' && status !== 'resolved')) {
    return noWayBack('This mark cannot be set again.')
  }
  return { plan: { kind: 'recreate', mark: mark.data, status } }
}

/** What undoing `row` would do now, or why it would not. `current` is the mark as the reader sees it, absent when gone. */
export function planUndo(row: AgentChangeRow, current: AnnotationView | undefined): UndoOutcome {
  if (row.objectKind === 'annotation_reply') return undoReply(row, current)
  switch (row.op) {
    case 'create':
      return undoCreate(row, current)
    case 'update':
      return undoUpdate(row, current)
    case 'delete':
      return undoDelete(row, current)
  }
}
