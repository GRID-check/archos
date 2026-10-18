'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { listProjectAnnotations } from '@/lib/annotations/client'
import type { ProjectMarksFilters, ProjectMarksResponse, ProjectMarkView } from '@/lib/annotations/project-types'

/** Where the list stands: its first page, and the page after it. */
export interface ProjectMarksState {
  marks: ProjectMarkView[]
  /** The first page of these filters: being read, read, or failed. */
  load: 'loading' | 'ready' | 'error'
  /** Whether a further page exists, and how reading it goes. */
  hasMore: boolean
  more: 'idle' | 'loading' | 'error'
  /** Read the first page again, after a failure. */
  retry: () => void
  loadMore: () => void
}

/**
 * A project's Offene Punkte under the filters on screen, a page at a time,
 * through the typed client. A change of filters reads the first page again and
 * drops an answer to the filters before it, so a slow read never paints over a
 * newer one. `initial` is the first page the server read for `initial.filters`;
 * it stands in for that read.
 */
export function useProjectMarks(
  projectId: string,
  filters: ProjectMarksFilters,
  initial: { page: ProjectMarksResponse | null; filters: ProjectMarksFilters } | null = null
): ProjectMarksState {
  const key = JSON.stringify(filters)
  const seeded = initial?.page && JSON.stringify(initial.filters) === key ? initial.page : null
  const [marks, setMarks] = useState<ProjectMarkView[]>(seeded?.marks ?? [])
  const [cursor, setCursor] = useState<string | null>(seeded?.nextCursor ?? null)
  const [load, setLoad] = useState<ProjectMarksState['load']>(seeded ? 'ready' : 'loading')
  const [more, setMore] = useState<ProjectMarksState['more']>('idle')
  const [attempt, setAttempt] = useState(0)
  /** The latest read; the answer to any earlier one is dropped. */
  const latest = useRef(0)
  const skipFirst = useRef(seeded !== null)

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false
      return
    }
    const read = ++latest.current
    setLoad('loading')
    setMore('idle')
    listProjectAnnotations(projectId, JSON.parse(key) as ProjectMarksFilters)
      .then((page) => {
        if (latest.current !== read) return
        setMarks(page.marks)
        setCursor(page.nextCursor)
        setLoad('ready')
      })
      .catch(() => {
        if (latest.current === read) setLoad('error')
      })
  }, [projectId, key, attempt])

  const loadMore = useCallback(() => {
    if (!cursor || more === 'loading') return
    const read = ++latest.current
    setMore('loading')
    listProjectAnnotations(projectId, JSON.parse(key) as ProjectMarksFilters, { cursor })
      .then((page) => {
        if (latest.current !== read) return
        setMarks((shown) => [...shown, ...page.marks])
        setCursor(page.nextCursor)
        setMore('idle')
      })
      .catch(() => {
        if (latest.current === read) setMore('error')
      })
  }, [projectId, key, cursor, more])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  return { marks, load, hasMore: cursor !== null, more, retry, loadMore }
}
