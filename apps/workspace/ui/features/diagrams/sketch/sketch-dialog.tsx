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
 * A filed sketch reopened from Files (ADR-0148) opens here too, with its
 * stored scene (`revision`), and „Als neue Fassung speichern" writes the next
 * Fassung of that document (`useSketchRevision`, `PUT /api/documents/{id}/sketch`)
 * instead of filing a new pair.
 *
 * A reopened sketch is live in its document's room (`useSketchRoom`): the
 * others' pointers, selections and strokes show as they draw, a reader's
 * canvas only shows, and any writer's save is the Fassung for everyone
 * (`docs/architecture/diagrams.md`, "Two people on one Skizze"). The canvas
 * stays open after a save, sitting on the new Fassung; a save refused because
 * someone saved first merges their Fassung in and tries once more.
 *
 * A close with unsaved changes asks once, in place. Excalidraw keeps no draft
 * of its own here (its local storage is the excalidraw.com app's, not the
 * component's), so a stray Escape would otherwise throw the work away.
 */

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSketch } from '@/adapters/api/diagrams-client'
import type { WireElement } from '@/lib/diagrams/sketch-room-types'
import type { RealtimePeer } from '@/lib/realtime/types'
import type { DocumentReview, ReviewDraft, RoomTransport } from '@/features/documents'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLocale, useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { useDiagramFiling } from '../use-diagram-filing'
import { useDiagramTheme } from '../use-diagram-theme'
import { DiagramFilingControls } from '../components/diagram-filing-controls'
import type { SketchCanvasHandle } from './sketch-canvas'
import { useSketchRevision, type SavedRevision, type SketchRevisionState } from './use-sketch-revision'
import { useSketchRoom, type SketchRoom } from './use-sketch-room'

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
  /** A filed sketch reopened from Files: its stored scene, saved as the next Fassung of `documentId`. */
  revision?: {
    documentId: string
    baseVersionId: string | null
    scene: { elements: readonly object[]; appState?: Record<string, unknown> }
    /** Whether the reader may save; otherwise the canvas only shows (and still shows the others draw). */
    canWrite?: boolean
    onSaved?: () => void
    /** The room's transport: the tab's live connection by default, a stand-in in the `/dev` preview. */
    roomTransport?: RoomTransport
    /** The document's review (the preview's): its Anmerkungen are drawn over the canvas on their elements. */
    review?: DocumentReview | null
  } | null
}

/** The line beside the buttons after a save of a reopened sketch. */
function RevisionStatus({ state }: { state: SketchRevisionState }) {
  const t = useTranslations(diagramsCopy)
  if (state.kind === 'saved') {
    return (
      <span>
        {t('sketch.savedVersion', { number: String(state.versionNumber) })}
        {state.pdfStale ? <span data-testid="sketch-pdf-stale"> {t('sketch.pdfStale')}</span> : null}
      </span>
    )
  }
  if (state.kind === 'stale') {
    return <span className="text-destructive">{t(state.merged ? 'sketch.saveAgain' : 'sketch.staleVersion')}</span>
  }
  if (state.kind === 'failed') return <span className="text-destructive">{state.message}</span>
  return null
}

/** What the room says beside the buttons: another's save, and an element too large to share live. */
function RoomStatus({ room }: { room: SketchRoom }) {
  const t = useTranslations(diagramsCopy)
  const { peerSave, tooLarge, refused } = room
  return (
    <>
      {peerSave ? (
        <span data-testid="sketch-peer-saved">
          {t(peerSave.matches ? 'sketch.peerSaved' : 'sketch.peerSavedDiffers', { name: peerSave.by.name })}
        </span>
      ) : null}
      {tooLarge.length > 0 ? <span> {t('sketch.tooLargeLive')}</span> : null}
      {refused.length > 0 ? <span> {t('sketch.refusedLive')}</span> : null}
    </>
  )
}

