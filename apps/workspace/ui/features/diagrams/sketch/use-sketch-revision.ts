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
 * open: every peer's save makes it the newer Fassung, so the base is read at
 * the moment of saving. A save refused as stale is offered to `resolveStale`
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
  | { kind: 'saved'; versionId: string; versionNumber: number }
  | { kind: 'stale'; merged?: boolean }
  | { kind: 'failed'; message: string }

export interface SketchRevisionTarget {
  documentId: string
  /** The Fassung the editor's changes sit on: what it opened, or, in a live room, what was saved since. */
  baseVersionId: string | null | (() => string | null)
}

export interface SketchRevisionOptions {
  onSaved?: (saved: { versionId: string; versionNumber: number }) => void
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
      const { source, svg } = await prepareSketch()
      const base = typeof target.baseVersionId === 'function' ? target.baseVersionId() : target.baseVersionId
      return saveSketch(target.documentId, { scene: JSON.parse(source), svg, baseVersionId: base })
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
      setState({ kind: 'saved', versionId: saved.versionId, versionNumber: saved.versionNumber })
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
