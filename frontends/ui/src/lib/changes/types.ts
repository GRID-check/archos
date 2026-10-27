/**
 * The change record's vocabulary and wire contract (migration 0142, ADR-0109).
 *
 * Every change Piloti APPLIES to an Anmerkung or a thread is one
 * `piloti_changes` row, with the turn that made it. A turn's card reads its
 * changes back from here (`GET /api/conversations/[id]/messages/[messageId]/changes`),
 * so it shows what is true now, not what the turn remembered; undo
 * (`POST /api/piloti-changes/[id]/undo`) is a compare-and-swap against `after`,
 * run as the person clicking, so a colleague's later change is never undone.
 *
 * No drizzle here, so a client component can import the shapes.
 */

import { z } from 'zod'

/** What a change was made to. A reply is created, never changed. */
export const PILOTI_CHANGE_OBJECTS = ['annotation', 'annotation_reply'] as const
export type PilotiChangeObject = (typeof PILOTI_CHANGE_OBJECTS)[number]

export const PILOTI_CHANGE_OPS = ['create', 'update', 'delete'] as const
export type PilotiChangeOp = (typeof PILOTI_CHANGE_OPS)[number]

/**
 * The changeable state a change records: for a mark, the fields the parity ops
 * set (`status`, `body`, `kind`, `assigneeUserId`, `dueDate`, the place on the
 * page); for a reply, its `body`. A JSON object, never an array (a CHECK).
 */
export const changeStateSchema = z.record(z.string(), z.unknown())
export type ChangeState = z.infer<typeof changeStateSchema>

/** Why an undo was refused (409). */
export const UNDO_REFUSALS = [
  /** The object is no longer as Piloti left it: somebody changed it since. */
  'moved-on',
  /** Somebody undid it already. */
  'already-undone',
] as const
export type UndoRefusal = (typeof UNDO_REFUSALS)[number]

/** One applied change, as a reader sees it. */
export const pilotiChangeViewSchema = z
  .object({
    id: z.guid(),
    documentId: z.guid(),
    annotationId: z.guid(),
    /** The mark's running number now; null once the mark is gone. */
    annotationNumber: z.number().int().positive().nullable(),
    objectKind: z.enum(PILOTI_CHANGE_OBJECTS),
    objectId: z.guid(),
    op: z.enum(PILOTI_CHANGE_OPS),
    before: changeStateSchema.nullable(),
    after: changeStateSchema.nullable(),
    /** The person the turn acted for, and their display name when known. */
    onBehalfOf: z.string(),
    onBehalfOfName: z.string().nullable(),
    createdAt: z.string(),
    undoneAt: z.string().nullable(),
    undoneBy: z.string().nullable(),
    undoneByName: z.string().nullable(),
    /** The reader may undo it now: not undone, the object still as Piloti left it, and they may edit the mark. */
    canUndo: z.boolean(),
  })
  .strict()
export type PilotiChangeView = z.infer<typeof pilotiChangeViewSchema>

/** `GET /api/conversations/[id]/messages/[messageId]/changes`: what that answer's turn changed, oldest first. Changes on documents the reader may not see are left out. */
export const turnChangesResponseSchema = z.object({ changes: z.array(pilotiChangeViewSchema) }).strict()
export type TurnChangesResponse = z.infer<typeof turnChangesResponseSchema>

/** `POST /api/piloti-changes/[id]/undo`: the change, now undone. 409 `{ error: UndoRefusal, message }` otherwise. */
export const undoChangeResponseSchema = z.object({ change: pilotiChangeViewSchema }).strict()
export type UndoChangeResponse = z.infer<typeof undoChangeResponseSchema>
