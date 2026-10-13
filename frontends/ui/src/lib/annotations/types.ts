/**
 * Anmerkungen as data: the vocabulary and the wire schemas every client of the
 * HTTP API validates against (CONTEXT.md „Anmerkung", ADR-0055).
 *
 * An Anmerkung is a mark set at a place on a page of a document, a point or a
 * region, with what is to be done about it (a Hinweis, a Rückfrage or a
 * Mangel), a thread of replies under it, and optionally someone who is to act
 * on it by a date. A person sets one, or Piloti proposes one for a person to
 * take over (migration 0135).
 *
 * No `server-only` and no drizzle: the browser, the typed client (`./client`),
 * the route handlers and, through the JSON Schema fixture, the Python tier read
 * this. `db/schema/document-annotations.ts` imports the tuples from here so the
 * CHECKs and the types cannot drift.
 */

import { z } from 'zod'

/** Hinweis, Rückfrage, Mangel. */
export const ANNOTATION_KINDS = ['hint', 'question', 'defect'] as const
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** A point on the page, or a region of it. */
export const ANNOTATION_SHAPES = ['point', 'region'] as const
export type AnnotationShape = (typeof ANNOTATION_SHAPES)[number]

/** Who set it. Piloti's marks are proposals until a person takes one over. */
export const ANNOTATION_AUTHORS = ['person', 'piloti'] as const
export type AnnotationAuthor = (typeof ANNOTATION_AUTHORS)[number]

/** Vorschlag, Offen, Erledigt, Verworfen. */
export const ANNOTATION_STATUSES = ['proposed', 'open', 'resolved', 'dismissed'] as const
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number]

/** The CHECKs `…_body_length` (trimmed) and `…_basis_length`. */
export const MAX_ANNOTATION_BODY = 2000
export const MAX_ANNOTATION_BASIS = 300

/** Anmerkungen one document may carry. A list read returns them all, so it is bounded here. */
export const MAX_ANNOTATIONS_PER_DOCUMENT = 500
/** Replies one Anmerkung may carry. */
export const MAX_REPLIES_PER_ANNOTATION = 200
/** Proposals one call of Piloti may make: a review of a sheet, not a flood. */
export const MAX_PROPOSALS_PER_CALL = 20

/** A calendar day, `YYYY-MM-DD`, as Postgres `date` stores it. */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'not a calendar day')

/** A share of the page, top-left origin: the `PageRegion` frame. */
const unit = z.number().finite().min(0).max(1)

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max))

/** The place fields every mark carries: a page, and a point or a region on it. */
const placeFields = {
  page: z.number().int().min(1).max(100_000),
  shape: z.enum(ANNOTATION_SHAPES),
  x: unit,
  y: unit,
  w: unit.nullable().optional(),
  h: unit.nullable().optional(),
}

type PlaceInput = {
  shape: AnnotationShape
  x: number
  y: number
  w?: number | null
  h?: number | null
}

/** A point has no size; a region has one and stays on its page (the CHECK `…_region_on_page`). */
export function placeProblem(place: PlaceInput): string | null {
  if (place.shape === 'point') return place.w != null || place.h != null ? 'a point has no size' : null
  if (!place.w || !place.h) return 'a region needs a size'
  if (place.x + place.w > 1.000001 || place.y + place.h > 1.000001) return 'a region stays on its page'
  return null
}

const checkPlace = (value: PlaceInput, context: z.RefinementCtx) => {
  const problem = placeProblem(value)
  if (problem) context.addIssue({ code: 'custom', message: problem })
}

const content = {
  kind: z.enum(ANNOTATION_KINDS),
  body: text(MAX_ANNOTATION_BODY),
  basis: text(MAX_ANNOTATION_BASIS).nullable().optional(),
  assigneeUserId: z.string().min(1).max(128).nullable().optional(),
  dueOn: calendarDay.nullable().optional(),
}

export const createAnnotationRequestSchema = z
  .object({ ...placeFields, ...content })
  .strict()
  .superRefine(checkPlace)
