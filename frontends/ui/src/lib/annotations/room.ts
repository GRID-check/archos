/**
 * The document room's transport: publish to and subscribe to ONE document's
 * channel (`./room-types` for what travels on it).
 *
 * ## Why a per-document channel, and why authorization is at subscribe time
 *
 * `@/lib/events/bus` addresses users: the server picks the audience at publish
 * time, and a channel only carries what was addressed to its owner. A pointer
 * moving twelve times a second cannot be fanned out per person like that, and
 * the audience of a room is "whoever is looking", which nobody knows at publish
 * time. So the room is per resource, like `conv:<id>:events`
 * (`@/lib/events/conversation-frames`), and carries the same burden: the live
 * route authorizes the document before it subscribes and again every
 * {@link ROOM_REAUTHORIZE_MS} while the stream is open, and closes it when the
 * reader may no longer read the document.
 *
 * ## Transport
 *
 * Every publish goes to the in-process fan-out, which is all a single process
 * (development, one replica) needs, and to Dragonfly when `REDIS_URL` is set,
 * for viewers held by another replica. A message carries the publishing
 * process's id, so the replica that published it drops its own echo instead of
 * delivering it twice. Publishing never throws: the room is company, not state.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { InProcessTransport, RedisTransport, type EventTransport } from '@/lib/events/bus'
import { roomEventSchema, type RoomEvent } from './room-types'

/** How often an open stream checks that its reader may still read the document. */
export const ROOM_REAUTHORIZE_MS = 30_000

const PROCESS_ID = randomUUID()

export function roomChannel(documentId: string): string {
  return `doc:${documentId}:room`
}

let local: InProcessTransport | null = null
let remote: EventTransport | null | undefined

const getLocal = () => (local ??= new InProcessTransport())

function getRemote(): EventTransport | null {
  if (remote !== undefined) return remote
  const url = process.env.REDIS_URL
  try {
    remote = url ? new RedisTransport(url) : null
  } catch (error) {
    console.warn('[room] no redis transport, staying in-process:', error)
    remote = null
  }
  return remote
}

/** Test seam: force a remote transport (or none) and reset the local fan-out. */
export function __setRoomTransportForTests(next: EventTransport | null): void {
  remote = next
  local = new InProcessTransport()
}

/** Publish one event to everyone in a document's room. Never throws. */
export async function publishToRoom(documentId: string, event: RoomEvent): Promise<void> {
  const channel = roomChannel(documentId)
  try {
    await getLocal().publish(channel, JSON.stringify(event))
  } catch (error) {
    console.warn('[room] local publish failed:', error)
  }
  const transport = getRemote()
  if (!transport) return
  try {
    await transport.publish(channel, JSON.stringify({ origin: PROCESS_ID, event }))
  } catch (error) {
    console.warn('[room] publish failed (other replicas miss this one):', error)
  }
}

/**
 * Subscribe to a document's room. The returned function MUST be called: a
 * remote subscription holds its own connection. The CALLER authorizes.
 */
export async function subscribeToRoom(
  documentId: string,
  onEvent: (event: RoomEvent) => void
): Promise<() => Promise<void>> {
  const channel = roomChannel(documentId)
  const deliver = (value: unknown) => {
    const parsed = roomEventSchema.safeParse(value)
    if (parsed.success) onEvent(parsed.data)
  }
  const releaseLocal = await getLocal().subscribe(channel, (payload) => deliver(safeJson(payload)))
  const transport = getRemote()
  if (!transport) return releaseLocal
  let releaseRemote: (() => Promise<void>) | null = null
  try {
    releaseRemote = await transport.subscribe(channel, (payload) => {
      const message = safeJson(payload) as { origin?: unknown; event?: unknown } | null
      // Our own publish already went out through the local fan-out.
      if (!message || message.origin === PROCESS_ID) return
      deliver(message.event)
    })
  } catch (error) {
    console.warn('[room] remote subscribe failed, this viewer sees only this replica:', error)
  }
  return async () => {
    await releaseLocal()
    await releaseRemote?.()
  }
}

function safeJson(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}
