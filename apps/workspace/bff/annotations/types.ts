/**
 * Anmerkungen as data: the vocabulary and the wire schemas every client of the
 * HTTP API validates against (CONTEXT.md „Anmerkung", ADR-0055).
 *
 * An Anmerkung is a mark set at a place on a page of a document, a point or a
 * region, with what is to be done about it (a Hinweis, a Rückfrage or a
 * Mangel), a thread of replies under it, and optionally someone who is to act
 * on it by a date. A person sets one, or Piloti proposes one for a person to
 * take over (migration 0138).
 *
 * No `server-only` and no drizzle: the browser, the typed client (`./client`),
 * the route handlers and, through the JSON Schema fixture, the Python tier read
 * this. `db/schema/document-annotations.ts` imports the tuples from here so the
 * CHECKs and the types cannot drift.
 */

import { z } from 'zod'
import { MAX_MENTIONS_PER_MESSAGE } from '@/lib/limits/catalog'
import { boxPlaced, placed, ANNOTATION_ANCHORS, ANNOTATION_SHAPES } from './place'
import { viewpointSummarySchema } from './viewpoint-types'
import type { AnnotationAnchor, AnnotationShape } from './place'
export {
  ANNOTATION_ANCHORS,
  ANNOTATION_SHAPES,
  MAX_ANCHOR_ELEMENTS,
  placeProblem,
  type AnnotationAnchor,
  type AnnotationShape,
} from './place'

/** Hinweis, Rückfrage, Mangel. */
export const ANNOTATION_KINDS = ['hint', 'question', 'defect'] as const
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** Who set it. Piloti's marks are proposals until a person takes one over. */
export const ANNOTATION_AUTHORS = ['person', 'piloti'] as const
/** The author of a mark the agent set or a reply it wrote. */
export const AGENT_AUTHOR = ANNOTATION_AUTHORS[1]
export type AnnotationAuthor = (typeof ANNOTATION_AUTHORS)[number]

/** Vorschlag, Offen, Erledigt, Verworfen. */
export const ANNOTATION_STATUSES = ['proposed', 'open', 'resolved', 'dismissed'] as const
export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number]

/**
 * What woke Piloti on a mark (ADR-0106): a reply that addresses it
 * (`thread_mention`), a reply on its own open question (`thread_reply`), or
 * being made the mark's delegate (`assigned`). The wire's `TurnTrigger.kind`.
 */
export const AGENT_WAKE_TRIGGERS = ['thread_mention', 'thread_reply', 'assigned'] as const
export type AgentWakeTrigger = (typeof AGENT_WAKE_TRIGGERS)[number]

/**
 * What a wake came to (`agent_wakes.status`, migrations 0139 and 0141).
 * `queued` until the job runs; `started` while its turn runs; then the turn's
 * end: `answered`, `stopped` (a person stopped it, or took the mark back), or
 * `failed`. `suppressed` and `refused` never started a turn; `failed` can be
 * either (the job gave up, or the turn errored).
 */
export const AGENT_WAKE_STATUSES = [
  'queued',
  'started',
  'answered',
  'stopped',
  'suppressed',
  'refused',
  'failed',
] as const
export type AgentWakeStatus = (typeof AGENT_WAKE_STATUSES)[number]

/**
 * What the BFF did with an event that could wake Piloti, as the writer's
 * response says it: `none` (no wake rule met), `off` (the organization's
 * switch is off: the browser asks Piloti itself, as before), `queued` (the
 * server will wake it; the browser must not), `suppressed` (a cap held it).
 */
export const WAKE_OUTCOMES = ['none', 'off', 'queued', 'suppressed'] as const
export type WakeOutcome = (typeof WAKE_OUTCOMES)[number]

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

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max))

/**
 * Someone a mark's text or a reply mentions: who was picked in the composer's
 * „@" picker (a user id, or Piloti's `AGENT_MENTION_ID`) and the name the
 * text shows for them, without the „@". The chat's own mention shape
 * (`DraftMention`, `lib/mentions/mention-text.ts`), stored on
 * the row (migration 0150) and rendered with the chat's chip. The server keeps
 * one only while its token still stands in the text, the name is the one the
 * directory has, and the person may open the document (`./mentions.ts`): a
 * client list is never taken on trust.
 */