export type CreateAnnotationRequest = z.input<typeof createAnnotationRequestSchema>

/**
 * A change to one Anmerkung. At least one field; `null` clears an assignee, a
 * date or a basis. `status` moves it: a person takes a proposal over (`open`)
 * or dismisses it, resolves an open one, or opens a closed one again. Moving
 * the mark is not offered: a mark set in the wrong place is deleted and set
 * again, so a position never changes under someone who read it.
 */
export const updateAnnotationRequestSchema = z
  .object({
    kind: content.kind.optional(),
    body: content.body.optional(),
    basis: content.basis,
    status: z.enum(['open', 'resolved', 'dismissed']).optional(),
    assigneeUserId: content.assigneeUserId,
    dueOn: content.dueOn,
    /**
     * The status the caller saw. A change made from a copy (a chat card) names
     * it, so a mark a colleague moved meanwhile is a 409, never overwritten:
     * taking over a proposal must not reopen one somebody just dismissed.
     */
    expectedStatus: z.enum(ANNOTATION_STATUSES).optional(),
  })
  .strict()
  .refine(({ expectedStatus: _, ...changes }) => Object.keys(changes).length > 0, 'nothing to change')
export type UpdateAnnotationRequest = z.input<typeof updateAnnotationRequestSchema>

export const createReplyRequestSchema = z.object({ body: text(MAX_ANNOTATION_BODY) }).strict()
export type CreateReplyRequest = z.input<typeof createReplyRequestSchema>

export const annotationReplyViewSchema = z.object({
  id: z.string(),
  annotationId: z.string(),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  body: z.string(),
  createdBy: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
})
export type AnnotationReplyView = z.infer<typeof annotationReplyViewSchema>

export const annotationViewSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  /** The document's running number, „Anmerkung 4". */
  number: z.number().int(),
  page: z.number().int(),
  shape: z.enum(ANNOTATION_SHAPES),
  x: z.number(),
  y: z.number(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  kind: z.enum(ANNOTATION_KINDS),
  body: z.string(),
  basis: z.string().nullable(),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  status: z.enum(ANNOTATION_STATUSES),
  assigneeUserId: z.string().nullable(),
  /** The assignee's name as the organization's directory has it; null when it does not know them. */
  assigneeName: z.string().nullable(),
  dueOn: z.string().nullable(),
  /** The Fassung number it was set on, when the document has a version row for it. */
  fassungNumber: z.number().int().nullable(),
  /**
   * Whether it was set on the Fassung the document shows now. False once a
   * newer Fassung replaced that one: it is listed, and not drawn over a sheet
   * whose geometry may have moved.
   */
  onCurrentFassung: z.boolean(),
  /** The person who set it, or on whose behalf Piloti proposed it. */
  createdBy: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  acceptedBy: z.string().nullable(),
  acceptedByName: z.string().nullable(),
  closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedAt: z.string().nullable(),
  replies: z.array(annotationReplyViewSchema),
  /** Whether THIS reader may change it: take it over, resolve it, reword it, assign it, reply. */
  canEdit: z.boolean(),
  /** Whether THIS reader may delete it: whoever set it, while they may still write here. */
  canDelete: z.boolean(),
})
export type AnnotationView = z.infer<typeof annotationViewSchema>

export const annotationListResponseSchema = z.object({
  annotations: z.array(annotationViewSchema),
  /** Whether this reader may set a new Anmerkung on the document. */
  canAnnotate: z.boolean(),
})
export type AnnotationListResponse = z.infer<typeof annotationListResponseSchema>

export const annotationResponseSchema = z.object({ annotation: annotationViewSchema })
export type AnnotationResponse = z.infer<typeof annotationResponseSchema>

/** Whether an Anmerkung still asks something of somebody. */
export const isLive = (annotation: Pick<AnnotationView, 'status'>): boolean =>
  annotation.status === 'open' || annotation.status === 'proposed'

