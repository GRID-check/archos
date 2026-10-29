/**
 * `POST /api/realtime/send` — say something in a live channel (ADR-0110):
 * `{ ch, msg }`, 204. The channel's definition authorizes the sender, spends
 * its own rate limit and decides what `msg` may be; the server stamps who said
 * it (`lib/realtime/send.ts`). A body past `REALTIME_SEND_MAX_BYTES` is a 413,
 * unread.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { sendToChannel } from '@/lib/realtime/send'
import { REALTIME_SEND_MAX_BYTES, sendBodySchema } from '@/lib/realtime/types'

export const POST = apiRoute(
  async ({ session, request }) => sendToChannel(session, await parseJsonBody(request, sendBodySchema, { maxBytes: REALTIME_SEND_MAX_BYTES })),
  {
    authz: { enforcedBy: 'registry channel.authorizeSend (sendToChannel, cached for the channel reauthorizeMs)' },
    limits: { none: true, why: 'sendToChannel spends the channel’s own limits after authorizing (the document room: ROOM_LIMIT for motion, ROOM_CLAIM_LIMIT for claims, SKETCH_EDIT_LIMIT for a sketch’s edits, SKETCH_WANT_LIMIT for its requests for the whole scene).' },
  }
)
