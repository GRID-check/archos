/**
 * The frame the loaded model is drawn in, remembered per renderer.
 *
 * The geometry kernel reports the offsets that moved the model near the origin
 * (`CoordinateInfo.wasmRtcOffset`, `originShift`) on its stream events. A
 * viewpoint is stored in IFC world coordinates, so capturing and restoring one
 * needs them (`viewpoint.ts`). The canvas controller only notes each event here
 * (one line); everything that reads the frame lives beside the viewpoint code,
 * and the controller does not grow.
 *
 * A WeakMap keyed by the renderer: the frame belongs to the model that renderer
 * drew, dies with it, and needs no ref threaded through the controller.
 */

import type { RenderFrameInfo } from '@ifc-lite/geometry/world-frame'

const frames = new WeakMap<object, RenderFrameInfo>()

/** The part of a geometry stream event that carries the frame. */
export interface FrameEvent {
  type?: string
  coordinateInfo?: RenderFrameInfo | null
}

/** Remember the latest offsets a stream event reports; events without any change nothing. */
export function noteGeometryEvent(renderer: object, event: FrameEvent): void {
  const info = event.coordinateInfo
  if (!info) return
  frames.set(renderer, {
    originShift: info.originShift ?? null,
    wasmRtcOffset: info.wasmRtcOffset ?? null,
  })
}

/** The frame the renderer's model is in, or null for a model that was never shifted or reported none. */
export function frameOf(renderer: object): RenderFrameInfo | null {
  return frames.get(renderer) ?? null
}
