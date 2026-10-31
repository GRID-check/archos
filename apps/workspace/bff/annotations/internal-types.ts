/**
 * Piloti's side of the Anmerkungen: `POST /api/internal/document-annotations`.
 * The agent's tools build these bodies; `annotation-schema.ts` exports them to
 * the JSON Schema fixture the Python tier validates against. Split from
 * `./types.ts` (which holds the vocabulary and the reader's wire) so neither
 * grows past what a file may hold.
 */

import { z } from 'zod'
import {
  ANNOTATION_AUTHORS,
  ANNOTATION_KINDS,
  ANNOTATION_STATUSES,
  annotationProposalSchema,
  content,
  MAX_PROPOSALS_PER_CALL,
} from './types'
import { ANNOTATION_SHAPES } from './place'
import { viewpointSummarySchema } from './viewpoint-types'

/** A pointer's label is a few words; a highlight's one line. */
export const MAX_POINT_LABEL = 80
export const MAX_HIGHLIGHT_LABEL = 120

/**
 * Common to every op: the answer the turn writes (marked when a restricted
 * folder is admitted), and the document, when the turn names one rather than
 * acting on the conversation's subject (`lib/annotations/agent.ts` admits it).
 */
const internalOpBase = {
  answerMessageId: z.guid().optional(),
  documentId: z.guid().optional(),
}

/** A name or an e-mail address as the asker said it; the BFF resolves it against the organization. */
export const MAX_ASSIGNEE_QUERY = 200

export const internalAnnotationRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), ...internalOpBase }).strict(),
  z
    .object({
      op: z.literal('propose'),
      ...internalOpBase,
      proposals: z.array(annotationProposalSchema).min(1).max(MAX_PROPOSALS_PER_CALL),
    })
    .strict(),
  // A mark the asker asked for: born open, taken over by the asker in the same
  // move (`accepted_by`), so the CHECK „Piloti's mark is open only with a
  // person" holds because the person stood behind it by asking.
  z
    .object({
      op: z.literal('create'),
      ...internalOpBase,
      marks: z.array(annotationProposalSchema).min(1).max(MAX_PROPOSALS_PER_CALL),
    })
    .strict(),
  // A change the asker asked for, through the same `updateAnnotation` a
  // person's PATCH runs, then `note` posted as Piloti's reply in the mark's
  // thread. At least one change (`./agent` refuses an empty one).
  z
    .object({
      op: z.literal('update'),
      ...internalOpBase,
      annotationId: z.guid(),
      status: z.enum(['open', 'resolved', 'dismissed']).optional(),
      /** Who is to act on it, by name or e-mail as the asker said it; null clears it. */
      assignee: z.string().trim().min(1).max(MAX_ASSIGNEE_QUERY).nullable().optional(),
      dueOn: content.dueOn,
      kind: content.kind.optional(),
      body: content.body.optional(),
      expectedStatus: z.enum(ANNOTATION_STATUSES).optional(),
      /** What Piloti did and why, in one sentence: its reply in the thread. */
      note: content.body,
    })
    .strict(),
  // Delete a mark, exactly as the asker could: only one they set themselves.
  z
    .object({
      op: z.literal('delete'),
      ...internalOpBase,
      annotationId: z.guid(),
    })
    .strict(),
  z
    .object({
      op: z.literal('reply'),
      ...internalOpBase,
      annotationId: z.guid(),
      body: content.body,
    })
    .strict(),
  // The room: who has the document open, and Piloti's own hand in it. A
  // pointer and a highlight are passing gestures, never stored.
  z.object({ op: z.literal('room'), ...internalOpBase }).strict(),
  z
    .object({
      op: z.literal('point'),
      ...internalOpBase,
      page: z.number().int().min(1),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      label: z.string().trim().min(1).max(MAX_POINT_LABEL).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('highlight'),
      ...internalOpBase,
      page: z.number().int().min(1),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().gt(0).max(1),
      h: z.number().gt(0).max(1),
      label: z.string().trim().min(1).max(MAX_HIGHLIGHT_LABEL),
    })
    .strict(),
  // What Piloti is reading, for everyone in the room: the page, or a box on it.
  // Presence, not content: it says where Piloti looks, never what it found.
  z
    .object({
      op: z.literal('look'),
      ...internalOpBase,
      page: z.number().int().min(1),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
      w: z.number().gt(0).max(1).optional(),
      h: z.number().gt(0).max(1).optional(),
    })
    .strict(),
  z.object({ op: z.literal('leave'), ...internalOpBase }).strict(),
])
export type InternalAnnotationRequest = z.input<typeof internalAnnotationRequestSchema>

