'use client'

/**
 * „Als Skizze bearbeiten" in the Files preview of a filed sketch (ADR-0148).
 *
 * Offered only where it works: an SVG Piloti filed whose bytes carry an
 * Excalidraw scene. That is asked of the server when the preview shows such a
 * file, as a probe (`?probe=1`) that answers whether, and nothing of the
 * drawing, so the download log need not record it: the person only looked at
 * the file. The click reads the sketch, and that read is logged: it is the
 * person opening the drawing, and it opens the latest Fassung (or, for a
 * writer, the open Freigabe draft). The editor (`SketchDialog`) is the chat's,
 * loaded on the click.
 *
 * The preview is in the document's room (its review's), and so is the editor
 * it opens: one room per tab. When a colleague's save, a Freigabe or an upload
 * makes another Fassung current (`version.published`), the preview reads its
 * picture again (`onChanged`) and asks again whether to offer the editor.
 */

import { PencilLine } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getSketch, probeSketch, type SketchForEditing, type SketchProbe } from '@/adapters/api/diagrams-client'
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
  const [probe, setProbe] = useState<SketchProbe | null>(null)
  const [sketch, setSketch] = useState<SketchForEditing | null>(null)
  const [open, setOpen] = useState(false)
  const [reads, setReads] = useState(0)
  const [opening, setOpening] = useState<'idle' | 'opening' | 'failed'>('idle')
  const candidate = mayBeFiledSketch(contentType, authoredBy)

  useEffect(() => {
    setProbe(null)
    if (!candidate) return
    const controller = new AbortController()
    probeSketch(documentId, controller.signal).then(setProbe, () => setProbe(null))
    return () => controller.abort()
  }, [candidate, documentId, reads])

  // Another Fassung is current: the preview shows it, whoever made it (G1). This tab's own save already reloaded.
  const room = review?.room ?? null
  useEffect(() => {
    if (!room || !candidate) return
    return room.onRoomEvent((event) => {
      if (event.kind !== 'version.published' || event.actor.peerId === room.peerId) return
      onChanged()
      setReads((count) => count + 1)
    })
  }, [room, candidate, onChanged])

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

  if (!probe?.hasScene) return null
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
      {sketch ? (
        <SketchDialog
          key={sketch.versionId ?? 'unversioned'}
          open={open}
          onOpenChange={onOpenChange}
          source=""
          elements={NO_ELEMENTS}
          title={sketch.title}
          revision={{
            documentId: sketch.documentId,
            baseVersionId: sketch.versionId,
            baseContentHash: sketch.contentHash,
            saveTarget: sketch.saveTarget,
            scene: sketch.scene,
            canWrite: sketch.canWrite,
            onSaved,
            review,
            links: sketch.links,
            projectId: sketch.projectId,
            underlay: sketch.underlay,
            // Moved to the base's newer Fassung: the preview shows the new picture, the editor reopens on it.
            onUnderlayMoved: () => {
              onChanged()
              void openEditor()
            },
          }}
        />
      ) : null}
    </>
  )
}