export const markMentionSchema = z
  .object({ targetId: z.string().min(1).max(128), display: z.string().min(1).max(200) })
  .strict()
export type MarkMention = z.infer<typeof markMentionSchema>

/** At most as many as one chat message may mention: one bound for one gesture (`MAX_MENTIONS_PER_MESSAGE`). */
export const markMentionsSchema = z.array(markMentionSchema).max(MAX_MENTIONS_PER_MESSAGE)

export const content = {
  kind: z.enum(ANNOTATION_KINDS),
  body: text(MAX_ANNOTATION_BODY),
  basis: text(MAX_ANNOTATION_BASIS).nullable().optional(),
  assigneeUserId: z.string().min(1).max(128).nullable().optional(),
  dueOn: calendarDay.nullable().optional(),
}

/** A box on a page, or the elements of a Skizze it is about (`./place.ts`): never both. */
export const createAnnotationRequestSchema = placed({ ...content, mentions: markMentionsSchema.optional() })
export type CreateAnnotationRequest = z.input<typeof createAnnotationRequestSchema>

/**
 * A change to one Anmerkung. At least one field; `null` clears an assignee, a
 * date or a basis. `status` moves it: a person takes a proposal over (`open`)
 * or dismisses it, resolves an open one, or opens a closed one again. Moving
 * the mark is not offered: a mark set in the wrong place is deleted and set
 * again, so a position never changes under someone who read it. The one
 * exception is a mark pinned to elements of a Skizze: its referent is the
 * elements, and a save of the Skizze moves its box with them
 * (`./sketch-carry.ts`).
 */
export const updateAnnotationRequestSchema = z
  .object({
    kind: content.kind.optional(),
    body: content.body.optional(),
    /**
     * Whom the new `body` mentions, as picked. Only with a body: without one
     * the stored mentions stand. A body sent without them keeps the stored
     * mentions whose token it still shows. Only someone mentioned anew is told.
     */
    mentions: markMentionsSchema.optional(),
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
    /**
     * Make Piloti the delegate on this open mark (true), or take the work back
     * from it (false). The mark keeps its assignee; the caller becomes
     * `delegatedBy`, and Piloti is woken to work it on their behalf. A
     * person's act: Piloti never delegates to itself.
     */
    delegateToPiloti: z.boolean().optional(),
    /**
     * „Gilt weiter": carry this open mark onto the Fassung the document shows
     * now, keeping its number, its thread and its place on the page (a
     * position never changes). A mark of a document another one replaced goes
     * to the replacing document as a linked mark (`carriedFrom`), and this one
     * is closed with the link back (`carriedTo`). A move of its own: nothing
     * else changes in the same request.
     */
    carryToCurrent: z.literal(true).optional(),
  })
  .strict()
  .refine(({ expectedStatus: _, ...changes }) => Object.keys(changes).length > 0, 'nothing to change')
  .refine(({ mentions, body }) => mentions === undefined || body !== undefined, 'mentions go with a body')
  .refine(
    ({ carryToCurrent, expectedStatus: _, ...changes }) => !carryToCurrent || Object.keys(changes).length === 0,
    'carrying a mark to the current Fassung changes nothing else'
  )
export type UpdateAnnotationRequest = z.input<typeof updateAnnotationRequestSchema>

export const createReplyRequestSchema = z
  .object({
    body: text(MAX_ANNOTATION_BODY),
    /**
     * The reply addresses Piloti: the composer's @Piloti chip. A structured
     * flag the person set, never read from the text (ADR-0036).
     */
    addressesPiloti: z.boolean().optional(),
    /**
     * Whom the reply mentions, as picked in the composer: colleagues, who are
     * told, and Piloti (which addresses it, as `addressesPiloti` does).
     */
    mentions: markMentionsSchema.optional(),
  })
  .strict()
export type CreateReplyRequest = z.input<typeof createReplyRequestSchema>

/**
 * `PATCH …/replies/{replyId}`: its author rewords their reply. Whom the new
 * words mention, as the composer kept them; absent, the ones stored whose
 * name still stands. No `addressesPiloti`: an edit never wakes Piloti, and
 * whether the reply addressed it stays what it was when it was posted.
 */
export const updateReplyRequestSchema = z
  .object({
    body: text(MAX_ANNOTATION_BODY),
    mentions: markMentionsSchema.optional(),
  })
  .strict()
