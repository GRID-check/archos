/**
 * The wire of the live channels (`lib/realtime`, ADR-0104): what one SSE
 * connection carries down and what one POST carries up, whatever the channel.
 *
 * A channel is named by a key, `<kind>:<id>` (`doc:<uuid>`). One connection
 * (`GET /api/realtime?ch=…&ch=…`) carries every channel a tab has open; each
 * frame names its channel in `ch`, so the browser demultiplexes. Up is
 * `POST /api/realtime/send` with `{ ch, msg }`, and the channel's own schema
 * decides what `msg` may be.
 *
 * Three classes of message travel on a channel, and none of them is state to
 * converge on (spec RT-4):
 *
 * - **presence**: "I am here", a claim with a TTL. The client names only its
 *   tab (`peerId`); the server stamps who it is (`userId`, `name`, `kind`) from
 *   the session, so nobody can be present as somebody else.
 * - **ephemeral**: a pointer, a scroll position, what Piloti is reading. Worth
 *   nothing a second later, so it is throttled, shed under load, and never
 *   retried.
 * - **hint**: "this changed" (`annotations.changed`). The receiver re-reads
 *   through the API; the hint itself is never trusted as the data.
 *
 * And three control frames about the connection itself: `welcome` (who the
 * server takes this reader to be), `revoked{ch}` (the reader may no longer be
 * in that channel; the server dropped it) and `unsupported{ch}` (no such
 * channel kind, or a key that does not parse).
 *
 * No `server-only`: the browser parses these.
 */

import { z } from 'zod'

/** The most channels one connection may carry. A tab with more is doing something wrong. */
export const MAX_CHANNELS_PER_CONNECTION = 8

/** `<kind>:<id>`: a lowercase kind, then an id of URL-safe characters. */
export const channelKeySchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,128}$/)
export type ChannelKey = z.infer<typeof channelKeySchema>

/** The kind of a channel key (`doc` for `doc:<id>`), or null when it is not a key. */
export function channelKind(key: string): string | null {
  const parsed = channelKeySchema.safeParse(key)
  return parsed.success ? key.slice(0, key.indexOf(':')) : null
}

/** One tab of one participant. `peerId` is the tab's own random id; the same person in two tabs is two peers. */
export const realtimePeerSchema = z.object({
  peerId: z.string().min(8).max(64),
  userId: z.string(),
  name: z.string(),
  /** Piloti while it works on the resource, a person otherwise. */
  kind: z.enum(['person', 'piloti']),
  /**
   * For Piloti: the display name of the person it acts for, so everyone in the
   * channel sees whose request it is working on (ADR-0105; EU AI Act Art. 50).
   * Only the server stamps it (`publishAsAgent`); a browser's peer is stamped
   * from its session and never has one. Absent when the name could not be read.
   */
  forName: z.string().min(1).max(120).optional(),
})
export type RealtimePeer = z.infer<typeof realtimePeerSchema>

/** Who the server takes the reader of a connection to be. */
export const realtimeSelfSchema = realtimePeerSchema.omit({ peerId: true, forName: true })
export type RealtimeSelf = z.infer<typeof realtimeSelfSchema>

export const PRESENCE_STATES = ['here', 'gone'] as const
export type PresenceState = (typeof PRESENCE_STATES)[number]

/** The presence class, the same on every channel that has presence. */
export const presenceEventSchema = z.object({
  kind: z.literal('presence'),
  peer: realtimePeerSchema,
  state: z.enum(PRESENCE_STATES),
  ttlMs: z.number().int().positive(),
})
export type PresenceEvent = z.infer<typeof presenceEventSchema>

/**
 * What every upstream message carries: the tab that says it, and optionally a
 * presence claim. A channel's own upstream schema extends this.
 */
export const upstreamBaseSchema = z.object({
  peerId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  presence: z.enum(PRESENCE_STATES).optional(),
})
export type UpstreamBase = z.infer<typeof upstreamBaseSchema>

/** The body of `POST /api/realtime/send`. `msg` is checked by the channel's own schema. */
export const sendBodySchema = z.object({ ch: channelKeySchema, msg: z.unknown() }).strict()
export type SendBody = z.infer<typeof sendBodySchema>

/** An event as it travels: an object with a `kind`. Each channel narrows it with its own schema. */
export const channelEventSchema = z.object({ kind: z.string().min(1) }).passthrough()
export type ChannelEvent = z.infer<typeof channelEventSchema>

/** One SSE frame of `GET /api/realtime`. */
export const realtimeFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('welcome'), self: realtimeSelfSchema }),
  z.object({ kind: z.literal('event'), ch: channelKeySchema, event: channelEventSchema }),
  z.object({ kind: z.literal('revoked'), ch: channelKeySchema }),
  z.object({ kind: z.literal('unsupported'), ch: channelKeySchema }),
])
export type RealtimeFrame = z.infer<typeof realtimeFrameSchema>

/** The stream's path for a set of channels. */
export function realtimeStreamPath(channels: readonly string[]): string {
  const query = new URLSearchParams()
  for (const ch of channels) query.append('ch', ch)
  return `/api/realtime?${query.toString()}`
}

export const REALTIME_SEND_PATH = '/api/realtime/send'
