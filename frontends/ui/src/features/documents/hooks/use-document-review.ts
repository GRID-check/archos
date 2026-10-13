'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import {
  AnnotationRequestError,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  replyToAnnotation,
  updateAnnotation,
} from '@/lib/annotations/client'
import type { RoomCursor } from '@/lib/annotations/room-types'
import {
  compareAnnotations,
  isLive,
  type AnnotationKind,
  type AnnotationShape,
  type AnnotationView,
  type UpdateAnnotationRequest,
} from '@/lib/annotations/types'
import { useDocumentRoom, type RoomTransport } from './use-document-room'

export type ReviewTool = 'select' | 'point' | 'region'
export type ReviewFilter = 'open' | 'proposed' | 'closed'

/** A place picked on a page and not yet saved: a point, or a region dragged out. */
export interface ReviewDraft {
  page: number
  shape: AnnotationShape
  x: number
  y: number
  w: number | null
  h: number | null
}

/** Where Piloti's pointer is while it walks the reader through what it just proposed. */
export interface PilotiTour {
  cursor: RoomCursor | null
  /** Proposals the walk has not reached yet: drawn only once the pointer has arrived. */
  pending: ReadonlySet<string>
}

/** Time the pointer takes to travel to a finding, and to rest there before the mark lands. */
const TOUR_TRAVEL_MS = 650
const TOUR_DWELL_MS = 380
const TOUR_LINGER_MS = 1400

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Everything a review of one document holds, shared by the inline preview and
 * the focused review, so a mark selected in one is selected in the other and
 * a tab is in the room once: the Anmerkungen, the room, the tool in hand, the
 * draft, the selection, the filter, and Piloti's walk.
 *
 * The list is the server's: every write replaces its row with what the API
 * answered, and a change somebody else made (a room hint) re-reads the list,
 * so a resolver's name, a number or a colleague's reply always comes from the
 * server rather than from a guess here.
 */
