'use client'

/**
 * „Was Piloti tut" for one project: read on open, and again when the reader
 * acts (`reload`). There is no channel behind it (`docs/architecture/piloti-activity.md`,
 * „Out of scope"), so the list is as fresh as the last read and says so by
 * re-reading after every action rather than by guessing the result.
 *
 * A failed re-read keeps what is shown and sets `failed`; only a view that has
 * never loaded has nothing to keep. The reads race (an action's re-read can
 * land after the next one), so only the latest request may write.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchPilotiActivity } from '@/lib/piloti-activity/client'
import type { PilotiActivityResponse } from '@/lib/piloti-activity/types'

/** How the view reads: the typed client in the browser, a fixture in a preview or a spec. */
export type PilotiActivityFetcher = (projectId: string) => Promise<PilotiActivityResponse>

const defaultFetcher: PilotiActivityFetcher = (projectId) => fetchPilotiActivity(projectId)

export interface PilotiActivityState {
  /** The last response that parsed; null until the first one. */
  activity: PilotiActivityResponse | null
  /** A read is in flight. */
  loading: boolean
  /** The latest read failed (a refused read or a body this build does not recognise). */
  failed: boolean
  /** Read again; resolves when that read has settled. */
  reload: () => Promise<void>
}

export function usePilotiActivity(
  projectId: string,
  fetcher: PilotiActivityFetcher = defaultFetcher
): PilotiActivityState {
  const [activity, setActivity] = useState<PilotiActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const latest = useRef(0)
  const mounted = useRef(true)

  const reload = useCallback(async (): Promise<void> => {
    const request = ++latest.current
    setLoading(true)
    try {
      const next = await fetcher(projectId)
      if (!mounted.current || request !== latest.current) return
      setActivity(next)
      setFailed(false)
    } catch {
      if (!mounted.current || request !== latest.current) return
      setFailed(true)
    } finally {
      if (mounted.current && request === latest.current) setLoading(false)
    }
  }, [projectId, fetcher])

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => {
      mounted.current = false
    }
  }, [reload])

  return { activity, loading, failed, reload }
}