export function SketchDialog({ open, onOpenChange, source, elements, title, revision = null }: SketchDialogProps) {
  const t = useTranslations(diagramsCopy)
  const { locale } = useLocale()
  const theme = useDiagramTheme()
  const handle = useRef<SketchCanvasHandle | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState<false | { others: string[] }>(false)
  const canWrite = revision?.canWrite ?? true

  const nameOf = useCallback(
    (peer: RealtimePeer) => (peer.forName ? t('sketch.agentFor', { name: peer.name, forName: peer.forName }) : peer.name),
    [t]
  )
  const room = useSketchRoom({
    documentId: open && revision ? revision.documentId : null,
    canWrite,
    baseVersionId: revision?.baseVersionId ?? null,
    transport: revision?.roomTransport,
    nameOf,
  })
  const roomRef = useRef(room)
  roomRef.current = room
  const baseOf = useCallback(() => roomRef.current.base(), [])
  const peerOf = useCallback(() => roomRef.current.peerId, [])
  /** Someone saved first: their Fassung is merged into this canvas, and the save is tried once more on it. */
  const resolveStale = useCallback(async () => {
    if (!revision) return false
    // An open editor merging, not a person opening the document: not a read the download log records.
    const latest = await getSketch(revision.documentId, undefined, { probe: true }).catch(() => null)
    if (!latest) return false
    roomRef.current.mergeFrom(latest.scene.elements as unknown as WireElement[], latest.versionId)
    return true
  }, [revision])
  const onRevisionSaved = useCallback(
    (saved: SavedRevision) => {
      handle.current?.markSaved()
      void roomRef.current.announceSave(saved.versionId, saved.elements as unknown as WireElement[])
      revision?.onSaved?.()
    },
    [revision]
  )
  // Another writer saved what this canvas shows: nothing here is unsaved any more. Saved something
  // else (an agent's change, a delta this canvas missed): its Fassung is merged in at once.
  const { peerSave } = room
  const resolveStaleRef = useRef(resolveStale)
  resolveStaleRef.current = resolveStale
  useEffect(() => {
    if (!peerSave) return
    if (peerSave.matches) handle.current?.markSaved()
    else void resolveStaleRef.current()
  }, [peerSave])

  const prepareSketch = useCallback(async () => {
    if (!handle.current) throw new Error('the canvas is not ready')
    return handle.current.prepare()
  }, [])
  const filing = useDiagramFiling({ source, fileSvg: null, prepareSketch, title })
  const revised = useSketchRevision(
    revision ? { documentId: revision.documentId, baseVersionId: baseOf, peerId: peerOf } : null,
    prepareSketch,
    onRevisionSaved,
    resolveStale
  )
  // A reopened sketch stays open after a save: the room goes on, on the new Fassung.
  const filed = revision ? false : filing.state.kind === 'filed' || filing.state.kind === 'partial'
  const saving = revision ? revised.state.kind === 'saving' : filing.state.kind === 'filing'

  const requestClose = useCallback(
    (next: boolean) => {
      if (next) return onOpenChange(true)
      if (dirty && !filed) return setConfirmingDiscard({ others: revision ? room.otherPeople() : [] })
      onOpenChange(false)
    },
    [dirty, filed, onOpenChange, revision, room]
  )
  // A mark on a selection: its elements must be in the saved Fassung, so unsaved work is saved first.
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next
    setDirty(next)
  }, [])
  const { save: saveRevision } = revised
  const annotate = useCallback(
    async (draft: ReviewDraft) => {
      if (dirtyRef.current) await saveRevision()
      if (!dirtyRef.current) revision?.review?.setDraft(draft)
    },
    [saveRevision, revision]
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
          <DialogDescription className="text-xs">
            {t(!revision ? 'sketch.description' : canWrite ? 'sketch.reviseDescription' : 'sketch.viewOnly')}
          </DialogDescription>
        </DialogHeader>
        <div className="border-border min-h-0 flex-1 overflow-hidden rounded-lg border phone:rounded-none phone:border-x-0">
          {open ? (
            <SketchCanvas
              initialElements={elements}
              initialScene={revision?.scene ?? null}
              theme={theme}
              langCode={locale === 'de' ? 'de-DE' : 'en'}
              onReady={onReady}
              onDirtyChange={onDirtyChange}
              readOnly={filed}
              collab={revision ? room.collab : null}
              pins={
                revision?.review
                  ? { review: revision.review, canAnnotate: canWrite && revision.review.canAnnotate, onAnnotate: annotate, canPickAssignee: true }
                  : null
              }
            />
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 text-sm phone:px-[max(1rem,env(safe-area-inset-left))] phone:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {confirmingDiscard ? (
            <>
              <span className="mr-auto" role="alert">
                {confirmingDiscard.others.length > 0
                  ? t('sketch.discardShared', { names: confirmingDiscard.others.join(', ') })
                  : t('sketch.discardQuestion')}
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
                {revision ? <RevisionStatus state={revised.state} /> : null}
                {revision ? <RoomStatus room={room} /> : null}
                {!revision && filed ? <DiagramFilingControls filing={filing} /> : null}
                {!revision && filing.state.kind === 'failed' ? (
                  <span className="text-destructive">{filing.state.message}</span>
                ) : null}
              </span>
              <Button variant="ghost" onClick={() => requestClose(false)}>
                {t('sketch.close')}
              </Button>
              {filed || !canWrite ? null : (
                <Button
                  onClick={() => void (revision ? revised.save() : filing.file())}
                  disabled={(!revision && !filing.target) || saving}
                  data-testid="sketch-save"
                >
                  {revision
                    ? t(saving ? 'sketch.savingVersion' : 'sketch.saveVersion')
                    : t(saving ? 'sketch.saving' : 'sketch.save')}
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
