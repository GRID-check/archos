'use client'

/**
 * A document room between browser tabs, for the `/dev/sketch-room` preview:
 * a `RoomTransport` over a `BroadcastChannel`, which stamps and relays a post
 * the way `POST /api/realtime/send` and the hub do (the sender's own tab hears
 * its echo too, and a reader's edit is refused with a 403). No server, no
 * session: two tabs of the preview are two people in one room.
 *
 * `window.__sketchRoomDropRate` (0…1) drops that share of what this tab hears
 * from others, so the preview can show a lost delta being repaired.
 */

import { roomEventSchema, type RoomFrame, type RoomPost } from '@/lib/annotations/room-types'
import { sketchEventsOf } from '@/lib/diagrams/sketch-room-types'
import type { RealtimePeer } from '@/lib/realtime/types'
import type { RoomTransport } from '@/features/documents/document-room'

declare global {
  interface Window {
    __sketchRoomDropRate?: number
  }
}

export interface BroadcastIdentity {
  userId: string
  name: string
  canWrite: boolean
}

const eventsOf = (post: RoomPost, peer: RealtimePeer) => [
  ...(post.presence ? [{ kind: 'presence', peer, state: post.presence, ttlMs: 25_000 }] : []),
  ...sketchEventsOf(post, peer),
]

export function broadcastRoomTransport(documentId: string, identity: BroadcastIdentity): RoomTransport {
  const name = `sketch-room:${documentId}`
  let local: ((frame: RoomFrame) => void) | null = null
  let channel: BroadcastChannel | null = null
  const hear = (event: unknown, fromSelf: boolean) => {
    if (!fromSelf && Math.random() < (window.__sketchRoomDropRate ?? 0)) return
    const parsed = roomEventSchema.safeParse(event)
    if (parsed.success) local?.({ kind: 'event', event: parsed.data })
  }
  return {
    connect({ onFrame, onOpen }) {
      local = onFrame
      channel = new BroadcastChannel(name)
      channel.onmessage = (message: MessageEvent<unknown>) => hear(message.data, false)
      queueMicrotask(() => {
        onFrame({ kind: 'welcome', self: { userId: identity.userId, name: identity.name, kind: 'person' } })
        onOpen()
      })
      return () => {
        channel?.close()
        channel = null
        local = null
      }
    },
    async post(post) {
      if (!identity.canWrite && (post.delta || post.saved)) return { status: 403, retryAfterMs: 0 }
      const peer: RealtimePeer = { peerId: post.peerId, userId: identity.userId, name: identity.name, kind: 'person' }
      for (const event of eventsOf(post, peer)) {
        channel?.postMessage(event)
        hear(event, true)
      }
      return { status: 204, retryAfterMs: 0 }
    },
  }
}
