/**
 * `GET /api/realtime?ch=<kind>:<id>&ch=…` — a tab's live channels on one
 * Server-Sent Events stream (ADR-0110, `lib/realtime`).
 *
 * `data: <RealtimeFrame>` per message: first `welcome`, then `{kind:'event',
 * ch, event}` for each channel, and `revoked{ch}` / `unsupported{ch}` for a
 * channel the reader may not (or can no longer) be in, or that does not exist.
 * Each channel is authorized by its registry definition before it is opened
 * and re-authorized while open; the stream ends after ten minutes so the
 * reconnect resolves the session again.
 */

import { apiRoute } from '@/lib/api/handler'
import { channelKeysOf, openRealtimeStream } from '@/lib/realtime/stream'

/** Long-lived response: never prerender, never cache. */
export const dynamic = 'force-dynamic'

export const GET = apiRoute(
  async ({ session, request }) => openRealtimeStream(session, channelKeysOf(request), request),
  { authz: { enforcedBy: 'registry channel.authorize (openRealtimeStream, per channel, re-checked while open)' } }
)
