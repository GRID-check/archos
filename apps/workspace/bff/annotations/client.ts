/**
 * The typed client for a document's Anmerkungen (ADR-0055). The room travels
 * on the live channels (`features/realtime`, `lib/realtime`).
 *
 * The paths, the verbs and the response shapes are written once, here; the
 * browser and the route specs both go through it, so a second consumer cannot
 * disagree with the first about what `PATCH …/annotations/{id}` expects.
 * Responses are parsed with the zod schemas from `./types`, not cast.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { bcfImportResultSchema, type BcfImportResult } from '@/lib/bim/bcf-import-wire'
import { ROOM_PEER_HEADER } from './peer-header'
import {
  projectMarksHref,
  projectMarksResponseSchema,
  type ProjectMarksFilters,
  type ProjectMarksResponse,
} from './project-types'
import { viewpointResponseSchema, type ViewpointView } from './viewpoint-types'
import {
  annotationListResponseSchema,
  annotationResponseSchema,
  documentThreadResponseSchema,
  replyResponseSchema,
  type AnnotationListResponse,
  type AnnotationResponse,
  type AnnotationView,
  type CreateAnnotationRequest,
  type CreateReplyRequest,
  type ReplyResponse,
  type UpdateAnnotationRequest,
  type UpdateReplyRequest,
} from './types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type AnnotationFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: AnnotationFetch = (path, init) => fetch(path, init)

/** A request the API refused, with its status, the body's own code, and its `details.reason` where it names one. */
export class AnnotationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason: string | null = null
  ) {
    super(message)
    this.name = 'AnnotationRequestError'
  }
}

