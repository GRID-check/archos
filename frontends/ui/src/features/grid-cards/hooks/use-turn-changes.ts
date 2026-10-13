'use client'

/**
 * What the turn behind an answer changed, as the server holds it (ADR-0109).
 *
 * The `canvas_activity` card is a window onto `piloti_changes`, not a copy of
 * them: it reads the turn's changes once it has been seen and again whenever
 * `token` moves (the document's live store says one of the card's marks
 * changed). The request fails soft. A card that cannot read the record, or
 * reads an empty one (an answer older than the record), keeps drawing from the
 * copy it was sent with; `changes` is then null or empty and nothing here
 * pretends otherwise.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getTurnChanges } from '@/lib/changes/client'
import type { PilotiChangeView } from '@/lib/changes/types'

export interface TurnChanges {
  /** The last list read, or null while none has been (not read yet, or every read failed). */
  changes: readonly PilotiChangeView[] | null
  /** Read the list again. Resolves to it, or null when the read failed. */
  refetch: () => Promise<readonly PilotiChangeView[] | null>
  /** Adopt one change an undo returned, without a second read. */
  adopt: (change: PilotiChangeView) => void
}

export function useTurnChanges(
  conversationId: string | null,
  messageId: string | undefined,
  { enabled, token }: { enabled: boolean; token: number }
): TurnChanges {
  const [changes, setChanges] = useState<readonly PilotiChangeView[] | null>(null)
  // Reads started and the newest applied, so a slow old read never overwrites a newer one.
  const started = useRef(0)
  const applied = useRef(0)

  const refetch = useCallback(async () => {
    if (!conversationId || !messageId) return null
    const ticket = ++started.current
    try {
      const response = await getTurnChanges(conversationId, messageId)
      if (ticket > applied.current) {
        applied.current = ticket
        setChanges(response.changes)
      }
      return response.changes
    } catch {
      return null
    }
  }, [conversationId, messageId])

  useEffect(() => {
    if (enabled) void refetch()
  }, [enabled, refetch, token])

  const adopt = useCallback((change: PilotiChangeView) => {
    setChanges((previous) => previous?.map((existing) => (existing.id === change.id ? change : existing)) ?? previous)
  }, [])

  return { changes, refetch, adopt }
}
