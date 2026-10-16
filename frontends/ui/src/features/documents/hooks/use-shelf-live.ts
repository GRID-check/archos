'use client'

import { useEffect, useRef } from 'react'
import { useChannel, type ChannelLink } from '@/features/realtime/use-channel'
import { shelfChannelKey, shelfEventSchema, type LiveShelf, type ShelfEvent } from '@/lib/documents/shelf-live-events'

/** How long a burst of hints (a folder upload, a bin of forty documents) is gathered into one re-read. */
export const SHELF_LIVE_COALESCE_MS = 400

export interface ShelfChange {
  /** The folder tree changed too, so it is worth reading again. */
  folders: boolean
}

export interface ShelfLiveOptions {
  /** Defaults to the tab's shared connection. Keep it stable. */
  link?: ChannelLink
  coalesceMs?: number
}

const parseShelfEvent = (event: unknown): ShelfEvent | null => {
  const parsed = shelfEventSchema.safeParse(event)
  return parsed.success ? parsed.data : null
}

/**
 * Keep a shelf's workspace current while it is open (ADR-0110): join
 * `shelf:<id>` and call `onChange` when somebody, or something, changed it.
 *
 * The Files workspace used to read the shelf once and then only after its own
 * actions, so a colleague's upload, a folder Piloti filed into, a document
 * moved from the chat or another tab stayed invisible until a reload, and a
 * row deleted elsewhere stayed on screen until someone clicked it.
 *
 * The hint is never the data: `onChange` re-reads through the API. Hints that
 * arrive close together are one call, and a missed hint is not lost for good,
 * because every time the channel comes up (the first time, after a dropped
 * connection, after a phone woke) the shelf is read again with the folders:
 * whatever changed while nobody was listening is on screen then.
 */
export function useShelfLive(
  shelf: LiveShelf,
  onChange: (change: ShelfChange) => void,
  { link, coalesceMs = SHELF_LIVE_COALESCE_MS }: ShelfLiveOptions = {}
): void {
  const key = shelfChannelKey(shelf)
  const callback = useRef(onChange)
  callback.current = onChange
  const pending = useRef<ShelfChange | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushRef = useRef(() => {
    timer.current = null
    const change = pending.current
    pending.current = null
    if (change) callback.current(change)
  })
  const noteRef = useRef((change: ShelfChange) => {
    pending.current = { folders: (pending.current?.folders ?? false) || change.folders }
    timer.current ??= setTimeout(() => flushRef.current(), coalesceMs)
  })

  const { status } = useChannel<ShelfEvent>(key, {
    enabled: true,
    link,
    parse: parseShelfEvent,
    onEvent: (event) => noteRef.current({ folders: event.folders }),
  })

  // Up: read everything once, to close the gap since the last read.
  useEffect(() => {
    if (status === 'live') noteRef.current({ folders: true })
  }, [status])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      pending.current = null
    },
    [key]
  )
}
