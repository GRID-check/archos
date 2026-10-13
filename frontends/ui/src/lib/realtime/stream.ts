/**
 * The one copy of the live channels' SSE plumbing (ADR-0104): a tab's channels
 * on one `text/event-stream`.
 *
 * In order:
 *
 * 1. Every key is resolved and authorized before anything is opened. A key no
 *    channel knows is `unsupported{ch}`, a channel the reader may not be in is
 *    `revoked{ch}`; the others are subscribed. A failure that is not a refusal
 *    (the database is down) fails the whole request, so the browser retries
 *    rather than dropping a channel it may be in.
 * 2. `welcome` names who the server takes the reader to be.
 * 3. Each channel's hub topics are listened to; an event that does not parse as
 *    the channel's vocabulary is dropped.
 * 4. Every channel re-authorizes on its own cadence while open, uncached. A
 *    refusal sends `revoked{ch}` and drops that channel; a stream left with no
 *    channel ends.
 * 5. The stream ends after {@link MAX_STREAM_AGE_MS} regardless, so a session
 *    that expired or changed organization is re-resolved by the reconnect
 *    rather than outliving itself on an open socket.
 *
 * Teardown is idempotent: the abort, the cancel, a failed write, the age limit
 * and the last revoke may each come first, and the second is a no-op.
 */

import 'server-only'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { forgetSendGrant, isAccessRefusal, type AnyChannel } from './channel'
import { subscribe } from './hub'
import { CHANNELS, resolveChannel, type ResolvedChannel } from './registry'
import { channelKeySchema, MAX_CHANNELS_PER_CONNECTION, type RealtimeFrame, type RealtimeSelf } from './types'

/** Heartbeat cadence, under the 60s idle timeout of typical proxies. */
export const HEARTBEAT_MS = 25_000
/** The browser's reconnect delay after a drop. */
export const RETRY_MS = 2_000
/** How long one stream lives before the browser reconnects and the session is resolved again. */
export const MAX_STREAM_AGE_MS = 10 * 60_000

export interface StreamOptions {
  heartbeatMs?: number
  maxAgeMs?: number
  channels?: Readonly<Record<string, AnyChannel>>
}

/** Who the session is on a channel: the server's word for it, never the client's. */
export function selfOf(session: AuthorizedSession): RealtimeSelf {
  return { userId: session.userId, name: session.name ?? session.email, kind: 'person' }
}

/** The distinct channel keys of a request, validated: 400 for none, too many, or a malformed one. */
export function channelKeysOf(request: Request): string[] {
  const keys = [...new Set(new URL(request.url).searchParams.getAll('ch'))]
  if (keys.length === 0) throw new BadRequestError('Name at least one channel (?ch=<kind>:<id>).')
  if (keys.length > MAX_CHANNELS_PER_CONNECTION) {
    throw new BadRequestError(`At most ${MAX_CHANNELS_PER_CONNECTION} channels per connection.`)
  }
  for (const key of keys) {
    if (!channelKeySchema.safeParse(key).success) throw new BadRequestError(`Not a channel key: ${key.slice(0, 40)}`)
  }
  return keys
}

type Opened = { resolved: ResolvedChannel; release: Array<() => void>; recheck: ReturnType<typeof setInterval> | null }

async function authorizeAll(
  session: AuthorizedSession,
  keys: readonly string[],
  channels: Readonly<Record<string, AnyChannel>>
): Promise<{ allowed: ResolvedChannel[]; refused: RealtimeFrame[] }> {
  const allowed: ResolvedChannel[] = []
  const refused: RealtimeFrame[] = []
  await Promise.all(
    keys.map(async (key) => {
      const resolved = resolveChannel(key, channels)
      if (!resolved) {
        refused.push({ kind: 'unsupported', ch: key })
        return
      }
      try {
        await resolved.channel.authorize(session, resolved.params)
        allowed.push(resolved)
      } catch (error) {
        if (!isAccessRefusal(error)) throw error
        refused.push({ kind: 'revoked', ch: key })
      }
    })
  )
  return { allowed, refused }
}

/** Open the SSE response for a session's channels. Throws only before the stream exists. */
export async function openRealtimeStream(
  session: AuthorizedSession,
  keys: readonly string[],
  request: Request,
  { heartbeatMs = HEARTBEAT_MS, maxAgeMs = MAX_STREAM_AGE_MS, channels = CHANNELS }: StreamOptions = {}
): Promise<Response> {
  const { allowed, refused } = await authorizeAll(session, keys, channels)

  const encoder = new TextEncoder()
  const open = new Map<string, Opened>()
  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = []
  let closed = false
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null

  const drop = (key: string): void => {
    const entry = open.get(key)
    if (!entry) return
    open.delete(key)
    if (entry.recheck) clearInterval(entry.recheck)
    for (const release of entry.release) release()
  }

  const teardown = (): void => {
    if (closed) return
    closed = true
    for (const timer of timers) clearInterval(timer)
    for (const key of [...open.keys()]) drop(key)
    try {
      controllerRef?.close()
    } catch {
      // Already closed by the cancel path.
    }
  }

  const write = (chunk: string): void => {
    if (closed || !controllerRef) return
    try {
      controllerRef.enqueue(encoder.encode(chunk))
    } catch {
      teardown()
    }
  }
  const send = (frame: RealtimeFrame) => write(`data: ${JSON.stringify(frame)}\n\n`)

  const revoke = (key: string): void => {
    if (closed || !open.has(key)) return
    drop(key)
    forgetSendGrant(session, key)
    send({ kind: 'revoked', ch: key })
    if (open.size === 0) teardown()
  }

  const attach = ({ key, channel, params }: ResolvedChannel): void => {
    const entry: Opened = { resolved: { key, channel, params }, release: [], recheck: null }
    open.set(key, entry)
    for (const topic of channel.topics(params)) {
      entry.release.push(
        subscribe(topic, (payload) => {
          const parsed = channel.events.safeParse(payload)
          if (parsed.success) send({ kind: 'event', ch: key, event: parsed.data })
        })
      )
    }
    entry.recheck = setInterval(() => {
      channel.authorize(session, params).then(
        () => undefined,
        (error: unknown) => {
          if (isAccessRefusal(error)) revoke(key)
          else console.warn(`[realtime] re-check of ${key} failed, keeping it until the next one:`, error)
        }
      )
    }, channel.reauthorizeMs)
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      write(`retry: ${RETRY_MS}\n\n`)
      send({ kind: 'welcome', self: selfOf(session) })
      for (const frame of refused) send(frame)
      if (allowed.length === 0) {
        teardown()
        return
      }
      for (const resolved of allowed) attach(resolved)
      timers.push(setInterval(() => write(': ping\n\n'), heartbeatMs))
      timers.push(setTimeout(teardown, maxAgeMs))
      request.signal.addEventListener('abort', teardown, { once: true })
      if (request.signal.aborted) teardown()
    },
    cancel() {
      teardown()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx-class proxies buffer otherwise, and pointers arrive in batches.
      'X-Accel-Buffering': 'no',
    },
  })
}
