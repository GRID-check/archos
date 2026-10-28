import type { JSX } from 'react'

import { Boxes, MonitorX } from 'lucide-react'
import { Button } from '@/components/ui/button'

import { useTranslations } from '@/i18n'
import { bimCopy } from '@/i18n/namespaces/bim'

import { useModelViewport } from '../hooks/use-model-viewport'

import { IfcViewerCanvasLazy, ModelViewportProgress, ViewerRetry } from './ifc-model-viewer'

import { ViewerNotice } from './viewer'

/**
 * The canvas, or the honest sentence that replaces it.
 *
 * Five different situations end without a building on screen, and they are
 * five different facts: the list has not arrived, the list failed, the project
 * has no model, the model is still being read, and this browser cannot render.
 * Collapsing any two of them tells the reader something untrue about their own
 * upload, which is why each gets its own branch and its own words.
 */
export function StageCanvas({
  isLoading,
  error,
  onRetry,
  onClose,
  hasModels,
  model,
  source,
  viewport,
}: {
  isLoading: boolean
  error: string | null
  onRetry: () => void
  /** Closes the stage — the way back to Dateien, where a model is uploaded. */
  onClose: () => void
  hasModels: boolean
  model: { status: string; errorMessage: string | null } | null
  source: { data: string | null; error: string | null; reload: () => void }
  viewport: ReturnType<typeof useModelViewport>
}): JSX.Element {
  const t = useTranslations(bimCopy)

  // `isLoading && nothing to show yet`, not `isLoading`.
  //
  // The model list polls every four seconds while ANY model in the project is
  // extracting, and each tick sets `isLoading` while deliberately keeping the
  // previous `data` — the hook's comment explains at length why. Keying the
  // veil on the flag alone undid that: uploading revision v3 while looking at
  // v2 swapped the canvas for "Modell wird geladen…" every four seconds,
  // unmounting the viewport, destroying the WebGPU device and re-streaming up
  // to 149 MB, losing the camera, the cut and every measurement each time.
  if (isLoading && !hasModels) {
    return <ModelViewportProgress phase="downloading" percent={null} />
  }
  if (error) {
    return (
      <ViewerNotice
        icon={Boxes}
        title={t('loadFailed.title')}
        description={t('loadFailed.description')}
        // Every error state in this viewer used to be terminal: the notices
        // took no action, `reload` on the hook had no caller, and the string
        // for this button had sat unused in both dictionaries since it was
        // written. Closing and reopening the stage was the only escape, and
        // nothing on screen suggested it.
        action={<ViewerRetry onClick={onRetry} />}
      />
    )
  }
  if (!hasModels || !model) {
    return (
      <ViewerNotice
        icon={Boxes}
        title={t('empty.title')}
        description={t('empty.description')}
        // A project with no model got a sentence and no way forward: the
        // notice says "upload an .ifc under Dateien" while sitting on top of
        // Dateien, with the × in the corner as the only exit anyone could
        // find. `empty.action` has existed in both dictionaries the whole
        // time with nothing rendering it.
        action={
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            {t('empty.action')}
          </Button>
        }
      />
    )
  }
  if (model.status !== 'ready') {
    return (
      <ViewerNotice
        icon={Boxes}
        title={t(`status.${model.status}`)}
        description={
          model.errorMessage ??
          // A FAILED extraction that stored no message used to fall through to
          // "Das Modell wird noch gelesen" — printed directly under "Modell
          // konnte nicht gelesen werden", so the notice contradicted its own
          // heading and the reader was left waiting for something that had
          // already stopped.
          (model.status === 'failed' ? t('stage.readFailed') : t('stage.notReady'))
        }
      />
    )
  }
  if (!viewport.webGpu) {
    return (
      <ViewerNotice
        icon={MonitorX}
        title={t('viewer.unsupported.title')}
        description={t('viewer.unsupported.description')}
      />
    )
  }
  if (viewport.status.phase === 'error') {
    return (
      <ViewerNotice
        icon={MonitorX}
        title={t('viewer.unavailable.title')}
        description={t('viewer.unavailable.description')}
        detail={
          viewport.status.message
            ? t('viewer.unavailable.reason', { message: viewport.status.message })
            : undefined
        }
        // Re-signing mints a NEW url, and a new url is what resets the stored
        // status and remounts the canvas — the recovery path existed and had
        // nothing to trigger it. A device loss (a driver reset, a laptop
        // waking) is the common way to land here, and it is entirely
        // recoverable.
        action={<ViewerRetry onClick={source.reload} />}
      />
    )
  }
  // A presigned URL that could not be minted — an expired session, a
  // withdrawn feature flag, a dropped connection. Its own branch, because the
  // fallthrough below renders an indeterminate progress bar, and a progress
  // bar that will never finish is the least honest thing this surface can do.
  if (source.error) {
    return (
      <ViewerNotice
        icon={MonitorX}
        title={t('viewer.unavailable.title')}
        description={t('viewer.unavailable.description')}
        action={<ViewerRetry onClick={source.reload} />}
      />
    )
  }
  if (!viewport.canvasProps) {
    return <ModelViewportProgress phase="downloading" percent={null} />
  }
  // The reader stopped the download. The canvas stays unmounted — the unmount
  // is what aborts the request — and the way back is one press, not a reopen.
  if (viewport.download.cancelled) {
    return (
      <ViewerNotice
        icon={Boxes}
        title={t('stage.download.cancelled.title')}
        description={t('stage.download.cancelled.description')}
        action={<ViewerRetry onClick={viewport.download.restart} label={t('stage.download.restart')} />}
      />
    )
  }

  return (
    <>
      <IfcViewerCanvasLazy {...viewport.canvasProps} className="size-full" />
      <ModelViewportProgress
        phase={viewport.status.phase}
        percent={viewport.status.percent}
        bytes={viewport.status.bytes}
        onCancel={viewport.download.cancel}
      />
    </>
  )
}
