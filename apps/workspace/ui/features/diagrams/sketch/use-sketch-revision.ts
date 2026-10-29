'use client'

/**
 * Saving a reopened sketch as the next Fassung of its document (ADR-0148): the
 * editor's counterpart of `use-diagram-filing.ts`, through
 * `PUT /api/documents/{id}/sketch`.
 *
 * Four outcomes a person is told apart: saved (with the Fassung number),
 * stale (a newer Fassung was saved since this one was opened: reopen it,
 * nothing is overwritten), refused (the server's own sentence) and failed.
 *
 * In a live room (`use-sketch-room.ts`) the base moves while the editor is
 * open: a peer's save of this very scene, or a newer Fassung merged in, makes
 * it the newer Fassung. So the base is read as the save starts, BEFORE the
 * scene is taken: a merge that lands while the picture is drawn then makes
 * the save stale rather than write a scene without it over the Fassung. A save refused as stale is offered to `resolveStale`
 * (merge the newer Fassung into the canvas) and tried once more; a second
 * refusal is `stale` with `merged`, which asks the person to save again.
 */

import { useCallback, useState } from 'react'
import { saveSketch, SketchRequestError } from '@/adapters/api/diagrams-client'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'

export type SketchRevisionState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; versionId: string; versionNumber: number; pdfStale?: boolean }
  | { kind: 'stale'; merged?: boolean }
  | { kind: 'failed'; message: string }

export interface SketchRevisionTarget {
  documentId: string
  /** The Fassung the editor's changes sit on: what it opened, or, in a live room, what was saved since. */
  baseVersionId: string | null | (() => string | null)
  /** This tab's id in the document room, sent with the save so the room's notice of it is no echo here. */
  peerId?: () => string | null
}

/** A save that landed: the Fassung, and the elements of the scene it wrote. */
export interface SavedRevision {
  versionId: string
  versionNumber: number
  pdfStale: boolean
  elements: readonly object[]
}

export interface SketchRevisionOptions {
  onSaved?: (saved: SavedRevision) => void
  /** A newer Fassung refused the save: merge it into the canvas, and say whether to try once more. */
  resolveStale?: () => Promise<boolean>
}

export interface SketchRevision {
  state: SketchRevisionState
  save: () => Promise<void>
}

export function useSketchRevision(
  target: SketchRevisionTarget | null,
  prepareSketch: () => Promise<{ source: string; svg: string }>,
  onSaved?: SketchRevisionOptions['onSaved'],
  resolveStale?: SketchRevisionOptions['resolveStale']
): SketchRevision {
  const t = useTranslations(diagramsCopy)
  const [state, setState] = useState<SketchRevisionState>({ kind: 'idle' })

  const save = useCallback(async () => {
    if (!target) return
    setState({ kind: 'saving' })
    const attempt = async () => {
      const base = typeof target.baseVersionId === 'function' ? target.baseVersionId() : target.baseVersionId
      const { source, svg } = await prepareSketch()
      const scene = JSON.parse(source) as { type: 'excalidraw'; elements: object[] }
      const saved = await saveSketch(target.documentId, { scene, svg, baseVersionId: base }, { peerId: target.peerId?.() })
      return { ...saved, elements: scene.elements }
    }
    try {
      let saved
      try {
        saved = await attempt()
      } catch (error) {
        const stale = error instanceof SketchRequestError && error.stale
        if (!stale || !resolveStale || !(await resolveStale())) throw error
        try {
          saved = await attempt()
        } catch (again) {
          if (again instanceof SketchRequestError && again.stale) return setState({ kind: 'stale', merged: true })
          throw again
        }
      }
      setState({ kind: 'saved', versionId: saved.versionId, versionNumber: saved.versionNumber, pdfStale: saved.pdfStale })
      onSaved?.(saved)
    } catch (error) {
      if (error instanceof SketchRequestError && error.stale) return setState({ kind: 'stale' })
      const message =
        error instanceof SketchRequestError && error.serverMessage ? error.serverMessage : t('sketch.saveFailed')
      setState({ kind: 'failed', message })
    }
  }, [target, prepareSketch, onSaved, resolveStale, t])

  return { state, save }
}
