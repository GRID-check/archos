/**
 * The tab's one live connection (ADR-0110): ONE `EventSource` carrying every
 * channel the tab has open, demultiplexed by `ch`, and one POST path up.
 *
 * Channels are ref-counted: two components in one document's room are one
 * channel on the wire. When the set of channels changes, the connection is
 * reopened with the new `?ch=` list, debounced so a page that mounts five
 * channels in one render reconnects once. A channel the server answers with
 * `revoked` or `unsupported` leaves the list until whoever joined it joins
 * again, so a reconnect never asks for it twice.
 *
 * Like the per-user hub (`features/collaboration/lib/event-hub.ts`) this is an
 * accelerator, never a source of truth: nothing a channel carries is state a
 * tab has to converge on, so a reconnect does not replay.
 */

import { createRetryLadder, type RetryLadder } from '@/shared/utils/backoff'
import {
  realtimeFrameSchema,
  realtimeStreamPath,
  REALTIME_SEND_PATH,
  type ChannelEvent,
  type RealtimeSelf,
} from '@/lib/realtime/types'

export type ChannelStatus = 'connecting' | 'live' | 'offline'

/** What a channel's joiner hears. */
export interface ChannelHandlers {
  onEvent(event: ChannelEvent): void
  /** Who the server takes this reader to be, on every (re)connect that carries the channel. */
  onWelcome?(self: RealtimeSelf): void
  /** The server dropped the channel: the reader may no longer be in it, or it does not exist. */
  onClosed?(reason: 'revoked' | 'unsupported'): void
  onStatus?(status: ChannelStatus): void
}

export interface RealtimeConnection {
  /** Join a channel. Returns the leave, which is idempotent. */
  join(ch: string, handlers: ChannelHandlers): () => void
  /** Say something in a channel. Fire and forget: a refusal is dropped, the next message is on its way. */
  send(ch: string, msg: unknown): void
  /** The status of one channel now. */
  status(ch: string): ChannelStatus
  /** Close everything: for tests. */
  dispose(): void
}

interface EventSourceLike {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  close(): void
}

export interface ConnectionOptions {
  createSource?: (url: string) => EventSourceLike
  post?: (path: string, body: string) => void
  /** How long a change of the channel set waits for more before reconnecting. */
  debounceMs?: number
  ladder?: RetryLadder
}

const defaultPost = (path: string, body: string) => {
  if (typeof fetch !== 'function') return
  void fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(
    () => undefined
  )
}

const defaultSource = (url: string): EventSourceLike | null =>
  typeof EventSource === 'undefined' ? null : (new EventSource(url) as unknown as EventSourceLike)

export function createRealtimeConnection({
  createSource,
  post = defaultPost,
  debounceMs = 250,
  ladder = createRetryLadder({ baseMs: 1_000, maxMs: 30_000 }),
}: ConnectionOptions = {}): RealtimeConnection {
  const joined = new Map<string, Set<ChannelHandlers>>()
  /** Channels the server closed; not asked for again until joined anew. */
  const dropped = new Set<string>()
  let source: EventSourceLike | null = null
  /** The channels the open (or opening) source carries. */
  let carried = new Set<string>()
  let live = false
  let self: RealtimeSelf | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null

  const wanted = () => [...joined.keys()].filter((ch) => !dropped.has(ch)).sort()

  const status = (ch: string): ChannelStatus => {
    if (dropped.has(ch)) return 'offline'
    if (live && carried.has(ch)) return 'live'
    return source || debounce ? 'connecting' : 'offline'
  }

  const each = (ch: string, run: (handlers: ChannelHandlers) => void) => {
    for (const handlers of [...(joined.get(ch) ?? [])]) {
      try {
        run(handlers)
      } catch (error) {
        console.warn('[realtime] channel handler threw:', error)
      }
    }
  }
  const announceStatus = () => {
    for (const ch of joined.keys()) {
      const now = status(ch)
      each(ch, (handlers) => handlers.onStatus?.(now))
    }
  }

  const closeSource = () => {
    if (!source) return
    source.onopen = source.onerror = source.onmessage = null
    source.close()
    source = null
    live = false
  }

  const open = (): void => {
    const channels = wanted()
    closeSource()
    carried = new Set(channels)
    if (channels.length === 0) {
      ladder.reset()
      announceStatus()
      return
    }
    const next = (createSource ?? defaultSource)(realtimeStreamPath(channels))
    if (!next) {
      announceStatus()
      return
    }
    source = next
    next.onopen = () => {
      ladder.reset()
      live = true
      announceStatus()
    }
    next.onerror = () => {
      // Take control, as the per-user hub does: EventSource retries only some
      // failures by itself, and a 4xx would close it for good. Our ladder backs
      // off with jitter instead of letting a fleet reconnect in step.
      closeSource()
      announceStatus()
      if (wanted().length > 0) ladder.schedule(open)
    }
    next.onmessage = (message) => {
      let raw: unknown
      try {
        raw = JSON.parse(message.data)
      } catch {
        return
      }
      const parsed = realtimeFrameSchema.safeParse(raw)
      if (!parsed.success) return
      const frame = parsed.data
      if (frame.kind === 'welcome') {
        self = frame.self
        live = true
        for (const ch of carried) each(ch, (handlers) => handlers.onWelcome?.(frame.self))
        announceStatus()
      } else if (frame.kind === 'event') {
        if (carried.has(frame.ch)) each(frame.ch, (handlers) => handlers.onEvent(frame.event))
      } else {
        dropped.add(frame.ch)
        carried.delete(frame.ch)
        each(frame.ch, (handlers) => handlers.onClosed?.(frame.kind))
        each(frame.ch, (handlers) => handlers.onStatus?.('offline'))
        // The server ends a stream left with nothing; reopen for the rest, without it.
        schedule()
      }
    }
    announceStatus()
  }

  /** Reopen with the current channel set, once things settle. */
  const schedule = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      const now = wanted()
      const same = now.length === carried.size && now.every((ch) => carried.has(ch))
      if (same && source) return
      ladder.cancel()
      open()
    }, debounceMs)
  }

  return {
    join(ch, handlers) {
      let set = joined.get(ch)
      if (!set) {
        set = new Set()
        joined.set(ch, set)
        dropped.delete(ch)
        schedule()
      }
      set.add(handlers)
      handlers.onStatus?.(status(ch))
      if (live && self && carried.has(ch)) handlers.onWelcome?.(self)
      let left = false
      return () => {
        if (left) return
        left = true
        const current = joined.get(ch)
        if (!current?.delete(handlers) || current.size > 0) return
        joined.delete(ch)
        dropped.delete(ch)
        schedule()
      }
    },
    send(ch, msg) {
      post(REALTIME_SEND_PATH, JSON.stringify({ ch, msg }))
    },
    status,
    dispose() {
      if (debounce) clearTimeout(debounce)
      debounce = null
      ladder.cancel()
      closeSource()
      joined.clear()
      dropped.clear()
      carried = new Set()
    },
  }
}

let shared: RealtimeConnection | null = null

/** The tab's connection, made on first use. */
export function getRealtimeConnection(): RealtimeConnection {
  return (shared ??= createRealtimeConnection())
}

/** Test seam: drop the tab's connection. */
export function __resetRealtimeConnection(): void {
  shared?.dispose()
  shared = null
}
