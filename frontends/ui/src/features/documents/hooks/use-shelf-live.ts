'use client'

import { useLiveHints, type LiveHintOptions } from '@/features/realtime/use-live-hints'
import { shelfChannelKey, shelfEventSchema, type LiveShelf, type ShelfEvent } from '@/lib/documents/shelf-live-events'

export interface ShelfChange {
  /** The folder tree changed too, so it is worth reading again. */
  folders: boolean
}

export type ShelfLiveOptions = Pick<
  LiveHintOptions<ShelfEvent, ShelfChange>,
  'link' | 'coalesceMs' | 'jitterMs' | 'holdWhile' | 'holdMs'
>

const parseShelfEvent = (event: unknown): ShelfEvent | null => {
  const parsed = shelfEventSchema.safeParse(event)
  return parsed.success ? parsed.data : null
}

const foldShelfEvent = (gathered: ShelfChange | null, event: ShelfEvent): ShelfChange => ({
  folders: (gathered?.folders ?? false) || event.folders,
})

/** Whatever changed while nobody listened: the level, the counts and the folders. */
const SHELF_RESYNC: ShelfChange = { folders: true }

/**
 * Keep a shelf's workspace current while it is open: `shelf:<id>` through
 * {@link useLiveHints}, which folds a burst into one call and resyncs whenever
 * the channel comes up.
 *
 * The Files workspace used to read the shelf once and then only after its own
 * actions, so a colleague's upload, a folder Piloti filed into, a document
 * moved from the chat or another tab stayed invisible until a reload, and a
 * row deleted elsewhere stayed on screen until someone clicked it.
 */
export function useShelfLive(
  shelf: LiveShelf,
  onChange: (change: ShelfChange) => void,
  options: ShelfLiveOptions = {}
): void {
  useLiveHints(shelfChannelKey(shelf), {
    parse: parseShelfEvent,
    fold: foldShelfEvent,
    resync: SHELF_RESYNC,
    onChange,
    ...options,
  })
}