/** What the agent reads back: the marks in a shape a model can cite, without the reader's controls. */
export const internalAnnotationSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  /** Null on a mark anchored to a viewpoint of a model: it has no page and no box. */
  page: z.number().int().nullable(),
  shape: z.enum(ANNOTATION_SHAPES).nullable(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  /** On a model: the short form of its viewpoint; null elsewhere. */
  viewpoint: viewpointSummarySchema.nullable().optional(),
  /** On a sketch: the element ids it is pinned to, and whether all of them were deleted; null and false elsewhere. */
  elementIds: z.array(z.string()).nullable(),
  anchorLost: z.boolean(),
  /** On a model: the link that opens the model at this mark's view, to hand the person; null elsewhere. */
  viewHref: z.string().nullable().optional(),
  kind: z.enum(ANNOTATION_KINDS),
  status: z.enum(ANNOTATION_STATUSES),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  body: z.string(),
  basis: z.string().nullable(),
  assigneeName: z.string().nullable(),
  dueOn: z.string().nullable(),
  onCurrentRevision: z.boolean(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  replies: z.array(
    z.object({
      authorKind: z.enum(ANNOTATION_AUTHORS),
      body: z.string(),
      createdByName: z.string().nullable(),
    })
  ),
})
export type InternalAnnotation = z.infer<typeof internalAnnotationSchema>

export const internalAnnotationListResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotations: z.array(internalAnnotationSchema),
})

/** A mark Piloti set, as the activity card draws it. */
const internalSetMarkSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  page: z.number().int().nullable(),
  shape: z.enum(ANNOTATION_SHAPES).nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  elementIds: z.array(z.string()).nullable(),
  kind: z.enum(ANNOTATION_KINDS),
  body: z.string(),
})

export const internalAnnotationProposeResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  proposed: z.array(internalSetMarkSchema),
})

export const internalAnnotationCreateResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  created: z.array(internalSetMarkSchema),
})

/** The fields a change moved, each as it stood: absent when the field did not change. */
const internalMarkFieldsSchema = z.object({
  status: z.enum(ANNOTATION_STATUSES).optional(),
  assigneeUserId: z.string().nullable().optional(),
  assigneeName: z.string().nullable().optional(),
  dueOn: z.string().nullable().optional(),
  kind: z.enum(ANNOTATION_KINDS).optional(),
  body: z.string().optional(),
})
export type InternalMarkFields = z.infer<typeof internalMarkFieldsSchema>

export const internalAnnotationUpdateResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotationId: z.string(),
  number: z.number().int(),
  /** The mark's status after the change: what an undo names as `expectedStatus`. */
  status: z.enum(ANNOTATION_STATUSES),
  before: internalMarkFieldsSchema,
  after: internalMarkFieldsSchema,
  /** Whether the note went into the thread; false when the change changed nothing. */
  noted: z.boolean(),
})

export const internalAnnotationDeleteResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotationId: z.string(),
  number: z.number().int(),
  body: z.string(),
})

export const internalAnnotationReplyResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  annotationId: z.string(),
  number: z.number().int(),
  replies: z.number().int(),
})

/** Who has the document open, as Piloti reads it to resolve „hier“. Never another tool's peer id. */
export const internalRoomResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  peers: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['person', 'piloti']),
      page: z.number().int().nullable(),
      viewport: z.object({ page: z.number().int(), y: z.number() }).nullable(),
      selectedMarkNumber: z.number().int().nullable(),
      draft: z
        .object({ page: z.number().int(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .nullable(),
    })
  ),
  marks: z.object({ open: z.number().int(), proposed: z.number().int() }),
})

/** A gesture in the room went out. */
export const internalRoomGestureResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  ok: z.literal(true),
})

/** The wire schemas the Python tier reads, by name. */
export const ANNOTATION_WIRE_SCHEMAS = {
  InternalAnnotationRequest: internalAnnotationRequestSchema,
  InternalAnnotationListResponse: internalAnnotationListResponseSchema,
  InternalAnnotationProposeResponse: internalAnnotationProposeResponseSchema,
  InternalAnnotationCreateResponse: internalAnnotationCreateResponseSchema,
  InternalAnnotationUpdateResponse: internalAnnotationUpdateResponseSchema,
  InternalAnnotationDeleteResponse: internalAnnotationDeleteResponseSchema,
  InternalAnnotationReplyResponse: internalAnnotationReplyResponseSchema,
  InternalRoomResponse: internalRoomResponseSchema,
  InternalRoomGestureResponse: internalRoomGestureResponseSchema,
} as const
