'use client'

import type { JSX } from 'react'

/**
 * The renderer, typed by the renderer.
 *
 * The declarations below used to be hand-written structural interfaces —
 * `render(options?: Record<string, unknown>)` and a dozen methods copied out by
 * eye — and that is what let every defect this component has shipped through.
 * `xrayContextIds` was not a key the renderer reads; `position: atMetres` was
 * metres in a percentage field. A `Record<string, unknown>` accepts both
 * happily, and neither shows up in a screenshot, so both survived a release.
 *
 * `import type` is erased at build time: it costs nothing in the bundle, does
 * not defeat the `next/dynamic` split this file exists for, and makes the
 * renderer's own `RenderOptions` the contract. A misspelled option is now a
 * type error at the call site, which is where it was always meant to be caught.
 */

import { useRef } from 'react'
import { useIfcViewerCanvasController } from './use-ifc-viewer-canvas-controller'
import { useViewpointBridge, type IfcViewerCanvasWithBridgeProps } from './use-viewpoint-bridge'
import { IfcViewerCanvasView } from './ifc-viewer-canvas-view'
export type { IfcViewerCanvasProps, IfcViewerStatus } from './use-ifc-viewer-canvas-controller'
export type { IfcViewerCanvasWithBridgeProps } from './use-viewpoint-bridge'

export function IfcViewerCanvas(props: IfcViewerCanvasWithBridgeProps): JSX.Element {
  const controller = useIfcViewerCanvasController(props)
  const pinLayerRef = useRef<HTMLDivElement | null>(null)
  useViewpointBridge(controller, props, pinLayerRef)
  return <IfcViewerCanvasView controller={controller} pinLayerRef={pinLayerRef} pins={props.bridge?.pinNodes} />
}

export default IfcViewerCanvas
