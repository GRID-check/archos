/**
 * The document room: who is looking at a document right now, where their
 * pointer is, which page they are on, what Piloti is reading, and that its
 * Anmerkungen changed.
 *
 * The room is the `doc:<id>` channel of the live channels (`lib/realtime`,
 * ADR-0104): carried down on the tab's one `GET /api/realtime` stream and up on
 * `POST /api/realtime/send`, with these schemas as the channel's vocabulary
 * (`lib/realtime/document-channel.ts`). The server stamps who sent a message
 * from the session; a client only says what it is doing.
 *
 * NOTHING HERE IS STATE TO CONVERGE ON. Presence is a claim with a TTL, a cursor
 * is worthless a second later, and `annotations.changed` is a hint to re-read
 * through the API (the rule `/api/stream` keeps, spec RT-4). A viewer that lost
 * the stream still has every Anmerkung; it only loses the company.
 *
 * No `server-only`: the browser parses these.
 */

import { z } from 'zod'
import { realtimePeerSchema, realtimeSelfSchema, upstreamBaseSchema } from '@/lib/realtime/types'

/** How long a presence claim holds without a refresh. */
export const PRESENCE_TTL_MS = 25_000
/** How often a viewer refreshes its claim. Well inside the TTL, so one lost refresh is not a departure. */
export const PRESENCE_REFRESH_MS = 10_000
/** The fastest a viewer sends its pointer: about twelve frames a second, interpolated on arrival. */
export const CURSOR_INTERVAL_MS = 80
/** The fastest a viewer sends where it is scrolled to, for those following it. */
export const VIEWPORT_INTERVAL_MS = 200

const unit = z.number().finite().min(0).max(1)

/** The longest cursor chat a viewer can show beside its pointer. */
export const CURSOR_CHAT_MAX = 140

/** One viewer in one tab. `peerId` is the tab's own random id; the same person in two tabs is two peers. */
export const roomPeerSchema = realtimePeerSchema
export type RoomPeer = z.infer<typeof roomPeerSchema>

export const ROOM_TOOLS = ['select', 'point', 'region'] as const
export type RoomTool = (typeof ROOM_TOOLS)[number]

export const roomCursorSchema = z.object({ page: z.number().int().min(1), x: unit, y: unit })
export type RoomCursor = z.infer<typeof roomCursorSchema>

/** Where a viewer is scrolled to: a page, and the share of it at the middle of their view. */
export const roomViewportSchema = z.object({ page: z.number().int().min(1), y: unit })
export type RoomViewport = z.infer<typeof roomViewportSchema>

/** A box on a page, as shares of it: a region a viewer is dragging out, or what Piloti is reading. */
const boxShape = { x: unit, y: unit, w: unit, h: unit }
export const roomDraftSchema = z.object(boxShape)
export type RoomDraft = z.infer<typeof roomDraftSchema>
export const roomBoxSchema = z.object({ page: z.number().int().min(1), ...boxShape })
export type RoomBox = z.infer<typeof roomBoxSchema>

const draftField = roomDraftSchema.nullable().optional()
const chatField = z.string().trim().max(CURSOR_CHAT_MAX).nullable().optional()
/** The mark a viewer has selected (an Anmerkung's id); `null` when none. */
const selectedField = z.string().min(1).max(64).nullable().optional()
const labelField = z.string().trim().min(1).max(CURSOR_CHAT_MAX).optional()

/** How long a highlight shows when its sender names no time. */
export const HIGHLIGHT_TTL_MS = 6_000

/** What a viewer sends up. Any combination; the server stamps the peer's identity. */
export const roomPostSchema = upstreamBaseSchema
  .extend({
    /** `null`: the pointer left the pages. */
    cursor: roomCursorSchema.nullable().optional(),
    viewport: roomViewportSchema.optional(),
    /** What the pointer is doing: setting a mark shows a different cursor to the others. */
    tool: z.enum(ROOM_TOOLS).optional(),
    /** The region this viewer is dragging out, on the cursor's page; `null` when none. Travels with the cursor. */
    draft: draftField,
    /** A line of cursor chat beside the pointer; `null` clears it. Travels with the cursor. */
    chat: chatField,
    /** The mark this viewer has selected; `null` when none. Travels as a viewport event. */
    selected: selectedField,
  })
  .strict()
export type RoomPost = z.infer<typeof roomPostSchema>

export const PILOTI_ACTIVITY_STATES = ['reading', 'idle'] as const
export type PilotiActivityState = (typeof PILOTI_ACTIVITY_STATES)[number]

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
    tool: z.enum(ROOM_TOOLS).optional(),
    /** Absent: unchanged. */
    draft: draftField,
    /** Absent: unchanged. */
    chat: chatField,
    /** A name beside the pointer: Piloti's, saying what it points at. Only the server sets it. */
    label: labelField,
  }),
  z.object({
    kind: z.literal('viewport'),
    peer: roomPeerSchema,
    /** Absent: unchanged (a selection alone). */
    viewport: roomViewportSchema.optional(),
    /** Absent: unchanged. */
    selected: selectedField,
  }),
  /**
   * What Piloti is doing on the document, in a few words („sieht sich Seite 2
   * an"), and the region it reads. Published by the server (`publishAsAgent`),
   * never by a browser. `idle` clears it; Piloti leaves with `presence: gone`.
   */
  z.object({
    kind: z.literal('activity'),
    peer: roomPeerSchema,
    state: z.enum(PILOTI_ACTIVITY_STATES),
    box: roomBoxSchema.optional(),
    label: labelField,
  }),
  /**
   * A box Piloti draws for a moment to show what it means: transient, gone
   * after `ttlMs`. Published by the server (`publishAsAgent`), never by a
   * browser.
   */
  z.object({
    kind: z.literal('highlight'),
    peer: roomPeerSchema,
    box: roomBoxSchema,
    label: labelField,
    ttlMs: z.number().int().positive().max(60_000),
  }),
  z.object({
    kind: z.literal('annotations.changed'),
    /** The Anmerkungen it touched, in the order they were set; one for every change but a batch of proposals. */
    annotationIds: z.array(z.string()).min(1),
    change: z.enum(ANNOTATION_CHANGES),
    actor: roomPeerSchema.omit({ peerId: true }).extend({ peerId: z.string().nullable() }),
  }),
])
export type RoomEvent = z.infer<typeof roomEventSchema>

export type RoomActivity = Extract<RoomEvent, { kind: 'activity' }>
export type RoomHighlight = Extract<RoomEvent, { kind: 'highlight' }>

/**
 * What the room hears, one channel's share of the tab's stream: a room event,
 * or one word about the stream itself. The `/dev` preview and the specs play
 * these through a `RoomTransport` (`features/documents/hooks/use-document-room`).
 */
export const roomFrameSchema = z.union([
  z.object({ kind: z.literal('event'), event: roomEventSchema }),
  z.object({ kind: z.literal('welcome'), self: realtimeSelfSchema }),
  z.object({ kind: z.literal('revoked') }),
])
export type RoomFrame = z.infer<typeof roomFrameSchema>
