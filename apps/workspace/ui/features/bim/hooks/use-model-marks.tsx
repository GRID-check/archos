'use client'

/**
 * Anmerkungen on the model on screen: the stage's half.
 *
 * A mark on a model is the review's own mark (`useDocumentReview`, the same
 * list, thread, status, Zuständige and Frist as on a page or a Skizze) anchored
 * to a viewpoint instead of a box. This hook is the glue between that review
 * and the viewport: it asks the canvas for a viewpoint when a mark is set,
 * draws the marks as pins, and puts a mark's view back on a jump or a link
 * (`?mark=`). It owns no list and no vocabulary of its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDocumentReview } from '@/features/documents'
import { AnnotationRequestError } from '@/lib/annotations/client'
import { isLive, type AnnotationView } from '@/lib/annotations/types'
import type { ViewpointInput, ViewpointView } from '@/lib/annotations/viewpoint-types'
import type { ModelStageController } from '../components/use-model-stage-controller'
import { ModelPins } from '../components/model-pins'
import { firstRestoredSelection, type CaptureNotices, type ViewerBridge, type ViewerPin, type ViewpointCapture } from '../lib/viewpoint-bridge'
import type { RestoredViewpoint } from '../lib/viewpoint'
import { MAX_PINNED_MARKS, useMarkViewpoints } from './use-mark-viewpoints'

/** What the panel says about the last thing that happened, besides the list. */
export type MarksNotice =
  | { kind: 'missing'; count: number }
  | { kind: 'planes'; count: number }
  | { kind: 'captureFailed' }
  | { kind: 'jumpFailed' }
  | { kind: 'carryFailed' }
  | { kind: 'carryNotReady' }
  | { kind: 'cut'; notices: CaptureNotices }

/** The wire's input for a stored viewpoint: `GET` says `pin: null` where the request says nothing. */
function asInput(view: ViewpointView): ViewpointInput {
  return { camera: view.camera, clippingPlanes: view.clippingPlanes, components: view.components }
}

/** The summary says it is a view of a model; page marks never show here, but a list is not trusted to be only ours. */
const isViewpointMark = (mark: AnnotationView): boolean => mark.anchor === 'viewpoint'

/** The pin of a mark: its stored point, else the elements it selected. */
export function pinOf(mark: AnnotationView, viewpoint: ViewpointView): ViewerPin {
  return {
    id: mark.id,
    world: viewpoint.pin?.point ?? null,
    globalIds: viewpoint.pin ? [] : viewpoint.components.selection.globalIds.slice(0, 50),
  }
}

/**
 * What the marks read of the stage: the model, its elements, the viewport's
 * camera, visibility and phase, the link's view and its one writer.
 */
export type ModelMarksStage = Pick<ModelStageController, 'model' | 'modelId' | 'elementList' | 'elementsLoading' | 'view' | 'setView' | 'canCollaborate'> & {
  viewport: {
    camera: ModelStageController['viewport']['camera']
    visibility: Pick<ModelStageController['viewport']['visibility'], 'restore'>
    status: Pick<ModelStageController['viewport']['status'], 'phase'>
  }
}

