'use client'

/**
 * A project's intake on the setup page: the review as the API last answered it,
 * the calls that change it, and the polling that keeps it current while Piloti
 * reads.
 *
 * Every call answers with the review as it stands after it (ADR-0055), so the
 * page never patches its own copy: it replaces it. A reading is polled every
 * five seconds, and for a while after documents were handed in, because the
 * server starts a reading when an upload batch has settled and the page cannot
 * see that moment.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import {
  createProjectIntakeClient,
  type ProjectIntakeClient,
} from '@/lib/project-intake/client'
import type { IntakeDecision, IntakeView } from '@/lib/project-intake/types'

export const INTAKE_POLL_MS = 5000
/** How long after a hand-in the page keeps asking whether a reading began. */
export const INTAKE_WATCH_MS = 3 * 60 * 1000

export interface UseIntakeOptions {
  projectId: string
  initial: IntakeView
  /** The typed client; the real one unless a spec brings its own. */
  client?: ProjectIntakeClient
}

export interface UseIntake {
  view: IntakeView
  /** A call is in flight: the controls wait. */
  busy: boolean
  /** The last refresh failed. The view on screen is the last good one. */
  stale: boolean
  decide: (decisions: IntakeDecision[]) => Promise<boolean>
  reread: () => Promise<void>
  complete: () => Promise<boolean>
  refresh: () => Promise<void>
  /** Documents were handed in: ask for a while whether a reading began. */
  watch: () => void
}

export function useIntake({ projectId, initial, client }: UseIntakeOptions): UseIntake {
  const t = useTranslations('projectIntake')
  const api = useRef<ProjectIntakeClient>(client ?? createProjectIntakeClient())
  const [view, setView] = useState<IntakeView>(initial)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [watchUntil, setWatchUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    try {
      setView(await api.current.get(projectId))
      setStale(false)
    } catch {
      setStale(true)
    }
  }, [projectId])

  const polling = view.status === 'reading' || now < watchUntil
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(() => {
      setNow(Date.now())
      void refresh()
    }, INTAKE_POLL_MS)
    return () => clearInterval(timer)
  }, [polling, refresh])

  const guarded = useCallback(
    async <T>(work: () => Promise<T>, failure: string): Promise<T | null> => {
      setBusy(true)
      try {
        return await work()
      } catch (error) {
        console.error('[project-intake] call failed:', error)
        toast.error(failure)
        return null
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const decide = useCallback(
    async (decisions: IntakeDecision[]): Promise<boolean> => {
      const answer = await guarded(() => api.current.decide(projectId, decisions), t('errors.decide'))
      if (!answer) return false
      setView(answer.intake)
      const refused = answer.results.filter((result) => !result.ok).length
      if (refused > 0) toast.error(t('errors.refused', { count: refused }))
      return refused === 0
    },
    [guarded, projectId, t]
  )

  const reread = useCallback(async () => {
    const next = await guarded(() => api.current.start(projectId, { scope: 'new' }), t('errors.start'))
    if (next) setView(next)
  }, [guarded, projectId, t])

  const complete = useCallback(async (): Promise<boolean> => {
    const next = await guarded(() => api.current.complete(projectId), t('errors.complete'))
    if (!next) return false
    setView(next)
    return true
  }, [guarded, projectId, t])

  const watch = useCallback(() => {
    const at = Date.now()
    setNow(at)
    setWatchUntil(at + INTAKE_WATCH_MS)
  }, [])

  return { view, busy, stale, decide, reread, complete, refresh, watch }
}