export type UpdateReplyRequest = z.input<typeof updateReplyRequestSchema>

export const annotationReplyViewSchema = z.object({
  id: z.string(),
  annotationId: z.string(),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  body: z.string(),
  createdBy: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  /** It addressed Piloti (the @Piloti chip). Absent from a server that predates wakes. */
  addressesPiloti: z.boolean().default(false),
  /**
   * What woke the turn that wrote this Piloti reply, or null for a reply nobody's
   * event woke (a person's, or Piloti asked in the canvas). Derived on read
   * (`./wake-attribution.ts`); absent from a server that predates it.
   */
  wokenBy: z.enum(AGENT_WAKE_TRIGGERS).nullable().optional(),
  /** Whom it mentions, as the server kept them; absent from a server that predates mentions. */
  mentions: z.array(markMentionSchema).optional(),
  /** When its author last reworded it, or null; absent from a server that predates editing (migration 0152). */
  editedAt: z.string().nullable().optional(),
})
export type AnnotationReplyView = z.infer<typeof annotationReplyViewSchema>

/**
 * Piloti at work on a mark, as the server knows it (`./agent-work.ts`), so
 * every reader sees the same line: `queued` until its turn starts, `working`
 * while it runs, `failed` for a while after it ended without an answer (the
 * class of why: `wakeEndReasonKind`), `held` briefly when a cap held it.
 */
export const AGENT_WORK_STATES = ['queued', 'working', 'failed', 'held'] as const
export type AgentWorkState = (typeof AGENT_WORK_STATES)[number]

export const agentWorkViewSchema = z.object({
  state: z.enum(AGENT_WORK_STATES),
  trigger: z.enum(AGENT_WAKE_TRIGGERS),
  /** The person whose act woke Piloti: it works for them. */
  forUserId: z.string(),
  forName: z.string().nullable(),
  /** Why it failed, as a class a person can act on; null unless `failed`. */
  reasonKind: z.enum(['budget', 'busy', 'access', 'error']).nullable(),
  /** When this state began: queued at, started at, or ended at. */
  since: z.string(),
})
export type AgentWorkView = z.infer<typeof agentWorkViewSchema>

/**
 * The other end of a carry (migration 0151): the mark of the replaced document
 * this one went on from, or of the replacing document it went on as. Only when
 * the reader may open that document; its name as people see it.
 */
export const carryLinkViewSchema = z.object({
  annotationId: z.string(),
  documentId: z.string(),
  number: z.number().int(),
  documentName: z.string(),
})
export type CarryLinkView = z.infer<typeof carryLinkViewSchema>

/**
 * Where „Auf aktuelle Fassung übernehmen" takes a mark for THIS reader: the
 * document it lands on, named as people see it. The mark's own document when
 * it moves in place; the document that replaces it, at the end of its chain
 * as the reader sees it, when it goes on as a linked mark.
 */
export const carryTargetViewSchema = carryLinkViewSchema.pick({ documentId: true, documentName: true }).extend({
  /** On a model: the number of the Fassung it lands on („Fassung 4“), when the document has a version row. */
  revisionNumber: z.number().int().nullable().optional(),
  /** On a model: how many of the elements it points at that Fassung has, by GlobalId (migration 0195). */
  elements: z.object({ present: z.number().int(), total: z.number().int() }).optional(),
})
export type CarryTargetView = z.infer<typeof carryTargetViewSchema>

/** Why its author may not delete a mark: a colleague answered in it, or it was carried on (`deleteRefusalOf`). */
export const annotationDeleteRefusalSchema = z.enum(['discussed', 'carried'])
export type AnnotationDeleteRefusal = z.infer<typeof annotationDeleteRefusalSchema>

