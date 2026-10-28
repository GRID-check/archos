/**
 * The changeable state a `agent_changes` row records (ADR-0109), decided in
 * one place: what `before` and `after` hold for each object and op, and the
 * comparison undo makes against the object as it stands now.
 *
 * - A mark Piloti SET (`create`): its whole changeable state as Piloti left it,
 *   the place on the page included, so a later move of any of it counts.
 * - A mark Piloti CHANGED (`update`): only the fields that moved, as they were
 *   and as Piloti left them. Undo compares exactly those.
 * - A mark Piloti DELETED (`delete`): its whole changeable state, which is
 *   what setting it again needs. Its thread and its number are not recreated.
 * - A reply: its `body`.
 *
 * The names are the annotation view's (`lib/annotations/types.ts`), so a state
 * reads against a mark without a mapping, and the fields an update may restore
 * are exactly those `updateAnnotationRequestSchema` accepts.
 *
 * No `server-only`: pure, and the card may read the shape.
 */

import type { AnnotationView } from '@/lib/annotations/types'
import type { ChangeState } from './types'

/** Everything about a mark a change can set or move: what it says, where, its status and who acts on it by when. */
export const MARK_STATE_FIELDS = [
  'status',
  'kind',
  'body',
  'basis',
  'assigneeUserId',
  'dueOn',
  'page',
  'shape',
  'x',
  'y',
  'w',
  'h',
] as const satisfies readonly (keyof AnnotationView)[]
export type MarkStateField = (typeof MARK_STATE_FIELDS)[number]

type MarkLike = Pick<AnnotationView, MarkStateField>

/** The mark's state on the named fields, as it stands in one read. */
export function fieldsOf(mark: MarkLike, fields: readonly MarkStateField[]): ChangeState {
  return Object.fromEntries(fields.map((field) => [field, mark[field]]))
}

/** The mark's whole changeable state: what a `create` leaves and a `delete` takes away. */
export const markState = (mark: MarkLike): ChangeState => fieldsOf(mark, MARK_STATE_FIELDS)

/** A reply's state: what it says. */
export const replyState = (body: string): ChangeState => ({ body })

/** Whether the object, as it stands now, still holds every value `state` records. */
export function matchesState(current: Partial<Record<string, unknown>>, state: ChangeState): boolean {
  return Object.entries(state).every(([field, value]) => (current[field] ?? null) === (value ?? null))
}
