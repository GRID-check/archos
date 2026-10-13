'use client'

/**
 * What the `canvas_activity` card reads about its document when it is seen:
 * where each mark stands now, and the first page's picture.
 *
 * Both are one GET per card, asked only once the card has been on screen (a
 * long thread does not read the marks of every card scrolled past), and both
 * fail soft: a card that cannot read the live list falls back to the decision
 * its message stored, and one with no thumbnail draws a plain page.
 */

import { useCallback, useEffect, useState } from 'react'
import { listAnnotations } from '@/lib/annotations/client'
import type { AnnotationView } from '@/lib/annotations/types'
import type { LiveMark } from '../lib/canvas-activity'

const liveOf = (annotation: AnnotationView): LiveMark => ({
  status: annotation.status,
  canEdit: annotation.canEdit,
  acceptedByName: annotation.acceptedByName,
  closedByName: annotation.closedByName,
  assigneeUserId: annotation.assigneeUserId,
  dueOn: annotation.dueOn,
  kind: annotation.kind,
  body: annotation.body,
})

export interface LiveMarks {
  /**
   * One mark as the canvas has it now: undefined while unknown (not read yet,
   * or the read failed), `gone` when the list was read and no longer holds it.
   */
  lookup: (annotationId: string) => LiveMark | 'gone' | undefined
  /** Read the list again. Resolves to the fresh lookup, or null when the read failed. */
  refresh: () => Promise<((annotationId: string) => LiveMark | 'gone') | null>
  /** Adopt what a write returned, without a second read. */
  adopt: (annotation: AnnotationView) => void
  /** Drop one mark that a write found missing (404). */
  forget: (annotationId: string) => void
}

type MarkMap = ReadonlyMap<string, LiveMark | 'gone'>

const lookupIn =
  (marks: MarkMap) =>
  (annotationId: string): LiveMark | 'gone' =>
    marks.get(annotationId) ?? 'gone'

/** The document's marks as the canvas has them, read once `enabled` turns true. */
export function useLiveMarks(documentId: string, enabled: boolean): LiveMarks {
  // The last full read, and what writes since then returned. Kept apart so a
  // write made before any read landed tells about its own mark only: absent
  // from a list nobody has read is „unknown", not „gone".
  const [list, setList] = useState<MarkMap | null>(null)
  const [since, setSince] = useState<MarkMap>(new Map())

  const read = useCallback(async (): Promise<MarkMap | null> => {
    try {
      const response = await listAnnotations(documentId)
      return new Map(response.annotations.map((annotation) => [annotation.id, liveOf(annotation)]))
    } catch {
      return null
    }
  }, [documentId])

  const settle = useCallback((next: MarkMap) => {
    setList(next)
    setSince(new Map())
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void read().then((next) => {
      if (!cancelled && next) settle(next)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, read, settle])

  const refresh = useCallback(async () => {
    const next = await read()
    if (!next) return null
    settle(next)
    return lookupIn(next)
  }, [read, settle])

  const adopt = useCallback((annotation: AnnotationView) => {
    setSince((previous) => new Map(previous).set(annotation.id, liveOf(annotation)))
  }, [])

  const forget = useCallback((annotationId: string) => {
    setSince((previous) => new Map(previous).set(annotationId, 'gone'))
  }, [])

  const lookup = useCallback(
    (annotationId: string) => since.get(annotationId) ?? (list === null ? undefined : lookupIn(list)(annotationId)),
    [list, since]
  )

  return { lookup, refresh, adopt, forget }
}

/**
 * The signed URL of the document's first-page picture, or null.
 *
 * The ingest renders it from page 1 of the PDF with the page's own proportions
 * (400px on the long edge), so a mark's normalized place on page 1 is the same
 * place on this picture. `/api/documents/{id}/thumbnail` answers `{ url: null }`
 * for a document without one; that, a refusal and a network failure all read
 * as null here, and the card draws the plain page instead.
 */
export function useFirstPageThumbnail(documentId: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(`/api/documents/${encodeURIComponent(documentId)}/thumbnail`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const value = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : null
        if (!cancelled) setUrl(typeof value === 'string' ? value : null)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, enabled])

  return url
}
