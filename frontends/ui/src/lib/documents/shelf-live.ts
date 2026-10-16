import 'server-only'
/**
 * Publishing that a shelf changed to its live channel (`shelf:<id>`,
 * `lib/realtime/shelf-channel.ts`). Separate from the channel definition so
 * the writers (uploads, deletes, moves, folders) can publish without importing
 * the channel, which imports the shelf's authorization.
 *
 * Called AFTER the write has committed, never inside its transaction: the
 * receiver re-reads at once, and a re-read that beats the commit sees the old
 * shelf and has no reason to ask again.
 */

import { publish } from '@/lib/realtime/hub'
import { shelfEventSchema, shelfTopic, type LiveShelf } from './shelf-live-events'

/**
 * Tell everyone reading this shelf that it changed. Never throws: the hub drops
 * what it cannot deliver, and a reader who misses the hint is brought up to
 * date when their channel next comes up (`useShelfLive`), or on reload.
 */
export async function publishShelfChanged(
  organizationId: string,
  shelf: LiveShelf | null,
  { folders = false }: { folders?: boolean } = {}
): Promise<void> {
  // A chat attachment is on no shelf: nobody lists it in a workspace.
  if (!shelf) return
  try {
    await publish(shelfTopic(organizationId, shelf), shelfEventSchema.parse({ kind: 'shelf.changed', folders }))
  } catch (error) {
    console.warn('[documents] could not announce a shelf change:', error)
  }
}
