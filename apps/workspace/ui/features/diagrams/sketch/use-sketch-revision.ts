'use client'

/**
 * Saving a reopened sketch as the next Fassung of its document (ADR-0148): the
 * editor's counterpart of `use-diagram-filing.ts`, through
 * `PUT /api/documents/{id}/sketch`.
 *
 * Four outcomes a person is told apart: saved (with the Fassung number),
 * stale (a newer Fassung was saved since this one was opened: reopen it,
 * nothing is overwritten), refused (the server's own sentence) and failed.
 */

import { useCallback, useState } from 'react'
import { saveSketch, SketchRequestError } from '@/adapters/api/diagrams-client'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'

export type SketchRevisionState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; versionNumber: number }
  | { kind: 'stale' }
  | { kind: 'failed'; message: string }

export interface SketchRevisionTarget {
  documentId: string
  /** The Fassung the editor opened. */
  baseVersionId: string | null
}

export interface SketchRevision {
  state: SketchRevisionState
  save: () => Promise<void>
}

export function useSketchRevision(
  target: SketchRevisionTarget | null,
  prepareSketch: () => Promise<{ source: string; svg: string }>,
  onSaved?: () => void
): SketchRevision {
  const t = useTranslations(diagramsCopy)
  const [state, setState] = useState<SketchRevisionState>({ kind: 'idle' })

  const save = useCallback(async () => {
    if (!target) return
    setState({ kind: 'saving' })
    try {
      const { source, svg } = await prepareSketch()
      const saved = await saveSketch(target.documentId, {
        scene: JSON.parse(source),
        svg,
        baseVersionId: target.baseVersionId,
      })
      setState({ kind: 'saved', versionNumber: saved.versionNumber })
      onSaved?.()
    } catch (error) {
      if (error instanceof SketchRequestError && error.stale) return setState({ kind: 'stale' })
      const message =
        error instanceof SketchRequestError && error.serverMessage ? error.serverMessage : t('sketch.saveFailed')
      setState({ kind: 'failed', message })
    }
  }, [target, prepareSketch, onSaved, t])

  return { state, save }
}