export function useModelMarks(controller: ModelMarksStage) {
  const { model, modelId, elementList, elementsLoading, viewport, view, setView } = controller
  /**
   * A view is put back only once the model's elements are known: a restore resolves GlobalIds against them, and
   * against an empty list every element would count as missing and an isolation would show nothing.
   */
  const canJump = viewport.status.phase === 'ready' && !elementsLoading && elementList.length > 0
  const documentId = modelId && model ? model.documentId : null
  const review = useDocumentReview(documentId ?? '', { enabled: documentId !== null })

  const [open, setOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [captureNonce, setCaptureNonce] = useState(0)
  const [restore, setRestore] = useState<{ nonce: number; viewpoint: ViewpointInput } | null>(null)
  const [notice, setNotice] = useState<MarksNotice | null>(null)
  /** The element a restore selected: the canvas must not fly to it and undo the pose just restored. */
  const [restoredElement, setRestoredElement] = useState<string | null>(null)
  /** Which restored element the selection has already reached; until it has, a stale selection is not a move away. */
  const reached = useRef<string | null>(null)
  const restoreNonce = useRef(0)
  const pending = useRef<ViewpointInput | null>(null)

  const marks = useMemo(() => review.annotations.filter(isViewpointMark), [review.annotations])
  const pinned = useMemo(() => marks.filter(isLive).slice(0, MAX_PINNED_MARKS), [marks])
  const wanted = useMemo(() => pinned.map((mark) => mark.id), [pinned])
  const { viewpoints, read, forget } = useMarkViewpoints(documentId, wanted)

  const pins = useMemo(
    () =>
      pinned.flatMap((mark) => {
        const viewpoint = viewpoints.get(mark.id)
        return viewpoint ? [pinOf(mark, viewpoint)] : []
      }),
    [pinned, viewpoints]
  )

  const openMark = useCallback(
    (annotationId: string | null) => {
      review.select(annotationId)
      if (annotationId) setOpen(true)
    },
    [review]
  )

  /** Put the view of a mark back: the canvas moves the camera and reports the rest (`onRestored`). */
  const jump = useCallback(
    async (annotationId: string) => {
      if (!canJump) return
      setNotice(null)
      try {
        const viewpoint = asInput(await read(annotationId))
        pending.current = viewpoint
        restoreNonce.current += 1
        setRestore({ nonce: restoreNonce.current, viewpoint })
      } catch {
        setNotice({ kind: 'jumpFailed' })
      }
    },
    [read, canJump]
  )

  const onRestored = useCallback(
    (restored: RestoredViewpoint) => {
      const viewpoint = pending.current
      pending.current = null
      if (!viewpoint) return
      const expressIdByGlobalId = new Map(elementList.map((element) => [element.globalId, element.expressId] as const))
      const element = firstRestoredSelection(viewpoint.components.selection.globalIds, expressIdByGlobalId)
      viewport.visibility.restore(restored.visibility)
      // One write: every `setView` is made from the view this render saw, so a second would undo the first. The level
      // filter goes because the viewpoint's visibility already says what was shown, and the camera's `view` is left
      // alone because naming a view again would fit the model over the pose just restored.
      setView({
        element: element ?? undefined,
        storey: undefined,
        camera: { ...viewport.camera, orthographic: viewpoint.camera.type === 'orthographic', section: restored.section },
      })
      reached.current = null
      setRestoredElement(element)
      setNotice(
        restored.missing > 0
          ? { kind: 'missing', count: restored.missing }
          : restored.ignoredPlanes > 0
            ? { kind: 'planes', count: restored.ignoredPlanes }
            : null
      )
    },
    [elementList, setView, viewport.camera, viewport.visibility]
  )

  /**
   * „übernehmen": the mark goes on with the model's current Fassung, through the review's own carry (one PATCH,
   * `carryToCurrent`). Its view is new then, or kept when none of its elements is left, so its pin is read again.
   */
  const carry = useCallback(
    async (annotation: AnnotationView) => {
      setNotice(null)
      try {
        await review.carry(annotation)
        forget(annotation.id)
      } catch (error) {
        // A colleague's move first is the review's own conflict notice, said once, there.
        if (error instanceof AnnotationRequestError && error.status === 409) return
        const notReady = error instanceof AnnotationRequestError && error.reason === 'model_not_ready'
        setNotice({ kind: notReady ? 'carryNotReady' : 'carryFailed' })
      }
    },
    [review, forget]
  )

  /** Take the view of the live renderer and open the composer on it (`onViewpoint`). */
  const startMark = useCallback(() => {
    setOpen(true)
    setNotice(null)
    review.select(null)
    review.setDraft(null)
    setCapturing(true)
    setCaptureNonce((nonce) => nonce + 1)
  }, [review])

  const onViewpoint = useCallback(
    (capture: ViewpointCapture | null) => {
      setCapturing(false)
      if (!capture) {
        setNotice({ kind: 'captureFailed' })
        return
      }
      // The review's draft is a box on a page; a model's carries a placeholder the wire drops (`placeOnWire`).
      review.setDraft({ page: 1, shape: 'point', x: 0.5, y: 0.5, w: null, h: null, viewpoint: capture.viewpoint })
      const { selectionCut, visibilityDropped, noSnapshot } = capture.notices
      setNotice(selectionCut || visibilityDropped || noSnapshot ? { kind: 'cut', notices: capture.notices } : null)
    },
    [review]
  )

  // A link with `?mark=` opens that mark's thread at once, and its view once the model is drawn: the thread is
  // readable while the building still loads, and the camera is only put back on a renderer that has the model.
  const opened = useRef<string | null>(null)
  const linked = useRef<string | null>(null)
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  const selectRef = useRef(review.select)
  selectRef.current = review.select
  const markInLink = view.mark ?? null
  // Selected once the list has it: a (re)load of the review clears the selection, so an earlier pick would be lost.
  const listed = markInLink !== null && marks.some((mark) => mark.id === markInLink)
  useEffect(() => {
    if (!markInLink || !listed || opened.current === markInLink) return
    opened.current = markInLink
    setOpen(true)
    selectRef.current(markInLink)
  }, [markInLink, listed])
  useEffect(() => {
    if (!markInLink || !documentId || !canJump || linked.current === markInLink) return
    linked.current = markInLink
    void jumpRef.current(markInLink)
  }, [markInLink, documentId, canJump])

  const close = useCallback(() => {
    setOpen(false)
    review.setDraft(null)
    review.select(null)
  }, [review])

  const bridge = useMemo<ViewerBridge | undefined>(
    () =>
      documentId
        ? {
            captureNonce,
            onViewpoint,
            restore,
            onRestored,
            pins,
            pinNodes: <ModelPins marks={pinned} pins={pins} selectedId={review.selectedId} onOpen={openMark} />,
          }
        : undefined,
    [documentId, captureNonce, onViewpoint, restore, onRestored, pins, pinned, review.selectedId, openMark]
  )

  const selectedElement = view.element ?? null
  // Once the selection moves off the element a restore selected, the override goes: picking it again flies to it.
  useEffect(() => {
    if (restoredElement === null) return
    if (selectedElement === restoredElement) reached.current = restoredElement
    else if (reached.current === restoredElement) setRestoredElement(null)
  }, [selectedElement, restoredElement])
  /** Props the canvas gets in place of the viewport's: no fly-to on the element a restore selected. */
  const canvasOverride = restoredElement !== null && restoredElement === selectedElement ? { zoomToSelection: false as const } : null

  return {
    available: documentId !== null,
    documentId,
    review,
    marks,
    open,
    setOpen,
    close,
    capturing,
    startMark,
    openMark,
    jump,
    canJump,
    carry,
    notice,
    dismissNotice: () => setNotice(null),
    bridge,
    canvasOverride,
    canPickAssignee: controller.canCollaborate,
    liveCount: marks.filter(isLive).length,
  }
}

export type ModelMarks = ReturnType<typeof useModelMarks>
