'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAnnotationViewpoint } from '@/lib/annotations/client'
import type { ViewpointView } from '@/lib/annotations/viewpoint-types'
import { inPool } from '@/lib/utils/in-pool'

/** Viewpoints read at once, and in all: a list is bounded by the document's 500 marks, pins by what is worth drawing. */
const READ_AT_ONCE = 4
export const MAX_PINNED_MARKS = 100

/**
 * The viewpoints of a model's marks, read on demand and kept.
 *
 * A mark in a list carries only a short summary; the camera, the cut and the
 * pin are `GET …/viewpoint`. A viewpoint never changes once set (migration
 * 0193), so a read is kept for the life of the stage; only a carry puts a mark
 * on a new one (0195), and `forget` drops what was kept for it.
 * `want` names the marks whose pins are drawn; `read` fetches one now (a jump).
 */
export function useMarkViewpoints(documentId: string | null, want: readonly string[]) {
  const [viewpoints, setViewpoints] = useState<ReadonlyMap<string, ViewpointView>>(new Map())
  const kept = useRef(new Map<string, ViewpointView>())
  const asked = useRef(new Set<string>())
  /** Bumped by `forget`, so a pin of a carried mark is read again. */
  const [generation, setGeneration] = useState(0)

  // A stage opened on another model starts from nothing: ids are per document.
  useEffect(() => {
    kept.current = new Map()
    asked.current = new Set()
    setViewpoints(new Map())
  }, [documentId])

  const key = want.slice(0, MAX_PINNED_MARKS).join(',')
  useEffect(() => {
    if (!documentId) return
    const missing = key.split(',').filter((id) => id && !asked.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) asked.current.add(id)
    // Reads go on when the list changes under them; they land in the map of the document they were asked for.
    const map = kept.current
    const seen = asked.current
    void inPool(missing, READ_AT_ONCE, async (id) => {
      try {
        map.set(id, await getAnnotationViewpoint(documentId, id))
      } catch {
        // A pin that cannot be read is a pin that is not drawn; the mark is still in the list, and a jump asks again.
        seen.delete(id)
      }
    }).then(() => {
      if (kept.current === map) setViewpoints(new Map(map))
    })
  }, [documentId, key, generation])

  const read = useCallback(
    async (annotationId: string): Promise<ViewpointView> => {
      const known = kept.current.get(annotationId)
      if (known) return known
      if (!documentId) throw new Error('no model')
      const viewpoint = await getAnnotationViewpoint(documentId, annotationId)
      kept.current.set(annotationId, viewpoint)
      setViewpoints(new Map(kept.current))
      return viewpoint
    },
    [documentId]
  )

  /** A carry put the mark on a new viewpoint: read it again when it is next wanted. */
  const forget = useCallback((annotationId: string) => {
    kept.current.delete(annotationId)
    asked.current.delete(annotationId)
    setViewpoints(new Map(kept.current))
    setGeneration((value) => value + 1)
  }, [])

  return { viewpoints, read, forget }
}
