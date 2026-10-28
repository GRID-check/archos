'use client'

/**
 * „Als Skizze bearbeiten": a drawing Piloti made, opened in Excalidraw so a
 * person can rework it and file their own version into the project. The
 * drawing is a flow or a Gliederung laid out as a sketch (`sketchFromModel`),
 * or a sketch Piloti drew itself (an ```excalidraw fence, ADR-0146).
 *
 * The canvas (`sketch-canvas.tsx`) is loaded with `next/dynamic` when the
 * dialog opens, never before, so a chat with diagrams in it downloads none of
 * Excalidraw until someone asks to edit one (ADR-0141).
 *
 * Filing is the existing one: `useDiagramFiling` posts to
 * `POST /api/projects/{id}/diagrams` (the `diagram-file` operation) with
 * `sourceKind: 'excalidraw'` and `edited: true`, so the files say a person
 * edited them, and the turn's trace gets a `diagram-filed: edited` score.
 *
 * A close with unsaved changes asks once, in place. Excalidraw keeps no draft
 * of its own here (its local storage is the excalidraw.com app's, not the
 * component's), so a stray Escape would otherwise throw the work away.
 */

import dynamic from 'next/dynamic'
import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLocale, useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { useDiagramFiling } from '../use-diagram-filing'
import { useDiagramTheme } from '../use-diagram-theme'
import { DiagramFilingControls } from '../components/diagram-filing-controls'
import type { SketchCanvasHandle } from './sketch-canvas'

/** While the canvas chunk loads, and in its place when it could not be loaded (offline, a stale deploy). */
function CanvasLoading({ error }: { error?: Error | null }) {
  const t = useTranslations(diagramsCopy)
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-sm" role="status">
      {error ? t('sketch.loadFailed') : t('sketch.loading')}
    </div>
  )
}

const SketchCanvas = dynamic(() => import('./sketch-canvas'), {
  ssr: false,
  loading: ({ error }) => <CanvasLoading error={error} />,
})

export interface SketchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The fence the drawing came from: its title names the file. */
  source: string
  /** The starting scene as Excalidraw skeletons, laid out once per opening by the caller. */
  elements: readonly object[]
  /** A title the fence states outside its source (a sketch fence's `title`). */
  title?: string | null
}

export function SketchDialog({ open, onOpenChange, source, elements, title }: SketchDialogProps) {
  const t = useTranslations(diagramsCopy)
  const { locale } = useLocale()
  const theme = useDiagramTheme()
  const handle = useRef<SketchCanvasHandle | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const prepareSketch = useCallback(async () => {
    if (!handle.current) throw new Error('the canvas is not ready')
    return handle.current.prepare()
  }, [])
  const filing = useDiagramFiling({ source, fileSvg: null, prepareSketch, title })
  const filed = filing.state.kind === 'filed' || filing.state.kind === 'partial'

  const requestClose = useCallback(
    (next: boolean) => {
      if (next) return onOpenChange(true)
      if (dirty && !filed) return setConfirmingDiscard(true)
      onOpenChange(false)
    },
    [dirty, filed, onOpenChange]
  )
  const onReady = useCallback((ready: SketchCanvasHandle) => {
    handle.current = ready
  }, [])

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        mobilePresentation="fullscreen"
        // Escape is the canvas's (deselect, leave a tool), not the dialog's: a close
        // by Escape mid-drawing was one keystroke from the discard question.
        onEscapeKeyDown={(event) => event.preventDefault()}
        data-testid="sketch-dialog"
        className="flex h-[90dvh] w-[calc(100vw-2*max(2.5vw,env(safe-area-inset-left),env(safe-area-inset-right)))] max-w-[calc(100vw-2*max(2.5vw,env(safe-area-inset-left),env(safe-area-inset-right)))] flex-col gap-3 overflow-hidden p-4 sm:max-w-[calc(100vw-2*max(2.5vw,env(safe-area-inset-left),env(safe-area-inset-right)))] sm:p-5 phone:h-dvh phone:max-h-dvh phone:w-screen phone:gap-2 phone:p-0"
      >
        <DialogHeader className="shrink-0 pr-8 text-left phone:pt-[max(0.75rem,env(safe-area-inset-top))] phone:pr-[calc(env(safe-area-inset-right)+3.75rem)] phone:pl-[max(1rem,env(safe-area-inset-left))]">
          <DialogTitle className="text-base">{t('sketch.title')}</DialogTitle>
          <DialogDescription className="text-xs">{t('sketch.description')}</DialogDescription>
        </DialogHeader>
        <div className="border-border min-h-0 flex-1 overflow-hidden rounded-lg border phone:rounded-none phone:border-x-0">
          {open ? (
            <SketchCanvas
              initialElements={elements}
              theme={theme}
              langCode={locale === 'de' ? 'de-DE' : 'en'}
              onReady={onReady}
              onDirtyChange={setDirty}
              readOnly={filed}
            />
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 text-sm phone:px-[max(1rem,env(safe-area-inset-left))] phone:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {confirmingDiscard ? (
            <>
              <span className="mr-auto" role="alert">
                {t('sketch.discardQuestion')}
              </span>
              <Button variant="ghost" onClick={() => setConfirmingDiscard(false)}>
                {t('sketch.keepEditing')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmingDiscard(false)
                  onOpenChange(false)
                }}
              >
                {t('sketch.discard')}
              </Button>
            </>
          ) : (
            <>
              <span className="text-muted-foreground mr-auto text-xs" aria-live="polite">
                {filed ? <DiagramFilingControls filing={filing} /> : null}
                {filing.state.kind === 'failed' ? (
                  <span className="text-destructive">{filing.state.message}</span>
                ) : null}
              </span>
              <Button variant="ghost" onClick={() => requestClose(false)}>
                {t('sketch.close')}
              </Button>
              {filed ? null : (
                <Button
                  onClick={() => void filing.file()}
                  disabled={!filing.target || filing.state.kind === 'filing'}
                  data-testid="sketch-save"
                >
                  {filing.state.kind === 'filing' ? t('sketch.saving') : t('sketch.save')}
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