export function useDocumentReview(
  documentId: string,
  { enabled, transport }: { enabled: boolean; transport?: RoomTransport }
) {
  const room = useDocumentRoom(documentId, { enabled, transport })
  const reduceMotion = useReducedMotion()
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [annotations, setAnnotations] = useState<AnnotationView[]>([])
  const [canAnnotate, setCanAnnotate] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [tool, setToolState] = useState<ReviewTool>('select')
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('open')
  const [tour, setTour] = useState<PilotiTour | null>(null)
  const [notice, setNotice] = useState<'conflict' | null>(null)
  const tourQueue = useRef<string[]>([])
  const touring = useRef(false)

  const fetchList = useCallback(async () => {
    const result = await listAnnotations(documentId)
    setAnnotations(result.annotations)
    setCanAnnotate(result.canAnnotate)
    setLoad('ready')
    return result.annotations
  }, [documentId])

  useEffect(() => {
    if (!enabled) return
    setLoad('loading')
    setDraft(null)
    setSelectedId(null)
    fetchList().catch(() => setLoad('error'))
  }, [enabled, fetchList, attempt])

  /** Walk Piloti's pointer to each new proposal in turn, landing each mark as it arrives. */
  const runTour = useCallback(
    async (list: AnnotationView[]) => {
      if (touring.current) return
      touring.current = true
      try {
        while (tourQueue.current.length > 0) {
          const ids = tourQueue.current.splice(0)
          const marks = ids
            .map((id) => list.find((annotation) => annotation.id === id))
            .filter((mark): mark is AnnotationView => Boolean(mark && mark.onCurrentFassung))
          if (reduceMotion || marks.length === 0) continue
          const pending = new Set(marks.map((mark) => mark.id))
          setTour({ cursor: null, pending: new Set(pending) })
          for (const mark of marks) {
            const target = { page: mark.page, x: mark.x + (mark.w ?? 0) / 2, y: mark.y + (mark.h ?? 0) / 2 }
            setTour({ cursor: target, pending: new Set(pending) })
            await sleep(TOUR_TRAVEL_MS)
            pending.delete(mark.id)
            setTour({ cursor: target, pending: new Set(pending) })
            await sleep(TOUR_DWELL_MS)
          }
          await sleep(TOUR_LINGER_MS)
        }
      } finally {
        touring.current = false
        setTour(null)
      }
    },
    [reduceMotion]
  )

  // Somebody else changed the Anmerkungen: read them again. Several hints in a
  // burst (a batch of replies) are one read. Subscribed on the room's stable
  // callbacks, not on `room`: pointers re-render it a dozen times a second, and
  // re-subscribing on each would cancel the pending read every time.
  const { onAnnotationsChanged, peerId } = room
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = onAnnotationsChanged((event) => {
      if (event.actor.peerId && event.actor.peerId === peerId) return
      if (event.actor.kind === 'piloti' && event.change === 'created') tourQueue.current.push(...event.annotationIds)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void fetchList()
          .then((list) => {
            if (tourQueue.current.length > 0) void runTour(list)
          })
          .catch(() => {})
      }, 120)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, onAnnotationsChanged, peerId, fetchList, runTour])

  const replace = useCallback((next: AnnotationView) => {
    setAnnotations((current) =>
      [...current.filter((annotation) => annotation.id !== next.id), next].sort(compareAnnotations)
    )
  }, [])

  /** A write a colleague beat: say so, and show what they did. */
  const guard = useCallback(
    async <T,>(act: () => Promise<T>): Promise<T> => {
      try {
        return await act()
      } catch (error) {
        if (error instanceof AnnotationRequestError && error.status === 409) {
          setNotice('conflict')
          void fetchList().catch(() => {})
        }
        throw error
      }
    },
    [fetchList]
  )

  const write = useMemo(() => ({ peerId: room.peerId }), [room.peerId])

  const setTool = useCallback((next: ReviewTool) => {
    setToolState(next)
    if (next !== 'select') setSelectedId(null)
  }, [])

  const create = useCallback(
    async (content: { kind: AnnotationKind; body: string; assigneeUserId?: string | null; dueOn?: string | null }) => {
      if (!draft) return null
      const created = await guard(() => createAnnotation(documentId, { ...draft, ...content }, write))
      replace(created)
      setDraft(null)
      setToolState('select')
      setSelectedId(created.id)
      setFilter('open')
      return created
    },
    [documentId, draft, guard, replace, write]
  )

  const update = useCallback(
    async (annotationId: string, input: UpdateAnnotationRequest) => {
      const updated = await guard(() => updateAnnotation(documentId, annotationId, input, write))
      replace(updated)
      return updated
    },
    [documentId, guard, replace, write]
  )

  const reply = useCallback(
    async (annotationId: string, body: string) => {
      const updated = await guard(() => replyToAnnotation(documentId, annotationId, { body }, write))
      replace(updated)
      return updated
    },
    [documentId, guard, replace, write]
  )

  const remove = useCallback(
    async (annotationId: string) => {
      await guard(() => deleteAnnotation(documentId, annotationId, write))
      setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId))
      setSelectedId((current) => (current === annotationId ? null : current))
    },
    [documentId, guard, write]
  )

  const counts = useMemo(
    () => ({
      open: annotations.filter((annotation) => annotation.status === 'open').length,
      proposed: annotations.filter((annotation) => annotation.status === 'proposed').length,
      closed: annotations.filter((annotation) => !isLive(annotation)).length,
    }),
    [annotations]
  )

  const listed = useMemo(
    () =>
      annotations.filter((annotation) =>
        filter === 'open'
          ? isLive(annotation)
          : filter === 'proposed'
            ? annotation.status === 'proposed'
            : !isLive(annotation)
      ),
    [annotations, filter]
  )

  /** Step to the next or previous live mark, in the order a review walks them. */
  const step = useCallback(
    (direction: 1 | -1) => {
      const live = annotations.filter((annotation) => isLive(annotation) && annotation.onCurrentFassung)
      if (live.length === 0) return null
      const index = live.findIndex((annotation) => annotation.id === selectedId)
      const next = live[(index + direction + live.length) % live.length] ?? live[0]
      setSelectedId(next.id)
      return next
    },
    [annotations, selectedId]
  )

  return {
    documentId,
    room,
    load,
    retry: () => setAttempt((value) => value + 1),
    annotations,
    listed,
    counts,
    canAnnotate,
    tool,
    setTool,
    draft,
    setDraft,
    selectedId,
    select: setSelectedId,
    hoveredId,
    hover: setHoveredId,
    filter,
    setFilter,
    tour,
    notice,
    dismissNotice: () => setNotice(null),
    create,
    update,
    reply,
    remove,
    step,
  }
}

export type DocumentReview = ReturnType<typeof useDocumentReview>
