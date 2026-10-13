/**
 * The document room: who is looking at a document right now, where their
 * pointer is, which page they are on, and that its Anmerkungen changed.
 *
 * One room per document, carried down to each viewer on
 * `GET /api/documents/:id/live` (SSE) and up on `POST /api/documents/:id/live`.
 * The server stamps who sent a message from the session; a client only says
 * what it is doing.
 *
 * NOTHING HERE IS STATE TO CONVERGE ON. Presence is a claim with a TTL, a cursor
 * is worthless a second later, and `annotations.changed` is a hint to re-read
 * through the API (the rule `/api/stream` keeps, spec RT-4). A viewer that lost
 * the stream still has every Anmerkung; it only loses the company.
 *
 * No `server-only`: the browser parses these.
 */

import { z } from 'zod'

/** How long a presence claim holds without a refresh. */
export const PRESENCE_TTL_MS = 25_000
/** How often a viewer refreshes its claim. Well inside the TTL, so one lost refresh is not a departure. */
export const PRESENCE_REFRESH_MS = 10_000
/** The fastest a viewer sends its pointer: about twelve frames a second, interpolated on arrival. */
export const CURSOR_INTERVAL_MS = 80
/** The fastest a viewer sends where it is scrolled to, for those following it. */
export const VIEWPORT_INTERVAL_MS = 200

const unit = z.number().finite().min(0).max(1)

/** One viewer in one tab. `peerId` is the tab's own random id; the same person in two tabs is two peers. */
export const roomPeerSchema = z.object({
  peerId: z.string().min(8).max(64),
  userId: z.string(),
  name: z.string(),
  /** Piloti while it works on the document, a person otherwise. */
  kind: z.enum(['person', 'piloti']),
})
export type RoomPeer = z.infer<typeof roomPeerSchema>

export const roomCursorSchema = z.object({ page: z.number().int().min(1), x: unit, y: unit })
export type RoomCursor = z.infer<typeof roomCursorSchema>

/** Where a viewer is scrolled to: a page, and the share of it at the middle of their view. */
export const roomViewportSchema = z.object({ page: z.number().int().min(1), y: unit })
export type RoomViewport = z.infer<typeof roomViewportSchema>

/** What a viewer sends up. Any combination; the server stamps the peer's identity. */
export const roomPostSchema = z
  .object({
    peerId: z.string().min(8).max(64),
    presence: z.enum(['here', 'gone']).optional(),
    /** `null`: the pointer left the pages. */
    cursor: roomCursorSchema.nullable().optional(),
    viewport: roomViewportSchema.optional(),
    /** What the pointer is doing: setting a mark shows a different cursor to the others. */
    tool: z.enum(['select', 'point', 'region']).optional(),
  })
  .strict()
export type RoomPost = z.infer<typeof roomPostSchema>

export const ANNOTATION_CHANGES = ['created', 'updated', 'deleted', 'replied'] as const
export type AnnotationChange = (typeof ANNOTATION_CHANGES)[number]

export const roomEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('presence'),
    peer: roomPeerSchema,
    state: z.enum(['here', 'gone']),
    ttlMs: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('cursor'),
    peer: roomPeerSchema,
    cursor: roomCursorSchema.nullable(),
    tool: z.enum(['select', 'point', 'region']).optional(),
  }),
  z.object({ kind: z.literal('viewport'), peer: roomPeerSchema, viewport: roomViewportSchema }),
  z.object({
    kind: z.literal('annotations.changed'),
    /** The Anmerkungen it touched, in the order they were set; one for every change but a batch of proposals. */
    annotationIds: z.array(z.string()).min(1),
    change: z.enum(ANNOTATION_CHANGES),
    actor: roomPeerSchema.omit({ peerId: true }).extend({ peerId: z.string().nullable() }),
  }),
])
export type RoomEvent = z.infer<typeof roomEventSchema>

/** What the SSE stream carries: a room event, or one word about the stream itself. */
export const roomFrameSchema = z.union([
  z.object({ kind: z.literal('event'), event: roomEventSchema }),
  z.object({ kind: z.literal('welcome'), self: roomPeerSchema.omit({ peerId: true }) }),
  z.object({ kind: z.literal('revoked') }),
])
export type RoomFrame = z.infer<typeof roomFrameSchema>
