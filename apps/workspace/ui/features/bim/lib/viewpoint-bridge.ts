/**
 * What the model stage and the canvas say to each other about marks.
 *
 * The canvas sits behind `next/dynamic`, so nothing crosses it but props: a
 * counter asks for a capture, a counter-stamped value asks for a restore, and
 * callbacks answer. These are the shapes, and the pure steps either side of
 * them (cleaning a capture for the wire, turning a restore into stage state).
 */

import type { ReactNode } from 'react'
import type { ViewpointInput, ViewpointPin } from '@/lib/annotations/viewpoint-types'
import type { SnapshotInput } from '@/lib/annotations/viewpoint-types'
import type { CapturedViewpoint, RestoredViewpoint, Vec3 } from './viewpoint'

/** A pin to draw: where it is in IFC world coordinates, or else the elements whose centre it stands on. */
export interface ViewerPin {
  id: string
  world: Vec3 | null
  globalIds: readonly string[]
}

/** What a capture hands back. `viewpoint` is exactly what the wire takes: no `truncated`. */
export interface ViewpointCapture {
  viewpoint: ViewpointInput
  /** Parts of the view the wire could not take, to say so. */
  notices: CaptureNotices
}

export interface CaptureNotices {
  /** More elements were selected than a mark holds; the first ones are kept. */
  selectionCut: boolean
  /** More elements were isolated or hidden than a mark can list; the mark shows the whole model instead. */
  visibilityDropped: boolean
  /** The picture could not be made; the mark is set without one. */
  noSnapshot: boolean
}

export interface ViewerBridge {
  /** Bumped to capture the view of the live renderer. */
  captureNonce: number
  /** The answer to a capture, or null when the renderer could not be read. */
  onViewpoint: (capture: ViewpointCapture | null) => void
  /** Bumped (with its viewpoint) to put the camera back. */
  restore: { nonce: number; viewpoint: ViewpointInput } | null
  onRestored: (restored: RestoredViewpoint) => void
  pins: readonly ViewerPin[]
  /** The pin buttons, one `data-pin-id` wrapper each; the canvas moves them every frame. */
  pinNodes: ReactNode
}

/**
 * The captured view as the wire takes it. `truncated` is the viewer's own
 * report and the wire is strict, so it is dropped here, and a view the lists
 * cannot hold is made honest: a cut selection keeps its first 500 elements; a
 * cut isolation would show only part of what was isolated, which is not the
 * picture the person saw, so the mark shows the whole model and says so.
 */
export function finalizeCapture(
  captured: CapturedViewpoint,
  extras: { pin?: ViewpointPin | null; snapshot?: SnapshotInput | null }
): ViewpointCapture {
  const { truncated, ...view } = captured
  const components = truncated.exceptions
    ? { ...view.components, visibility: { defaultVisibility: true, exceptions: [] } }
    : view.components
  const viewpoint: ViewpointInput = {
    ...view,
    components,
    ...(extras.pin ? { pin: extras.pin } : {}),
    ...(extras.snapshot ? { snapshot: extras.snapshot } : {}),
  }
  return {
    viewpoint,
    notices: {
      selectionCut: truncated.selection,
      visibilityDropped: truncated.exceptions,
      noSnapshot: !extras.snapshot,
    },
  }
}

/** The one element a restore selects: the first of the viewpoint's selection that this model has. */
export function firstRestoredSelection(
  selectedGlobalIds: readonly string[],
  expressIdByGlobalId: ReadonlyMap<string, number>
): string | null {
  return selectedGlobalIds.find((globalId) => expressIdByGlobalId.has(globalId)) ?? null
}
