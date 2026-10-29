'use client'

/**
 * „Als Skizze bearbeiten" in the Files preview of a filed sketch (ADR-0148).
 *
 * Offered only where it works: an SVG Piloti filed whose bytes carry an
 * Excalidraw scene. That is asked of the server (`GET …/sketch`, 415 for a
 * mermaid diagram or any other SVG) when the preview shows such a file, as a
 * probe (`?probe=1`) the download log does not record: the person only looked
 * at the file. The click reads the sketch again, and that read is logged: it
 * is the person opening the drawing, and it opens the latest Fassung. The
 * editor (`SketchDialog`) is the chat's, loaded on the click.
 */

import { PencilLine } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getSketch, type SketchForEditing } from '@/adapters/api/diagrams-client'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import type { PreviewDocumentActionProps } from '@/features/documents/preview-actions'
import { SketchDialog } from './sketch-dialog'

const NO_ELEMENTS: readonly object[] = []

/** Whether the preview should ask: a machine-authored SVG, the only kind a filed sketch is. */
export function mayBeFiledSketch(contentType: string | null, authoredBy: string | null): boolean {
  return contentType === 'image/svg+xml' && authoredBy === 'agent'
}

export function SketchReviseAction({
  documentId,
  contentType,
  authoredBy,
  onChanged,
  review = null,
  reviewRequest = null,
}: PreviewDocumentActionProps) {
  const t = useTranslations(diagramsCopy)
  const [sketch, setSketch] = useState<SketchForEditing | null>(null)
  const [open, setOpen] = useState(false)
  const [reads, setReads] = useState(0)
  const [opening, setOpening] = useState<'idle' | 'opening' | 'failed'>('idle')
  const candidate = mayBeFiledSketch(contentType, authoredBy)

  useEffect(() => {
    setSketch(null)
    if (!candidate) return
    const controller = new AbortController()
    getSketch(documentId, controller.signal, { probe: true }).then(setSketch, () => setSketch(null))
    return () => controller.abort()
  }, [candidate, documentId, reads])

  const onSaved = useCallback(() => onChanged(), [onChanged])
  const openEditor = useCallback(async () => {
    setOpening('opening')
    const read = await getSketch(documentId).catch(() => null)
    if (!read) return setOpening('failed')
    setSketch(read)
    setOpening('idle')
    setOpen(true)
  }, [documentId])
  // A Skizze's review is its editor: a pin or a link (`?review=1&mark=`) opens it, at that mark.
  const requested = reviewRequest?.open ?? false
  const requestedMark = reviewRequest?.annotationId ?? null
  const selectMark = review?.select
  useEffect(() => {
    if (!requested || !candidate) return
    void openEditor()
  }, [requested, candidate, openEditor])
  useEffect(() => {
    if (open && requestedMark) selectMark?.(requestedMark)
  }, [open, requestedMark, selectMark])
  const closeRequest = reviewRequest?.onOpenChange
  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      // The next opening starts from the Fassung just saved, never from the one read before it.
      if (next) return
      setReads((count) => count + 1)
      if (requested) closeRequest?.(false)
    },
    [requested, closeRequest]
  )

  if (!sketch) return null
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full gap-1.5"
        onClick={() => void openEditor()}
        disabled={opening === 'opening'}
        data-testid="sketch-revise"
      >
        <PencilLine className="size-3.5" aria-hidden />
        {t(opening === 'opening' ? 'sketch.opening' : 'sketch.action')}
      </Button>
      {opening === 'failed' ? (
        <p className="text-destructive text-xs" role="status">
          {t('sketch.openFailed')}
        </p>
      ) : null}
      <SketchDialog
        open={open}
        onOpenChange={onOpenChange}
        source=""
        elements={NO_ELEMENTS}
        title={sketch.title}
        revision={{
          documentId: sketch.documentId,
          baseVersionId: sketch.versionId,
          scene: sketch.scene,
          canWrite: sketch.canWrite,
          onSaved,
          review,
        }}
      />
    </>
  )
}