export const annotationViewSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  /** The document's running number, „Anmerkung 4". */
  number: z.number().int(),
  /** What the mark is anchored to; absent from a server that predates viewpoints (migration 0193), which is `page`. */
  anchor: z.enum(ANNOTATION_ANCHORS).optional(),
  /** Null on a mark anchored to a viewpoint of a model, which has no box (`hasBox`). */
  page: z.number().int().nullable(),
  shape: z.enum(ANNOTATION_SHAPES).nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  w: z.number().nullable(),
  h: z.number().nullable(),
  /** On a model: the short form of its viewpoint; the whole view is `GET …/viewpoint`. Null elsewhere. */
  viewpoint: viewpointSummarySchema.nullable().optional(),
  /** On a Skizze: the elements it is about, its box derived from them (migration 0192); null elsewhere. Absent from a server that predates it. */
  elementIds: z.array(z.string()).nullable().optional(),
  /** None of its elements is in the Skizze, or in the model's Fassung it was carried to, any more: it keeps its last box or view. Absent from a server that predates it. */
  anchorLost: z.boolean().optional(),
  /** On a model: the in-app link that opens the model at this mark's view (`?mark=`); null elsewhere. */
  viewHref: z.string().nullable().optional(),
  kind: z.enum(ANNOTATION_KINDS),
  body: z.string(),
  /** Whom its text mentions, as the server kept them; absent from a server that predates mentions. */
  mentions: z.array(markMentionSchema).optional(),
  basis: z.string().nullable(),
  authorKind: z.enum(ANNOTATION_AUTHORS),
  status: z.enum(ANNOTATION_STATUSES),
  assigneeUserId: z.string().nullable(),
  /** The assignee's name as the organization's directory has it; null when it does not know them. */
  assigneeName: z.string().nullable(),
  dueOn: z.string().nullable(),
  /** The Fassung number it was set on, when the document has a version row for it. */
  revisionNumber: z.number().int().nullable(),
  /**
   * Whether it was set on the Fassung the document shows now. False once a
   * newer Fassung replaced that one: it is listed, and not drawn over a sheet
   * whose geometry may have moved.
   */
  onCurrentRevision: z.boolean(),
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
  /**
   * Piloti works this mark on this person's behalf (the delegate), or null.
   * Absent from a server that predates delegation, which is none.
   */
  delegatedBy: z.string().nullable().default(null),
  delegatedByName: z.string().nullable().default(null),
  delegatedAt: z.string().nullable().default(null),
  replies: z.array(annotationReplyViewSchema),
  /** Piloti at work on it, as the server knows it; null when it is not. Absent from a server that predates it. */
  pilotiWork: agentWorkViewSchema.nullable().optional(),
  /** Where it went on from: the replaced document's mark, with its thread. Absent from a server that predates carrying. */
  carriedFrom: carryLinkViewSchema.nullable().optional(),
  /** Where it went on: the replacing document's mark. Absent from a server that predates carrying. */
  carriedTo: carryLinkViewSchema.nullable().optional(),
  /**
   * Where THIS reader's carry would take it, or null when they may not carry
   * it: it is not open, they may not edit it, it is on the current Fassung of
   * a document nothing replaces, or it goes on to a replacing document they
   * may not write or not open, or Piloti works it. Every condition the server
   * refuses a carry on, so the review offers only what goes through. Absent
   * from a server that predates it, which offers none.
   */
  carryTarget: carryTargetViewSchema.nullable().optional(),
  /** Whether THIS reader may change it: take it over, resolve it, reword it, assign it, reply. */
  canEdit: z.boolean(),
  /**
   * Whether THIS reader may delete it: whoever set it, while they may still
   * write here, and while nothing but its author and Piloti stands on it
   * (`deleteRefused`).
   */
  canDelete: z.boolean(),
  /**
   * Why the author may NOT delete their own mark now: `discussed` (a colleague
   * answered in its thread) or `carried` (it went on to, or came from, another
   * document). Null for anybody else's mark and for one they may delete. The
   * card shows the delete it withholds, and why. Absent from a server that
   * predates the rule.
   */
  deleteRefused: annotationDeleteRefusalSchema.nullable().optional(),
})
export type AnnotationView = z.infer<typeof annotationViewSchema>

export const annotationListResponseSchema = z.object({
  annotations: z.array(annotationViewSchema),
  /** Whether this reader may set a new Anmerkung on the document. */
  canAnnotate: z.boolean(),
  /**
   * Whether the organization lets events wake Piloti (the `piloti-wakes`
   * switch): a mark can be delegated to Piloti, and an @Piloti reply is
   * answered by the server rather than by this tab. Absent from a server
   * that predates wakes, which is off.
   */
  pilotiWakes: z.boolean().default(false),
})
export type AnnotationListResponse = z.infer<typeof annotationListResponseSchema>

