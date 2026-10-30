'use client'

/**
 * A Skizze's Anmerkungen over its live canvas (migration 0192,
 * `docs/architecture/document-annotations.md`, „A mark on a Skizze“).
 *
 * The marks are the review's own (`useDocumentReview`, the preview's instance,
 * so the tab is in the room once), drawn by the review's own layer
 * (`ReviewPageLayer`, page 1) and opened in its own cards. What is particular
 * here is the frame: a mark is stored as a share of the exported sheet, and
 * the sheet is the scene's bounds plus the export padding. So the layer is laid
 * over the canvas exactly where that sheet sits at the canvas's scroll and
 * zoom, and a mark pinned to elements is placed from where those elements are
 * NOW (`lib/annotations/sketch-anchor.ts`, the same arithmetic the server
 * stores with): a pin follows its element while it is dragged, before any save.
 *
 * Only the Excalidraw API's shape is named here, never its module:
 * `sketch-canvas.tsx` stays the one importer (`sketch-isolation.spec.ts`).
 *
 * „Anmerkung“ on a selection: the selected elements become the draft's
 * anchor. The server takes a mark's elements from the saved Fassung, so the
 * dialog saves first when anything is unsaved (`onAnnotate`).
 */

import { MessageSquarePlus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  paddedFrame,
  regionInFrame,
  type AnchorElement,
  type SheetFrame,
  type SheetRegion,
} from '@/lib/annotations/sketch-anchor'
import { MAX_ANCHOR_ELEMENTS, type AnnotationView } from '@/lib/annotations/types'
import { DraftCard, ReviewPageLayer, ThreadCard, type DocumentReview, type ReviewDraft } from '@/features/documents'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'

/** What the pins read of the canvas: Excalidraw's imperative API, by shape. */
export interface SketchViewApi {
  getSceneElements: () => readonly AnchorElement[]
  getAppState: () => {
    scrollX: number
    scrollY: number
    zoom: { value: number }
    selectedElementIds: Readonly<Record<string, boolean>>
  }
  onChange: (callback: () => void) => () => void
  onScrollChange: (callback: () => void) => () => void
}

export interface SketchPinsProps {
  api: SketchViewApi | null
  review: DocumentReview
  /** Whether the reader may set a mark here: they may write the document, and the canvas is theirs to edit. */
  canAnnotate: boolean
  /** Set a mark on these elements: the dialog saves first when the canvas has unsaved changes. */
  onAnnotate: (draft: ReviewDraft & { elementIds: string[] }) => void
  canPickAssignee?: boolean
}

const NONE: string[] = []

export interface CanvasView {
  elements: readonly AnchorElement[]
  frame: SheetFrame | null
  scrollX: number
  scrollY: number
  zoom: number
  selected: string[]
}

function readView(api: SketchViewApi): CanvasView {
  const elements = api.getSceneElements()
  const state = api.getAppState()
  return {
    elements,
    frame: paddedFrame(elements),
    scrollX: state.scrollX,
    scrollY: state.scrollY,
    zoom: state.zoom.value,
    selected: Object.entries(state.selectedElementIds)
      .filter(([, on]) => on)
      .map(([id]) => id),
  }
}

/** The canvas's view, read again once per animation frame while it changes or scrolls. */
export function useCanvasView(api: SketchViewApi | null): CanvasView | null {
  const [view, setView] = useState<CanvasView | null>(null)
  useEffect(() => {
    if (!api) return
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        setView(readView(api))
      })
    }
    setView(readView(api))
    const offChange = api.onChange(schedule)
    const offScroll = api.onScrollChange(schedule)
    return () => {
      offChange()
      offScroll()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [api])
  return view
}

/** A mark with its box where its elements stand now; a mark whose elements are gone keeps the box it has. */
export function placedLive<T extends { elementIds?: string[] | null; x: number; y: number; w: number | null; h: number | null }>(
  mark: T,
  elements: readonly AnchorElement[],
  frame: SheetFrame | null
): T {
  const ids = mark.elementIds
  const region: SheetRegion | null = ids && frame ? regionInFrame(elements, ids, frame) : null
  return region ? { ...mark, x: region.x, y: region.y, w: region.w, h: region.h } : mark
}

export function SketchPins({ api, review, canAnnotate, onAnnotate, canPickAssignee = false }: SketchPinsProps) {
  const t = useTranslations(diagramsCopy)
  const view = useCanvasView(api)
  const elements = view?.elements
  const frame = view?.frame ?? null

  // The review as the layer reads it, with every pinned mark (and the draft) where its elements stand now.
  const live = useMemo((): DocumentReview => {
    if (!elements) return review
    const annotations = review.annotations.map((mark: AnnotationView) => placedLive(mark, elements, frame))
    const draft = review.draft ? placedLive(review.draft, elements, frame) : null
    return { ...review, annotations, draft }
  }, [review, elements, frame])

  const selected = view?.selected ?? NONE
  const annotate = useCallback(() => {
    const ids = view?.selected ?? NONE
    if (!view?.frame || ids.length === 0) return
    const region = regionInFrame(view.elements, ids, view.frame)
    if (!region) return
    onAnnotate({ page: 1, shape: 'region', ...region, elementIds: ids.slice(0, MAX_ANCHOR_ELEMENTS) })
  }, [view, onAnnotate])

  const renderThread = useCallback(
    (anchor: { placement: 'left' | 'right' | 'below' }) => {
      if (live.draft) return <DraftCard review={live} draft={live.draft} placement={anchor.placement} canPickAssignee={canPickAssignee} />
      const mark = live.annotations.find((annotation) => annotation.id === live.selectedId)
      return mark ? (
        <ThreadCard key={mark.id} review={live} annotation={mark} placement={anchor.placement} canPickAssignee={canPickAssignee} />
      ) : null
    },
    [live, canPickAssignee]
  )

  if (!view || !frame) return null
  const sheet = {
    left: (frame.left + view.scrollX) * view.zoom,
    top: (frame.top + view.scrollY) * view.zoom,
    width: frame.width * view.zoom,
    height: frame.height * view.zoom,
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="sketch-pins">
      <div className="absolute" style={sheet} data-testid="sketch-pins-sheet">
        <ReviewPageLayer page={1} review={live} focused renderThread={renderThread} />
      </div>
      {canAnnotate && selected.length > 0 && !review.draft ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="pointer-events-auto absolute bottom-16 left-1/2 -translate-x-1/2 gap-1.5 shadow-md"
          onClick={annotate}
          data-testid="sketch-annotate"
        >
          <MessageSquarePlus className="size-3.5" aria-hidden />
          {t('sketch.annotate')}
        </Button>
      ) : null}
    </div>
  )
}
