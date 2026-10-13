/**
 * The typed client for a document's Anmerkungen and its room (ADR-0055).
 *
 * The paths, the verbs and the response shapes are written once, here; the
 * browser and the route specs both go through it, so a second consumer cannot
 * disagree with the first about what `PATCH …/annotations/{id}` expects.
 * Responses are parsed with the zod schemas from `./types`, not cast.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { ROOM_PEER_HEADER } from './peer-header'
import type { RoomPost } from './room-types'
import {
  annotationListResponseSchema,
  annotationResponseSchema,
  type AnnotationListResponse,
  type AnnotationView,
  type CreateAnnotationRequest,
  type CreateReplyRequest,
  type UpdateAnnotationRequest,
} from './types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type AnnotationFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: AnnotationFetch = (path, init) => fetch(path, init)

/** A request the API refused, with its status and the body's own code. */
export class AnnotationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
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
    const error = (body ?? {}) as { error?: string; code?: string }
    throw new AnnotationRequestError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`
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
/** The room's SSE stream and its POST, one path. */
export const roomPath = (documentId: string) => `${documentPath(documentId)}/live`

const one = (value: unknown) => annotationResponseSchema.parse(value).annotation

export function listAnnotations(
  documentId: string,
  run: AnnotationFetch = defaultFetch
): Promise<AnnotationListResponse> {
  return request(run, annotationsPath(documentId), { method: 'GET' }, (value) =>
    annotationListResponseSchema.parse(value)
  )
}

export function createAnnotation(
  documentId: string,
  input: CreateAnnotationRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationView> {
  return request(run, annotationsPath(documentId), json('POST', input, peerId), one)
}

export function updateAnnotation(
  documentId: string,
  annotationId: string,
  input: UpdateAnnotationRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationView> {
  return request(run, annotationPath(documentId, annotationId), json('PATCH', input, peerId), one)
}

export function replyToAnnotation(
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  { peerId, run = defaultFetch }: WriteOptions = {}
): Promise<AnnotationView> {
  return request(run, `${annotationPath(documentId, annotationId)}/replies`, json('POST', input, peerId), one)
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
 * Say something to the room. `keepalive`, so a „gone" sent while the tab
 * closes still leaves; a refusal is swallowed, because a pointer is worthless a
 * moment later and the next one is already on its way.
 */
export function postToRoom(documentId: string, post: RoomPost, run: AnnotationFetch = defaultFetch): Promise<void> {
  return run(roomPath(documentId), { ...json('POST', post), keepalive: true }).then(
    () => undefined,
    () => undefined
  )
}