/** Live ones first, then by page and number: the order a review walks them in. */
export function compareAnnotations(a: AnnotationView, b: AnnotationView): number {
  if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1
  if (a.page !== b.page) return a.page - b.page
  return a.number - b.number
}

/** Whether an open Anmerkung's date has passed, on the reader's calendar day `today` (`YYYY-MM-DD`). */
export function isOverdue(annotation: Pick<AnnotationView, 'status' | 'dueOn'>, today: string): boolean {
  return annotation.status === 'open' && annotation.dueOn !== null && annotation.dueOn < today
}

/** A mark's place as a box, `[x0, y0, x1, y1]`; a point is a box of no size. */
export function annotationBox(annotation: Pick<AnnotationView, 'x' | 'y' | 'w' | 'h'>): [number, number, number, number] {
  return [annotation.x, annotation.y, annotation.x + (annotation.w ?? 0), annotation.y + (annotation.h ?? 0)]
}

// ---------------------------------------------------------------------------
// Piloti's side: POST /api/internal/document-annotations. The agent's tools
// build these bodies; `annotation-schema.ts` exports them to the JSON Schema
// fixture the Python tier validates against.
// ---------------------------------------------------------------------------

/** One finding Piloti proposes: a place, a kind, what it found, and what it rests on. */
export const annotationProposalSchema = z
  .object({
    ...placeFields,
    kind: content.kind,
    body: content.body,
    basis: content.basis,
  })
  .strict()
  .superRefine(checkPlace)
export type AnnotationProposal = z.input<typeof annotationProposalSchema>

/**
 * What Piloti asks for. No document id: the route acts on the conversation's
 * subject document, resolved from the signed envelope's conversation
 * (`./agent`), never on an id a model typed. `answerMessageId` is the answer
 * the turn writes, marked when reading the subject admits a restricted folder
 * (ADR-0093).
 */
/** A pointer's label is a few words; a highlight's one line. */
export const MAX_POINT_LABEL = 80
export const MAX_HIGHLIGHT_LABEL = 120

/**
 * Common to every op: the answer the turn writes (marked when a restricted
 * folder is admitted), and the document, when the turn names one rather than
 * acting on the conversation's subject (`lib/annotations/agent.ts` admits it).
 */
const internalOpBase = {
  answerMessageId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
}

export const internalAnnotationRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), ...internalOpBase }).strict(),
  z
    .object({
      op: z.literal('propose'),
      ...internalOpBase,
      proposals: z.array(annotationProposalSchema).min(1).max(MAX_PROPOSALS_PER_CALL),
    })
    .strict(),
  z
    .object({
      op: z.literal('reply'),
      ...internalOpBase,
      annotationId: z.string().uuid(),
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
  z.object({ op: z.literal('leave'), ...internalOpBase }).strict(),
])
export type InternalAnnotationRequest = z.input<typeof internalAnnotationRequestSchema>

/** What the agent reads back: the marks in a shape a model can cite, without the reader's controls. */
export const internalAnnotationSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  page: z.number().int(),
  shape: z.enum(ANNOTATION_SHAPES),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  kind: z.enum(ANNOTATION_KINDS),
  status: z.enum(ANNOTATION_STATUSES),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  body: z.string(),
  basis: z.string().nullable(),
  assigneeName: z.string().nullable(),
  dueOn: z.string().nullable(),
  onCurrentFassung: z.boolean(),
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

export const internalAnnotationProposeResponseSchema = z.object({
  documentId: z.string(),
  documentName: z.string(),
  proposed: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      page: z.number().int(),
      shape: z.enum(ANNOTATION_SHAPES),
      x: z.number(),
      y: z.number(),
      w: z.number().nullable(),
      h: z.number().nullable(),
      kind: z.enum(ANNOTATION_KINDS),
      body: z.string(),
    })
  ),
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
  InternalAnnotationReplyResponse: internalAnnotationReplyResponseSchema,
  InternalRoomResponse: internalRoomResponseSchema,
  InternalRoomGestureResponse: internalRoomGestureResponseSchema,
} as const
