/**
 * The document room (`lib/annotations/room-types.ts`).
 *
 * `GET` — Server-Sent Events: `data: <RoomFrame>` per message. First a
 * `welcome` naming who the server takes this reader to be, then every event of
 * the room, until the reader leaves or may no longer read the document
 * (`revoked`, checked every 30s, after which the stream ends).
 *
 * `POST` — what this viewer is doing: here or gone, where the pointer is, where
 * the view is scrolled. 204. The server stamps who said it.
 *
 * Why its own stream rather than `/api/stream`: that one is per user and
 * carries a handful of hints a minute; a room carries pointers at a dozen a
 * second, to whoever has this document open. The same reasoning
 * `/api/conversations/:id/live` gives for itself.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ROOM_LIMIT } from '@/lib/limits'
import { ROOM_REAUTHORIZE_MS, subscribeToRoom } from '@/lib/annotations/room'
import { postToRoom, requireRoomAccess, selfInRoom, stillInRoom } from '@/lib/annotations/room-service'
import { roomPostSchema, type RoomFrame } from '@/lib/annotations/room-types'

type Params = { id: string }

/** Heartbeat cadence, under the 60s idle timeout of typical proxies. */
const HEARTBEAT_MS = 25_000
/** Reconnect delay after a drop: a room is company, two seconds without it is a gap people notice. */
const RETRY_MS = 2_000

export const dynamic = 'force-dynamic'

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const documentId = params.id
    // Before anything is opened: a document this reader may not see is a 404.
    await requireRoomAccess(session, documentId)

    const encoder = new TextEncoder()
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let recheck: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => Promise<void>) | null = null
    let closed = false

    const teardown = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (recheck) clearInterval(recheck)
      const release = unsubscribe
      unsubscribe = null
      await release?.().catch((error: unknown) => console.warn('[room] unsubscribe failed:', error))
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (chunk: string): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            void teardown()
          }
        }
        const send = (frame: RoomFrame) => write(`data: ${JSON.stringify(frame)}\n\n`)
        const close = (): void => {
          void teardown()
          try {
            controller.close()
          } catch {
            // Already closed by the cancel path.
          }
        }

        write(`retry: ${RETRY_MS}\n\n`)
        send({ kind: 'welcome', self: selfInRoom(session) })
        heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)

        const release = await subscribeToRoom(documentId, (event) => send({ kind: 'event', event }))
        if (closed) {
          await release().catch(() => {})
          return
        }
        unsubscribe = release

        recheck = setInterval(() => {
          void stillInRoom(session, documentId).then((allowed) => {
            if (allowed || closed) return
            send({ kind: 'revoked' })
            close()
          })
        }, ROOM_REAUTHORIZE_MS)

        request.signal.addEventListener('abort', () => void teardown(), { once: true })
        if (request.signal.aborted) await teardown()
      },
      async cancel() {
        await teardown()
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  },
  { authz: { enforcedBy: 'requireRoomAccess -> getAccessibleDocument (read)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, request, params }) =>
    postToRoom(session, params.id, await parseJsonBody(request, roomPostSchema)),
  {
    authz: { enforcedBy: 'postToRoom -> requireRoomAccess -> getAccessibleDocument (read)' },
    limits: { rule: ROOM_LIMIT },
  }
)