async function request<T>(
  run: AnnotationFetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await run(path, init)
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string; details?: { reason?: unknown } }
    const reason = typeof error.details?.reason === 'string' ? error.details.reason : null
    throw new AnnotationRequestError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`,
      reason
    )
  }
  return parse(body)
}

/** The options every write takes: the tab's room id, so its own echo can be told apart. */
export interface WriteOptions {
  peerId?: string | null
  run?: AnnotationFetch
}

const json = (method: string, payload: unknown, peerId?: string | null): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(peerId ? { [ROOM_PEER_HEADER]: peerId } : {}) },
  body: JSON.stringify(payload),
})

const documentPath = (documentId: string) => `/api/documents/${encodeURIComponent(documentId)}`
export const annotationsPath = (documentId: string) => `${documentPath(documentId)}/annotations`
const annotationPath = (documentId: string, annotationId: string) =>
  `${annotationsPath(documentId)}/${encodeURIComponent(annotationId)}`

const one = (value: unknown) => annotationResponseSchema.parse(value).annotation

export function listAnnotations(
  documentId: string,
  run: AnnotationFetch = defaultFetch
): Promise<AnnotationListResponse> {
  return request(run, annotationsPath(documentId), { method: 'GET' }, (value) =>
    annotationListResponseSchema.parse(value)
  )
}

/** One Anmerkung as this reader sees it: what a room hint names is read again, not the whole list. */
export function getAnnotation(
  documentId: string,
  annotationId: string,
  run: AnnotationFetch = defaultFetch
): Promise<AnnotationView> {
  return request(run, annotationPath(documentId, annotationId), { method: 'GET' }, one)
}

/**
 * A mark on elements of a Skizze goes without a box: the server derives it from
 * the elements (`./sketch-place.ts`), and a box beside them is refused. A draft
 * on the canvas carries both, the box to draw it with until it is saved.
 */
function placeOnWire(input: CreateAnnotationRequest): CreateAnnotationRequest {
  // A mark on a model sets a viewpoint and no box: the draft carries one only to satisfy the review's shape.
  const anchored = ('elementIds' in input && input.elementIds) || ('viewpoint' in input && input.viewpoint)
  if (!anchored) return input
  const { page: _page, shape: _shape, x: _x, y: _y, w: _w, h: _h, ...rest } = input as typeof input & Partial<ReviewBox>
  return rest
}

type ReviewBox = { page: number; shape: string; x: number; y: number; w: number | null; h: number | null }

export function createAnnotation(
  documentId: string,
  input: CreateAnnotationRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationView> {
  return request(run, annotationsPath(documentId), json('POST', placeOnWire(input), peerId), one)
}

export function updateAnnotation(
  documentId: string,
  annotationId: string,
  input: UpdateAnnotationRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationView> {
  return updateAnnotationWithWake(documentId, annotationId, input, { peerId, run }).then(({ annotation }) => annotation)
}

/** A change, and what the server did with it as an event that could wake Piloti (a delegation). */
export function updateAnnotationWithWake(
  documentId: string,
  annotationId: string,
  input: UpdateAnnotationRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationResponse> {
  return request(run, annotationPath(documentId, annotationId), json('PATCH', input, peerId), (value) =>
    annotationResponseSchema.parse(value)
  )
}

/**
 * Answer in the thread. The response says whether the server wakes Piloti for
 * it (`wake: 'queued'`): then this tab must not ask Piloti itself.
 */
export function replyToAnnotation(
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<ReplyResponse> {
  return request(run, `${annotationPath(documentId, annotationId)}/replies`, json('POST', input, peerId), (value) =>
    replyResponseSchema.parse(value)
  )
}

const replyPath = (documentId: string, annotationId: string, replyId: string) =>
  `${annotationPath(documentId, annotationId)}/replies/${encodeURIComponent(replyId)}`

/**
 * Reword one's own reply: the mark with its thread as it now stands. Refused
 * 409 with `REPLY_TAKEN_UP_REASON` once Piloti took the reply up, and 422 with
 * `REPLY_MARK_CLOSED_REASON` on a closed mark. Never wakes Piloti.
 */
export function editReply(
  documentId: string,
  annotationId: string,
  replyId: string,
  input: UpdateReplyRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationView> {
  return request(run, replyPath(documentId, annotationId, replyId), json('PATCH', input, peerId), one)
}

/** Delete one's own reply, refused as {@link editReply} is. */
export function deleteReply(
  documentId: string,
  annotationId: string,
  replyId: string,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<void> {
  return request(
    run,
    replyPath(documentId, annotationId, replyId),
    { method: 'DELETE', headers: peerId ? { [ROOM_PEER_HEADER]: peerId } : {} },
    () => undefined
  )
}

/** The whole viewpoint of a mark on a model (`GET …/annotations/{id}/viewpoint`): camera, section, selection, visibility, pin. */
export function getAnnotationViewpoint(
  documentId: string,
  annotationId: string,
  run: AnnotationFetch = defaultFetch
): Promise<ViewpointView> {
  return request(
    run,
    `${annotationPath(documentId, annotationId)}/viewpoint`,
    { method: 'GET' },
    (value) => viewpointResponseSchema.parse(value).viewpoint
  )
}

/** A coordination BCF file onto a model (`POST …/annotations/bcf`): what became of each topic. */
export function importAnnotationsBcf(documentId: string, file: File, run: AnnotationFetch = defaultFetch): Promise<BcfImportResult> {
  const body = new FormData()
  body.append('file', file)
  return request(run, `${annotationsPath(documentId)}/bcf`, { method: 'POST', body }, (value) => bcfImportResultSchema.parse(value))
}

/** Where the snapshot image of a viewpoint mark is served from (binary, so no typed read). */
export const annotationSnapshotHref = (documentId: string, annotationId: string): string =>
  `${annotationPath(documentId, annotationId)}/snapshot`

/** The caller's own thread about a document, created when it does not exist (ADR-0106). */
export function documentThread(
  documentId: string,
  { title, run = defaultFetch }: { title?: string; run?: AnnotationFetch } = {}
): Promise<string> {
  return request(
    run,
    `${documentPath(documentId)}/thread`,
    json('POST', title ? { title } : {}),
    (value) => documentThreadResponseSchema.parse(value).conversationId
  )
}

export function deleteAnnotation(
  documentId: string,
  annotationId: string,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<void> {
  return request(
    run,
    annotationPath(documentId, annotationId),
    { method: 'DELETE', headers: peerId ? { [ROOM_PEER_HEADER]: peerId } : {} },
    () => undefined
  )
}

/**
 * A page of a project's Offene Punkte: the live marks of every document of the
 * project this reader may see, each the view a document's list carries, with
 * the document's name (`GET /api/projects/{id}/annotations`).
 */
export function listProjectAnnotations(
  projectId: string,
  filters: ProjectMarksFilters = {},
  { limit, cursor, run = defaultFetch }: { limit?: number; cursor?: string | null; run?: AnnotationFetch } = {}
): Promise<ProjectMarksResponse> {
  return request(run, projectMarksHref(projectId, filters, { limit, cursor }), { method: 'GET' }, (value) =>
    projectMarksResponseSchema.parse(value)
  )
}