export const annotationResponseSchema = z.object({
  annotation: annotationViewSchema,
  /** What the BFF did with the write as an event that could wake Piloti; absent on writes that cannot. */
  wake: z.enum(WAKE_OUTCOMES).optional(),
})
export type AnnotationResponse = z.infer<typeof annotationResponseSchema>

/** A reply: the mark with its thread, the new reply's id, and whether the server wakes Piloti for it. */
export const replyResponseSchema = z.object({
  annotation: annotationViewSchema,
  /** Absent only from a server that predates wakes. */
  replyId: z.string().optional(),
  /** `none` from a server that predates wakes: the browser asks Piloti itself, as before. */
  wake: z.enum(WAKE_OUTCOMES).default('none'),
})
export type ReplyResponse = z.infer<typeof replyResponseSchema>

/** The body of `POST /api/documents/{id}/thread`. */
export const documentThreadRequestSchema = z.object({ title: z.string().trim().max(200).optional() }).strict()

/** `POST /api/documents/{id}/thread`: the caller's own thread about the document (ADR-0106). */
export const documentThreadResponseSchema = z.object({ conversationId: z.string().min(1) })

/**
 * The `details.reason` of a 409 on a reply its author may no longer change:
 * Piloti took it up (it is working on it, or answered after it).
 */
export const REPLY_TAKEN_UP_REASON = 'piloti-took-it-up'
/** The `details.reason` of a 422 on a reply of a mark that is closed: its thread is the record. */
export const REPLY_MARK_CLOSED_REASON = 'mark-closed'

/** Whether a reply was for Piloti: its @Piloti, or an answer on Piloti's own Rückfrage. Pure. */
export const replyIsForAgent = (
  mark: { authorKind: AnnotationAuthor; kind: AnnotationKind },
  reply: { authorKind: AnnotationAuthor; addressesPiloti: boolean }
): boolean =>
  reply.authorKind === 'person' && (reply.addressesPiloti || (mark.authorKind === 'piloti' && mark.kind === 'question'))

/** Whether Piloti wrote in the thread after this reply. Pure; `createdAt` as stored or as the view says it. */
export const agentRepliedSince = (
  replies: ReadonlyArray<{ authorKind: AnnotationAuthor; createdAt: Date | string }>,
  reply: { createdAt: Date | string }
): boolean => {
  const at = new Date(reply.createdAt).getTime()
  return replies.some((other) => other.authorKind === 'piloti' && new Date(other.createdAt).getTime() > at)
}

/** The statuses that still ask something of somebody: open, and Piloti's proposals nobody has decided on. */
export const LIVE_ANNOTATION_STATUSES = ['open', 'proposed'] as const satisfies readonly AnnotationStatus[]

/** Piloti's mark that no person took over: a proposal still, or one dismissed as one. Not yet the office's record. */
export const isUnreviewedProposal = (annotation: Pick<AnnotationView, 'authorKind' | 'acceptedBy'>): boolean =>
  annotation.authorKind === 'piloti' && annotation.acceptedBy === null

/** Whether an Anmerkung still asks something of somebody. */
export const isLive = (annotation: Pick<AnnotationView, 'status'>): boolean =>
  (LIVE_ANNOTATION_STATUSES as readonly AnnotationStatus[]).includes(annotation.status)

/**
 * Whether a mark is the reader's: they are its Zuständige, and it is the
 * office's, not a proposal of Piloti's nobody took over yet (a proposal that
 * names them becomes theirs when somebody takes it over). Who set it does not
 * count: a mark a person set for a colleague is the colleague's.
 *
 * The one answer to „für Sie“: the review's filter of that name lists the
 * marks it holds, and the live ones among them ({@link isLive}, so open) are
 * the number Dateien's chip says („4 offen · 2 für Sie“). The server counts
 * that number in SQL (`tallyLiveMarks`, `status = 'open' and assignee_user_id
 * = reader`); `repository.integration.spec.ts` holds the two to the same cases
 * (`@/test-utils/marks-for-reader`).
 */
export function isForReader(
  annotation: Pick<AnnotationView, 'status' | 'assigneeUserId'>,
  readerUserId: string | null
): boolean {
  return readerUserId !== null && annotation.status !== 'proposed' && annotation.assigneeUserId === readerUserId
}

