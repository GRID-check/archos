'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  parseFassungVisualChanges,
  type CompareRegion,
  type FassungVisualChanges,
} from '@/lib/documents/fassung-compare-types'

export type FassungVisualChangesState = 'idle' | 'loading' | 'done' | 'error'

export interface UseFassungVisualChanges {
  state: FassungVisualChangesState
  /** The boxes on the NEWER page the last finished run drew; empty until `done`. */
  regions: CompareRegion[]
  /** What changed, in words; „keine sichtbare Änderung" when nothing did. Empty until `done`. */
  summary: string[]
  /** The refusal's HTTP status after an `error` (0: the request never arrived), otherwise `null`. */
  errorStatus: number | null
  /** Ask Piloti what changed on this 1-based page of the two Fassungen. Resolves when the run has settled. */
  run: (page: number) => Promise<void>
}

const NOTHING: FassungVisualChanges = { regions: [], summary: [] }

/**
 * Piloti marks what changed between two Fassungen on the page and says it in
 * words — on request, never by itself: a run is a model call.
 *
 * `newerId` is the document the box is drawn on and the one in the path;
 * `olderId` is the Fassung it replaces. Both must be known for a run to start.
 * One run is in flight at a time: a newer `run` (or a change of either id, or
 * unmounting) abandons the earlier one, whose answer is dropped rather than shown
 * over the page it no longer belongs to. A page answered once stays answered for
 * these two documents, so flipping back to it costs no request.
 */
export function useFassungVisualChanges(
  newerId: string | null | undefined,
  olderId: string | null | undefined,
): UseFassungVisualChanges {
  const [state, setState] = useState<FassungVisualChangesState>('idle')
  const [changes, setChanges] = useState<FassungVisualChanges>(NOTHING)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const answered = useRef(new Map<number, FassungVisualChanges>())

  useEffect(() => {
    const flight = inFlight
    const cache = answered.current
    return () => {
      flight.current?.abort()
      flight.current = null
      cache.clear()
      setState('idle')
      setChanges(NOTHING)
      setErrorStatus(null)
    }
  }, [newerId, olderId])

  const run = useCallback(
    async (page: number): Promise<void> => {
      if (!newerId || !olderId) return
      inFlight.current?.abort()
      const known = answered.current.get(page)
      if (known) {
        inFlight.current = null
        setChanges(known)
        setErrorStatus(null)
        setState('done')
        return
      }

      const flight = new AbortController()
      inFlight.current = flight
      setState('loading')
      setErrorStatus(null)
      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(newerId)}/fassung-compare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ older: olderId, page }),
          signal: flight.signal,
        })
        if (flight.signal.aborted) return
        if (!response.ok) {
          setErrorStatus(response.status)
          setState('error')
          return
        }
        const parsed = parseFassungVisualChanges(await response.json().catch(() => null))
        if (flight.signal.aborted) return
        answered.current.set(page, parsed)
        setChanges(parsed)
        setState('done')
      } catch {
        if (flight.signal.aborted) return
        setErrorStatus(0)
        setState('error')
      }
    },
    [newerId, olderId],
  )

  return { state, regions: changes.regions, summary: changes.summary, errorStatus, run }
}
