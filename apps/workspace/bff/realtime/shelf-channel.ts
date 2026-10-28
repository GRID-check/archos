/**
 * A shelf as a live channel: `shelf:project-<projectId>` and `shelf:archiv`
 * (ADR-0110, ADR-0078).
 *
 * Being in the channel is reading the shelf, by the same rule as its listing:
 * `requireShelfRead` (`project:view` on the project; any member for the
 * Archiv). The topic carries the session's organization, so the Archiv's key
 * names the tenant's own Archiv and no other.
 *
 * The browsers say nothing here (no upstream); the speakers are the server's
 * writers of the shelf (`lib/documents/shelf-live.ts`), after each write. The
 * event is a hint: the workspace re-reads through the API, which hides what
 * this reader may not see (a held upload, a restricted folder).
 */

import 'server-only'
import { requireShelfRead } from '@/lib/documents/shelf-authz'
import { parseShelfChannelId, shelfEventSchema, shelfTopic } from '@/lib/documents/shelf-live-events'
import { defineChannel } from './channel'

/** How often an open stream checks that its reader may still read the shelf. */
export const SHELF_REAUTHORIZE_MS = 30_000

export const shelfChannel = defineChannel({
  kind: 'shelf',
  parse: parseShelfChannelId,
  topics: (shelf, organizationId) => [shelfTopic(organizationId, shelf)],
  authorize: async (session, shelf) => {
    await requireShelfRead(session, shelf)
  },
  reauthorizeMs: SHELF_REAUTHORIZE_MS,
  events: shelfEventSchema,
})