/**
 * Whether a mark is drawn as a ghost in the review of `documentId`: still
 * open, and set on an earlier Fassung of THIS document, so it is drawn hollow
 * where it stood on that sheet, for the reader to see where it would land
 * before carrying it on. A mark of another document (a replaced one) is never
 * drawn there: its sheet is another drawing, and its place may mean nothing
 * on this one.
 */
export function isGhostMark(
  annotation: Pick<AnnotationView, 'documentId' | 'onCurrentRevision' | 'status'>,
  documentId: string
): boolean {
  return annotation.documentId === documentId && !annotation.onCurrentRevision && annotation.status === 'open'
}

/**
 * What a listing row says about a document's Anmerkungen, for the reader it
 * was read for, on every Fassung: how many are open, how many are Piloti's
 * proposals nobody decided on (live, {@link isLive}, but not yet the office's:
 * counted apart, so „offen“ means the same here as in Offene Punkte, the
 * Protokoll and the Postfach), and how many of the open ones are the reader's
 * ({@link isForReader}: open, with the reader as Zuständige).
 */
export interface MarkTally {
  open: number
  proposed: number
  forYou: number
}

/**
 * Whether a mark has a box on a page. A mark on a model is anchored to a
 * viewpoint instead (`page`, `x` and `y` are null): it has no page to be drawn
 * on and no page to be sorted by. A type guard, so a caller that passes it has
 * a page and a place.
 */
export function hasBox<T extends { anchor?: AnnotationAnchor; page: number | null; x: number | null; y: number | null }>(
  annotation: T
): annotation is T & { page: number; shape: AnnotationShape; x: number; y: number } {
  return annotation.anchor !== 'viewpoint' && annotation.page != null && annotation.x != null && annotation.y != null
}

/** Live ones first, then by page and number: the order a review walks them in; marks on a model after the pages. */
export function compareAnnotations(a: AnnotationView, b: AnnotationView): number {
  if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1
  if (a.page !== b.page) {
    if (a.page == null) return 1
    if (b.page == null) return -1
    return a.page - b.page
  }
  return a.number - b.number
}

/** Whether an open Anmerkung's date has passed, on the reader's calendar day `today` (`YYYY-MM-DD`). */
export function isOverdue(annotation: Pick<AnnotationView, 'status' | 'dueOn'>, today: string): boolean {
  return annotation.status === 'open' && annotation.dueOn !== null && annotation.dueOn < today
}

/** A point asked about becomes a box this wide and tall around it (shares of the page). */
const POINT_BOX = 0.08

/**
 * The box a place stands for when Piloti is asked about it: a region as it
 * is, a point as a small box around it, kept on its page. The canvas asks
 * with it, and so does a wake (`lib/annotations/wake-job.ts`).
 */
export function regionAround(place: { page: number; x: number; y: number; w?: number | null; h?: number | null }): {
  page: number
  x: number
  y: number
  w: number
  h: number
} {
  if (place.w && place.h) return { page: place.page, x: place.x, y: place.y, w: place.w, h: place.h }
  const round = (value: number) => Math.round(value * 10_000) / 10_000
  const start = (value: number) => round(Math.min(1 - POINT_BOX, Math.max(0, value - POINT_BOX / 2)))
  return { page: place.page, x: start(place.x), y: start(place.y), w: POINT_BOX, h: POINT_BOX }
}

/** A mark's place as a box, `[x0, y0, x1, y1]`; a point is a box of no size. */
export function annotationBox(
  annotation: Pick<AnnotationView, 'anchor' | 'page' | 'x' | 'y' | 'w' | 'h'>
): [number, number, number, number] | null {
  if (!hasBox(annotation)) return null
  return [annotation.x, annotation.y, annotation.x + (annotation.w ?? 0), annotation.y + (annotation.h ?? 0)]
}

/**
 * One mark Piloti sets: a place, a kind, what it says, and what it rests on.
 * Born a proposal (`propose`), or open when the asker asked for exactly this
 * mark (`create`).
 */
const proposalContent = { kind: content.kind, body: content.body, basis: content.basis }
export const annotationProposalSchema = placed(proposalContent)
export type AnnotationProposal = z.input<typeof annotationProposalSchema>
/** A proposal on a box of a page: what a revision notice proposes on a PDF. */
export const annotationBoxProposalSchema = boxPlaced(proposalContent)
export type AnnotationBoxProposal = z.input<typeof annotationBoxProposalSchema>
