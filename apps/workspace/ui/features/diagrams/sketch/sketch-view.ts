'use client'

/**
 * Where the sheet of a live sketch canvas sits: its elements, their padded
 * frame, the scroll, zoom and selection, read once per animation frame. The
 * pins (`sketch-pins.tsx`) and the links (`sketch-links.tsx`) both lay their
 * marks over it. Its own module so the links, drawn on every canvas, do not
 * import the pins and with them the document review
 * (`task workspace:blast-radius`).
 *
 * Only the Excalidraw API's shape is named here, never its module:
 * `sketch-canvas.tsx` stays the one importer (`sketch-isolation.spec.ts`).
 */

import { useEffect, useState } from 'react'
import { paddedFrame, type AnchorElement, type SheetFrame } from '@/lib/annotations/sketch-anchor'

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
