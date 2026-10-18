'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { listProjectAnnotations } from '@/lib/annotations/client'
import {
  MAX_PROJECT_MARKS_PAGE,
  PROJECT_MARKS_PAGE_SIZE,
  type ProjectMarksFilters,
  type ProjectMarksResponse,
  type ProjectMarkView,
} from '@/lib/annotations/project-types'

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
 * it is painted at once.
 *
 * The list is read again, quietly (what is shown stays until the answer
 * replaces it), whenever the page comes back: on mount, because Back from a
 * review restores the page with the server's first page as it was when the
 * reader left, before they closed the marks they went to; and when the tab
 * returns to view. That read covers as many marks as are shown, so a reader
 * who loaded more pages keeps them (up to the most one page holds).
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
  /** The mount's read is quiet when the server's page is already painted. */
  const quietFirst = useRef(seeded !== null)
  /** How many marks are shown and whether they stand, for a quiet read to cover them. */
  const shown = useRef({ count: marks.length, ready: load === 'ready' })
  useEffect(() => {
    shown.current = { count: marks.length, ready: load === 'ready' }
  }, [marks.length, load])

  /** Read the first page; `quiet` keeps what is shown until the answer replaces it, and a failure keeps it too. */
  const readFirst = useCallback(
    (quiet: boolean) => {
      const read = ++latest.current
      if (!quiet) setLoad('loading')
      setMore('idle')
      const covered = Math.min(shown.current.count, MAX_PROJECT_MARKS_PAGE)
      const page = quiet && covered > PROJECT_MARKS_PAGE_SIZE ? { limit: covered } : {}
      listProjectAnnotations(projectId, JSON.parse(key) as ProjectMarksFilters, page)
        .then((answer) => {
          if (latest.current !== read) return
          setMarks(answer.marks)
          setCursor(answer.nextCursor)
          setLoad('ready')
        })
        .catch(() => {
          if (latest.current === read && !quiet) setLoad('error')
        })
    },
    [projectId, key]
  )

  /** The filters and attempt last read, so a repeat of the same read (a remount, Strict Mode) stays quiet. */
  const lastRead = useRef<string | null>(null)
  useEffect(() => {
    const id = `${key}\n${attempt}`
    const quiet = lastRead.current === id || (lastRead.current === null && quietFirst.current)
    lastRead.current = id
    readFirst(quiet)
  }, [readFirst, key, attempt])

  // The tab comes back into view: what was decided meanwhile, here or elsewhere, is read.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && shown.current.ready) readFirst(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [readFirst])

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
